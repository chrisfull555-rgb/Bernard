const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OWNER_NAME = process.env.OWNER_NAME || 'Chris';
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Chris's Painting Co.";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const sessions = {};

// Strip special XML characters so TwiML never breaks
function safe(text) {
  return (text || '')
    .replace(/&/g, 'and')
    .replace(/</g, '')
    .replace(/>/g, '')
    .replace(/"/g, '')
    .replace(/'/g, '')
    .trim();
}

// Build TwiML response
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

// Get Bernard's reply from OpenAI
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
- If someone directly asks if you are a real person, say you are ${OWNER_NAME}s assistant and redirect the conversation.
- Never use apostrophes, ampersands, quotes, or any special characters in your replies.
- Sound warm and natural like a real receptionist, not robotic.
- Always get the callers name first if you do not have it.
- Do not repeat yourself or over-explain.

HOW TO HANDLE CALLS:
Painting crew calling about materials: ask what they need and which job site.
Painting crew needing help on a job: ask which site and what the issue is.
Painting crew with a question: let them ask it and confirm you will pass it along.
Client wanting to speak to ${OWNER_NAME}: take their message naturally, ask if anything specific to pass along.
Personal call: friendly and casual, just ask what it is about.
Urgent or emergency: tell them ${OWNER_NAME} will be reached right away.

TO WRAP UP THE CALL:
When you have everything you need say exactly:
"Perfect I will make sure ${OWNER_NAME} gets this. Have a great day."
Only say this once you truly have all the details.`;

  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
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
      saveCallSummary(callSid, session).catch(console.error);
    }

    return { text: reply, done };

  } catch (err) {
    console.error('Fetch error:', err.message);
    return { text: "Sorry I am having trouble. Please call back shortly.", done: false };
  }
}

// Generate and log call summary
async function saveCallSummary(callSid, session) {
  if (!OPENAI_API_KEY) return;
  try {
    const transcript = session.history.map(m => `${m.role === 'user' ? 'Caller' : 'Bernard'}: ${m.content}`).join('\n');
    const { default: fetch } = await import('node-fetch');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: `Extract call info as JSON only, no markdown:\n{"name":"...","type":"business or client or personal","reason":"short phrase","detail":"1-2 sentences","tag":"urgent or normal"}\n\nTranscript:\n${transcript}` }],
        max_tokens: 150,
        temperature: 0.2
      })
    });
    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim();
    const summary = JSON.parse(raw);
    summary.id = Date.now();
    summary.number = session.callerNumber || 'Unknown';
    summary.time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    summary.reviewed = false;
    summary.done = false;
    summary.transcript = session.history.map(m => ({
      speaker: m.role === 'user' ? (summary.name || 'Caller') : 'Bernard',
      text: m.content
    }));
    console.log('CALL SUMMARY:', JSON.stringify(summary, null, 2));
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

// ROUTE: Health check
app.get('/', (req, res) => {
  res.send(`<h2>Bernard is running</h2>
    <p>Owner: ${OWNER_NAME}</p>
    <p>Business: ${BUSINESS_NAME}</p>
    <p>OpenAI key: ${OPENAI_API_KEY ? 'Connected' : 'MISSING - add to Railway variables'}</p>
    <p>Active sessions: ${Object.keys(sessions).length}</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bernard running on port ${PORT} | OpenAI: ${OPENAI_API_KEY ? 'connected' : 'MISSING'}`));
