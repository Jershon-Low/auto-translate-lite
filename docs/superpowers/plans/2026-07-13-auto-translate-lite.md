# Auto Translate Lite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live speech-to-text + translation system for church services — a volunteer-run capture page transcribes the sermon via Deepgram, a Node/TypeScript server translates finalized sentences into active target languages via Gemini, and congregants reach a Next.js viewer page (via QR code) showing a scrollable, live-updating caption feed in their chosen language.

**Architecture:** Two independent apps in one repo: `server/` (Node.js + TypeScript, owns Deepgram/Gemini calls and a `ws` WebSocket server for audio ingest + caption fan-out, all state in memory) and `web/` (Next.js + shadcn/ui, three pages: language picker, capture, viewer — all talking to the server over plain HTTP health checks and WebSocket).

**Tech Stack:** Node.js 20+, TypeScript, Express, `ws`, `@deepgram/sdk`, `@google/genai` (Gemini), Vitest — Next.js 15 (App Router), Tailwind, shadcn/ui.

## Global Constraints

- Backend is Node.js + TypeScript only; frontend is Next.js + shadcn/ui only — no other framework.
- No database. All session/transcript state lives in server memory; a server restart is allowed to lose the current session.
- Exactly one active session at a time. Sessions are keyed by an internal session ID so multi-session support can be added later without a redesign, but only one is ever active now.
- Source language is fixed to English. Target languages are a fixed preset list of 12 (defined in Task 3) — no dynamic/open language input.
- Translation is exactly one Gemini call per finalized sentence, requesting only the languages with at least one currently-connected viewer. On failure, retry once, then skip that line and log the error — never crash the session over one bad translation.
- The rolling transcript buffer holds the last 10 minutes of finalized English segments.
- End-to-end latency budget is ~5 seconds; audio is proxied through the server to Deepgram (the Deepgram API key must never reach the browser).
- Caption lines always carry both the English original and the translation as a pair; the viewer UI renders English (grey, muted) above the translation (full-size) beneath it.
- Automated tests cover backend logic only (buffer, translation, WebSocket fan-out); frontend correctness is verified manually per the spec.

---

## File Structure

```
server/
  src/
    app.ts              Express app factory (health check)
    types.ts            CaptionLine type
    transcriptBuffer.ts  Rolling 10-minute buffer of finalized segments
    languages.ts         Fixed target language list
    gemini.ts            Gemini client + translateSegment / translateBacklog
    deepgram.ts           Deepgram connection wrapper + finalized-transcript filter
    session.ts            In-memory session state (id, buffer, viewer registry)
    wsServer.ts            WebSocket routing: capture + viewer protocols, fan-out orchestration
    index.ts               Entrypoint: wires app + http server + ws server + real clients
  tests/
    app.test.ts
    transcriptBuffer.test.ts
    gemini.test.ts
    deepgram.test.ts
    session.test.ts
    wsServer.test.ts
  package.json
  tsconfig.json
  .env.example

web/
  app/
    layout.tsx            Root layout, forces dark theme
    page.tsx               Landing / language-select page
    view/page.tsx           Viewer caption page
    capture/page.tsx         Capture page (volunteer-facing)
  lib/
    languages.ts            Fixed target language list (mirrors server/src/languages.ts)
    useViewerSocket.ts       WebSocket client hook for the viewer page
  components/ui/            shadcn-generated components (button, card)
  package.json
  tsconfig.json
  .env.example

docs/
  DEPLOY.md                 VPS provisioning + reverse proxy + process manager runbook
README.md                   Repo overview + local dev instructions
```

---

## Backend Tasks

### Task 1: Scaffold server project with health check

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/.env.example`
- Create: `server/src/app.ts`
- Create: `server/src/index.ts`
- Test: `server/tests/app.test.ts`

**Interfaces:**
- Produces: `createApp(): Express` — an Express app with a `GET /health` route returning `{ status: 'ok' }`. Later tasks attach the `ws` server to the `http.Server` wrapping this app.

- [ ] **Step 1: Create the server package**

`server/package.json`:
```json
{
  "name": "auto-translate-lite-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@deepgram/sdk": "^3.9.0",
    "@google/genai": "^0.3.0",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "@types/ws": "^8.5.10",
    "supertest": "^7.0.0",
    "tsx": "^4.16.2",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

`server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

`server/.env.example`:
```
DEEPGRAM_API_KEY=
GEMINI_API_KEY=
PORT=3001
```

Run: `cd server && npm install`
Expected: dependencies install with no errors.

- [ ] **Step 2: Write the failing test for the health check**

`server/tests/app.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

describe('GET /health', () => {
  it('returns status ok', async () => {
    const response = await request(createApp()).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: FAIL — `Cannot find module '../src/app'`

- [ ] **Step 4: Implement `createApp`**

`server/src/app.ts`:
```typescript
import express, { type Express } from 'express';

export function createApp(): Express {
  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  return app;
}
```

`server/src/index.ts`:
```typescript
import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';

const app = createApp();
const httpServer = createServer(app);
const port = process.env.PORT ? Number(process.env.PORT) : 3001;

httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: PASS (1 test)

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/tsconfig.json server/.env.example server/src/app.ts server/src/index.ts server/tests/app.test.ts
git commit -m "feat(server): scaffold express app with health check"
```

---

### Task 2: Rolling transcript buffer

**Files:**
- Create: `server/src/types.ts`
- Create: `server/src/transcriptBuffer.ts`
- Test: `server/tests/transcriptBuffer.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `CaptionLine { id: string; timestampMs: number; english: string }` and `TranscriptBuffer` class with `append(english: string, timestampMs?: number): CaptionLine`, `getRecent(nowMs?: number): CaptionLine[]`, `clear(): void`. Used by `session.ts` (Task 5) and `wsServer.ts` (Task 6).

- [ ] **Step 1: Write the failing tests**

`server/src/types.ts`:
```typescript
export interface CaptionLine {
  id: string;
  timestampMs: number;
  english: string;
}
```

`server/tests/transcriptBuffer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { TranscriptBuffer } from '../src/transcriptBuffer';

describe('TranscriptBuffer', () => {
  it('returns appended lines in order', () => {
    const buffer = new TranscriptBuffer();
    buffer.append('Hello', 1000);
    buffer.append('World', 2000);
    expect(buffer.getRecent(2000).map((l) => l.english)).toEqual(['Hello', 'World']);
  });

  it('drops lines older than the 10-minute window', () => {
    const buffer = new TranscriptBuffer();
    buffer.append('Old', 0);
    buffer.append('Recent', 5 * 60 * 1000);
    const nowMs = 11 * 60 * 1000;
    expect(buffer.getRecent(nowMs).map((l) => l.english)).toEqual(['Recent']);
  });

  it('clear() empties the buffer', () => {
    const buffer = new TranscriptBuffer();
    buffer.append('Hello', 1000);
    buffer.clear();
    expect(buffer.getRecent(1000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/transcriptBuffer.test.ts`
Expected: FAIL — `Cannot find module '../src/transcriptBuffer'`

- [ ] **Step 3: Implement `TranscriptBuffer`**

`server/src/transcriptBuffer.ts`:
```typescript
import { randomUUID } from 'node:crypto';
import type { CaptionLine } from './types.js';

const BUFFER_WINDOW_MS = 10 * 60 * 1000;

export class TranscriptBuffer {
  private lines: CaptionLine[] = [];

  append(english: string, timestampMs: number = Date.now()): CaptionLine {
    const line: CaptionLine = { id: randomUUID(), timestampMs, english };
    this.lines.push(line);
    this.trim(timestampMs);
    return line;
  }

  getRecent(nowMs: number = Date.now()): CaptionLine[] {
    this.trim(nowMs);
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - BUFFER_WINDOW_MS;
    this.lines = this.lines.filter((line) => line.timestampMs >= cutoff);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/transcriptBuffer.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/types.ts server/src/transcriptBuffer.ts server/tests/transcriptBuffer.test.ts
git commit -m "feat(server): add rolling transcript buffer"
```

---

### Task 3: Target languages + Gemini translation module

**Files:**
- Create: `server/src/languages.ts`
- Create: `server/src/gemini.ts`
- Test: `server/tests/gemini.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `TARGET_LANGUAGES: Language[]`, `LANGUAGE_CODES: string[]` from `languages.ts`. `GeminiClient` interface, `createGeminiClient(apiKey: string): GeminiClient`, `translateSegment(client: GeminiClient, englishText: string, languageCodes: string[]): Promise<Record<string, string>>`, `translateBacklog(client: GeminiClient, englishLines: string[], languageCode: string): Promise<string[]>` from `gemini.ts`. Used by `wsServer.ts` (Task 6) and `index.ts` (Task 7).

- [ ] **Step 1: Add the fixed target language list**

`server/src/languages.ts`:
```typescript
export interface Language {
  code: string;
  label: string;
}

export const TARGET_LANGUAGES: Language[] = [
  { code: 'zh', label: '中文 (Mandarin)' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'ko', label: '한국어 (Korean)' },
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'vi', label: 'Tiếng Việt (Vietnamese)' },
  { code: 'th', label: 'ภาษาไทย (Thai)' },
  { code: 'es', label: 'Español (Spanish)' },
  { code: 'pt', label: 'Português (Portuguese)' },
  { code: 'fr', label: 'Français (French)' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'my', label: 'မြန်မာ (Burmese)' },
];

export const LANGUAGE_CODES: string[] = TARGET_LANGUAGES.map((language) => language.code);
```

This list must be kept identical to `web/lib/languages.ts` (Task 9) — adding or removing a language means editing both files.

- [ ] **Step 2: Write the failing tests for Gemini translation**

`server/tests/gemini.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { translateSegment, translateBacklog, type GeminiClient } from '../src/gemini';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: responseText }),
    },
  };
}

describe('translateSegment', () => {
  it('returns parsed translations for the requested languages', async () => {
    const client = fakeClient('{"zh":"你好","ko":"안녕"}');
    const result = await translateSegment(client, 'Hello', ['zh', 'ko']);
    expect(result).toEqual({ zh: '你好', ko: '안녕' });
  });

  it('skips the API call and returns an empty object when no languages are active', async () => {
    const client = fakeClient('{}');
    const result = await translateSegment(client, 'Hello', []);
    expect(result).toEqual({});
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });
});

describe('translateBacklog', () => {
  it('returns translations in the same order as the input lines', async () => {
    const client = fakeClient('{"translations":["你好","再见"]}');
    const result = await translateBacklog(client, ['Hello', 'Goodbye'], 'zh');
    expect(result).toEqual(['你好', '再见']);
  });

  it('skips the API call and returns an empty array for an empty backlog', async () => {
    const client = fakeClient('{"translations":[]}');
    const result = await translateBacklog(client, [], 'zh');
    expect(result).toEqual([]);
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/gemini.test.ts`
Expected: FAIL — `Cannot find module '../src/gemini'`

- [ ] **Step 4: Implement the Gemini translation module**

`server/src/gemini.ts`:
```typescript
import { GoogleGenAI } from '@google/genai';

export interface GeminiClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config: { responseMimeType: string; responseSchema: Record<string, unknown> };
    }): Promise<{ text: string | null }>;
  };
}

export function createGeminiClient(apiKey: string): GeminiClient {
  return new GoogleGenAI({ apiKey });
}

const MODEL = 'gemini-2.5-flash';

export async function translateSegment(
  client: GeminiClient,
  englishText: string,
  languageCodes: string[]
): Promise<Record<string, string>> {
  if (languageCodes.length === 0) return {};

  const properties: Record<string, { type: string }> = {};
  for (const code of languageCodes) properties[code] = { type: 'string' };

  const response = await client.models.generateContent({
    model: MODEL,
    contents: `Translate the following sentence, spoken during a live church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal. Sentence: "${englishText}"`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: languageCodes },
    },
  });

  return JSON.parse(response.text ?? '{}');
}

export async function translateBacklog(
  client: GeminiClient,
  englishLines: string[],
  languageCode: string
): Promise<string[]> {
  if (englishLines.length === 0) return [];

  const response = await client.models.generateContent({
    model: MODEL,
    contents: `Translate each of these sentences, spoken during a live church sermon, into language code "${languageCode}". Return the translations in the exact same order as the input. Sentences: ${JSON.stringify(englishLines)}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { translations: { type: 'array', items: { type: 'string' } } },
        required: ['translations'],
      },
    },
  });

  const parsed = JSON.parse(response.text ?? '{"translations":[]}');
  return parsed.translations ?? [];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/gemini.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/languages.ts server/src/gemini.ts server/tests/gemini.test.ts
git commit -m "feat(server): add target language list and Gemini translation module"
```

---

### Task 4: Deepgram connection wrapper

**Files:**
- Create: `server/src/deepgram.ts`
- Test: `server/tests/deepgram.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `DeepgramCallbacks { onFinalSegment: (text: string) => void; onError: (error: Error) => void; onClose: () => void }`, `extractFinalTranscript(event): string | null`, `createDeepgramConnection(apiKey: string, callbacks: DeepgramCallbacks): DeepgramConnection`, `DeepgramConnection { send(data: Buffer): void; finish(): void }`, `type DeepgramConnectionFactory = typeof createDeepgramConnection`. Used by `wsServer.ts` (Task 6) and `index.ts` (Task 7).

- [ ] **Step 1: Write the failing test for the transcript filter**

`server/tests/deepgram.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { extractFinalTranscript } from '../src/deepgram';

describe('extractFinalTranscript', () => {
  it('returns the transcript when is_final is true and text is non-empty', () => {
    const event = { is_final: true, channel: { alternatives: [{ transcript: 'Hello there' }] } };
    expect(extractFinalTranscript(event)).toBe('Hello there');
  });

  it('returns null for interim (non-final) results', () => {
    const event = { is_final: false, channel: { alternatives: [{ transcript: 'Hello' }] } };
    expect(extractFinalTranscript(event)).toBeNull();
  });

  it('returns null for a final result with empty transcript', () => {
    const event = { is_final: true, channel: { alternatives: [{ transcript: '   ' }] } };
    expect(extractFinalTranscript(event)).toBeNull();
  });

  it('returns null when there are no alternatives', () => {
    const event = { is_final: true, channel: { alternatives: [] } };
    expect(extractFinalTranscript(event)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/deepgram.test.ts`
Expected: FAIL — `Cannot find module '../src/deepgram'`

- [ ] **Step 3: Implement the Deepgram wrapper**

`server/src/deepgram.ts`:
```typescript
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

export interface DeepgramTranscriptEvent {
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

export function extractFinalTranscript(event: DeepgramTranscriptEvent): string | null {
  const transcript = event.channel?.alternatives?.[0]?.transcript ?? '';
  if (event.is_final && transcript.trim().length > 0) {
    return transcript.trim();
  }
  return null;
}

export interface DeepgramCallbacks {
  onFinalSegment: (text: string) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export interface DeepgramConnection {
  send(data: Buffer): void;
  finish(): void;
}

export function createDeepgramConnection(
  apiKey: string,
  callbacks: DeepgramCallbacks
): DeepgramConnection {
  const deepgram = createClient(apiKey);
  const connection = deepgram.listen.live({
    model: 'nova-2',
    language: 'en',
    smart_format: true,
    interim_results: true,
    encoding: 'opus',
    mimetype: 'audio/webm',
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data: DeepgramTranscriptEvent) => {
    const finalText = extractFinalTranscript(data);
    if (finalText) callbacks.onFinalSegment(finalText);
  });

  connection.on(LiveTranscriptionEvents.Error, (error: Error) => callbacks.onError(error));
  connection.on(LiveTranscriptionEvents.Close, () => callbacks.onClose());

  return {
    send: (data: Buffer) => connection.send(data),
    finish: () => connection.finish(),
  };
}

export type DeepgramConnectionFactory = typeof createDeepgramConnection;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/deepgram.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/deepgram.ts server/tests/deepgram.test.ts
git commit -m "feat(server): add Deepgram connection wrapper with finalized-transcript filter"
```

---

### Task 5: In-memory session state

**Files:**
- Create: `server/src/session.ts`
- Test: `server/tests/session.test.ts`

**Interfaces:**
- Consumes: `TranscriptBuffer` from `transcriptBuffer.ts` (Task 2).
- Produces: `Session` class with `id: string`, `isActive: boolean`, `buffer: TranscriptBuffer`, `start(): void`, `stop(): void`, `addViewer(socket: WebSocket, language: string): void`, `removeViewer(socket: WebSocket): void`, `switchViewerLanguage(socket: WebSocket, language: string): void`, `getActiveLanguages(): string[]`, `getViewersForLanguage(language: string): WebSocket[]`. Used by `wsServer.ts` (Task 6) and `index.ts` (Task 7).

- [ ] **Step 1: Write the failing tests**

`server/tests/session.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { Session } from '../src/session';

function fakeSocket(): WebSocket {
  return {} as WebSocket;
}

describe('Session', () => {
  it('tracks the set of active languages across connected viewers', () => {
    const session = new Session();
    session.addViewer(fakeSocket(), 'zh');
    session.addViewer(fakeSocket(), 'ko');
    expect(session.getActiveLanguages().sort()).toEqual(['ko', 'zh']);
  });

  it('deduplicates languages shared by multiple viewers', () => {
    const session = new Session();
    session.addViewer(fakeSocket(), 'zh');
    session.addViewer(fakeSocket(), 'zh');
    expect(session.getActiveLanguages()).toEqual(['zh']);
  });

  it('removes a viewer from active language tracking on disconnect', () => {
    const session = new Session();
    const socket = fakeSocket();
    session.addViewer(socket, 'zh');
    session.removeViewer(socket);
    expect(session.getActiveLanguages()).toEqual([]);
  });

  it('returns only the viewers subscribed to a given language', () => {
    const session = new Session();
    const zhSocket = fakeSocket();
    const koSocket = fakeSocket();
    session.addViewer(zhSocket, 'zh');
    session.addViewer(koSocket, 'ko');
    expect(session.getViewersForLanguage('zh')).toEqual([zhSocket]);
  });

  it('switchViewerLanguage moves a viewer to a new language', () => {
    const session = new Session();
    const socket = fakeSocket();
    session.addViewer(socket, 'zh');
    session.switchViewerLanguage(socket, 'ko');
    expect(session.getViewersForLanguage('zh')).toEqual([]);
    expect(session.getViewersForLanguage('ko')).toEqual([socket]);
  });

  it('start() assigns a fresh id, activates the session, and clears the buffer', () => {
    const session = new Session();
    session.buffer.append('leftover', 0);
    const previousId = session.id;
    session.start();
    expect(session.id).not.toBe(previousId);
    expect(session.isActive).toBe(true);
    expect(session.buffer.getRecent(0)).toEqual([]);
  });

  it('stop() deactivates the session without clearing the buffer', () => {
    const session = new Session();
    session.start();
    session.buffer.append('kept', 0);
    session.stop();
    expect(session.isActive).toBe(false);
    expect(session.buffer.getRecent(0)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/session.test.ts`
Expected: FAIL — `Cannot find module '../src/session'`

- [ ] **Step 3: Implement `Session`**

`server/src/session.ts`:
```typescript
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { TranscriptBuffer } from './transcriptBuffer.js';

export class Session {
  id: string = randomUUID();
  isActive: boolean = false;
  buffer: TranscriptBuffer = new TranscriptBuffer();
  private viewers: Map<WebSocket, string> = new Map();

  start(): void {
    this.id = randomUUID();
    this.isActive = true;
    this.buffer.clear();
  }

  stop(): void {
    this.isActive = false;
  }

  addViewer(socket: WebSocket, language: string): void {
    this.viewers.set(socket, language);
  }

  removeViewer(socket: WebSocket): void {
    this.viewers.delete(socket);
  }

  switchViewerLanguage(socket: WebSocket, language: string): void {
    this.viewers.set(socket, language);
  }

  getActiveLanguages(): string[] {
    return Array.from(new Set(this.viewers.values()));
  }

  getViewersForLanguage(language: string): WebSocket[] {
    return Array.from(this.viewers.entries())
      .filter(([, viewerLanguage]) => viewerLanguage === language)
      .map(([socket]) => socket);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/session.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/session.ts server/tests/session.test.ts
git commit -m "feat(server): add in-memory session state"
```

---

### Task 6: WebSocket server — capture + viewer protocols and fan-out

**Files:**
- Create: `server/src/wsServer.ts`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `Session` (Task 5), `TARGET_LANGUAGES`/language codes (Task 3), `GeminiClient`, `translateSegment`, `translateBacklog` (Task 3), `DeepgramCallbacks`, `DeepgramConnection`, `DeepgramConnectionFactory` (Task 4).
- Produces: `attachWsServer(deps: WsServerDeps): void` where `WsServerDeps { httpServer: http.Server; session: Session; geminiClient: GeminiClient; deepgramApiKey: string; createDeepgramConnection: DeepgramConnectionFactory }`. Used by `index.ts` (Task 7).

Wire protocol:
- Capture socket (`/ws/capture`), client→server JSON: `{ type: 'start' }`, `{ type: 'stop' }`; binary frames are raw audio. Server→client JSON: `{ type: 'status', status: 'recording' | 'idle' | 'error' }`, `{ type: 'transcript', english: string }`.
- Viewer socket (`/ws/viewer`), client→server JSON: `{ type: 'subscribe', language: string }` (also used to switch languages). Server→client JSON: `{ type: 'backlog', lines: { english: string; translated: string }[] }`, `{ type: 'caption', english: string; translated: string }`.

- [ ] **Step 1: Write the failing integration test**

`server/tests/wsServer.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachWsServer } from '../src/wsServer';
import { Session } from '../src/session';
import type { GeminiClient } from '../src/gemini';
import type { DeepgramCallbacks } from '../src/deepgram';

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once('open', () => resolve()));
}

describe('wsServer', () => {
  let httpServer: Server;
  let port: number;
  let session: Session;
  let capturedCallbacks: DeepgramCallbacks | null;
  let geminiClient: GeminiClient;

  beforeEach(async () => {
    session = new Session();
    capturedCallbacks = null;
    httpServer = createServer();

    geminiClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({ text: '{"zh":"你好"}' }),
      },
    };

    attachWsServer({
      httpServer,
      session,
      geminiClient,
      deepgramApiKey: 'fake-key',
      createDeepgramConnection: (_apiKey, callbacks) => {
        capturedCallbacks = callbacks;
        return { send: vi.fn(), finish: vi.fn() };
      },
    });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(() => {
    httpServer.close();
  });

  it('broadcasts a translated caption to a subscribed viewer', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    await waitForMessage(viewerSocket); // backlog: []

    const captionPromise = waitForMessage(viewerSocket);
    capturedCallbacks!.onFinalSegment('Hello everyone');
    const caption = await captionPromise;

    expect(caption).toEqual({ type: 'caption', english: 'Hello everyone', translated: '你好' });

    captureSocket.close();
    viewerSocket.close();
  });

  it('sends translated backlog to a viewer joining after segments already arrived', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    session.buffer.append('Earlier line', Date.now());
    (geminiClient.models.generateContent as any).mockResolvedValueOnce({
      text: '{"translations":["较早的一行"]}',
    });

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    const backlogMessage = await waitForMessage(viewerSocket);

    expect(backlogMessage).toEqual({
      type: 'backlog',
      lines: [{ english: 'Earlier line', translated: '较早的一行' }],
    });

    captureSocket.close();
    viewerSocket.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: FAIL — `Cannot find module '../src/wsServer'`

- [ ] **Step 3: Implement `attachWsServer`**

`server/src/wsServer.ts`:
```typescript
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from './session.js';
import { translateSegment, translateBacklog, type GeminiClient } from './gemini.js';
import type { DeepgramConnection, DeepgramConnectionFactory } from './deepgram.js';

export interface WsServerDeps {
  httpServer: HttpServer;
  session: Session;
  geminiClient: GeminiClient;
  deepgramApiKey: string;
  createDeepgramConnection: DeepgramConnectionFactory;
}

export function attachWsServer(deps: WsServerDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  deps.httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '', 'http://localhost');
    if (pathname === '/ws/capture' || pathname === '/ws/viewer') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, pathname);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, _request, pathname: string) => {
    if (pathname === '/ws/capture') {
      handleCaptureConnection(ws, deps);
    } else {
      handleViewerConnection(ws, deps);
    }
  });
}

function handleCaptureConnection(ws: WebSocket, deps: WsServerDeps): void {
  let deepgramConnection: DeepgramConnection | null = null;

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const message = JSON.parse(data.toString());
      if (message.type === 'start') {
        deps.session.start();
        deepgramConnection = deps.createDeepgramConnection(deps.deepgramApiKey, {
          onFinalSegment: (text) => {
            void handleFinalSegment(text, deps, ws);
          },
          onError: () => {
            ws.send(JSON.stringify({ type: 'status', status: 'error' }));
          },
          onClose: () => {},
        });
        ws.send(JSON.stringify({ type: 'status', status: 'recording' }));
      } else if (message.type === 'stop') {
        deps.session.stop();
        deepgramConnection?.finish();
        deepgramConnection = null;
        ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
      }
    } else if (deepgramConnection) {
      deepgramConnection.send(data as Buffer);
    }
  });

  ws.on('close', () => {
    deps.session.stop();
    deepgramConnection?.finish();
  });
}

async function handleFinalSegment(
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket
): Promise<void> {
  const line = deps.session.buffer.append(english);
  captureSocket.send(JSON.stringify({ type: 'transcript', english }));

  const activeLanguages = deps.session.getActiveLanguages();
  if (activeLanguages.length === 0) return;

  let translations: Record<string, string>;
  try {
    translations = await translateSegment(deps.geminiClient, english, activeLanguages);
  } catch {
    try {
      translations = await translateSegment(deps.geminiClient, english, activeLanguages);
    } catch (secondError) {
      console.error('Translation failed after retry, skipping segment:', secondError);
      return;
    }
  }

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;
    const payload = JSON.stringify({ type: 'caption', english: line.english, translated });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}

function handleViewerConnection(ws: WebSocket, deps: WsServerDeps): void {
  ws.on('message', (data) => {
    void (async () => {
      const message = JSON.parse(data.toString());
      if (message.type === 'subscribe') {
        const language = message.language as string;
        deps.session.addViewer(ws, language);

        const backlog = deps.session.buffer.getRecent();
        if (backlog.length === 0) {
          ws.send(JSON.stringify({ type: 'backlog', lines: [] }));
          return;
        }

        const translations = await translateBacklog(
          deps.geminiClient,
          backlog.map((line) => line.english),
          language
        );
        const lines = backlog.map((line, index) => ({
          english: line.english,
          translated: translations[index] ?? '',
        }));
        ws.send(JSON.stringify({ type: 'backlog', lines }));
      }
    })();
  });

  ws.on('close', () => deps.session.removeViewer(ws));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "feat(server): wire capture/viewer WebSocket protocols with translation fan-out"
```

---

### Task 7: Server entrypoint wiring

**Files:**
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `createApp` (Task 1), `attachWsServer`/`WsServerDeps` (Task 6), `Session` (Task 5), `createGeminiClient` (Task 3), `createDeepgramConnection` (Task 4).
- Produces: a runnable server process. No further tasks consume this directly (it's the entrypoint).

- [ ] **Step 1: Wire the real entrypoint**

`server/src/index.ts`:
```typescript
import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachWsServer } from './wsServer.js';
import { Session } from './session.js';
import { createGeminiClient } from './gemini.js';
import { createDeepgramConnection } from './deepgram.js';

const requiredEnvVars = ['DEEPGRAM_API_KEY', 'GEMINI_API_KEY'] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const app = createApp();
const httpServer = createServer(app);
const session = new Session();
const geminiClient = createGeminiClient(process.env.GEMINI_API_KEY!);

attachWsServer({
  httpServer,
  session,
  geminiClient,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
  createDeepgramConnection,
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

- [ ] **Step 2: Run the full backend test suite to confirm nothing broke**

Run: `cd server && npx vitest run`
Expected: PASS (all tests across app/transcriptBuffer/gemini/deepgram/session/wsServer)

- [ ] **Step 3: Manually verify the server boots and accepts connections**

Create `server/.env` with real `DEEPGRAM_API_KEY` and `GEMINI_API_KEY` values (copy `.env.example` and fill in; `.env` must stay out of git — see Step 4).

Run: `cd server && npm run dev`
Expected output: `Server listening on port 3001`

In a second terminal:
Run: `curl http://localhost:3001/health`
Expected: `{"status":"ok"}`

Run (requires `npm install -g wscat` or `npx wscat`): `npx wscat -c ws://localhost:3001/ws/capture`
Then type: `{"type":"start"}`
Expected: server replies `{"type":"status","status":"recording"}` (or `"error"` if the Deepgram key is invalid — either way, the process must not crash).

- [ ] **Step 4: Ensure `.env` is git-ignored, then commit**

Create `server/.gitignore`:
```
node_modules/
dist/
.env
```

```bash
git add server/src/index.ts server/.gitignore
git commit -m "feat(server): wire real entrypoint with Deepgram/Gemini clients"
```

---

## Frontend Tasks

### Task 8: Scaffold Next.js app with Tailwind + shadcn/ui

**Files:**
- Create: `web/` (via `create-next-app`)
- Create: `web/app/layout.tsx` (modified after scaffold)
- Create: `web/.env.example`

**Interfaces:**
- Produces: a running Next.js dev server with shadcn/ui's `button` and `card` components installed under `web/components/ui/`, and a root layout that forces dark mode. Used by all later frontend tasks.

- [ ] **Step 1: Scaffold the Next.js app**

Run (from the repo root):
```bash
npx create-next-app@latest web --typescript --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-npm
```
Expected: a `web/` directory is created with a working Next.js app.

- [ ] **Step 2: Initialize shadcn/ui and add the components this project needs**

Run:
```bash
cd web
npx shadcn@latest init -d
npx shadcn@latest add button card
```
Expected: `web/components/ui/button.tsx` and `web/components/ui/card.tsx` exist; `web/components.json` is created.

- [ ] **Step 3: Force dark mode in the root layout**

`web/app/layout.tsx` (edit the generated file so the `<html>` tag carries `className="dark"`):
```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Auto Translate Lite',
  description: 'Live sermon translation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
```

`web/.env.example`:
```
NEXT_PUBLIC_WS_URL=ws://localhost:3001
```

- [ ] **Step 4: Manually verify the scaffold**

Run: `cd web && npm run dev`
Expected output includes: `Ready` and a local URL (typically `http://localhost:3000`).

Open `http://localhost:3000` in a browser.
Expected: the default Next.js starter page renders with a dark background (confirming the `dark` class and shadcn's dark theme tokens are active).

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat(web): scaffold Next.js app with Tailwind and shadcn/ui, force dark theme"
```

---

### Task 9: Landing / language-select page

**Files:**
- Create: `web/lib/languages.ts`
- Create: `web/app/page.tsx`

**Interfaces:**
- Consumes: shadcn `Card`/`CardContent` from `web/components/ui/card.tsx` (Task 8).
- Produces: `TARGET_LANGUAGES: Language[]` (must stay identical to `server/src/languages.ts` from Task 3). The landing page writes the chosen language code to `localStorage` under the key `auto-translate-lite:language` and navigates to `/view?lang=<code>` — this storage key and URL shape are consumed by the viewer page (Task 10).

- [ ] **Step 1: Add the shared language list**

`web/lib/languages.ts`:
```typescript
export interface Language {
  code: string;
  label: string;
}

export const TARGET_LANGUAGES: Language[] = [
  { code: 'zh', label: '中文 (Mandarin)' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'ko', label: '한국어 (Korean)' },
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'vi', label: 'Tiếng Việt (Vietnamese)' },
  { code: 'th', label: 'ภาษาไทย (Thai)' },
  { code: 'es', label: 'Español (Spanish)' },
  { code: 'pt', label: 'Português (Portuguese)' },
  { code: 'fr', label: 'Français (French)' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'my', label: 'မြန်မာ (Burmese)' },
];
```

- [ ] **Step 2: Build the landing page**

`web/app/page.tsx`:
```tsx
'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TARGET_LANGUAGES } from '@/lib/languages';
import { Card, CardContent } from '@/components/ui/card';

const STORAGE_KEY = 'auto-translate-lite:language';

function LandingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (searchParams.get('reset') === '1') {
      window.localStorage.removeItem(STORAGE_KEY);
      setReady(true);
      return;
    }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) {
      router.replace(`/view?lang=${saved}`);
    } else {
      setReady(true);
    }
  }, [router, searchParams]);

  function selectLanguage(code: string) {
    window.localStorage.setItem(STORAGE_KEY, code);
    router.push(`/view?lang=${code}`);
  }

  if (!ready) return null;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold text-center">Choose your language</h1>
      <div className="grid grid-cols-2 gap-4 w-full max-w-md">
        {TARGET_LANGUAGES.map((language) => (
          <Card
            key={language.code}
            className="cursor-pointer hover:bg-accent transition-colors"
            onClick={() => selectLanguage(language.code)}
          >
            <CardContent className="p-4 text-center text-lg">{language.label}</CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}

export default function LandingPage() {
  return (
    <Suspense fallback={null}>
      <LandingPageContent />
    </Suspense>
  );
}
```

- [ ] **Step 3: Manually verify**

Run: `cd web && npm run dev`
Open `http://localhost:3000`.
Expected: a grid of 12 language cards on a dark background.

Click any language card.
Expected: browser navigates to `http://localhost:3000/view?lang=<code>` (a 404/blank page is fine here — the viewer page doesn't exist until Task 10). Open devtools → Application → Local Storage and confirm `auto-translate-lite:language` is set to the clicked code.

Reload `http://localhost:3000` directly.
Expected: immediately redirects to `/view?lang=<code>` without showing the picker (since a language is already saved).

Navigate to `http://localhost:3000/?reset=1`.
Expected: the picker grid shows again, and Local Storage no longer has the key.

- [ ] **Step 4: Commit**

```bash
git add web/lib/languages.ts web/app/page.tsx
git commit -m "feat(web): add landing/language-select page"
```

---

### Task 10: Viewer WebSocket hook + caption page

**Files:**
- Create: `web/lib/useViewerSocket.ts`
- Create: `web/app/view/page.tsx`

**Interfaces:**
- Consumes: `/ws/viewer` protocol from Task 6 (`{type:'subscribe',language}` → `{type:'backlog',lines}` / `{type:'caption',english,translated}`), `NEXT_PUBLIC_WS_URL` env var (Task 8), the `?lang=` query param and `auto-translate-lite:language` storage key set by Task 9's landing page.
- Produces: `useViewerSocket(language: string, wsUrl: string): { status: ViewerStatus; lines: CaptionLine[] }` where `ViewerStatus = 'connecting' | 'reconnecting' | 'live'` and `CaptionLine { english: string; translated: string }`.

- [ ] **Step 1: Build the WebSocket client hook**

`web/lib/useViewerSocket.ts`:
```typescript
'use client';

import { useEffect, useRef, useState } from 'react';

export interface CaptionLine {
  english: string;
  translated: string;
}

export type ViewerStatus = 'connecting' | 'reconnecting' | 'live';

export function useViewerSocket(language: string, wsUrl: string) {
  const [status, setStatus] = useState<ViewerStatus>('connecting');
  const [lines, setLines] = useState<CaptionLine[]>([]);

  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let socket: WebSocket;

    function connect() {
      socket = new WebSocket(wsUrl);
      setStatus('connecting');

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'subscribe', language }));
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'backlog') {
          setLines(message.lines);
          setStatus('live');
        } else if (message.type === 'caption') {
          setLines((previous) => [
            ...previous,
            { english: message.english, translated: message.translated },
          ]);
          setStatus('live');
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setStatus('reconnecting');
        reconnectTimeout = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimeout);
      socket?.close();
    };
  }, [language, wsUrl]);

  return { status, lines };
}
```

- [ ] **Step 2: Build the viewer caption page**

`web/app/view/page.tsx`:
```tsx
'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useViewerSocket } from '@/lib/useViewerSocket';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';

function ViewerPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const language = searchParams.get('lang') ?? '';
  const { status, lines } = useViewerSocket(language, `${WS_URL}/ws/viewer`);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  useEffect(() => {
    if (!language) {
      router.replace('/');
    }
  }, [language, router]);

  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines]);

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom < 80;
    autoScrollRef.current = atBottom;
    setShowJumpButton(!atBottom);
  }

  function jumpToLatest() {
    autoScrollRef.current = true;
    setShowJumpButton(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  if (!language) return null;

  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="p-3 text-sm text-muted-foreground flex justify-between items-center border-b">
        <span>
          {status === 'connecting' && 'Connecting…'}
          {status === 'reconnecting' && 'Reconnecting…'}
          {status === 'live' && lines.length === 0 && 'Waiting for the service to start…'}
          {status === 'live' && lines.length > 0 && 'Live'}
        </span>
        <a href="/?reset=1" className="underline">
          Change language
        </a>
      </div>
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4">
        {lines.map((line, index) => (
          <div key={index}>
            <p className="text-sm text-muted-foreground">{line.english}</p>
            <p className="text-xl">{line.translated}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {showJumpButton && (
        <button
          onClick={jumpToLatest}
          className="fixed bottom-6 right-6 bg-primary text-primary-foreground rounded-full px-4 py-2 shadow-lg"
        >
          Jump to latest ↓
        </button>
      )}
    </main>
  );
}

export default function ViewerPage() {
  return (
    <Suspense fallback={null}>
      <ViewerPageContent />
    </Suspense>
  );
}
```

- [ ] **Step 3: Manually verify against the running backend**

Run the backend: `cd server && npm run dev` (Task 7 must be complete, with valid API keys in `server/.env`).
Run the frontend: `cd web && npm run dev`.

Open `http://localhost:3000/view?lang=zh` directly.
Expected: status line reads "Connecting…" then "Waiting for the service to start…" (backend has no active session yet), and the WebSocket connection appears as status `101` in the browser devtools Network tab, filtered to "WS".

Click "Change language".
Expected: navigates to `/?reset=1` and shows the language picker again.

- [ ] **Step 4: Commit**

```bash
git add web/lib/useViewerSocket.ts web/app/view/page.tsx
git commit -m "feat(web): add viewer WebSocket hook and caption page"
```

---

### Task 11: Capture page (volunteer-facing)

**Files:**
- Create: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: `/ws/capture` protocol from Task 6 (`{type:'start'}` / `{type:'stop'}` / binary audio → `{type:'status',status}` / `{type:'transcript',english}`), `NEXT_PUBLIC_WS_URL` env var (Task 8).
- Produces: a page at `/capture` with no further consumers within this plan.

- [ ] **Step 1: Build the capture page**

`web/app/capture/page.tsx`:
```tsx
'use client';

import { useRef, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';

type CaptureStatus = 'idle' | 'recording' | 'reconnecting' | 'error';

export default function CapturePage() {
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [transcriptLines, setTranscriptLines] = useState<string[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const manuallyStoppedRef = useRef(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  async function ensureRecorderStreaming(socket: WebSocket) {
    if (!streamRef.current) {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const recorder = new MediaRecorder(streamRef.current, { mimeType: 'audio/webm;codecs=opus' });
    recorderRef.current = recorder;

    recorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(await event.data.arrayBuffer());
      }
    };

    recorder.start(250);
  }

  function connectSocket() {
    const socket = new WebSocket(`${WS_URL}/ws/capture`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'status') {
        setStatus(message.status);
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => [...previous.slice(-49), message.english]);
      }
    };

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'start' }));
      void ensureRecorderStreaming(socket);
    };

    socket.onclose = () => {
      if (manuallyStoppedRef.current) {
        setStatus('idle');
        return;
      }
      setStatus('reconnecting');
      reconnectTimeoutRef.current = setTimeout(connectSocket, 2000);
    };
  }

  function start() {
    manuallyStoppedRef.current = false;
    connectSocket();
  }

  function stop() {
    manuallyStoppedRef.current = true;
    clearTimeout(reconnectTimeoutRef.current);
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    socketRef.current?.send(JSON.stringify({ type: 'stop' }));
    socketRef.current?.close();
  }

  return (
    <main className="min-h-screen flex flex-col items-center gap-6 p-6">
      <h1 className="text-xl font-semibold">Sermon Capture</h1>
      <div className="flex gap-4">
        <button
          onClick={start}
          disabled={status === 'recording' || status === 'reconnecting'}
          className="bg-primary text-primary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          Start
        </button>
        <button
          onClick={stop}
          disabled={status === 'idle'}
          className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          Stop
        </button>
      </div>
      <p className="text-sm text-muted-foreground">Status: {status}</p>
      <div className="w-full max-w-xl h-64 overflow-y-auto border rounded p-3 text-sm space-y-1">
        {transcriptLines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
    </main>
  );
}
```

Unexpected socket closure (server restart, network blip) triggers automatic reconnect after 2 seconds, matching the spec's "capture page auto-reconnects and re-establishes the Deepgram stream" requirement — the mic stream is reused (not re-requested) so no repeat permission prompt.

- [ ] **Step 2: Manually verify against the running backend**

With `server` (Task 7) and `web` running, open `http://localhost:3000/capture`.
Click **Start**, grant microphone permission when prompted.
Expected: status changes to "recording"; speaking into the mic causes lines to appear in the rolling transcript box within a few seconds (requires a valid `DEEPGRAM_API_KEY`).

Click **Stop**.
Expected: status returns to "idle"; the microphone indicator in the browser tab turns off.

- [ ] **Step 3: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "feat(web): add volunteer-facing capture page"
```

---

### Task 12: Full end-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Run both apps locally with real API keys**

Run: `cd server && npm run dev`
Run (separate terminal): `cd web && npm run dev`

- [ ] **Step 2: Verify the golden path**

Open `http://localhost:3000/capture` in one browser tab, click Start.
Open `http://localhost:3000/view?lang=zh` (or any other target language) in a second tab.
Speak a few sentences into the mic.
Expected: within ~5 seconds of each sentence, a caption block appears in the viewer tab showing the grey English line above the full-size Mandarin translation beneath it.

- [ ] **Step 3: Verify mid-stream join gets scrollback**

While still speaking, open a third tab at `http://localhost:3000/view?lang=ko`.
Expected: the tab immediately shows a translated Korean backlog of everything spoken so far, then continues with new live lines.

- [ ] **Step 4: Verify reconnect behavior**

In the viewer tab, open devtools → Network → toggle "Offline", wait a couple seconds, then toggle back online.
Expected: status briefly shows "Reconnecting…", then resumes receiving live captions without a page reload.

Repeat the same offline/online toggle in the capture tab.
Expected: status briefly shows "reconnecting", the mic permission prompt does not reappear (the existing stream is reused), and it returns to "recording" once back online.

- [ ] **Step 5: Verify stop/restart**

Click **Stop** on the capture page, then **Start** again.
Expected: no server crash; the transcript buffer/session resets cleanly (viewer tabs still connected keep working once new segments arrive).

- [ ] **Step 6: Record the verification**

```bash
git commit --allow-empty -m "chore: verified end-to-end golden path, mid-stream join, reconnect, and restart manually"
```

---

## Deployment Task

### Task 13: VPS deployment guide + README

**Files:**
- Create: `docs/DEPLOY.md`
- Create: `README.md`
- Create: `ecosystem.config.js`

**Interfaces:** none (operational runbook, not consumed by code).

- [ ] **Step 1: Write the deployment runbook**

`docs/DEPLOY.md`:
```markdown
# Deploying Auto Translate Lite

## 1. Provision a VPS
- Spin up a small Ubuntu 22.04 droplet/instance (1 vCPU / 1-2GB RAM is enough for ~50 viewers).
- Point a domain's A record at the VPS's public IP (e.g. `translate.yourchurch.org`).

## 2. Install Node.js and pm2
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

## 3. Clone the repo and install dependencies
```bash
git clone <your-repo-url> auto-translate-lite
cd auto-translate-lite/server && npm install && npm run build
cd ../web && npm install && npm run build
```

## 4. Configure environment variables
- `server/.env`: `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `PORT=3001`.
- `web/.env.production`: `NEXT_PUBLIC_WS_URL=wss://translate.yourchurch.org`.

## 5. Install and configure Caddy as a reverse proxy (automatic HTTPS)
```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:
```
translate.yourchurch.org {
  reverse_proxy /ws/* localhost:3001
  reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

## 6. Start both apps with pm2

`ecosystem.config.js` (at repo root — see below).

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 7. Verify

```bash
curl http://localhost:3001/health
```
Expected: `{"status":"ok"}`

Open `https://translate.yourchurch.org` on a phone.
Expected: the language picker loads over HTTPS; devtools Network tab shows a `101 Switching Protocols` response when a language is selected (WSS upgrade succeeded).

## 8. Generate the QR code for the LED wall
Point any QR code generator (e.g. `qrencode "https://translate.yourchurch.org" -o qr.png`, or an online generator) at `https://translate.yourchurch.org` and display the result on the LED wall.
```

- [ ] **Step 2: Write the pm2 process file**

`ecosystem.config.js`:
```javascript
module.exports = {
  apps: [
    {
      name: 'auto-translate-server',
      cwd: './server',
      script: 'dist/index.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'auto-translate-web',
      cwd: './web',
      script: 'node_modules/.bin/next',
      args: 'start',
      env: { NODE_ENV: 'production' },
    },
  ],
};
```

- [ ] **Step 3: Write the root README**

`README.md`:
```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOY.md README.md ecosystem.config.js
git commit -m "docs: add VPS deployment guide, pm2 process file, and root README"
```
