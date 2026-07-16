# Viewer Subscribe Burst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every viewer subscribe from re-translating the entire visible backlog against Gemini from scratch, and bound worst-case concurrent Gemini load, so many viewers joining within the same few seconds doesn't hammer the API or the instance.

**Architecture:** A new per-session `TranslationCache` stores the already-verified translation for each `(language, lineId)` pair, populated for free inside the existing live-publish path (`finishPublishing`). Viewer subscribe now only calls `translateBacklog`/`verifyTranslations` for backlog lines missing from the cache, and an in-flight-fill map on `Session` coalesces concurrent first-time subscribes to the same language into a single Gemini call. Separately, a `GeminiCallLimiter` (a small async semaphore) wraps every outbound Gemini call via a `withGeminiLimiter` client decorator — mirroring the existing `withCostTracking` decorator — as a generic concurrency cap independent of the caching fix.

**Tech Stack:** TypeScript, `@google/genai` (Gemini), `ws` (WebSocket server), Vitest (server tests).

## Global Constraints

- The cache lives only in memory for the lifetime of a `Session` — no persistence across a capture restart (matches `buffer` and `sermonCache` today).
- No cache eviction beyond the existing 10-minute backlog trim in `transcriptBuffer.ts` — entries for trimmed lines just become unreachable.
- `GeminiCallLimiter`'s default concurrency cap is a fixed constant: **8**. Not configurable via environment/config in this plan.
- One shared `GeminiCallLimiter` instance wraps all three outbound Gemini call sites (`translateSegment`, `translateBacklog`, `verifyTranslations`) via the client decorator — not one limiter per function.
- Server test commands run from the `server/` directory: `npm test` (= `vitest run`), or `npx vitest run tests/<file>.test.ts` for a single file.
- Typecheck command: `npx tsc -p tsconfig.json --noEmit` (from `server/`).

---

### Task 1: `TranslationCache`

**Files:**
- Create: `server/src/translationCache.ts`
- Create: `server/tests/translationCache.test.ts`

**Interfaces:**
- Produces: `TranslationCache` class with `get(language: string, lineId: string): string | undefined`, `set(language: string, lineId: string, translated: string): void`, `clear(): void`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/translationCache.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TranslationCache } from '../src/translationCache';

describe('TranslationCache', () => {
  it('returns undefined for a line that was never cached', () => {
    const cache = new TranslationCache();
    expect(cache.get('zh', 'line-1')).toBeUndefined();
  });

  it('set/get roundtrips a translated line for a given language', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', '你好');
    expect(cache.get('zh', 'line-1')).toBe('你好');
  });

  it('keeps the same line id independent across different languages', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', '你好');
    cache.set('fr', 'line-1', 'Bonjour');
    expect(cache.get('zh', 'line-1')).toBe('你好');
    expect(cache.get('fr', 'line-1')).toBe('Bonjour');
  });

  it('overwrites a previously cached value for the same language and line id', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', '你好');
    cache.set('zh', 'line-1', '你好呀');
    expect(cache.get('zh', 'line-1')).toBe('你好呀');
  });

  it('clear() empties every language', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', '你好');
    cache.set('fr', 'line-1', 'Bonjour');
    cache.clear();
    expect(cache.get('zh', 'line-1')).toBeUndefined();
    expect(cache.get('fr', 'line-1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/translationCache.test.ts`
Expected: FAIL — cannot find module `../src/translationCache`.

- [ ] **Step 3: Implement `TranslationCache`**

Create `server/src/translationCache.ts`:

```ts
export class TranslationCache {
  private byLanguage: Map<string, Map<string, string>> = new Map();

  get(language: string, lineId: string): string | undefined {
    return this.byLanguage.get(language)?.get(lineId);
  }

  set(language: string, lineId: string, translated: string): void {
    let lines = this.byLanguage.get(language);
    if (!lines) {
      lines = new Map();
      this.byLanguage.set(language, lines);
    }
    lines.set(lineId, translated);
  }

  clear(): void {
    this.byLanguage.clear();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/translationCache.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/translationCache.ts server/tests/translationCache.test.ts
git commit -m "$(cat <<'EOF'
Add TranslationCache for per-language, per-line translation reuse

Standalone building block for the viewer-subscribe-burst fix: a
per-session cache of already-verified translated lines, keyed by
language and line id, so a translation computed once during live
publishing can be reused instead of recomputed on every viewer
subscribe.
EOF
)"
```

---

### Task 2: `GeminiCallLimiter`

**Files:**
- Create: `server/src/geminiLimiter.ts`
- Create: `server/tests/geminiLimiter.test.ts`

**Interfaces:**
- Produces: `GeminiCallLimiter` class, `constructor(maxConcurrent: number = 8)`, `run<T>(fn: () => Promise<T>): Promise<T>`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/geminiLimiter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GeminiCallLimiter } from '../src/geminiLimiter';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('GeminiCallLimiter', () => {
  it('runs up to maxConcurrent calls immediately, without waiting for a slot', async () => {
    const limiter = new GeminiCallLimiter(2);
    const first = deferred<string>();
    const second = deferred<string>();
    let firstStarted = false;
    let secondStarted = false;

    const firstRun = limiter.run(() => {
      firstStarted = true;
      return first.promise;
    });
    const secondRun = limiter.run(() => {
      secondStarted = true;
      return second.promise;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(true);

    first.resolve('a');
    second.resolve('b');
    await Promise.all([firstRun, secondRun]);
  });

  it('queues the (maxConcurrent + 1)th call until a slot frees', async () => {
    const limiter = new GeminiCallLimiter(2);
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    let thirdStarted = false;

    const firstRun = limiter.run(() => first.promise);
    const secondRun = limiter.run(() => second.promise);
    const thirdRun = limiter.run(() => {
      thirdStarted = true;
      return third.promise;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(thirdStarted).toBe(false);

    first.resolve('a');
    await new Promise((resolve) => setImmediate(resolve));
    expect(thirdStarted).toBe(true);

    second.resolve('b');
    third.resolve('c');
    await Promise.all([firstRun, secondRun, thirdRun]);
  });

  it('frees the slot for the next queued call even if the running call rejects', async () => {
    const limiter = new GeminiCallLimiter(1);
    const first = deferred<string>();
    let secondStarted = false;

    const firstRun = limiter.run(() => first.promise).catch(() => 'handled-first-rejection');
    const secondRun = limiter.run(() => {
      secondStarted = true;
      return Promise.resolve('b');
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(secondStarted).toBe(false);

    first.reject(new Error('boom'));
    await firstRun;
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondStarted).toBe(true);

    await secondRun;
  });

  it('defaults maxConcurrent to 8', async () => {
    const limiter = new GeminiCallLimiter();
    const deferredCalls = Array.from({ length: 8 }, () => deferred<number>());
    const started: boolean[] = new Array(8).fill(false);

    const runs = deferredCalls.map((entry, index) =>
      limiter.run(() => {
        started[index] = true;
        return entry.promise;
      })
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(started.every(Boolean)).toBe(true);

    deferredCalls.forEach((entry, index) => entry.resolve(index));
    await Promise.all(runs);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/geminiLimiter.test.ts`
Expected: FAIL — cannot find module `../src/geminiLimiter`.

- [ ] **Step 3: Implement `GeminiCallLimiter`**

Create `server/src/geminiLimiter.ts`:

```ts
export class GeminiCallLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number = 8) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/geminiLimiter.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/geminiLimiter.ts server/tests/geminiLimiter.test.ts
git commit -m "$(cat <<'EOF'
Add GeminiCallLimiter, a fixed-concurrency async semaphore

Standalone building block: caps concurrent async work at a fixed
limit (default 8), queuing excess calls FIFO and releasing a slot
in a finally block so a rejected call doesn't leak its slot. Not
yet wired into any Gemini call site.
EOF
)"
```

---

### Task 3: `withGeminiLimiter` decorator, wired into `index.ts`

**Files:**
- Create: `server/src/geminiRateLimiting.ts`
- Create: `server/tests/geminiRateLimiting.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `GeminiCallLimiter.run` (Task 2); `GeminiClient` (`server/src/gemini.ts`, unchanged).
- Produces: `withGeminiLimiter(client: GeminiClient, limiter: GeminiCallLimiter): GeminiClient` — same decorator shape as the existing `withCostTracking` in `server/src/geminiCostTracking.ts`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/geminiRateLimiting.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { withGeminiLimiter } from '../src/geminiRateLimiting';
import { GeminiCallLimiter } from '../src/geminiLimiter';
import type { GeminiClient } from '../src/gemini';

function fakeClient(): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: '{}' }),
    },
    caches: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe('withGeminiLimiter', () => {
  it('routes generateContent calls through the limiter and returns the original response', async () => {
    const client = fakeClient();
    const limiter = new GeminiCallLimiter(1);
    const runSpy = vi.spyOn(limiter, 'run');
    const wrapped = withGeminiLimiter(client, limiter);

    const response = await wrapped.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: 'hi',
      config: { responseMimeType: 'application/json', responseSchema: {} },
    });

    expect(response).toEqual({ text: '{}' });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent calls beyond the limiter cap', async () => {
    const client = fakeClient();
    let concurrent = 0;
    let maxConcurrent = 0;
    (client.models.generateContent as any).mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return { text: '{}' };
    });
    const limiter = new GeminiCallLimiter(2);
    const wrapped = withGeminiLimiter(client, limiter);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        wrapped.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: 'hi',
          config: { responseMimeType: 'application/json', responseSchema: {} },
        })
      )
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('passes the caches object through unchanged', () => {
    const client = fakeClient();
    const limiter = new GeminiCallLimiter();
    const wrapped = withGeminiLimiter(client, limiter);
    expect(wrapped.caches).toBe(client.caches);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/geminiRateLimiting.test.ts`
Expected: FAIL — cannot find module `../src/geminiRateLimiting`.

- [ ] **Step 3: Implement `withGeminiLimiter`**

Create `server/src/geminiRateLimiting.ts`:

```ts
import type { GeminiClient } from './gemini.js';
import type { GeminiCallLimiter } from './geminiLimiter.js';

export function withGeminiLimiter(client: GeminiClient, limiter: GeminiCallLimiter): GeminiClient {
  return {
    models: {
      generateContent(params) {
        return limiter.run(() => client.models.generateContent(params));
      },
    },
    caches: client.caches,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/geminiRateLimiting.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Wire the limiter into `index.ts`**

In `server/src/index.ts`, the current relevant lines read:

```ts
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
```

Replace with:

```ts
import { createGeminiClient } from './gemini.js';
import { createDeepgramConnection } from './deepgram.js';
import { createSermonDocStore } from './sermonDocStore.js';
import { createFeedbackStore } from './feedbackStore.js';
import { createViewerFeedbackStore } from './viewerFeedbackStore.js';
import { createCostTracker } from './costTracker.js';
import { withCostTracking } from './geminiCostTracking.js';
import { withGeminiLimiter } from './geminiRateLimiting.js';
import { GeminiCallLimiter } from './geminiLimiter.js';

const requiredEnvVars = ['DEEPGRAM_API_KEY', 'GEMINI_API_KEY'] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const session = new Session();
const costTracker = createCostTracker(process.env.COST_FILE_PATH ?? 'data/cost.json');
const geminiLimiter = new GeminiCallLimiter();
const geminiClient = withCostTracking(
  withGeminiLimiter(createGeminiClient(process.env.GEMINI_API_KEY!), geminiLimiter),
  costTracker
);
```

(Only these lines change; the rest of `index.ts` — `sermonDocStore` through `httpServer.listen`, is untouched.)

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full server test suite**

Run (from `server/`): `npm test`
Expected: all tests pass (no existing test imports or exercises `index.ts` directly, so this is a smoke check that nothing else broke).

- [ ] **Step 8: Commit**

```bash
git add server/src/geminiRateLimiting.ts server/tests/geminiRateLimiting.test.ts server/src/index.ts
git commit -m "$(cat <<'EOF'
Wrap the shared Gemini client in a fixed-concurrency limiter

withGeminiLimiter decorates GeminiClient.models.generateContent with
GeminiCallLimiter.run, mirroring the existing withCostTracking
decorator. Wired into index.ts so every outbound Gemini call —
segment translation, backlog translation, and verification alike —
shares one process-wide cap of 8 concurrent requests, as a safety
net against any burst source.
EOF
)"
```

---

### Task 4: `Session` gains `translationCache` and `inFlightFills`

**Files:**
- Modify: `server/src/session.ts`
- Modify: `server/tests/session.test.ts`

**Interfaces:**
- Consumes: `TranslationCache` (Task 1).
- Produces: `Session.translationCache: TranslationCache` (public field); `Session.inFlightFills: Map<string, Promise<void>>` (public field, keyed by language). Both are replaced with fresh instances by `Session.start()`, not cleared in place.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `server/tests/session.test.ts`, after the existing `'start() clears any previous sermon cache reference'` test (before the closing `});` of the `describe('Session', ...)` block):

```ts
  it('start() replaces the translation cache, discarding anything cached in the previous session', () => {
    const session = new Session();
    session.translationCache.set('zh', 'old-line', '你好');
    session.start();
    expect(session.translationCache.get('zh', 'old-line')).toBeUndefined();
  });

  it('start() replaces the in-flight fill map, discarding anything tracked in the previous session', () => {
    const session = new Session();
    session.inFlightFills.set('zh', Promise.resolve());
    session.start();
    expect(session.inFlightFills.size).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — `session.translationCache` / `session.inFlightFills` are `undefined`.

- [ ] **Step 3: Add the fields to `Session`**

In `server/src/session.ts`, the current top of the file reads:

```ts
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { TranscriptBuffer } from './transcriptBuffer.js';
import type { SermonCacheRef } from './gemini.js';

export class Session {
  id: string = randomUUID();
  isActive: boolean = false;
  buffer: TranscriptBuffer = new TranscriptBuffer();
  sermonCache: SermonCacheRef | null = null;
  private viewers: Map<WebSocket, string> = new Map();

  start(): void {
    this.id = randomUUID();
    this.isActive = true;
    this.buffer.clear();
    this.sermonCache = null;
  }
```

Replace with:

```ts
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { TranscriptBuffer } from './transcriptBuffer.js';
import { TranslationCache } from './translationCache.js';
import type { SermonCacheRef } from './gemini.js';

export class Session {
  id: string = randomUUID();
  isActive: boolean = false;
  buffer: TranscriptBuffer = new TranscriptBuffer();
  sermonCache: SermonCacheRef | null = null;
  translationCache: TranslationCache = new TranslationCache();
  inFlightFills: Map<string, Promise<void>> = new Map();
  private viewers: Map<WebSocket, string> = new Map();

  start(): void {
    this.id = randomUUID();
    this.isActive = true;
    this.buffer.clear();
    this.sermonCache = null;
    this.translationCache = new TranslationCache();
    this.inFlightFills = new Map();
  }
```

(Leave the rest of the class — `stop()` through `getAllViewers()` — untouched.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/session.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/session.ts server/tests/session.test.ts
git commit -m "$(cat <<'EOF'
Give Session a per-language translation cache and fill tracker

Session now owns a TranslationCache and an inFlightFills map (keyed
by language), both replaced with fresh instances on start() rather
than cleared in place — so a fill still in flight from a just-ended
session can only write into an orphaned object, never the new
session's state. Neither field is consumed yet; wsServer.ts wiring
follows in later tasks.
EOF
)"
```

---

### Task 5: Populate the cache on live publish

**Files:**
- Modify: `server/src/wsServer.ts` (`finishPublishing`)
- Modify: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `Session.translationCache.set(language, lineId, translated)` (Task 4).
- No new message shapes — this only adds a side effect to the existing live-publish path.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `server/tests/wsServer.test.ts`, as a sibling of the existing `describe('reinstate', ...)` block (after its closing `});`, before `describe('admin-remove', ...)`):

```ts
  describe('translation cache (viewer subscribe burst fix)', () => {
    it('caches the live-published translation for each active language', async () => {
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

      expect(session.translationCache.get('zh', caption.id)).toBe('你好');

      captureSocket.close();
      viewerSocket.close();
    });

    it('caches the English fallback when the verifier flags a translation as unsafe', async () => {
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":false,"reason":"polarity flip"}}' });
        }
        return Promise.resolve({ text: '{"zh":"耶稣不爱你"}' });
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const captionPromise = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('Jesus loves you');
      const caption = await captionPromise;

      expect(session.translationCache.get('zh', caption.id)).toBe('Jesus loves you');

      warnSpy.mockRestore();
      captureSocket.close();
      viewerSocket.close();
    });

    it('does not cache anything for a language with no translation at all for that line', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'ko' }));
      await waitForMessage(viewerSocket); // backlog: []

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone'); // fakeGeminiClient's default translate only returns "zh"
      await transcriptPromise;
      await new Promise((resolve) => setImmediate(resolve));

      const recent = session.buffer.getRecent();
      expect(session.translationCache.get('ko', recent[0].id)).toBeUndefined();

      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/wsServer.test.ts -t "translation cache"`
Expected: FAIL — `session.translationCache.get(...)` returns `undefined` for the first two tests (nothing populates the cache yet).

- [ ] **Step 3: Populate the cache inside `finishPublishing`**

In `server/src/wsServer.ts`, the current per-language loop inside `finishPublishing` reads:

```ts
  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = safe ? translated : line.english;

    if (!safe) {
      logTranslationFallback(language, line.english, translated, verification?.reason ?? 'verification unavailable');
    }

    const payload = JSON.stringify({ type: viewerMessageType, id: line.id, english: line.english, translated: outgoing });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
```

Replace with:

```ts
  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = safe ? translated : line.english;
    deps.session.translationCache.set(language, line.id, outgoing);

    if (!safe) {
      logTranslationFallback(language, line.english, translated, verification?.reason ?? 'verification unavailable');
    }

    const payload = JSON.stringify({ type: viewerMessageType, id: line.id, english: line.english, translated: outgoing });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
```

(Only the one new line — `deps.session.translationCache.set(...)` — is added. Everything else in `finishPublishing` and the rest of `wsServer.ts` is untouched by this task; `handleReinstate` already calls `finishPublishing`, so a reinstated line's corrected translation is cached automatically with no separate code path.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/wsServer.test.ts`
Expected: all tests pass, including the new `'translation cache (viewer subscribe burst fix)'` block.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "$(cat <<'EOF'
Cache each live-published translation for reuse on later subscribes

finishPublishing now writes the exact value it broadcasts to live
viewers (the real translation if verified safe, otherwise the
English fallback) into Session.translationCache. This makes the
cache self-populating with zero new Gemini calls; it goes unused
until the subscribe path is made cache-aware in the next task.
EOF
)"
```

---

### Task 6: Cache-aware subscribe with in-flight coalescing

**Files:**
- Modify: `server/src/wsServer.ts` (`handleViewerConnection`; new `ensureBacklogCached` helper)
- Modify: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `Session.translationCache` (Task 4/5), `Session.inFlightFills` (Task 4), `translateBacklog` and `verifyTranslationsWithRetry` (existing, unchanged signatures).
- No client-visible protocol changes — `subscribe` still yields the same `{ type: 'backlog', lines }` shape.

- [ ] **Step 1: Write the failing tests**

Add these tests inside the `describe('translation cache (viewer subscribe burst fix)', ...)` block added in Task 5, after its last test (before the block's closing `});`):

```ts
    it('serves a second subscriber to an already-active language from cache, without additional Gemini calls', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const firstViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(firstViewer);
      firstViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(firstViewer); // backlog: []

      const captionPromise = waitForMessage(firstViewer);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      await captionPromise;

      const callsBeforeSecondSubscribe = (geminiClient.models.generateContent as any).mock.calls.length;

      const secondViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(secondViewer);
      secondViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlogMessage = await waitForMessage(secondViewer);

      expect(backlogMessage).toEqual({
        type: 'backlog',
        lines: [{ id: expect.any(String), english: 'Hello everyone', translated: '你好' }],
      });
      expect((geminiClient.models.generateContent as any).mock.calls.length).toBe(callsBeforeSecondSubscribe);

      captureSocket.close();
      firstViewer.close();
      secondViewer.close();
    });

    it('coalesces two concurrent first-time subscribes to the same new language into one backlog fill', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      session.buffer.append('Earlier line', Date.now());

      let resolveTranslate!: (value: { text: string }) => void;
      const pendingTranslate = new Promise<{ text: string }>((resolve) => {
        resolveTranslate = resolve;
      });
      let notifyTranslateStarted!: () => void;
      const translateStarted = new Promise<void>((resolve) => {
        notifyTranslateStarted = resolve;
      });
      let translateCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          // Mirror fakeGeminiClient's default behavior (see top of this file):
          // mark every requested id safe, so this test isolates coalescing
          // behavior instead of accidentally exercising the unsafe-fallback path.
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        translateCallCount += 1;
        notifyTranslateStarted();
        return pendingTranslate;
      });

      const firstViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(firstViewer);
      firstViewer.send(JSON.stringify({ type: 'subscribe', language: 'fr' }));
      await translateStarted;

      const secondViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(secondViewer);
      secondViewer.send(JSON.stringify({ type: 'subscribe', language: 'fr' }));
      await new Promise((resolve) => setImmediate(resolve));

      expect(translateCallCount).toBe(1);

      const firstBacklogPromise = waitForMessage(firstViewer);
      const secondBacklogPromise = waitForMessage(secondViewer);
      resolveTranslate({ text: '{"translations":["Plus tôt"]}' });

      const [firstBacklog, secondBacklog] = await Promise.all([firstBacklogPromise, secondBacklogPromise]);
      expect(firstBacklog).toEqual({
        type: 'backlog',
        lines: [{ id: expect.any(String), english: 'Earlier line', translated: 'Plus tôt' }],
      });
      expect(secondBacklog).toEqual(firstBacklog);
      expect(translateCallCount).toBe(1);

      captureSocket.close();
      firstViewer.close();
      secondViewer.close();
    });

    it('a viewer subscribing after a reinstated correction sees the cached corrected translation, with no extra Gemini calls', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const firstViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(firstViewer);
      firstViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(firstViewer); // backlog: []

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });
      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const flagged = await transcriptPromise;

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":true,"reason":"ok"}}' });
        }
        return Promise.resolve({ text: '{"zh":"耶稣确实是神的儿子"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(firstViewer);
      captureSocket.send(
        JSON.stringify({ type: 'reinstate', id: flagged.id, english: 'Jesus is indeed the son of God' })
      );
      await ackPromise;
      await insertedPromise;

      expect(session.translationCache.get('zh', flagged.id)).toBe('耶稣确实是神的儿子');

      const callsBeforeSecondSubscribe = (geminiClient.models.generateContent as any).mock.calls.length;

      const secondViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(secondViewer);
      secondViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlogMessage = await waitForMessage(secondViewer);

      expect(backlogMessage).toEqual({
        type: 'backlog',
        lines: [{ id: flagged.id, english: 'Jesus is indeed the son of God', translated: '耶稣确实是神的儿子' }],
      });
      expect((geminiClient.models.generateContent as any).mock.calls.length).toBe(callsBeforeSecondSubscribe);

      captureSocket.close();
      firstViewer.close();
      secondViewer.close();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/wsServer.test.ts -t "translation cache"`
Expected: FAIL — the three new tests fail (the subscribe path doesn't consult the cache yet, so it still re-translates on every subscribe and the call-count/coalescing assertions don't hold).

- [ ] **Step 3: Add `ensureBacklogCached` and rewrite `handleViewerConnection`**

In `server/src/wsServer.ts`, the current `handleViewerConnection` function (the last function in the file) reads:

```ts
function handleViewerConnection(ws: WebSocket, deps: WsServerDeps): void {
  ws.on('message', (data) => {
    void (async () => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'subscribe') {
          const language = message.language as string;

          const backlog = deps.session.buffer.getRecent();
          if (backlog.length === 0) {
            ws.send(JSON.stringify({ type: 'backlog', lines: [] }));
            deps.session.addViewer(ws, language);
            return;
          }

          const visibleEntries = backlog.filter((line) => !line.suppressed);
          const translations = await translateBacklog(
            deps.geminiClient,
            visibleEntries.map((line) => line.english),
            language
          );
          const visibleLines = visibleEntries.map((line, index) => ({
            id: line.id,
            english: line.english,
            translated: translations[index] ?? '',
          }));

          const verificationItems: VerificationItem[] = visibleLines
            .filter((line) => line.translated.length > 0)
            .map((line) => ({ id: line.id, english: line.english, translated: line.translated }));
          const verifications = await verifyTranslationsWithRetry(
            deps.geminiClient,
            verificationItems,
            deps.session.sermonCache
          );

          const verifiedById = new Map(
            visibleLines.map((line) => {
              if (line.translated.length === 0) {
                return [line.id, { id: line.id, english: line.english, translated: line.english }] as const;
              }
              const verification = verifications[line.id];
              if (verification?.safe === true) return [line.id, line] as const;
              logTranslationFallback(
                language,
                line.english,
                line.translated,
                verification?.reason ?? 'verification unavailable'
              );
              return [line.id, { id: line.id, english: line.english, translated: line.english }] as const;
            })
          );

          const lines = backlog.map((line) =>
            line.suppressed
              ? { id: line.id, english: '', translated: '', removed: true }
              : verifiedById.get(line.id)!
          );

          ws.send(JSON.stringify({ type: 'backlog', lines }));
          deps.session.addViewer(ws, language);
        }
      } catch (error) {
        void logEvent('error', {
          event: 'viewer_message_error',
          error: error instanceof Error ? error.message : String(error),
        });
        ws.send(JSON.stringify({ type: 'backlog', lines: [] }));
      }
    })();
  });

  ws.on('close', () => deps.session.removeViewer(ws));
}
```

Replace it with:

```ts
async function ensureBacklogCached(
  deps: WsServerDeps,
  language: string,
  missingEntries: CaptionLine[]
): Promise<void> {
  if (missingEntries.length === 0) return;

  const cache = deps.session.translationCache;
  const fills = deps.session.inFlightFills;

  const existingFill = fills.get(language);
  if (existingFill) {
    await existingFill;
    const stillMissing = missingEntries.filter((line) => cache.get(language, line.id) === undefined);
    if (stillMissing.length === 0) return;
    return ensureBacklogCached(deps, language, stillMissing);
  }

  const fillPromise = (async () => {
    let translations: string[];
    try {
      translations = await translateBacklog(
        deps.geminiClient,
        missingEntries.map((line) => line.english),
        language
      );
    } catch (error) {
      void logEvent('error', {
        event: 'backlog_translation_failed',
        language,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const line of missingEntries) {
        cache.set(language, line.id, line.english);
      }
      return;
    }

    const verificationItems: VerificationItem[] = missingEntries
      .map((line, index) => ({ id: line.id, english: line.english, translated: translations[index] ?? '' }))
      .filter((item) => item.translated.length > 0);
    const verifications = await verifyTranslationsWithRetry(deps.geminiClient, verificationItems, deps.session.sermonCache);

    missingEntries.forEach((line, index) => {
      const translated = translations[index];
      if (!translated) {
        cache.set(language, line.id, line.english);
        return;
      }
      const verification = verifications[line.id];
      if (verification?.safe === true) {
        cache.set(language, line.id, translated);
        return;
      }
      logTranslationFallback(language, line.english, translated, verification?.reason ?? 'verification unavailable');
      cache.set(language, line.id, line.english);
    });
  })();

  fills.set(language, fillPromise);
  try {
    await fillPromise;
  } finally {
    fills.delete(language);
  }
}

function handleViewerConnection(ws: WebSocket, deps: WsServerDeps): void {
  ws.on('message', (data) => {
    void (async () => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'subscribe') {
          const language = message.language as string;
          const cache = deps.session.translationCache;

          const backlog = deps.session.buffer.getRecent();
          const visibleEntries = backlog.filter((line) => !line.suppressed);
          const missingEntries = visibleEntries.filter((line) => cache.get(language, line.id) === undefined);

          if (missingEntries.length > 0) {
            await ensureBacklogCached(deps, language, missingEntries);
          }

          const lines = backlog.map((line) =>
            line.suppressed
              ? { id: line.id, english: '', translated: '', removed: true }
              : { id: line.id, english: line.english, translated: cache.get(language, line.id) ?? line.english }
          );

          ws.send(JSON.stringify({ type: 'backlog', lines }));
          deps.session.addViewer(ws, language);
        }
      } catch (error) {
        void logEvent('error', {
          event: 'viewer_message_error',
          error: error instanceof Error ? error.message : String(error),
        });
        ws.send(JSON.stringify({ type: 'backlog', lines: [] }));
      }
    })();
  });

  ws.on('close', () => deps.session.removeViewer(ws));
}
```

Note the empty-backlog short-circuit from the old code is gone but not lost: when `backlog` is `[]`, `visibleEntries` and `missingEntries` are both `[]`, `ensureBacklogCached` is skipped, `lines` is `[]`, and the same `{ type: 'backlog', lines: [] }` is sent — one fewer special case, same behavior.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/wsServer.test.ts`
Expected: **all** tests in the file pass — both the pre-existing ones (every one of them is a first-ever subscribe to its language within a fresh `Session`, so the cache starts empty and they exercise the same "fill from scratch" path as before) and the new cache/coalescing tests from this task and Task 5.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full server test suite**

Run (from `server/`): `npm test`
Expected: all tests across every file pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "$(cat <<'EOF'
Make viewer subscribe cache-aware, with in-flight fill coalescing

Subscribe now only calls translateBacklog/verifyTranslations for
backlog lines missing from Session.translationCache, instead of
re-translating the whole visible backlog every time. Concurrent
first-time subscribes to the same not-yet-cached language share one
in-flight fill (Session.inFlightFills) rather than each firing their
own Gemini call — this is the actual fix for many viewers joining
within the same few seconds: most joins become pure cache hits with
zero Gemini calls, and the rare simultaneous cold joins collapse
into a single call instead of one per viewer.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** `TranslationCache` (get/set/clear) → Task 1. Populated for free in `finishPublishing` → Task 5. Cache-aware subscribe (only translate what's missing) → Task 6. In-flight coalescing via `Session.inFlightFills` and the recursive top-up in `ensureBacklogCached` → Task 6. Reinstate updating the cache automatically (falls out of `finishPublishing` being reused) → covered by Task 5's implementation note and directly asserted by Task 6's third new test. `GeminiCallLimiter` (fixed cap, FIFO queue, releases slot on rejection) → Task 2. Shared limiter wrapping all three Gemini call sites via one client decorator → Task 3 (`withGeminiLimiter`, wired once in `index.ts`, so `translateSegment`, `translateBacklog`, and `verifyTranslations` all funnel through the same underlying `client.models.generateContent`). `Session.start()` replacing rather than clearing `translationCache`/`inFlightFills` (the error-handling requirement from the spec) → Task 4. Cache-fill failure falling back to English and not being retried by coalesced waiters → Task 6's `ensureBacklogCached` catch block (caches the English fallback so `stillMissing` sees those ids as resolved). Out-of-scope items from the spec (configurable limiter cap, cross-restart persistence, proactive precomputation) have no corresponding tasks, as intended.
- **Placeholder scan:** no TBD/TODO; every step has complete, runnable code.
- **Type consistency:** `TranslationCache.get/set/clear` (Task 1) signatures match every call site in `Session` (Task 4) and `wsServer.ts` (Tasks 5–6). `GeminiCallLimiter.run<T>(fn: () => Promise<T>): Promise<T>` (Task 2) matches its one call site inside `withGeminiLimiter` (Task 3). `Session.translationCache: TranslationCache` and `Session.inFlightFills: Map<string, Promise<void>>` (Task 4) are the exact names/types `ensureBacklogCached` and `handleViewerConnection` read in Task 6 — no divergent naming (e.g. no `inFlightFill` vs `inFlightFills` mismatch). `ensureBacklogCached(deps: WsServerDeps, language: string, missingEntries: CaptionLine[]): Promise<void>` is used identically at its two call sites (the recursive top-up and `handleViewerConnection`).
- **Deviation from the spec worth flagging:** the spec's section 6 describes wrapping `client.models.generateContent(...)` individually at each of the three call sites (`translateSegment`, `translateBacklog`, `verifyTranslations`). This plan instead wraps the whole `GeminiClient` once via a `withGeminiLimiter` decorator (Task 3), composed with the existing `withCostTracking` decorator in `index.ts` — functionally identical (one shared limiter gates every outbound call), but it requires zero changes to `gemini.ts` or `translationVerifier.ts`, matches the codebase's own existing pattern for cross-cutting `GeminiClient` concerns, and needs no new test coverage in `gemini.test.ts`/`translationVerifier.test.ts`. This is a strict simplification, not a scope change.
