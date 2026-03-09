const express = require('express');
const bodyParser = require('body-parser');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OWNER_NAME = process.env.OWNER_NAME || 'Chris';
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Chris's Painting Co.";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://bernardbot-4faab.web.app';

// Store active call sessions in memory
const sessions = {};

// ── Helper: ask OpenAI to generate Bernard's next response ──
async function bernardReply(callSid, userSaid) {
  const session = sessions[callSid];
  if (!session) return "I'm sorry, I lost track of our conversation. Could you call back?";

  session.history.push({ role: 'user', content: userSaid });

  const systemPrompt = `You are Bernard, ${OWNER_NAME}'s friendly and professional AI receptionist.
Your job is to answer calls on behalf of ${OWNER_NAME} when he is unavailable.

BUSINESS: ${BUSINESS_NAME}

YOUR PERSONALITY:
- Warm, calm, and professional
- Male voice and demeanor
- Efficient — don't ramble, keep responses short (1-3 sentences max)
- Never pretend to be a human if sincerely asked

YOUR GREETING (already done, don't repeat it):
You already said: "Hi, you've reached ${OWNER_NAME}'s phone. My name is Bernard, I'm ${OWNER_NAME}'s AI assistant. Could I get your name and find out how I can help you today?"

SCREENING RULES:
1. Always get the caller's name first if you don't have it
2. For BUSINESS calls (painting crew, job sites, materials, clients):
   - If they need MATERIALS: ask what materials and which job site
   - If they need HELP ON A JOB: ask which job site and describe the issue
   - If they have a QUESTION: let them ask it, summarize it back
   - If a CLIENT wants to speak to ${OWNER_NAME}: take a message, ask if there's anything specific to pass along
3. For PERSONAL calls: ask why they're calling in a friendly way, keep it brief
4. For URGENT calls (emergency, accident, flooding, fire): flag as urgent, say ${OWNER_NAME} will be notified immediately
5. Always end with: "Perfect, I've got all of that noted. I'll make sure ${OWNER_NAME} gets this message. Have a great day [name]!"

IMPORTANT: Keep all responses SHORT. One or two sentences. You are a voice assistant.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, ...session.history],
        max_tokens: 150,
        temperature: 0.7
      })
    });
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "I'm sorry, could you repeat that?";
    session.history.push({ role: 'assistant', content: reply });

    // Check if call is wrapping up
    if (reply.toLowerCase().includes("have a great day") || reply.toLowerCase().includes("i'll make sure")) {
      session.done = true;
      await saveCallSummary(callSid, session);
    }

    return reply;
  } catch (err) {
    console.error('OpenAI error:', err);
    return "I'm sorry, I'm having a little trouble right now. Could you please repeat that?";
  }
}

// ── Helper: generate summary and save to Firebase ──
async function saveCallSummary(callSid, session) {
  if (!OPENAI_API_KEY) return;
  try {
    const summaryPrompt = `Based on this call transcript, extract:
1. Caller name
2. Call type (business/client/personal)
3. Reason for calling (short phrase)
4. Key details (1-2 sentences)
5. Urgency (urgent/normal)

Respond in JSON only like:
{"name":"...","type":"business","reason":"...","detail":"...","tag":"normal"}

Transcript:
${session.history.map(m => `${m.role === 'user' ? 'Caller' : 'Bernard'}: ${m.content}`).join('\n')}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: summaryPrompt }],
        max_tokens: 200,
        temperature: 0.3
      })
    });
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const summary = JSON.parse(clean);
    summary.id = Date.now();
    summary.time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    summary.number = session.callerNumber || 'Unknown';
    summary.reviewed = false;
    summary.done = false;
    summary.transcript = session.history.map(m => ({ speaker: m.role === 'user' ? (summary.name || 'Caller') : 'Bernard', text: m.content }));
    console.log('📋 Call summary saved:', JSON.stringify(summary, null, 2));
    // In production this would push to Firebase Realtime DB
    // For now it logs to console — Phase 2 will wire up live push
  } catch (err) {
    console.error('Summary error:', err);
  }
}

// ── Route: Incoming call ──
app.post('/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || 'Unknown';

  sessions[callSid] = {
    history: [],
    callerNumber,
    done: false,
    startTime: new Date()
  };

  const greeting = `Hi, you've reached ${OWNER_NAME}'s phone. My name is Bernard, I'm ${OWNER_NAME}'s AI assistant. Could I get your name and find out how I can help you today?`;

  sessions[callSid].history.push({ role: 'assistant', content: greeting });

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew" language="en-US">${greeting}</Say>
  <Gather input="speech" action="/respond" method="POST" speechTimeout="auto" language="en-US">
  </Gather>
</Response>`);
});

// ── Route: Handle caller's speech ──
app.post('/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';

  console.log(`📞 [${callSid}] Caller said: "${speechResult}"`);

  const reply = await bernardReply(callSid, speechResult);
  const session = sessions[callSid];
  const isDone = session?.done;

  res.type('text/xml');
  if (isDone) {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew" language="en-US">${reply}</Say>
  <Hangup/>
</Response>`);
  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew" language="en-US">${reply}</Say>
  <Gather input="speech" action="/respond" method="POST" speechTimeout="auto" language="en-US">
  </Gather>
</Response>`);
  }
});

// ── Route: Health check ──
app.get('/', (req, res) => {
  res.send('🎙️ Bernard is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Bernard server running on port ${PORT}`));
