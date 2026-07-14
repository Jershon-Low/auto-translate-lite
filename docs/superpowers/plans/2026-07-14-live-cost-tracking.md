# Live Gemini + Deepgram Cost Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live, per-session and lifetime running dollar cost on the capture page, computed from Google's real per-call Gemini token counts and Deepgram's streaming duration, replacing the README's static hand-derived cost estimate with an actual auditable figure.

**Architecture:** A `CostTracker` (session + persisted lifetime totals, `data/cost.json`) is fed two ways: a transparent `GeminiClient` wrapper records real `usageMetadata` token counts from every Gemini call with zero changes to any existing Gemini call site, and `wsServer.ts`'s existing start/stop handling records Deepgram wall-clock duration. The tracker pushes updates to the capture page over a new `{ type: 'cost' }` WebSocket message via an explicit subscribe/unsubscribe callback, avoiding any change to the translation/verification code path.

**Tech Stack:** Node.js/TypeScript server (`@google/genai`, `ws`), Vitest for server tests; Next.js/React capture page (no automated frontend test infra in this repo — manual verification only, consistent with prior plans in this codebase).

## Global Constraints

- Model matches the existing translation/verification calls: `gemini-3.1-flash-lite`. Deepgram model: `nova-3`.
- Pricing (per [README.md's Cost analysis](../../../README.md), verified mid-2026 — do not re-derive): Gemini input $0.25/1M tokens, cached input $0.025/1M tokens, output $1.50/1M tokens; Deepgram `nova-3` streaming $0.0077/min.
- Cached prompt tokens are a **subset** of `promptTokenCount`, not additive — cost must be computed as `(promptTokens - cachedTokens)` at the standard input rate plus `cachedTokens` at the discounted cached rate, or cached tokens get double-billed.
- Session cost resets to zero on every capture `'start'`; the lifetime total persists across server restarts via `data/cost.json` and is never reset by this plan.
- **Sequencing:** a separate, in-progress effort (transcription-safety-check) is actively modifying `wsServer.ts`'s `handleFinalSegment` function and `capture/page.tsx`'s `transcript` message handling/rendering in this same worktree. This plan's `wsServer.ts` changes are confined to `handleCaptureConnection` (the `'start'`/`'stop'`/`close` handler) — a different function — and never touch `handleFinalSegment`. Its `capture/page.tsx` changes are additive (new state, new `'cost'` message branch, new display element) and never touch the existing `transcript` message branch or its rendering block. Before starting Task 4 or Task 6, re-read the current contents of `server/src/wsServer.ts` / `web/app/capture/page.tsx` — if the transcription-safety-check work has landed by then, apply this plan's edits against the file's actual current state rather than assuming the snapshots quoted below.
- Message ordering on the capture WebSocket matters for existing tests: `'status'` messages must remain the first message sent after `'start'`/`'stop'` is processed, exactly as today. `'cost'` broadcasts are only ever sent as a direct result of a real `recordGeminiUsage`/`recordDeepgramSeconds` call — never automatically on session reset — specifically to avoid ever inserting an unexpected extra message immediately after `'status: recording'`, where other tests (existing and pending) expect the next capture-socket message to be something specific.

---

### Task 1: Pricing config

**Files:**
- Create: `server/src/costPricing.ts`

**Interfaces:**
- Produces: `GEMINI_PRICING_USD_PER_MILLION_TOKENS`, `DEEPGRAM_PRICING_USD_PER_MINUTE`, both exported from `server/src/costPricing.ts`, consumed by Task 2 (`costTracker.ts`).

This is a pure data/constants file with no behavior to unit-test — same precedent as the existing `server/src/languages.ts`, which also has no dedicated test file. No TDD steps apply here.

- [ ] **Step 1: Create `costPricing.ts`**

Create `server/src/costPricing.ts`:

```ts
// Rates verified against Google's and Deepgram's published pricing as of mid-2026
// (see README.md's "Cost analysis" section, which these values match exactly).
// There is no live pricing API for either provider — update these manually if
// Google or Deepgram change their published rates.

export const GEMINI_PRICING_USD_PER_MILLION_TOKENS = {
  'gemini-3.1-flash-lite': {
    input: 0.25,
    cachedInput: 0.025,
    output: 1.5,
  },
} as const;

export const DEEPGRAM_PRICING_USD_PER_MINUTE = {
  'nova-3': 0.0077,
} as const;
```

- [ ] **Step 2: Commit**

```bash
git add server/src/costPricing.ts
git commit -m "feat: add Gemini and Deepgram pricing config for cost tracking"
```

---

### Task 2: `CostTracker`

**Files:**
- Create: `server/src/costTracker.ts`
- Create: `server/tests/costTracker.test.ts`

**Interfaces:**
- Consumes: `GEMINI_PRICING_USD_PER_MILLION_TOKENS`, `DEEPGRAM_PRICING_USD_PER_MINUTE` from `./costPricing.js` (Task 1); `logEvent` from `./logger.js` (existing).
- Produces: `GeminiUsage` interface, `CostTracker` interface, and `createCostTracker(filePath: string): CostTracker`, all exported from `server/src/costTracker.ts`, consumed by Task 3 (`geminiCostTracking.ts`), Task 4 (`wsServer.ts`), and Task 5 (`index.ts`).

`CostTracker`'s `record*` methods are synchronous (`void` return) and persist to disk synchronously (`node:fs`, not `node:fs/promises`) rather than firing an unawaited background write — deliberately, so a test can call `recordDeepgramSeconds(...)` and immediately read the file back without a race. Call volume is a handful of writes per minute of live sermon audio, which is negligible for a small local JSON file.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/costTracker.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCostTracker } from '../src/costTracker';

describe('createCostTracker', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('starts at zero for both session and lifetime when no file exists yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));
    expect(tracker.getSessionCostUsd()).toBe(0);
    expect(tracker.getLifetimeCostUsd()).toBe(0);
  });

  it('loads a prior lifetime total from an existing file', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const filePath = join(tempDir, 'cost.json');
    await writeFile(filePath, JSON.stringify({ lifetimeUsd: 12.5 }), 'utf-8');
    const tracker = createCostTracker(filePath);
    expect(tracker.getLifetimeCostUsd()).toBe(12.5);
    expect(tracker.getSessionCostUsd()).toBe(0);
  });

  it('treats a corrupt file as a zero starting balance', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const filePath = join(tempDir, 'cost.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const tracker = createCostTracker(filePath);
    expect(tracker.getLifetimeCostUsd()).toBe(0);
  });

  it('charges non-cached input at the standard rate, cached input at the discounted rate, and candidates at the output rate', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    // 1,000,000 prompt tokens, 200,000 of which came from cache; 100,000 candidate tokens.
    tracker.recordGeminiUsage({ promptTokens: 1_000_000, candidatesTokens: 100_000, cachedTokens: 200_000 });

    // 800k non-cached @ $0.25/1M = $0.20; 200k cached @ $0.025/1M = $0.005; 100k output @ $1.50/1M = $0.15
    expect(tracker.getSessionCostUsd()).toBeCloseTo(0.355, 6);
    expect(tracker.getLifetimeCostUsd()).toBeCloseTo(0.355, 6);
  });

  it('charges Deepgram usage at the per-minute rate', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    tracker.recordDeepgramSeconds(60);

    expect(tracker.getSessionCostUsd()).toBeCloseTo(0.0077, 6);
  });

  it('resets only the session total, leaving the lifetime total untouched', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    tracker.recordDeepgramSeconds(60);
    tracker.resetSession();

    expect(tracker.getSessionCostUsd()).toBe(0);
    expect(tracker.getLifetimeCostUsd()).toBeCloseTo(0.0077, 6);
  });

  it('does not notify subscribers on resetSession', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    const calls: Array<[number, number]> = [];
    tracker.onUpdate((sessionUsd, lifetimeUsd) => calls.push([sessionUsd, lifetimeUsd]));

    tracker.resetSession();

    expect(calls).toHaveLength(0);
  });

  it('persists the running lifetime total to disk synchronously after every update', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const filePath = join(tempDir, 'cost.json');
    const tracker = createCostTracker(filePath);

    tracker.recordDeepgramSeconds(60);

    const saved = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(saved.lifetimeUsd).toBeCloseTo(0.0077, 6);
  });

  it('notifies subscribers with the updated session and lifetime totals after a recording', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    const calls: Array<[number, number]> = [];
    tracker.onUpdate((sessionUsd, lifetimeUsd) => calls.push([sessionUsd, lifetimeUsd]));

    tracker.recordDeepgramSeconds(60);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeCloseTo(0.0077, 6);
    expect(calls[0][1]).toBeCloseTo(0.0077, 6);
  });

  it('stops notifying a listener after it unsubscribes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    const calls: Array<[number, number]> = [];
    const unsubscribe = tracker.onUpdate((sessionUsd, lifetimeUsd) => calls.push([sessionUsd, lifetimeUsd]));
    unsubscribe();

    tracker.recordDeepgramSeconds(60);

    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/costTracker.test.ts`
Expected: FAIL — `Cannot find module '../src/costTracker'`

- [ ] **Step 3: Create `costTracker.ts`**

Create `server/src/costTracker.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GEMINI_PRICING_USD_PER_MILLION_TOKENS, DEEPGRAM_PRICING_USD_PER_MINUTE } from './costPricing.js';
import { logEvent } from './logger.js';

export interface GeminiUsage {
  promptTokens: number;
  candidatesTokens: number;
  cachedTokens: number;
}

export interface CostTracker {
  recordGeminiUsage(usage: GeminiUsage): void;
  recordDeepgramSeconds(seconds: number): void;
  resetSession(): void;
  getSessionCostUsd(): number;
  getLifetimeCostUsd(): number;
  onUpdate(listener: (sessionUsd: number, lifetimeUsd: number) => void): () => void;
}

function loadLifetimeUsd(filePath: string): number {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { lifetimeUsd?: unknown };
    return typeof parsed.lifetimeUsd === 'number' ? parsed.lifetimeUsd : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      void logEvent('warn', {
        event: 'cost_file_load_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return 0;
  }
}

export function createCostTracker(filePath: string): CostTracker {
  let sessionUsd = 0;
  let lifetimeUsd = loadLifetimeUsd(filePath);
  const listeners = new Set<(sessionUsd: number, lifetimeUsd: number) => void>();

  function persist(): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify({ lifetimeUsd }), 'utf-8');
    } catch (error) {
      void logEvent('warn', {
        event: 'cost_file_write_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function notify(): void {
    for (const listener of listeners) listener(sessionUsd, lifetimeUsd);
  }

  function addCost(usd: number): void {
    sessionUsd += usd;
    lifetimeUsd += usd;
    persist();
    notify();
  }

  return {
    recordGeminiUsage(usage: GeminiUsage): void {
      const pricing = GEMINI_PRICING_USD_PER_MILLION_TOKENS['gemini-3.1-flash-lite'];
      const nonCachedPromptTokens = Math.max(0, usage.promptTokens - usage.cachedTokens);
      const cost =
        (nonCachedPromptTokens / 1_000_000) * pricing.input +
        (usage.cachedTokens / 1_000_000) * pricing.cachedInput +
        (usage.candidatesTokens / 1_000_000) * pricing.output;
      addCost(cost);
    },
    recordDeepgramSeconds(seconds: number): void {
      const rate = DEEPGRAM_PRICING_USD_PER_MINUTE['nova-3'];
      addCost((seconds / 60) * rate);
    },
    resetSession(): void {
      sessionUsd = 0;
    },
    getSessionCostUsd(): number {
      return sessionUsd;
    },
    getLifetimeCostUsd(): number {
      return lifetimeUsd;
    },
    onUpdate(listener: (sessionUsd: number, lifetimeUsd: number) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/costTracker.test.ts`
Expected: PASS (all 10 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/costTracker.ts server/tests/costTracker.test.ts
git commit -m "feat: add CostTracker with session/lifetime totals persisted to disk"
```

---

### Task 3: Transparent Gemini client cost wrapper

**Files:**
- Modify: `server/src/gemini.ts` (widen `GeminiClient`'s response type only — no logic changes)
- Create: `server/src/geminiCostTracking.ts`
- Create: `server/tests/geminiCostTracking.test.ts`

**Interfaces:**
- Consumes: `GeminiClient` from `./gemini.js` (widened in this task); `CostTracker` from `./costTracker.js` (Task 2).
- Produces: `withCostTracking(client: GeminiClient, tracker: CostTracker): GeminiClient`, exported from `server/src/geminiCostTracking.ts`, consumed by Task 5 (`index.ts`).

This task does not modify `translateSegment`, `translateBacklog`, `verifyTranslations`, `createSermonContextCache`, `deleteSermonContextCache`, or the in-progress `transcriptionVerifier.ts` — every one of them keeps calling `generateContent`/`caches.create`/`caches.delete` exactly as today. `index.ts` (Task 5) will pass a *wrapped* client into `attachWsServer`, so every current and future call site is covered automatically without being touched.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/geminiCostTracking.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { withCostTracking } from '../src/geminiCostTracking';
import type { GeminiClient } from '../src/gemini';
import type { CostTracker } from '../src/costTracker';

function fakeClient(usageMetadata?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: '{}', usageMetadata }),
    },
    caches: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
}

function fakeCostTracker(): CostTracker {
  return {
    recordGeminiUsage: vi.fn(),
    recordDeepgramSeconds: vi.fn(),
    resetSession: vi.fn(),
    getSessionCostUsd: vi.fn().mockReturnValue(0),
    getLifetimeCostUsd: vi.fn().mockReturnValue(0),
    onUpdate: vi.fn().mockReturnValue(() => {}),
  };
}

describe('withCostTracking', () => {
  it('records Gemini usage from the response and still returns the original response', async () => {
    const client = fakeClient({ promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 10 });
    const tracker = fakeCostTracker();
    const wrapped = withCostTracking(client, tracker);

    const response = await wrapped.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: 'hi',
      config: { responseMimeType: 'application/json', responseSchema: {} },
    });

    expect(response).toEqual({
      text: '{}',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 10 },
    });
    expect(tracker.recordGeminiUsage).toHaveBeenCalledWith({
      promptTokens: 100,
      candidatesTokens: 20,
      cachedTokens: 10,
    });
  });

  it('defaults missing token counts to zero', async () => {
    const client = fakeClient({});
    const tracker = fakeCostTracker();
    const wrapped = withCostTracking(client, tracker);

    await wrapped.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: 'hi',
      config: { responseMimeType: 'application/json', responseSchema: {} },
    });

    expect(tracker.recordGeminiUsage).toHaveBeenCalledWith({
      promptTokens: 0,
      candidatesTokens: 0,
      cachedTokens: 0,
    });
  });

  it('does not record usage when the response has no usageMetadata', async () => {
    const client = fakeClient(undefined);
    const tracker = fakeCostTracker();
    const wrapped = withCostTracking(client, tracker);

    await wrapped.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: 'hi',
      config: { responseMimeType: 'application/json', responseSchema: {} },
    });

    expect(tracker.recordGeminiUsage).not.toHaveBeenCalled();
  });

  it('passes the caches object through unchanged, without tracking cache creation', async () => {
    const client = fakeClient();
    const tracker = fakeCostTracker();
    const wrapped = withCostTracking(client, tracker);

    expect(wrapped.caches).toBe(client.caches);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/geminiCostTracking.test.ts`
Expected: FAIL — `Cannot find module '../src/geminiCostTracking'`

- [ ] **Step 3: Widen `GeminiClient`'s response type in `gemini.ts`**

In `server/src/gemini.ts`, replace:

```ts
export interface GeminiClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config: {
        responseMimeType: string;
        responseSchema: Record<string, unknown>;
        cachedContent?: string;
      };
    }): Promise<{ text: string | null | undefined }>;
  };
  caches: {
    create(params: {
      model: string;
      config: { systemInstruction: string; ttl: string; displayName?: string };
    }): Promise<{ name?: string }>;
    delete(params: { name: string }): Promise<unknown>;
  };
}
```

with:

```ts
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config: {
        responseMimeType: string;
        responseSchema: Record<string, unknown>;
        cachedContent?: string;
      };
    }): Promise<{ text: string | null | undefined; usageMetadata?: GeminiUsageMetadata }>;
  };
  caches: {
    create(params: {
      model: string;
      config: { systemInstruction: string; ttl: string; displayName?: string };
    }): Promise<{ name?: string }>;
    delete(params: { name: string }): Promise<unknown>;
  };
}
```

This only widens the return type (`usageMetadata` is optional) — every existing caller and every existing fake `GeminiClient` in other test files stays valid unchanged.

- [ ] **Step 4: Create `geminiCostTracking.ts`**

Create `server/src/geminiCostTracking.ts`:

```ts
import type { GeminiClient } from './gemini.js';
import type { CostTracker } from './costTracker.js';

export function withCostTracking(client: GeminiClient, tracker: CostTracker): GeminiClient {
  return {
    models: {
      async generateContent(params) {
        const response = await client.models.generateContent(params);
        const usage = response.usageMetadata;
        if (usage) {
          tracker.recordGeminiUsage({
            promptTokens: usage.promptTokenCount ?? 0,
            candidatesTokens: usage.candidatesTokenCount ?? 0,
            cachedTokens: usage.cachedContentTokenCount ?? 0,
          });
        }
        return response;
      },
    },
    caches: client.caches,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/geminiCostTracking.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Run the full server test suite to confirm the type widening didn't break anything**

Run: `cd server && npm test`
Expected: PASS (every existing suite — `gemini.test.ts`, `translationVerifier.test.ts`, `transcriptionVerifier.test.ts`, `wsServer.test.ts`, `sermonCache.test.ts`, etc. — none of which this task's logic touches, only an additive optional type field)

- [ ] **Step 7: Commit**

```bash
git add server/src/gemini.ts server/src/geminiCostTracking.ts server/tests/geminiCostTracking.test.ts
git commit -m "feat: add transparent GeminiClient wrapper that records real token usage"
```

---

### Task 4: Wire Deepgram timing and cost broadcast into `wsServer.ts`

**Files:**
- Modify: `server/src/wsServer.ts` — **only** `handleCaptureConnection`; do not touch `handleFinalSegment` or anything below it (see Global Constraints).
- Modify: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `CostTracker` from `./costTracker.js` (Task 2).
- Produces: `WsServerDeps` gains a required `costTracker: CostTracker` field, consumed by Task 5 (`index.ts`). No other exports change.

Before starting, re-read the current `server/src/wsServer.ts` and `server/tests/wsServer.test.ts` — if the transcription-safety-check work has landed, `handleFinalSegment` and parts of the test file will differ from the snapshots below, but `handleCaptureConnection` and the shared `beforeEach`/`attachWsServer` setup block should still match, since that other plan explicitly leaves them untouched.

- [ ] **Step 1: Update test imports, fakes, and `beforeEach`**

In `server/tests/wsServer.test.ts`, add this import directly below the existing `import type { FeedbackStore } from '../src/feedbackStore';` line:

```ts
import type { CostTracker } from '../src/costTracker';
```

Add this helper directly below the existing `fakeFeedbackStore` function:

```ts
function fakeCostTracker(): CostTracker & { listeners: Set<(sessionUsd: number, lifetimeUsd: number) => void> } {
  let sessionUsd = 0;
  let lifetimeUsd = 0;
  const listeners = new Set<(sessionUsd: number, lifetimeUsd: number) => void>();
  return {
    listeners,
    recordGeminiUsage: vi.fn(),
    recordDeepgramSeconds: vi.fn((seconds: number) => {
      sessionUsd += seconds * 0.001;
      lifetimeUsd += seconds * 0.001;
      for (const listener of listeners) listener(sessionUsd, lifetimeUsd);
    }),
    resetSession: vi.fn(() => {
      sessionUsd = 0;
    }),
    getSessionCostUsd: vi.fn(() => sessionUsd),
    getLifetimeCostUsd: vi.fn(() => lifetimeUsd),
    onUpdate: vi.fn((listener: (sessionUsd: number, lifetimeUsd: number) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
}
```

In the `describe('wsServer', () => { ... })` block, replace:

```ts
  let httpServer: Server;
  let port: number;
  let session: Session;
  let capturedCallbacks: DeepgramCallbacks | null;
  let geminiClient: GeminiClient;
  let sermonDocStore: SermonDocStore;
  let feedbackStore: FeedbackStore;

  beforeEach(async () => {
    session = new Session();
    capturedCallbacks = null;
    httpServer = createServer();

    geminiClient = fakeGeminiClient();
    sermonDocStore = createSermonDocStore();
    feedbackStore = fakeFeedbackStore();

    attachWsServer({
      httpServer,
      session,
      geminiClient,
      deepgramApiKey: 'fake-key',
      createDeepgramConnection: (_apiKey, callbacks) => {
        capturedCallbacks = callbacks;
        return { send: vi.fn(), finish: vi.fn() };
      },
      sermonDocStore,
      feedbackStore,
    });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });
```

with:

```ts
  let httpServer: Server;
  let port: number;
  let session: Session;
  let capturedCallbacks: DeepgramCallbacks | null;
  let geminiClient: GeminiClient;
  let sermonDocStore: SermonDocStore;
  let feedbackStore: FeedbackStore;
  let costTracker: ReturnType<typeof fakeCostTracker>;

  beforeEach(async () => {
    session = new Session();
    capturedCallbacks = null;
    httpServer = createServer();

    geminiClient = fakeGeminiClient();
    sermonDocStore = createSermonDocStore();
    feedbackStore = fakeFeedbackStore();
    costTracker = fakeCostTracker();

    attachWsServer({
      httpServer,
      session,
      geminiClient,
      deepgramApiKey: 'fake-key',
      createDeepgramConnection: (_apiKey, callbacks) => {
        capturedCallbacks = callbacks;
        return { send: vi.fn(), finish: vi.fn() };
      },
      sermonDocStore,
      feedbackStore,
      costTracker,
    });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });
```

- [ ] **Step 2: Write the new failing tests**

Add this new `describe` block directly before the final closing `});` of `describe('wsServer', ...)` — i.e. after whatever is currently the last `describe`/`it` block in the file:

```ts
  describe('cost tracking', () => {
    it('resets the session cost tracker and subscribes to updates when a capture session starts', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(costTracker.resetSession).toHaveBeenCalledTimes(1);
      expect(costTracker.onUpdate).toHaveBeenCalledTimes(1);

      captureSocket.close();
    });

    it('sends a cost update to the capture socket whenever the tracker reports new totals', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const costPromise = waitForMessage(captureSocket);
      for (const listener of costTracker.listeners) listener(0.0032, 14.82);
      const cost = await costPromise;

      expect(cost).toEqual({ type: 'cost', sessionUsd: 0.0032, lifetimeUsd: 14.82 });

      captureSocket.close();
    });

    it('sends status:idle before the final cost update on stop, and records Deepgram seconds', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      captureSocket.send(JSON.stringify({ type: 'stop' }));
      const idleStatus = await waitForMessage(captureSocket);
      expect(idleStatus).toEqual({ type: 'status', status: 'idle' });

      const finalCost = await waitForMessage(captureSocket);
      expect(finalCost.type).toBe('cost');

      expect(costTracker.recordDeepgramSeconds).toHaveBeenCalledTimes(1);
      const elapsedSeconds = (costTracker.recordDeepgramSeconds as any).mock.calls[0][0];
      expect(elapsedSeconds).toBeGreaterThanOrEqual(0);
      expect(elapsedSeconds).toBeLessThan(5);

      captureSocket.close();
    });

    it('stops sending cost updates after stop, even if the tracker fires again', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      captureSocket.send(JSON.stringify({ type: 'stop' }));
      await waitForMessage(captureSocket); // status: idle
      await waitForMessage(captureSocket); // final cost update

      expect(costTracker.listeners.size).toBe(0);

      captureSocket.close();
    });

    it('records Deepgram seconds on an abrupt close without an explicit stop', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      captureSocket.close();
      await new Promise((resolve) => setImmediate(resolve));

      expect(costTracker.recordDeepgramSeconds).toHaveBeenCalledTimes(1);
    });

    it('does not double-record Deepgram seconds when close fires after an explicit stop', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      captureSocket.send(JSON.stringify({ type: 'stop' }));
      await waitForMessage(captureSocket); // status: idle
      await waitForMessage(captureSocket); // final cost update
      captureSocket.close();
      await new Promise((resolve) => setImmediate(resolve));

      expect(costTracker.recordDeepgramSeconds).toHaveBeenCalledTimes(1);
    });
  });
```

- [ ] **Step 3: Run tests to verify the new ones fail and existing ones still pass**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: The 6 new tests in `describe('cost tracking', ...)` FAIL (production `WsServerDeps`/`handleCaptureConnection` doesn't reference `costTracker` yet, so `resetSession`/`onUpdate`/`recordDeepgramSeconds` are never called and no `'cost'` message is ever sent). All pre-existing tests should still PASS, since Step 1 only added an extra dependency to the shared setup without changing any existing test's assertions.

- [ ] **Step 4: Update `wsServer.ts`**

In `server/src/wsServer.ts`, add this import directly below the existing `import type { FeedbackStore } from './feedbackStore.js';` line:

```ts
import type { CostTracker } from './costTracker.js';
```

Replace the `WsServerDeps` interface:

```ts
export interface WsServerDeps {
  httpServer: HttpServer;
  session: Session;
  geminiClient: GeminiClient;
  deepgramApiKey: string;
  createDeepgramConnection: DeepgramConnectionFactory;
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
}
```

with:

```ts
export interface WsServerDeps {
  httpServer: HttpServer;
  session: Session;
  geminiClient: GeminiClient;
  deepgramApiKey: string;
  createDeepgramConnection: DeepgramConnectionFactory;
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
  costTracker: CostTracker;
}
```

Replace the entire `handleCaptureConnection` function:

```ts
function handleCaptureConnection(ws: WebSocket, deps: WsServerDeps): void {
  let deepgramConnection: DeepgramConnection | null = null;

  ws.on('message', (data, isBinary) => {
    void (async () => {
      try {
        if (!isBinary) {
          const message = JSON.parse(data.toString());
          if (message.type === 'start') {
            deps.session.start();

            const sermonText = deps.sermonDocStore.get();
            if (sermonText) {
              const feedbackText = await deps.feedbackStore.read();
              deps.session.sermonCache = await createSermonContextCache(
                deps.geminiClient,
                feedbackText,
                sermonText
              );
            }

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
            await deleteSermonContextCache(deps.geminiClient, deps.session.sermonCache);
            deps.session.sermonCache = null;
            deepgramConnection?.finish();
            deepgramConnection = null;
            ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
          }
        } else if (deepgramConnection) {
          deepgramConnection.send(data as Buffer);
        }
      } catch (error) {
        void logEvent('error', {
          event: 'capture_message_error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  ws.on('close', () => {
    deps.session.stop();
    void deleteSermonContextCache(deps.geminiClient, deps.session.sermonCache).then(() => {
      deps.session.sermonCache = null;
    });
    deepgramConnection?.finish();
  });
}
```

with:

```ts
function handleCaptureConnection(ws: WebSocket, deps: WsServerDeps): void {
  let deepgramConnection: DeepgramConnection | null = null;
  let recordingStartedAt: number | null = null;
  let unsubscribeCost: (() => void) | null = null;

  function finalizeDeepgramCost(): void {
    if (recordingStartedAt !== null) {
      const elapsedSeconds = (Date.now() - recordingStartedAt) / 1000;
      deps.costTracker.recordDeepgramSeconds(elapsedSeconds);
      recordingStartedAt = null;
    }
  }

  ws.on('message', (data, isBinary) => {
    void (async () => {
      try {
        if (!isBinary) {
          const message = JSON.parse(data.toString());
          if (message.type === 'start') {
            deps.session.start();

            const sermonText = deps.sermonDocStore.get();
            if (sermonText) {
              const feedbackText = await deps.feedbackStore.read();
              deps.session.sermonCache = await createSermonContextCache(
                deps.geminiClient,
                feedbackText,
                sermonText
              );
            }

            deepgramConnection = deps.createDeepgramConnection(deps.deepgramApiKey, {
              onFinalSegment: (text) => {
                void handleFinalSegment(text, deps, ws);
              },
              onError: () => {
                ws.send(JSON.stringify({ type: 'status', status: 'error' }));
              },
              onClose: () => {},
            });
            recordingStartedAt = Date.now();
            ws.send(JSON.stringify({ type: 'status', status: 'recording' }));

            deps.costTracker.resetSession();
            unsubscribeCost = deps.costTracker.onUpdate((sessionUsd, lifetimeUsd) => {
              ws.send(JSON.stringify({ type: 'cost', sessionUsd, lifetimeUsd }));
            });
          } else if (message.type === 'stop') {
            deps.session.stop();
            await deleteSermonContextCache(deps.geminiClient, deps.session.sermonCache);
            deps.session.sermonCache = null;
            deepgramConnection?.finish();
            deepgramConnection = null;
            ws.send(JSON.stringify({ type: 'status', status: 'idle' }));

            finalizeDeepgramCost();
            unsubscribeCost?.();
            unsubscribeCost = null;
          }
        } else if (deepgramConnection) {
          deepgramConnection.send(data as Buffer);
        }
      } catch (error) {
        void logEvent('error', {
          event: 'capture_message_error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  ws.on('close', () => {
    deps.session.stop();
    void deleteSermonContextCache(deps.geminiClient, deps.session.sermonCache).then(() => {
      deps.session.sermonCache = null;
    });
    deepgramConnection?.finish();

    // Unsubscribe before finalizing: the socket is already closed by the time
    // this event fires, so the cost-update listener must not attempt a send.
    unsubscribeCost?.();
    unsubscribeCost = null;
    finalizeDeepgramCost();
  });
}
```

Note the deliberate asymmetry: on `'stop'`, the final cost update is sent (socket is still open), so `finalizeDeepgramCost()` runs *before* unsubscribing. On `'close'`, the socket is already gone, so unsubscribing happens *first* to guarantee the listener never attempts `ws.send()` on a closed socket.

- [ ] **Step 5: Run tests to verify everything passes**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: PASS (all tests, including the 6 new ones and every pre-existing test)

- [ ] **Step 6: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS (all suites)

- [ ] **Step 7: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "feat: track Deepgram session duration and broadcast live cost updates to the capture page"
```

---

### Task 5: Wire everything together in `index.ts`

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/.env.example`

**Interfaces:**
- Consumes: `createCostTracker` from `./costTracker.js` (Task 2), `withCostTracking` from `./geminiCostTracking.js` (Task 3), the updated `WsServerDeps` from `./wsServer.js` (Task 4).
- Produces: nothing new — this is bootstrap wiring, no exports change. No dedicated test file, matching this codebase's existing precedent (`index.ts` has no `index.test.ts`).

- [ ] **Step 1: Update `index.ts`**

Replace the full contents of `server/src/index.ts`:

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

const app = createApp({ sermonDocStore, feedbackStore });
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

- [ ] **Step 2: Add the new env var to `.env.example`**

In `server/.env.example`, replace:

```
DEEPGRAM_API_KEY=
GEMINI_API_KEY=
PORT=3001
FEEDBACK_FILE_PATH=data/feedback.txt
LOG_FILE_PATH=data/events.log
```

with:

```
DEEPGRAM_API_KEY=
GEMINI_API_KEY=
PORT=3001
FEEDBACK_FILE_PATH=data/feedback.txt
LOG_FILE_PATH=data/events.log
COST_FILE_PATH=data/cost.json
```

- [ ] **Step 3: Run the full server test suite and the build**

Run: `cd server && npm test && npm run build`
Expected: All tests PASS; `npm run build` (a `tsc` typecheck/compile) completes with no errors — this is the step that would catch any wiring mistake (e.g. a missing `costTracker` field) that vitest's non-type-checked test runner wouldn't.

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts server/.env.example
git commit -m "feat: wire CostTracker and the cost-tracking Gemini client wrapper into the server"
```

---

### Task 6: Capture page shows the live cost readout

**Files:**
- Modify: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: the new `{ type: 'cost', sessionUsd: number, lifetimeUsd: number }` WebSocket message produced by Task 4.
- Produces: no exports — this is a leaf UI component.

Before starting, re-read the current `web/app/capture/page.tsx` — if the transcription-safety-check work has landed, its `transcriptLines` state shape and rendering block will differ from the snapshot below, but this task's edits are additive (new state, a new `else if` branch, a new paragraph) and shouldn't need to touch those lines either way.

- [ ] **Step 1: Add session/lifetime cost state**

In `web/app/capture/page.tsx`, replace:

```tsx
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [transcriptLines, setTranscriptLines] = useState<string[]>([]);
```

with:

```tsx
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [transcriptLines, setTranscriptLines] = useState<string[]>([]);
  const [sessionCostUsd, setSessionCostUsd] = useState(0);
  const [lifetimeCostUsd, setLifetimeCostUsd] = useState(0);
```

(If the transcription-safety-check work has already changed `transcriptLines`' type, e.g. to `{ text: string; flagged: boolean }[]`, leave that line as-is and only add the two new `sessionCostUsd`/`lifetimeCostUsd` lines after it.)

- [ ] **Step 2: Handle the new `'cost'` WebSocket message**

In the `socket.onmessage` handler, replace:

```tsx
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'status') {
        setStatus(message.status);
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => [...previous.slice(-49), message.english]);
      }
    };
```

with:

```tsx
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'status') {
        setStatus(message.status);
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => [...previous.slice(-49), message.english]);
      } else if (message.type === 'cost') {
        setSessionCostUsd(message.sessionUsd);
        setLifetimeCostUsd(message.lifetimeUsd);
      }
    };
```

(If the transcription-safety-check work has already changed the `'transcript'` branch's body, leave it as-is and only add the new `else if (message.type === 'cost')` branch after it.)

- [ ] **Step 3: Reset the session figure to zero when a new recording starts**

Replace:

```tsx
  function start() {
    manuallyStoppedRef.current = false;
    setErrorMessage(null);
    connectSocket();
  }
```

with:

```tsx
  function start() {
    manuallyStoppedRef.current = false;
    setErrorMessage(null);
    setSessionCostUsd(0);
    connectSocket();
  }
```

- [ ] **Step 4: Display the cost readout**

Replace:

```tsx
      <p className="text-sm text-muted-foreground">Status: {status}</p>
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
```

with:

```tsx
      <p className="text-sm text-muted-foreground">Status: {status}</p>
      <p className="text-sm text-muted-foreground">
        Session: ${sessionCostUsd.toFixed(4)} · Lifetime: ${lifetimeCostUsd.toFixed(2)}
      </p>
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
```

- [ ] **Step 5: Manual verification**

This repo has no automated frontend test infrastructure (consistent with prior plans in this codebase). Verify manually:

Run: `cd server && npm run dev` (first terminal) and `cd web && npm run dev` (second terminal)

1. Open `http://localhost:3000/capture`, click Start.
2. Confirm "Session: $0.0000 · Lifetime: $0.00" (or a nonzero lifetime figure, if `server/data/cost.json` already has one) appears near the Status line.
3. Speak a sentence into the mic. Once it's transcribed and translated, confirm the session figure ticks up from $0.0000 (Gemini calls cost fractions of a cent per sentence, so expect small increments like $0.0001–$0.0005).
4. Click Stop, then Start again. Confirm the session figure resets to $0.0000 while the lifetime figure keeps its accumulated value.
5. Stop the server (Ctrl+C) and restart it (`npm run dev` again). Reload the capture page and click Start. Confirm the lifetime figure shown matches what it was before the restart, proving `server/data/cost.json` persisted it.

- [ ] **Step 6: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "feat: show live session and lifetime API cost on the capture page"
```

---

### Task 7: README updates

**Files:**
- Modify: `README.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Note that the cost estimate is now live-tracked**

In `README.md`, find this paragraph (in the `## Cost analysis` section):

```markdown
For a typical church running one ~60-minute translated service a week, that's **roughly $3.50–$5/month in API usage** — the AWS free tier (or a ~$5–10/month VPS after it expires) covers hosting on top of that. There's no seat licensing, no per-viewer surcharge, and no cost incurred outside of active Start/Stop sessions.
```

Insert this new paragraph directly after it, **before** the existing `*(Pricing verified against Deepgram's and Google's published rates...` italicized paragraph:

```markdown
The server also tracks this live: every Gemini call's real token usage (from the API response's `usageMetadata`, not an estimate) and every session's Deepgram streaming duration are converted to dollars using the rates below and shown as a running session/lifetime total on the capture page, persisted to `server/data/cost.json`. The table above is the *a priori* estimate; the capture page shows the *actual* running total for real usage.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: note that the cost estimate is now live-tracked, not just a priori"
```
