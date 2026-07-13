# Auto Translate Lite

Live speech-to-text and translation for church services. See `docs/superpowers/specs/2026-07-13-auto-translate-lite-design.md` for the design and `docs/DEPLOY.md` for production deployment.

## Local development

Two apps run side by side:

```bash
cd server && npm install && cp .env.example .env   # fill in DEEPGRAM_API_KEY and GEMINI_API_KEY
npm run dev   # http://localhost:3001
```

```bash
cd web && npm install && cp .env.example .env.local
npm run dev   # http://localhost:3000
```

Open `http://localhost:3000/capture` to start a session, and `http://localhost:3000` to pick a language and view live captions.

## Tests

```bash
cd server && npm test
```
