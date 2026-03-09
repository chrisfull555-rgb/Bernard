const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OWNER_NAME = process.env.OWNER_NAME || 'Chris';
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Chris's Painting Co.";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Store active call sessions in memory
const sessions = {};

// Helper: sanitize text for TwiML - removes all special XML chars
function safe(text) {
  return (text || '')
    .replace(/&/g, 'and')
    .replace(/</g, '')
    .replace(/>/g, '')
    .replace(/"/g, '')
    .replace(/'/g, '')
    .trim();
}

// Helper: build a TwiML response
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

// Helper: call OpenAI and get Bernard's reply
async function bernardReply(callSid, userSaid) {
  const session = sessions[callSid];
  if (!session) return { text: "I am sorry I lost track of our call. Please call back.", done: true };

  // Keep history from getting too long
  if (session.history.length > 12) session.history = session.history.slice(-12);

  session.history.push({ role: 'user', content: userSaid });

  const system = `You are Bernard, ${OWNER_NAME}s AI receptionist for ${BUSINESS_NAME}.
Answer calls on behalf of ${OWNER_NAME} who is unavailable.

CRITICAL RULES:
- Maximum 2 short sentences per response. You are voice only.
- Never use apostrophes, ampersands, quotes, or special characters in replies.
- Never say you are human if sincerely asked.
- Always get the callers name first before anything else.

HOW TO SCREEN CALLS:
Business crew calling about:
  - Materials needed: ask what materials and which job site
  - Help on a job: ask which job site and what the problem is
  - A question: let them ask it and confirm you will pass it to ${OWNER_NAME}
Client calling for ${OWNER_NAME}: take a message and ask if there is anything specific to pass along
Personal call: friendly and open, just ask why they are calling
Urgent call (emergency, accident): say ${OWNER_NAME} will be notified immediately

TO END THE CALL say these exact words when done collecting info:
"Perfect I have got all of that noted. I will make sure ${OWNER_NAME} gets this message. Have a great day."`;

  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, ...session.history],
        max_tokens: 100,
        temperature: 0.5
      })
    });

    if (!res.ok) {
      console.error('OpenAI error:', res.status, await res.text());
      return { text: "I am having trouble right now. Could you say that again?", done: false };
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "I am sorry could you repeat that?";
    session.history.push({ role: 'assistant', content: reply });

    const done = reply.toLowerCase().includes("have a great day") || reply.toLowerCase().includes("i will make sure");
    if (done) {
      session.done = true;
      saveCallSummary(callSid, session).catch(console.error);
    }

    return { text: reply, done };

  } catch (err) {
    console.error('Fetch error:', err.message);
    return { text: "I am sorry I am having trouble. Please call back shortly.", done: false };
  }
}

// Helper: generate and log call summary
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
    summary.transcript = session.history.map(m => ({ speaker: m.role === 'user' ? (summary.name || 'Caller') : 'Bernard', text: m.content }));
    console.log('CALL SUMMARY:', JSON.stringify(summary, null, 2));
    // TODO: push to Firebase Realtime DB in Phase 2
  } catch (err) {
    console.error('Summary error:', err.message);
  }
}

// ROUTE: Incoming call from Twilio
app.post('/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || 'Unknown';
  console.log(`Incoming call from ${callerNumber} [${callSid}]`);

  sessions[callSid] = { history: [], callerNumber, done: false, silenceCount: 0 };

  const greeting = `Hi, you have reached ${OWNER_NAME}s phone. My name is Bernard, I am ${OWNER_NAME}s AI assistant. Could I get your name and find out how I can help you today?`;
  sessions[callSid].history.push({ role: 'assistant', content: greeting });

  res.type('text/xml');
  res.send(twiml(greeting, false));
});

// ROUTE: Handle what the caller says
app.post('/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const session = sessions[callSid];

  console.log(`[${callSid}] Heard: "${speech}"`);

  // Nothing heard
  if (!speech) {
    if (!session) { res.type('text/xml'); res.send(twiml("I could not hear you. Please call back. Goodbye!", true)); return; }
    session.silenceCount = (session.silenceCount || 0) + 1;
    if (session.silenceCount >= 2) { res.type('text/xml'); res.send(twiml("I am sorry I cannot hear you. Please try calling back. Goodbye!", true)); return; }
    res.type('text/xml');
    res.send(twiml("I am sorry I did not catch that. Could you say that again?", false));
    return;
  }

  if (session) session.silenceCount = 0;

  const { text, done } = await bernardReply(callSid, speech);
  res.type('text/xml');
  res.send(twiml(text, done));
});

// ROUTE: Health check - visit this URL to confirm Bernard is running
app.get('/', (req, res) => {
  res.send(`<h2>Bernard is running</h2><p>Owner: ${OWNER_NAME}</p><p>Business: ${BUSINESS_NAME}</p><p>OpenAI key: ${OPENAI_API_KEY ? 'Connected' : 'MISSING - add to Railway variables'}</p><p>Active sessions: ${Object.keys(sessions).length}</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bernard running on port ${PORT} | OpenAI: ${OPENAI_API_KEY ? 'connected' : 'MISSING'}`));
