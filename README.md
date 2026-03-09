# Bernard Server

Bernard's voice brain — handles incoming Twilio calls and generates AI responses.

## Environment Variables (set these in Railway)

| Variable | Value |
|---|---|
| `OWNER_NAME` | Chris |
| `BUSINESS_NAME` | Chris's Painting Co. |
| `OPENAI_API_KEY` | your OpenAI API key |
| `FIREBASE_URL` | https://bernardbot-4faab.web.app |

## Twilio Webhook URL

After deploying to Railway, set your Twilio phone number webhook to:
```
https://YOUR-RAILWAY-URL/incoming
```
