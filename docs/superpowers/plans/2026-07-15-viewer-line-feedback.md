# Viewer Per-Line Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let viewers on `/view` flag an individual caption line with an optional comment, and let the capture-page operator skim and download that feedback as CSV — separate from the existing operator "feedback notes" mechanism.

**Architecture:** A new file-backed `ViewerFeedbackStore` (JSON on disk, same pattern as `costTracker.ts`) holds flagged-line submissions. Two new Express routes create/list items; two more return CSV and mark items downloaded. The `/view` page gains a per-line flag button + inline comment form, with UI strings localized via a static per-language table. The capture page gains a "Viewer Feedback" list with per-item and bulk download buttons.

**Tech Stack:** Express + TypeScript (server), Next.js client components + TypeScript (web), Vitest + Supertest (server tests only — this repo has no web test framework; web changes are verified via the browser preview tools).

## Global Constraints

- Full design reference: [docs/superpowers/specs/2026-07-15-viewer-line-feedback-design.md](../specs/2026-07-15-viewer-line-feedback-design.md).
- Server code uses ESM with explicit `.js` extensions in relative imports (e.g. `from './session.js'`) — this project compiles TS to ESM output; every new/modified server source file must follow this.
- New server persisted files follow the existing `feedbackStore.ts`/`costTracker.ts` convention: file path from an env var with a `data/...` default, missing-file-means-empty-state, warn-and-continue on read/write failure (never throw into the request path), via `logEvent` from `server/src/logger.ts`.
- No new dependencies — hand-roll CSV encoding and blob-download client logic rather than adding libraries (this repo currently has zero CSV/download dependencies in either `server/package.json` or `web/package.json`).
- Web components in this repo are monolithic single-file pages (`capture/page.tsx`, `view/page.tsx`) with inline helper functions rather than extracted subcomponents — new UI follows that existing convention, not a new component-splitting pattern.
- `web/AGENTS.md` warns this Next.js version has breaking changes from training-data assumptions — already checked: this plan only adds client-side state/fetch/JSX to existing `'use client'` pages, touching no routing, layout, metadata, or server-side Next APIs, so no further doc reading is needed before implementing.

---

## Task 1: CSV encoding helper

**Files:**
- Create: `server/src/csv.ts`
- Test: `server/tests/csv.test.ts`

**Interfaces:**
- Produces: `toCsv(header: string[], rows: string[][]): string` — used by Task 4's download routes.

- [ ] **Step 1: Write the failing test**

Create `server/tests/csv.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toCsv } from '../src/csv';

describe('toCsv', () => {
  it('joins a header and rows with CRLF, ending in a trailing CRLF', () => {
    const result = toCsv(['A', 'B'], [['1', '2'], ['3', '4']]);
    expect(result).toBe('A,B\r\n1,2\r\n3,4\r\n');
  });

  it('returns just the header line when there are no rows', () => {
    const result = toCsv(['A', 'B'], []);
    expect(result).toBe('A,B\r\n');
  });

  it('wraps a field containing a comma in double quotes', () => {
    const result = toCsv(['A'], [['hello, world']]);
    expect(result).toBe('A\r\n"hello, world"\r\n');
  });

  it('wraps a field containing a double quote and doubles the internal quote', () => {
    const result = toCsv(['A'], [['she said "hi"']]);
    expect(result).toBe('A\r\n"she said ""hi"""\r\n');
  });

  it('wraps a field containing a newline in double quotes', () => {
    const result = toCsv(['A'], [['line one\nline two']]);
    expect(result).toBe('A\r\n"line one\nline two"\r\n');
  });

  it('leaves plain fields unquoted', () => {
    const result = toCsv(['A'], [['plain text']]);
    expect(result).toBe('A\r\nplain text\r\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/csv.test.ts`
Expected: FAIL with "Cannot find module '../src/csv'" (or similar — the module doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `server/src/csv.ts`:

```ts
function toCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(header: string[], rows: string[][]): string {
  const lines = [header, ...rows].map((row) => row.map(toCsvField).join(','));
  return lines.join('\r\n') + '\r\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/csv.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/csv.ts server/tests/csv.test.ts
git commit -m "feat: add CSV encoding helper for viewer feedback export"
```

---

## Task 2: ViewerFeedbackStore

**Files:**
- Create: `server/src/viewerFeedbackStore.ts`
- Test: `server/tests/viewerFeedbackStore.test.ts`

**Interfaces:**
- Consumes: `logEvent(level: 'warn' | 'error', payload: Record<string, unknown>): Promise<void>` from `server/src/logger.ts` (already exists).
- Produces:
  ```ts
  interface ViewerFeedbackItem {
    id: string;
    sessionId: string;
    timestamp: string;
    language: string;
    lineIndex: number;
    english: string;
    translated: string;
    comment: string;
    downloaded: boolean;
  }

  interface ViewerFeedbackStore {
    add(entry: {
      sessionId: string;
      language: string;
      lineIndex: number;
      english: string;
      translated: string;
      comment: string;
    }): ViewerFeedbackItem;
    list(): ViewerFeedbackItem[];
    get(id: string): ViewerFeedbackItem | undefined;
    getUndownloaded(): ViewerFeedbackItem[];
    markDownloaded(ids: string[]): void;
  }

  function createViewerFeedbackStore(filePath: string): ViewerFeedbackStore
  ```
  Used by Task 3 (`app.ts`, `index.ts`) and Task 4 (download routes).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/viewerFeedbackStore.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewerFeedbackStore } from '../src/viewerFeedbackStore';

describe('createViewerFeedbackStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('starts with an empty list when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const store = createViewerFeedbackStore(join(tempDir, 'viewer-feedback.json'));
    expect(store.list()).toEqual([]);
  });

  it('add() assigns an id, timestamp, and downloaded:false, and persists to disk', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const filePath = join(tempDir, 'nested', 'viewer-feedback.json');
    const store = createViewerFeedbackStore(filePath);

    const item = store.add({
      sessionId: 'session-1',
      language: 'es',
      lineIndex: 3,
      english: 'In the beginning',
      translated: 'En el principio',
      comment: 'sounds robotic',
    });

    expect(item.id).toBeTruthy();
    expect(item.timestamp).toBeTruthy();
    expect(item.downloaded).toBe(false);
    expect(item.sessionId).toBe('session-1');

    const raw = await readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(item.id);
  });

  it('list() returns items newest first', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const store = createViewerFeedbackStore(join(tempDir, 'viewer-feedback.json'));

    const first = store.add({ sessionId: 's', language: 'fr', lineIndex: 0, english: 'A', translated: 'a', comment: '' });
    const second = store.add({ sessionId: 's', language: 'fr', lineIndex: 1, english: 'B', translated: 'b', comment: '' });

    expect(store.list().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('get() finds an item by id, and returns undefined for an unknown id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const store = createViewerFeedbackStore(join(tempDir, 'viewer-feedback.json'));
    const item = store.add({ sessionId: 's', language: 'ja', lineIndex: 0, english: 'A', translated: 'あ', comment: '' });

    expect(store.get(item.id)?.id).toBe(item.id);
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('getUndownloaded() excludes items already marked downloaded', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const store = createViewerFeedbackStore(join(tempDir, 'viewer-feedback.json'));
    const first = store.add({ sessionId: 's', language: 'ko', lineIndex: 0, english: 'A', translated: '가', comment: '' });
    const second = store.add({ sessionId: 's', language: 'ko', lineIndex: 1, english: 'B', translated: '나', comment: '' });

    store.markDownloaded([first.id]);

    expect(store.getUndownloaded().map((item) => item.id)).toEqual([second.id]);
  });

  it('markDownloaded() flips downloaded to true for the given ids and persists it', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const filePath = join(tempDir, 'viewer-feedback.json');
    const store = createViewerFeedbackStore(filePath);
    const item = store.add({ sessionId: 's', language: 'th', lineIndex: 0, english: 'A', translated: 'ก', comment: '' });

    store.markDownloaded([item.id]);

    expect(store.get(item.id)?.downloaded).toBe(true);
    const raw = await readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted[0].downloaded).toBe(true);
  });

  it('reloads persisted items from disk when constructed again with the same path', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const filePath = join(tempDir, 'viewer-feedback.json');
    const first = createViewerFeedbackStore(filePath);
    first.add({ sessionId: 's', language: 'vi', lineIndex: 0, english: 'A', translated: 'a', comment: '' });

    const second = createViewerFeedbackStore(filePath);
    expect(second.list()).toHaveLength(1);
  });

  it('treats an unreadable/corrupt file as an empty list rather than throwing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const filePath = join(tempDir, 'viewer-feedback.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'not valid json', 'utf-8');

    const store = createViewerFeedbackStore(filePath);
    expect(store.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/viewerFeedbackStore.test.ts`
Expected: FAIL with "Cannot find module '../src/viewerFeedbackStore'"

- [ ] **Step 3: Write minimal implementation**

Create `server/src/viewerFeedbackStore.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logEvent } from './logger.js';

export interface ViewerFeedbackItem {
  id: string;
  sessionId: string;
  timestamp: string;
  language: string;
  lineIndex: number;
  english: string;
  translated: string;
  comment: string;
  downloaded: boolean;
}

export interface ViewerFeedbackStore {
  add(entry: {
    sessionId: string;
    language: string;
    lineIndex: number;
    english: string;
    translated: string;
    comment: string;
  }): ViewerFeedbackItem;
  list(): ViewerFeedbackItem[];
  get(id: string): ViewerFeedbackItem | undefined;
  getUndownloaded(): ViewerFeedbackItem[];
  markDownloaded(ids: string[]): void;
}

function loadItems(filePath: string): ViewerFeedbackItem[] {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      void logEvent('warn', {
        event: 'viewer_feedback_file_load_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}

export function createViewerFeedbackStore(filePath: string): ViewerFeedbackStore {
  let items: ViewerFeedbackItem[] = loadItems(filePath);

  function persist(): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(items), 'utf-8');
    } catch (error) {
      void logEvent('warn', {
        event: 'viewer_feedback_file_write_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    add(entry): ViewerFeedbackItem {
      const item: ViewerFeedbackItem = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        downloaded: false,
        ...entry,
      };
      items = [item, ...items];
      persist();
      return item;
    },
    list(): ViewerFeedbackItem[] {
      return items;
    },
    get(id: string): ViewerFeedbackItem | undefined {
      return items.find((item) => item.id === id);
    },
    getUndownloaded(): ViewerFeedbackItem[] {
      return items.filter((item) => !item.downloaded);
    },
    markDownloaded(ids: string[]): void {
      const idSet = new Set(ids);
      items = items.map((item) => (idSet.has(item.id) ? { ...item, downloaded: true } : item));
      persist();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/viewerFeedbackStore.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/viewerFeedbackStore.ts server/tests/viewerFeedbackStore.test.ts
git commit -m "feat: add ViewerFeedbackStore for persisted per-line viewer feedback"
```

---

## Task 3: `POST`/`GET /viewer-feedback` endpoints

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Test: `server/tests/app.test.ts`

**Interfaces:**
- Consumes: `createViewerFeedbackStore` and `ViewerFeedbackStore` from Task 2; `Session` class from `server/src/session.ts` (already exists — has a public `id: string` field, no required constructor args).
- Produces: `AppDeps` gains `viewerFeedbackStore: ViewerFeedbackStore` and `session: Session`, consumed by Task 4's routes and by `index.ts`'s existing `createApp(...)` call.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/app.test.ts` — first update the imports and `testDeps()` helper near the top of the file:

```ts
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { createSermonDocStore } from '../src/sermonDocStore';
import { createFeedbackStore } from '../src/feedbackStore';
import { createViewerFeedbackStore } from '../src/viewerFeedbackStore';
import { Session } from '../src/session';

vi.mock('../src/docExtraction', () => ({
  extractDocumentText: vi.fn().mockResolvedValue('Extracted sermon text'),
}));

import { extractDocumentText } from '../src/docExtraction';

function testDeps() {
  return {
    sermonDocStore: createSermonDocStore(),
    feedbackStore: createFeedbackStore(join(tmpdir(), `feedback-app-test-${Date.now()}-${Math.random()}.txt`)),
    viewerFeedbackStore: createViewerFeedbackStore(
      join(tmpdir(), `viewer-feedback-app-test-${Date.now()}-${Math.random()}.json`)
    ),
    session: new Session(),
  };
}
```

(Leave the rest of the existing file — `GET /health`, `POST /sermon-doc`, `GET/PUT /feedback` describe blocks — unchanged.)

Then append these new `describe` blocks at the end of the file:

```ts
describe('POST /viewer-feedback', () => {
  it('returns 400 when a required field is missing', async () => {
    const response = await request(createApp(testDeps()))
      .post('/viewer-feedback')
      .send({ language: 'es', english: 'Hi', translated: 'Hola' }); // missing lineIndex
    expect(response.status).toBe(400);
  });

  it('creates an item tagged with the current session id, defaulting comment to an empty string', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const response = await request(app).post('/viewer-feedback').send({
      language: 'es',
      lineIndex: 2,
      english: 'In the beginning',
      translated: 'En el principio',
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    const items = deps.viewerFeedbackStore.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sessionId: deps.session.id,
      language: 'es',
      lineIndex: 2,
      english: 'In the beginning',
      translated: 'En el principio',
      comment: '',
      downloaded: false,
    });
  });

  it('stores a provided comment', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({
      language: 'fr',
      lineIndex: 0,
      english: 'Hello',
      translated: 'Bonjour',
      comment: 'sounds off',
    });
    expect(deps.viewerFeedbackStore.list()[0].comment).toBe('sounds off');
  });
});

describe('GET /viewer-feedback', () => {
  it('returns an empty list when nothing has been submitted yet', async () => {
    const response = await request(createApp(testDeps())).get('/viewer-feedback');
    expect(response.body).toEqual({ items: [] });
  });

  it('returns submitted items newest first', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 0, english: 'A', translated: 'あ' });
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 1, english: 'B', translated: 'い' });

    const response = await request(app).get('/viewer-feedback');
    expect(response.body.items.map((item: { english: string }) => item.english)).toEqual(['B', 'A']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: FAIL — `testDeps()` doesn't satisfy `AppDeps` (TypeScript error) and the new routes don't exist yet (404s).

- [ ] **Step 3: Write minimal implementation**

Modify `server/src/app.ts`:

```ts
import express, { type Express } from 'express';
import cors from 'cors';
import multer from 'multer';
import { extractDocumentText } from './docExtraction.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { ViewerFeedbackStore } from './viewerFeedbackStore.js';
import type { Session } from './session.js';

export interface AppDeps {
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
  viewerFeedbackStore: ViewerFeedbackStore;
  session: Session;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/sermon-doc', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const text = await extractDocumentText(req.file.buffer, req.file.mimetype);
      if (text.length === 0) {
        res.status(400).json({ error: 'Could not extract any text from this document' });
        return;
      }
      deps.sermonDocStore.set(text);
      res.json({ ok: true, characterCount: text.length });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to process document' });
    }
  });

  app.get('/feedback', async (_req, res) => {
    const text = await deps.feedbackStore.read();
    res.json({ text });
  });

  app.put('/feedback', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    await deps.feedbackStore.write(text);
    res.json({ ok: true });
  });

  app.post('/viewer-feedback', (req, res) => {
    const { language, lineIndex, english, translated, comment } = req.body ?? {};
    if (
      typeof language !== 'string' ||
      typeof lineIndex !== 'number' ||
      typeof english !== 'string' ||
      typeof translated !== 'string'
    ) {
      res.status(400).json({ error: 'language, lineIndex, english, and translated are required' });
      return;
    }
    deps.viewerFeedbackStore.add({
      sessionId: deps.session.id,
      language,
      lineIndex,
      english,
      translated,
      comment: typeof comment === 'string' ? comment : '',
    });
    res.json({ ok: true });
  });

  app.get('/viewer-feedback', (_req, res) => {
    res.json({ items: deps.viewerFeedbackStore.list() });
  });

  return app;
}
```

Modify `server/src/index.ts` — add the import and instantiate the store, then pass both new deps into `createApp(...)`:

```ts
import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachWsServer } from './wsServer.js';
import { Session } from './session.js';
import { createGeminiClient } from './gemini.js';
import { createDeepgramConnection } from './deepgram.js';
import { createSermonDocStore } from './sermonDocStore.js';
import { createFeedbackStore } from './feedbackStore.js';
import { createViewerFeedbackStore } from './viewerFeedbackStore.js';
import { createCostTracker } from './costTracker.js';
import { withCostTracking } from './geminiCostTracking.js';

const requiredEnvVars = ['DEEPGRAM_API_KEY', 'GEMINI_API_KEY'] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const session = new Session();
const costTracker = createCostTracker(process.env.COST_FILE_PATH ?? 'data/cost.json');
const geminiClient = withCostTracking(createGeminiClient(process.env.GEMINI_API_KEY!), costTracker);
const sermonDocStore = createSermonDocStore();
const feedbackStore = createFeedbackStore(process.env.FEEDBACK_FILE_PATH ?? 'data/feedback.txt');
const viewerFeedbackStore = createViewerFeedbackStore(
  process.env.VIEWER_FEEDBACK_FILE_PATH ?? 'data/viewer-feedback.json'
);

const app = createApp({ sermonDocStore, feedbackStore, viewerFeedbackStore, session });
const httpServer = createServer(app);

attachWsServer({
  httpServer,
  session,
  geminiClient,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
  createDeepgramConnection,
  sermonDocStore,
  feedbackStore,
  costTracker,
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

(Only the three marked lines/blocks change: the new import, the new `viewerFeedbackStore` const, and `viewerFeedbackStore, session` added to the `createApp({...})` call — everything else in `index.ts` stays as-is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: PASS (all tests in the file, including the new ones)

Then run the full server test suite to confirm nothing else broke:

Run: `cd server && npx vitest run`
Expected: PASS (all test files)

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/tests/app.test.ts
git commit -m "feat: add POST/GET /viewer-feedback endpoints"
```

---

## Task 4: Download endpoints

**Files:**
- Modify: `server/src/app.ts`
- Test: `server/tests/app.test.ts`

**Interfaces:**
- Consumes: `toCsv(header: string[], rows: string[][]): string` from Task 1; `ViewerFeedbackStore.get`/`getUndownloaded`/`markDownloaded` from Task 2.
- Produces: nothing new consumed by later tasks (this is the last server task).

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/app.test.ts`:

```ts
describe('POST /viewer-feedback/:id/download', () => {
  it('returns 404 for an unknown id', async () => {
    const response = await request(createApp(testDeps())).post('/viewer-feedback/does-not-exist/download');
    expect(response.status).toBe(404);
  });

  it('returns a one-row CSV for the item and marks it downloaded', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({
      language: 'ko',
      lineIndex: 1,
      english: 'Peace be with you',
      translated: '평안이 있기를',
      comment: 'unclear',
    });
    const [{ id }] = deps.viewerFeedbackStore.list();

    const response = await request(app).post(`/viewer-feedback/${id}/download`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('Peace be with you');
    expect(response.text).toContain('평안이 있기를');
    expect(response.text).toContain('unclear');
    expect(deps.viewerFeedbackStore.get(id)?.downloaded).toBe(true);
  });
});

describe('POST /viewer-feedback/download-all', () => {
  it('returns a header-only CSV when nothing is undownloaded', async () => {
    const response = await request(createApp(testDeps())).post('/viewer-feedback/download-all');
    expect(response.status).toBe(200);
    expect(response.text).toBe('Timestamp,Language,English,Translated,Comment,Session ID\r\n');
  });

  it('returns only undownloaded items and marks them all downloaded', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 0, english: 'Alpha line', translated: 'あ' });
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 1, english: 'Beta line', translated: 'い' });
    const items = deps.viewerFeedbackStore.list(); // newest first: Beta, then Alpha
    const alphaId = items.find((item) => item.english === 'Alpha line')!.id;
    await request(app).post(`/viewer-feedback/${alphaId}/download`); // marks Alpha downloaded

    const response = await request(app).post('/viewer-feedback/download-all');

    expect(response.status).toBe(200);
    expect(response.text).toContain('Beta line');
    expect(response.text).not.toContain('Alpha line');
    expect(deps.viewerFeedbackStore.list().every((item) => item.downloaded)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: FAIL — both routes 404 (not defined yet).

- [ ] **Step 3: Write minimal implementation**

Modify `server/src/app.ts` — add the `toCsv` import near the top, and add the two new routes right after the existing `GET /viewer-feedback` route:

```ts
import { toCsv } from './csv.js';
```

```ts
  const VIEWER_FEEDBACK_CSV_HEADER = ['Timestamp', 'Language', 'English', 'Translated', 'Comment', 'Session ID'];

  app.post('/viewer-feedback/:id/download', (req, res) => {
    const item = deps.viewerFeedbackStore.get(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Feedback item not found' });
      return;
    }
    deps.viewerFeedbackStore.markDownloaded([item.id]);
    const csv = toCsv(VIEWER_FEEDBACK_CSV_HEADER, [
      [item.timestamp, item.language, item.english, item.translated, item.comment, item.sessionId],
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-${item.id}.csv"`);
    res.send(csv);
  });

  app.post('/viewer-feedback/download-all', (_req, res) => {
    const undownloaded = deps.viewerFeedbackStore.getUndownloaded();
    deps.viewerFeedbackStore.markDownloaded(undownloaded.map((item) => item.id));
    const csv = toCsv(
      VIEWER_FEEDBACK_CSV_HEADER,
      undownloaded.map((item) => [item.timestamp, item.language, item.english, item.translated, item.comment, item.sessionId])
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-all-${Date.now()}.csv"`);
    res.send(csv);
  });
```

(Place `VIEWER_FEEDBACK_CSV_HEADER` and both routes inside `createApp`, after the `GET /viewer-feedback` route and before the function's closing `return app;`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: PASS (all tests in the file)

Then the full suite once more:

Run: `cd server && npx vitest run`
Expected: PASS (all test files)

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/tests/app.test.ts
git commit -m "feat: add per-item and bulk CSV download endpoints for viewer feedback"
```

---

## Task 5: Localized feedback UI strings

**Files:**
- Create: `web/lib/feedbackStrings.ts`

**Interfaces:**
- Produces:
  ```ts
  interface FeedbackStrings {
    flagPlaceholder: string;
    submit: string;
    cancel: string;
    thanksConfirmation: string;
    submitError: string;
  }
  function getFeedbackStrings(languageCode: string): FeedbackStrings
  ```
  Used by Task 6 (`view/page.tsx`).

This repo has no web test framework (`web/package.json` has no test script or test dependency) — this task is verified by TypeScript compiling cleanly and by manual use in Task 6, not a unit test.

- [ ] **Step 1: Create the file**

Create `web/lib/feedbackStrings.ts`:

```ts
export interface FeedbackStrings {
  flagPlaceholder: string;
  submit: string;
  cancel: string;
  thanksConfirmation: string;
  submitError: string;
}

// Hand-authored translations for the small set of feedback-flagging UI strings.
// Not reviewed by native speakers — worth a review pass before relying on them
// in a live service (see the design doc's "Known Simplifications").
const FEEDBACK_STRINGS: Record<string, FeedbackStrings> = {
  zh: {
    flagPlaceholder: '可选:这一行有什么问题?',
    submit: '提交',
    cancel: '取消',
    thanksConfirmation: '谢谢,已标记',
    submitError: '发送失败,请重试',
  },
  id: {
    flagPlaceholder: 'Opsional: apa yang salah dengan baris ini?',
    submit: 'Kirim',
    cancel: 'Batal',
    thanksConfirmation: 'Terima kasih, sudah ditandai',
    submitError: 'Gagal mengirim — coba lagi',
  },
  tl: {
    flagPlaceholder: 'Opsyonal: ano ang mali sa linyang ito?',
    submit: 'Ipadala',
    cancel: 'Kanselahin',
    thanksConfirmation: 'Salamat, na-flag na',
    submitError: 'Hindi naipadala — subukan muli',
  },
  ko: {
    flagPlaceholder: '선택 사항: 이 줄에 어떤 문제가 있나요?',
    submit: '제출',
    cancel: '취소',
    thanksConfirmation: '감사합니다, 신고되었습니다',
    submitError: '전송 실패 — 다시 시도해주세요',
  },
  ja: {
    flagPlaceholder: '任意:この行の何が問題ですか?',
    submit: '送信',
    cancel: 'キャンセル',
    thanksConfirmation: 'ありがとうございます、報告されました',
    submitError: '送信できませんでした もう一度お試しください',
  },
  vi: {
    flagPlaceholder: 'Không bắt buộc: dòng này có vấn đề gì?',
    submit: 'Gửi',
    cancel: 'Hủy',
    thanksConfirmation: 'Cảm ơn, đã được gắn cờ',
    submitError: 'Gửi không thành công — vui lòng thử lại',
  },
  th: {
    flagPlaceholder: 'ไม่บังคับ: บรรทัดนี้มีปัญหาอะไร?',
    submit: 'ส่ง',
    cancel: 'ยกเลิก',
    thanksConfirmation: 'ขอบคุณ ถูกทำเครื่องหมายแล้ว',
    submitError: 'ส่งไม่สำเร็จ — ลองอีกครั้ง',
  },
  es: {
    flagPlaceholder: 'Opcional: ¿qué está mal en esta línea?',
    submit: 'Enviar',
    cancel: 'Cancelar',
    thanksConfirmation: 'Gracias, marcado',
    submitError: 'No se pudo enviar — inténtalo de nuevo',
  },
  pt: {
    flagPlaceholder: 'Opcional: o que está errado nesta linha?',
    submit: 'Enviar',
    cancel: 'Cancelar',
    thanksConfirmation: 'Obrigado, sinalizado',
    submitError: 'Falha ao enviar — tente novamente',
  },
  fr: {
    flagPlaceholder: "Facultatif : qu'est-ce qui ne va pas avec cette ligne ?",
    submit: 'Envoyer',
    cancel: 'Annuler',
    thanksConfirmation: 'Merci, signalé',
    submitError: "Échec de l'envoi — réessayez",
  },
  hi: {
    flagPlaceholder: 'वैकल्पिक: इस पंक्ति में क्या गलत है?',
    submit: 'भेजें',
    cancel: 'रद्द करें',
    thanksConfirmation: 'धन्यवाद, फ़्लैग कर दिया गया',
    submitError: 'भेजने में विफल — पुनः प्रयास करें',
  },
  my: {
    flagPlaceholder: 'ချန်ထားနိုင်သည်: ဒီစာကြောင်းမှာ ဘာမှားနေလဲ?',
    submit: 'ပို့ရန်',
    cancel: 'ပယ်ဖျက်ရန်',
    thanksConfirmation: 'ကျေးဇူးတင်ပါသည်၊ အမှတ်အသားပြုပြီးပါပြီ',
    submitError: 'ပို့၍မရပါ — ထပ်စမ်းကြည့်ပါ',
  },
};

const EN_FALLBACK: FeedbackStrings = {
  flagPlaceholder: "Optional: what's wrong with this line?",
  submit: 'Submit',
  cancel: 'Cancel',
  thanksConfirmation: 'Thanks, flagged',
  submitError: "Couldn't send — try again",
};

export function getFeedbackStrings(languageCode: string): FeedbackStrings {
  return FEEDBACK_STRINGS[languageCode] ?? EN_FALLBACK;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors referencing `feedbackStrings.ts`

- [ ] **Step 3: Commit**

```bash
git add web/lib/feedbackStrings.ts
git commit -m "feat: add localized viewer-feedback UI strings"
```

---

## Task 6: Per-line flag UI on `/view`

**Files:**
- Modify: `web/app/view/page.tsx`

**Interfaces:**
- Consumes: `getFeedbackStrings(languageCode: string): FeedbackStrings` from Task 5; `POST /viewer-feedback` from Task 3 (body `{ language, lineIndex, english, translated, comment }`).

This repo has no web test framework — verify this task with the browser preview tools (see Step 3) rather than an automated test.

- [ ] **Step 1: Modify the file**

In `web/app/view/page.tsx`, make these changes to `ViewerPageContent`:

Add the import and `API_URL` constant near the top of the file:

```tsx
import { getFeedbackStrings } from '@/lib/feedbackStrings';
```

```tsx
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');
```

Inside `ViewerPageContent`, add new state and a strings lookup right after the existing `useState` declarations:

```tsx
  type LineFeedbackMode = 'idle' | 'open' | 'submitting' | 'submitted' | 'flagged' | 'error';
  interface LineFeedbackState {
    mode: LineFeedbackMode;
    comment: string;
  }
  const [feedbackByLine, setFeedbackByLine] = useState<Record<number, LineFeedbackState>>({});
  const flaggedTimeoutsRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const strings = getFeedbackStrings(language);
```

Add a cleanup effect (alongside the existing `useEffect` calls):

```tsx
  useEffect(() => {
    return () => {
      Object.values(flaggedTimeoutsRef.current).forEach(clearTimeout);
    };
  }, []);
```

Add these handler functions inside the component, near `handleExportPdf`:

```tsx
  function openFeedback(index: number) {
    setFeedbackByLine((previous) => ({
      ...previous,
      [index]: { mode: 'open', comment: previous[index]?.comment ?? '' },
    }));
  }

  function cancelFeedback(index: number) {
    setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'idle', comment: '' } }));
  }

  function updateFeedbackComment(index: number, comment: string) {
    setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'open', comment } }));
  }

  async function submitFeedback(index: number, line: { english: string; translated: string }, comment: string) {
    setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'submitting', comment } }));
    try {
      const response = await fetch(`${API_URL}/viewer-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          lineIndex: index,
          english: line.english,
          translated: line.translated,
          comment,
        }),
      });
      if (!response.ok) throw new Error('request failed');
      setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'submitted', comment: '' } }));
      flaggedTimeoutsRef.current[index] = setTimeout(() => {
        setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'flagged', comment: '' } }));
      }, 2000);
    } catch {
      setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'error', comment } }));
    }
  }

  function renderLineFeedback(index: number, line: { english: string; translated: string }) {
    const state = feedbackByLine[index] ?? { mode: 'idle' as const, comment: '' };

    if (state.mode === 'idle') {
      return (
        <button
          onClick={() => openFeedback(index)}
          aria-label="Flag this line"
          className="text-lg leading-none text-muted-foreground hover:text-foreground"
        >
          ⚑
        </button>
      );
    }

    if (state.mode === 'flagged') {
      return (
        <button
          onClick={() => openFeedback(index)}
          aria-label="Flag this line again"
          className="text-lg leading-none opacity-40"
        >
          ⚑
        </button>
      );
    }

    if (state.mode === 'submitted') {
      return <span className="text-xs text-green-600 whitespace-nowrap">{strings.thanksConfirmation}</span>;
    }

    return (
      <div className="flex flex-col gap-1 w-48 shrink-0">
        <textarea
          value={state.comment}
          onChange={(event) => updateFeedbackComment(index, event.target.value)}
          rows={2}
          className="w-full border rounded p-1 text-xs"
          placeholder={strings.flagPlaceholder}
          disabled={state.mode === 'submitting'}
        />
        <div className="flex gap-2">
          <button
            onClick={() => void submitFeedback(index, line, state.comment)}
            disabled={state.mode === 'submitting'}
            className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded disabled:opacity-50"
          >
            {strings.submit}
          </button>
          <button
            onClick={() => cancelFeedback(index)}
            disabled={state.mode === 'submitting'}
            className="text-xs underline disabled:opacity-50"
          >
            {strings.cancel}
          </button>
        </div>
        {state.mode === 'error' && <p className="text-xs text-destructive">{strings.submitError}</p>}
      </div>
    );
  }
```

Finally, replace the non-removed line's JSX inside the `lines.map(...)` block:

```tsx
            <div key={index}>
              <p className="text-sm text-muted-foreground">{line.english}</p>
              <p className="text-xl">{line.translated}</p>
            </div>
```

with:

```tsx
            <div key={index} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground">{line.english}</p>
                <p className="text-xl">{line.translated}</p>
              </div>
              {renderLineFeedback(index, line)}
            </div>
```

(The `line.removed` branch just above it is unchanged.)

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Manually verify in the browser**

Start the dev servers (server on its usual port, `cd web && npm run dev`), open `/view?lang=es` (or any supported code) via the browser preview tools once at least one caption line has arrived (trigger a session from `/capture` in another tab, or temporarily hardcode a test line if no live session is easy to start). Confirm:
- A flag (⚑) is visible next to every caption line.
- Clicking it opens the textarea with the Spanish placeholder text ("Opcional: ¿qué está mal en esta línea?") and Spanish Submit/Cancel buttons.
- Submitting with a comment shows "Gracias, marcado" briefly, then the flag dims but stays clickable.
- Submitting with an empty comment also succeeds (blank comment is valid).
- `GET http://localhost:3001/viewer-feedback` (via `read_network_requests` or a manual fetch) shows the submitted item with the right `language`/`lineIndex`/`english`/`translated`/`comment`.

- [ ] **Step 4: Commit**

```bash
git add web/app/view/page.tsx
git commit -m "feat: add per-line flag button with localized inline feedback form"
```

---

## Task 7: Viewer Feedback list on the capture page

**Files:**
- Modify: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: `GET /viewer-feedback` (Task 3), `POST /viewer-feedback/:id/download` and `POST /viewer-feedback/download-all` (Task 4).

This repo has no web test framework — verify this task with the browser preview tools (see Step 3) rather than an automated test.

- [ ] **Step 1: Modify the file**

In `web/app/capture/page.tsx`, add a local interface and new state near the top of the component (alongside the existing `useState` declarations):

```tsx
interface ViewerFeedbackItem {
  id: string;
  sessionId: string;
  timestamp: string;
  language: string;
  lineIndex: number;
  english: string;
  translated: string;
  comment: string;
  downloaded: boolean;
}
```

```tsx
  const [viewerFeedback, setViewerFeedback] = useState<ViewerFeedbackItem[]>([]);
  const [feedbackDownloadError, setFeedbackDownloadError] = useState<string | null>(null);
```

Add a fetch-on-mount effect (alongside the existing `/feedback` fetch effect):

```tsx
  useEffect(() => {
    void fetchViewerFeedback();
  }, []);

  async function fetchViewerFeedback() {
    try {
      const response = await fetch(`${API_URL}/viewer-feedback`);
      const data = await response.json();
      setViewerFeedback(Array.isArray(data.items) ? data.items : []);
    } catch {
      setViewerFeedback([]);
    }
  }
```

Add the download helper and its two callers, near `saveFeedback`:

```tsx
  async function downloadFeedbackCsv(url: string) {
    setFeedbackDownloadError(null);
    try {
      const response = await fetch(url, { method: 'POST' });
      if (!response.ok) {
        setFeedbackDownloadError(`Download failed (status ${response.status}). Check your connection and try again.`);
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : 'feedback.csv';
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
      await fetchViewerFeedback();
    } catch {
      setFeedbackDownloadError('Download failed. Check your connection and try again.');
    }
  }

  function downloadFeedbackItem(id: string) {
    void downloadFeedbackCsv(`${API_URL}/viewer-feedback/${id}/download`);
  }

  function downloadAllUndownloadedFeedback() {
    void downloadFeedbackCsv(`${API_URL}/viewer-feedback/download-all`);
  }
```

Add the "Viewer Feedback" section to the JSX, right after the existing "Feedback notes" `</div>` block and before the closing `</main>`:

```tsx
      <div className="w-full max-w-xl flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium">Viewer feedback</label>
          <button
            onClick={downloadAllUndownloadedFeedback}
            disabled={viewerFeedback.every((item) => item.downloaded)}
            className="bg-secondary text-secondary-foreground px-3 py-1 rounded text-sm disabled:opacity-50"
          >
            Download all undownloaded ({viewerFeedback.filter((item) => !item.downloaded).length} new)
          </button>
        </div>
        {feedbackDownloadError && <p className="text-sm text-destructive">{feedbackDownloadError}</p>}
        {viewerFeedback.length === 0 ? (
          <p className="text-sm text-muted-foreground">No feedback yet.</p>
        ) : (
          <div className="border rounded divide-y max-h-80 overflow-y-auto text-sm">
            {viewerFeedback.map((item) => (
              <div key={item.id} className="p-2 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {new Date(item.timestamp).toLocaleString()} · {item.language}
                    {item.downloaded ? ' · downloaded' : ' · new'}
                  </span>
                  <button onClick={() => downloadFeedbackItem(item.id)} className="text-xs underline">
                    Download
                  </button>
                </div>
                <p className="text-muted-foreground">{item.english}</p>
                <p>{item.translated}</p>
                {item.comment && <p className="italic">&quot;{item.comment}&quot;</p>}
              </div>
            ))}
          </div>
        )}
      </div>
```

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Manually verify in the browser**

With both the server and `cd web && npm run dev` running, open `/capture` via the browser preview tools. Submit at least one item via `/view`'s flag UI (Task 6) in another tab, then on `/capture`:
- Confirm the "Viewer feedback" section shows the item with its English/translated text, comment, language, and a "new" marker.
- Confirm the "Download all undownloaded (1 new)" button is enabled and its count matches.
- Click the per-item "Download" button: confirm a `.csv` file downloads (check via `read_network_requests` or the browser's download behavior) and the item's marker flips to "downloaded".
- Submit a second flag from `/view`, then click "Download all undownloaded": confirm only the new item is in the downloaded CSV and the count badge returns to "(0 new)" with the button now disabled.

- [ ] **Step 4: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "feat: add Viewer Feedback list with per-item and bulk CSV download to capture page"
```

---

## Self-Review Notes

- **Spec coverage:** Storage/API (Tasks 1–4), viewer flag UI + localization (Tasks 5–6), admin list + downloads (Task 7), error handling (400/404 tests in Tasks 3–4, inline error states in Tasks 6–7), testing plan (unit tests in Tasks 1–4, manual browser verification in Tasks 6–7) — all covered.
- **Type consistency:** `ViewerFeedbackItem` shape (`id, sessionId, timestamp, language, lineIndex, english, translated, comment, downloaded`) is identical across Task 2's store, Task 3/4's routes, and Task 7's client-side interface. `toCsv(header, rows)` signature from Task 1 matches its two call sites in Task 4. `getFeedbackStrings(languageCode)` from Task 5 matches its call in Task 6.
- **No placeholders:** every step has complete code, not descriptions of code.
