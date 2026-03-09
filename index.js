const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OWNER_NAME = process.env.OWNER_NAME || 'Chris';
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Chris's Painting Co.";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://bernardbot-4faab-default-rtdb.firebaseio.com';

const sessions = {};

function safe(text) {
  return (text || '')
    .replace(/&/g, 'and')
    .replace(/</g, '')
    .replace(/>/g, '')
    .replace(/"/g, '')
    .replace(/'/g, '')
    .trim();
}

function twiml(sayText, hangup = false) {
  const cleaned = safe(sayText);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew" language="en-US">${cleaned}</Say>
  ${hangup
    ? '<Hangup/>'
    : `<Gather input="speech" action="/respond" method="POST" speechTimeout="2" timeout="10" language="en-US" enhanced="true" speechModel="phone_call"></Gather>`
  }
</Response>`;
}

async function bernardReply(callSid, userSaid) {
  const session = sessions[callSid];
  if (!session) return { text: "Sorry I lost track of our call. Please call back.", done: true };

  if (session.history.length > 12) session.history = session.history.slice(-12);
  session.history.push({ role: 'user', content: userSaid });

  const system = `You are Bernard, a professional phone assistant who handles calls for ${OWNER_NAME} at ${BUSINESS_NAME}.
You answer the phone when ${OWNER_NAME} is unavailable. You sound calm, natural, and human.

RULES:
- Keep every response to 1 sentence maximum. Short and natural.
- Never mention you are an AI, a bot, or automated in any way.
- If someone directly asks if you are a real person, say you are ${OWNER_NAME}s assistant and redirect.
- Never use apostrophes, ampersands, quotes, or any special characters in your replies.
- Sound warm and natural like a real receptionist, not robotic.
- Always get the callers name first if you do not have it.
- Do not repeat yourself or over-explain.

HOW TO HANDLE CALLS:
Painting crew calling about materials: ask what they need and which job site.
Painting crew needing help on a job: ask which site and what the issue is.
Painting crew with a question: let them ask it and confirm you will pass it along.
Client wanting to speak to ${OWNER_NAME}: take their message, ask if anything specific to pass along.
Personal call: friendly and casual, just ask what it is about.
Urgent or emergency: tell them ${OWNER_NAME} will be reached right away.

TO WRAP UP THE CALL when you have everything you need say exactly:
"Perfect I will make sure ${OWNER_NAME} gets this. Have a great day."
Only say this once you truly have all the details.`;

  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, ...session.history],
        max_tokens: 60,
        temperature: 0.4
      })
    });

    if (!res.ok) {
      console.error('OpenAI error:', res.status, await res.text());
      return { text: "Sorry about that, could you say that one more time?", done: false };
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "Sorry could you repeat that?";
    session.history.push({ role: 'assistant', content: reply });

    const done = reply.toLowerCase().includes("have a great day") || reply.toLowerCase().includes("i will make sure");
    if (done) {
      session.done = true;
      saveCallSummary(callSid, session, false).catch(console.error);
    }

    return { text: reply, done };

  } catch (err) {
    console.error('Fetch error:', err.message);
    return { text: "Sorry I am having trouble. Please call back shortly.", done: false };
  }
}

// Push call summary to Firebase
async function saveCallSummary(callSid, session, hungUp = false) {
  if (!OPENAI_API_KEY) return;
  try {
    const { default: fetch } = await import('node-fetch');
    const id = Date.now();
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    let summary;

    // If caller hung up early with little or no conversation
    if (hungUp && session.history.length <= 2) {
      summary = {
        id,
        name: 'Unknown',
        number: session.callerNumber || 'Unknown',
        type: 'personal',
        reason: 'Hung up',
        detail: 'Caller hung up before leaving a message.',
        tag: 'normal',
        time,
        reviewed: false,
        done: false,
        hungUp: true,
        transcript: session.history.map(m => ({
          speaker: m.role === 'user' ? 'Caller' : 'Bernard',
          text: m.content
        }))
      };
    } else {
      // Generate AI summary from transcript
      const transcript = session.history.map(m => `${m.role === 'user' ? 'Caller' : 'Bernard'}: ${m.content}`).join('\n');

      const extraInstruction = hungUp
        ? 'Note: the caller hung up before the conversation was finished. Summarize what was captured so far.'
        : '';

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: `Extract call info as JSON only, no markdown:\n{"name":"...","type":"business or client or personal","reason":"short phrase","detail":"1-2 sentences","tag":"urgent or normal"}\n${extraInstruction}\n\nTranscript:\n${transcript}` }],
          max_tokens: 150,
          temperature: 0.2
        })
      });

      const data = await res.json();
      const raw = (data.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim();
      summary = JSON.parse(raw);
      summary.id = id;
      summary.number = session.callerNumber || 'Unknown';
      summary.time = time;
      summary.reviewed = false;
      summary.done = false;
      summary.hungUp = hungUp;
      if (hungUp) summary.reason = summary.reason + ' (hung up early)';
      summary.transcript = session.history.map(m => ({
        speaker: m.role === 'user' ? (summary.name || 'Caller') : 'Bernard',
        text: m.content
      }));
    }

    // Push to Firebase
    const dbRes = await fetch(`${FIREBASE_DB_URL}/calls/${summary.id}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary)
    });

    if (dbRes.ok) {
      console.log(`Call saved to Firebase: ${summary.name} - ${summary.reason}${hungUp ? ' [HUNG UP]' : ''}`);
    } else {
      console.error('Firebase write failed:', await dbRes.text());
    }

  } catch (err) {
    console.error('Summary error:', err.message);
  }
}

// ROUTE: Incoming call
app.post('/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || 'Unknown';
  console.log(`Incoming call from ${callerNumber} [${callSid}]`);

  sessions[callSid] = { history: [], callerNumber, done: false, silenceCount: 0 };

  const greeting = `Hey there, you have reached ${OWNER_NAME}s phone, this is Bernard. Who am I speaking with today?`;
  sessions[callSid].history.push({ role: 'assistant', content: greeting });

  res.type('text/xml');
  res.send(twiml(greeting, false));
});

// ROUTE: Handle caller speech
app.post('/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const session = sessions[callSid];

  console.log(`[${callSid}] Heard: "${speech}"`);

  if (!speech) {
    if (!session) { res.type('text/xml'); res.send(twiml("I could not hear you. Please call back. Goodbye!", true)); return; }
    session.silenceCount = (session.silenceCount || 0) + 1;
    if (session.silenceCount >= 2) { res.type('text/xml'); res.send(twiml("I am sorry I cannot hear you. Please try calling back. Goodbye!", true)); return; }
    res.type('text/xml');
    res.send(twiml("Sorry I did not catch that, could you say that again?", false));
    return;
  }

  if (session) session.silenceCount = 0;

  const { text, done } = await bernardReply(callSid, speech);
  res.type('text/xml');
  res.send(twiml(text, done));
});

// ROUTE: Twilio calls this when a call ends for any reason
app.post('/status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const session = sessions[callSid];

  console.log(`Call ${callSid} ended with status: ${callStatus}`);

  // If call ended but we never saved a summary, caller hung up early
  if (session && !session.done) {
    console.log(`Caller hung up early on ${callSid} — saving partial summary`);
    saveCallSummary(callSid, session, true).catch(console.error);
    session.done = true;
  }

  // Clean up session after a delay
  setTimeout(() => { delete sessions[callSid]; }, 5000);

  res.sendStatus(200);
});

// ROUTE: Health check
app.get('/', (req, res) => {
  res.send(`<h2>Bernard is running</h2>
    <p>Owner: ${OWNER_NAME}</p>
    <p>Business: ${BUSINESS_NAME}</p>
    <p>OpenAI key: ${OPENAI_API_KEY ? 'Connected' : 'MISSING - add to Railway variables'}</p>
    <p>Firebase DB: ${FIREBASE_DB_URL}</p>
    <p>Active sessions: ${Object.keys(sessions).length}</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bernard running on port ${PORT} | OpenAI: ${OPENAI_API_KEY ? 'connected' : 'MISSING'}`));
