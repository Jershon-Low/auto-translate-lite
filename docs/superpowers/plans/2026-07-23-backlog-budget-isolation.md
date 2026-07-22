# Backlog Budget Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the on-subscribe backlog fill a small, lower-priority carve-out of the shared OpenRouter budget so live captions are never queued behind backlog calls, with no increase in the total load OpenRouter sees.

**Architecture:** Keep one OpenRouter concurrency limiter and one rate limiter, but make both reservation- and priority-aware: backlog calls may occupy at most a small sub-cap of each budget, and live waiters are always admitted before backlog waiters. Route the backlog path (`translateBacklog` + its `verifyTranslations`) through a second OpenRouter client wrapper tagged `backlog` and a new `session.backlogProviders` set; the live path keeps using `session.providers`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node.js, `ws`, Vitest.

## Global Constraints

- Reuse the existing limiter classes in place; **all additions are backward-compatible** — a call with no explicit priority behaves as `live`, and each new sub-cap constructor argument defaults to "no restriction" (equal to the corresponding total), so every current construction and the entire Gemini path behave exactly as today.
- Shared priority type (exact): `export type CallPriority = 'live' | 'backlog';`, defined and exported from `server/src/geminiLimiter.ts`.
- Concurrency limiter constructor (exact): `constructor(maxConcurrent = 8, backlogMaxConcurrent = maxConcurrent)`. Method (exact): `run<T>(fn: () => Promise<T>, priority: CallPriority = 'live'): Promise<T>`.
- Rate limiter constructor (exact): `constructor(maxPerWindow = 5, windowMs = 2000, backlogMaxPerWindow = maxPerWindow)`. Method (exact): `run<T>(fn: () => Promise<T>, priority: CallPriority = 'live'): Promise<T>`.
- Wrapper signature (exact): `withOpenRouterLimiter(client, limiter, rateLimiter?, priority: CallPriority = 'live')`.
- New `WsServerDeps` field (exact): `backlogLlmClients: LlmClients;`.
- New `Session` field (exact): `backlogProviders: BacklogProviders | null = null;` (type `BacklogProviders { translation: LlmProvider; translationVerifier: LlmProvider }` in `server/src/llmTypes.ts`).
- Env var names + defaults (exact): `OPENROUTER_MAX_CONCURRENT` (8), `OPENROUTER_BACKLOG_MAX_CONCURRENT` (2), `OPENROUTER_BACKLOG_MAX_CALLS_PER_WINDOW` (1). Existing `OPENROUTER_MAX_CALLS_PER_WINDOW` (5) and `OPENROUTER_RATE_WINDOW_MS` (2000) are unchanged.
- Default carve-out sizes: backlog ≤ 2 concurrent (reserving ≥ 6 for live) and ≤ 1 call / 2s (reserving ≥ 4 for live). These are strictly *within* today's totals of 8 and 5/2s.
- ESM imports within `server/src` use `.js` specifiers (e.g. `'./geminiLimiter.js'`), even though source files are `.ts`. Test files under `server/tests` import from `'../src/...'` without the `.js` suffix (match existing tests).
- Server-only change. No files under `web/` are touched.
- Run all commands from the `server/` directory. Tests: `npm test` (Vitest). Type-check/build: `npm run build`.

---

### Task 1: Reservation- and priority-aware concurrency limiter

**Files:**
- Modify: `server/src/geminiLimiter.ts` (add `CallPriority`; extend `GeminiCallLimiter`)
- Test: `server/tests/geminiLimiter.test.ts` (add new cases; keep existing green)

**Interfaces:**
- Produces: `export type CallPriority = 'live' | 'backlog'` and an extended `GeminiCallLimiter` whose `run(fn, priority?)` accepts a priority and whose constructor takes `(maxConcurrent = 8, backlogMaxConcurrent = maxConcurrent)`. Backlog concurrency is capped at `backlogMaxConcurrent`; queued live calls are admitted before queued backlog calls.

- [ ] **Step 1: Write the failing tests**

In `server/tests/geminiLimiter.test.ts`, add these four `it(...)` blocks immediately before the closing `});` of the `describe('GeminiCallLimiter', ...)` block (the existing `deferred<T>()` helper is already defined at the top of the file):

```ts
  it('caps concurrent backlog calls at backlogMaxConcurrent', async () => {
    const limiter = new GeminiCallLimiter(3, 1);
    const calls = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started = [false, false, false];

    const runs = calls.map((entry, index) =>
      limiter.run(() => {
        started[index] = true;
        return entry.promise;
      }, 'backlog')
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([true, false, false]); // only 1 backlog runs at a time

    calls[0].resolve('a');
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([true, true, false]); // freed slot admits the next backlog

    calls[1].resolve('b');
    calls[2].resolve('c');
    await Promise.all(runs);
  });

  it('admits a queued live call ahead of a queued backlog call', async () => {
    const limiter = new GeminiCallLimiter(1, 1);
    const first = deferred<string>();
    const queuedLive = deferred<string>();
    let liveStarted = false;
    let backlogStarted = false;

    const runFirst = limiter.run(() => first.promise, 'live'); // occupies the only slot
    await new Promise((resolve) => setImmediate(resolve));

    const runBacklog = limiter.run(() => {
      backlogStarted = true;
      return Promise.resolve('b');
    }, 'backlog');
    const runLive = limiter.run(() => {
      liveStarted = true;
      return queuedLive.promise;
    }, 'live');

    await new Promise((resolve) => setImmediate(resolve));
    expect([liveStarted, backlogStarted]).toEqual([false, false]);

    first.resolve('x');
    await new Promise((resolve) => setImmediate(resolve));
    expect(liveStarted).toBe(true); // live jumps ahead of the queued backlog
    expect(backlogStarted).toBe(false); // slot now held by the queued live call

    queuedLive.resolve('y');
    await new Promise((resolve) => setImmediate(resolve));
    expect(backlogStarted).toBe(true); // backlog runs once a slot frees

    await Promise.all([runFirst, runLive, runBacklog]);
  });

  it('does not starve live: reserves maxConcurrent - backlogMaxConcurrent slots for live', async () => {
    const limiter = new GeminiCallLimiter(3, 1);
    const backlog = deferred<string>();
    const runBacklog = limiter.run(() => backlog.promise, 'backlog'); // holds 1 slot
    await new Promise((resolve) => setImmediate(resolve));

    const live = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started = [false, false, false];
    const liveRuns = live.map((entry, index) =>
      limiter.run(() => {
        started[index] = true;
        return entry.promise;
      }, 'live')
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([true, true, false]); // 2 live run alongside 1 backlog (active = 3 = max)

    backlog.resolve('b');
    live.forEach((entry, index) => entry.resolve(String(index)));
    await Promise.all([runBacklog, ...liveRuns]);
  });

  it('leaves backlog unrestricted when no backlog cap is given (backward compatible)', async () => {
    const limiter = new GeminiCallLimiter(2); // backlogMaxConcurrent defaults to 2
    const first = deferred<string>();
    const second = deferred<string>();
    let firstStarted = false;
    let secondStarted = false;

    const firstRun = limiter.run(() => {
      firstStarted = true;
      return first.promise;
    }, 'backlog');
    const secondRun = limiter.run(() => {
      secondStarted = true;
      return second.promise;
    }, 'backlog');

    await new Promise((resolve) => setImmediate(resolve));
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(true); // both backlog calls run: cap == maxConcurrent == 2

    first.resolve('a');
    second.resolve('b');
    await Promise.all([firstRun, secondRun]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- geminiLimiter`
Expected: FAIL — the new backlog-cap and priority assertions do not hold (today's single-FIFO limiter ignores the priority arg and the second constructor arg, so e.g. the `caps concurrent backlog calls` test sees `[true, true, false]` or all-started instead of `[true, false, false]`).

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `server/src/geminiLimiter.ts` with:

```ts
export type CallPriority = 'live' | 'backlog';

export class GeminiCallLimiter {
  private active = 0;
  private backlogActive = 0;
  private readonly liveQueue: Array<() => void> = [];
  private readonly backlogQueue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number = 8,
    private readonly backlogMaxConcurrent: number = maxConcurrent
  ) {}

  async run<T>(fn: () => Promise<T>, priority: CallPriority = 'live'): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release(priority);
    }
  }

  private acquire(priority: CallPriority): Promise<void> {
    return new Promise((resolve) => {
      (priority === 'backlog' ? this.backlogQueue : this.liveQueue).push(resolve);
      this.drain();
    });
  }

  // Live waiters are admitted first (priority); backlog waiters are admitted
  // only up to backlogMaxConcurrent, so at least maxConcurrent - backlogMaxConcurrent
  // slots are never occupiable by backlog.
  private drain(): void {
    while (this.liveQueue.length > 0 && this.active < this.maxConcurrent) {
      this.active += 1;
      this.liveQueue.shift()!();
    }
    while (
      this.backlogQueue.length > 0 &&
      this.active < this.maxConcurrent &&
      this.backlogActive < this.backlogMaxConcurrent
    ) {
      this.active += 1;
      this.backlogActive += 1;
      this.backlogQueue.shift()!();
    }
  }

  private release(priority: CallPriority): void {
    this.active -= 1;
    if (priority === 'backlog') this.backlogActive -= 1;
    this.drain();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- geminiLimiter`
Expected: PASS — the four new cases plus all pre-existing `GeminiCallLimiter` cases (the existing cases pass no priority, so they exercise the live-only FIFO path unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/geminiLimiter.ts server/tests/geminiLimiter.test.ts
git commit -m "Add call priority and backlog concurrency sub-cap to GeminiCallLimiter"
```

---

### Task 2: Reservation- and priority-aware rate limiter

**Files:**
- Modify: `server/src/openRouterRateLimiter.ts` (import `CallPriority`; extend `OpenRouterRateLimiter`)
- Test: `server/tests/openRouterRateLimiter.test.ts` (add new cases; keep existing green)

**Interfaces:**
- Consumes: `CallPriority` from `server/src/geminiLimiter.ts` (Task 1).
- Produces: extended `OpenRouterRateLimiter` whose `run(fn, priority?)` accepts a priority and whose constructor takes `(maxPerWindow = 5, windowMs = 2000, backlogMaxPerWindow = maxPerWindow)`. Backlog admissions per window are capped at `backlogMaxPerWindow`; total admissions per window stay ≤ `maxPerWindow`; queued live calls drain before queued backlog calls.

- [ ] **Step 1: Write the failing tests**

In `server/tests/openRouterRateLimiter.test.ts`, add these three `it(...)` blocks immediately before the closing `});` of the `describe('OpenRouterRateLimiter', ...)` block (the file already sets up fake timers in `beforeEach`/`afterEach`):

```ts
  it('caps backlog admissions at backlogMaxPerWindow even when the main window has room', async () => {
    const limiter = new OpenRouterRateLimiter(5, 2000, 1);
    const started = [false, false, false];

    const runs = started.map((_, index) =>
      limiter.run(async () => {
        started[index] = true;
        return index;
      }, 'backlog')
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([true, false, false]); // 1 backlog/window despite 5 total slots

    await vi.advanceTimersByTimeAsync(2001);
    expect(started).toEqual([true, true, false]);

    await vi.advanceTimersByTimeAsync(2001);
    expect(started).toEqual([true, true, true]);

    await Promise.all(runs);
  });

  it('admits a queued live call ahead of a queued backlog call', async () => {
    const limiter = new OpenRouterRateLimiter(1, 2000, 1);
    const order: string[] = [];

    const runLive0 = limiter.run(async () => {
      order.push('l0');
    }, 'live'); // fills the single-slot window
    const runBacklog = limiter.run(async () => {
      order.push('b');
    }, 'backlog'); // queued
    const runLive1 = limiter.run(async () => {
      order.push('l1');
    }, 'live'); // queued

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['l0']);

    await vi.advanceTimersByTimeAsync(2001);
    expect(order).toEqual(['l0', 'l1']); // queued live drains before queued backlog

    await vi.advanceTimersByTimeAsync(2001);
    expect(order).toEqual(['l0', 'l1', 'b']);

    await Promise.all([runLive0, runBacklog, runLive1]);
  });

  it('reserves maxPerWindow - backlogMaxPerWindow tokens for live under backlog pressure', async () => {
    const limiter = new OpenRouterRateLimiter(3, 2000, 1);
    const started = { b0: false, b1: false, l0: false, l1: false, l2: false };

    const runs = [
      limiter.run(async () => {
        started.b0 = true;
      }, 'backlog'),
      limiter.run(async () => {
        started.b1 = true;
      }, 'backlog'),
      limiter.run(async () => {
        started.l0 = true;
      }, 'live'),
      limiter.run(async () => {
        started.l1 = true;
      }, 'live'),
      limiter.run(async () => {
        started.l2 = true;
      }, 'live'),
    ];

    await vi.advanceTimersByTimeAsync(0);
    // Window of 3: 1 backlog (its cap) + 2 live (the reserved 3 - 1). Aggregate == 3 == max.
    expect(started).toEqual({ b0: true, b1: false, l0: true, l1: true, l2: false });

    await vi.advanceTimersByTimeAsync(2001);
    expect(started).toEqual({ b0: true, b1: true, l0: true, l1: true, l2: true });

    await Promise.all(runs);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- openRouterRateLimiter`
Expected: FAIL — the current limiter ignores the priority arg and the third constructor arg, so backlog is not sub-capped and live gets no priority (e.g. the first new test sees `[true, true, true]` in the first window instead of `[true, false, false]`).

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `server/src/openRouterRateLimiter.ts` with:

```ts
import type { CallPriority } from './geminiLimiter.js';

// Smooths bursts of OpenRouter calls into a steady rate so a burst doesn't trip
// OpenRouter's per-minute rate limit. Backlog calls get a lower-priority share:
// they are capped at backlogMaxPerWindow per window and are admitted only after
// live callers, so live captions are never delayed behind on-subscribe backlog
// fills. This is independent of GeminiCallLimiter, which caps concurrency.
export class OpenRouterRateLimiter {
  private readonly startTimes: number[] = []; // all starts in the current window
  private readonly backlogStartTimes: number[] = []; // backlog-only starts in the current window
  private readonly liveQueue: Array<() => void> = [];
  private readonly backlogQueue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly maxPerWindow: number = 5,
    private readonly windowMs: number = 2000,
    private readonly backlogMaxPerWindow: number = maxPerWindow
  ) {}

  async run<T>(fn: () => Promise<T>, priority: CallPriority = 'live'): Promise<T> {
    await this.acquire(priority);
    return fn();
  }

  private acquire(priority: CallPriority): Promise<void> {
    return new Promise((resolve) => {
      (priority === 'backlog' ? this.backlogQueue : this.liveQueue).push(resolve);
      this.drain();
    });
  }

  private drain(): void {
    const now = Date.now();
    this.prune(now);

    // Live first (priority).
    while (this.liveQueue.length > 0 && this.startTimes.length < this.maxPerWindow) {
      this.startTimes.push(now);
      this.liveQueue.shift()!();
    }
    // Then backlog, bounded by both the total window cap and the backlog sub-cap.
    while (
      this.backlogQueue.length > 0 &&
      this.startTimes.length < this.maxPerWindow &&
      this.backlogStartTimes.length < this.backlogMaxPerWindow
    ) {
      this.startTimes.push(now);
      this.backlogStartTimes.push(now);
      this.backlogQueue.shift()!();
    }

    if (this.timer === null) {
      const waitMs = this.nextWaitMs(now);
      if (waitMs !== null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.drain();
        }, waitMs);
      }
    }
  }

  // Soonest delay (ms) at which a still-blocked waiter could become admissible,
  // or null if nothing is waiting. Wakes and re-evaluates; on wake the drain
  // reschedules if still blocked, so progress is always made.
  private nextWaitMs(now: number): number | null {
    const mainFull = this.startTimes.length >= this.maxPerWindow;
    const candidates: number[] = [];
    if (this.liveQueue.length > 0 && mainFull) {
      candidates.push(this.windowMs - (now - this.startTimes[0]));
    }
    if (this.backlogQueue.length > 0) {
      if (mainFull) candidates.push(this.windowMs - (now - this.startTimes[0]));
      if (this.backlogStartTimes.length >= this.backlogMaxPerWindow && this.backlogStartTimes.length > 0) {
        candidates.push(this.windowMs - (now - this.backlogStartTimes[0]));
      }
    }
    if (candidates.length === 0) return null;
    return Math.max(0, Math.min(...candidates)) + 1;
  }

  private prune(now: number): void {
    while (this.startTimes.length > 0 && now - this.startTimes[0] >= this.windowMs) {
      this.startTimes.shift();
    }
    while (this.backlogStartTimes.length > 0 && now - this.backlogStartTimes[0] >= this.windowMs) {
      this.backlogStartTimes.shift();
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- openRouterRateLimiter`
Expected: PASS — the three new cases plus all pre-existing cases (which pass no priority and so exercise the live-only path, identical to today).

- [ ] **Step 5: Commit**

```bash
git add server/src/openRouterRateLimiter.ts server/tests/openRouterRateLimiter.test.ts
git commit -m "Add call priority and backlog per-window sub-cap to OpenRouterRateLimiter"
```

---

### Task 3: Thread priority through the OpenRouter limiter wrapper

**Files:**
- Modify: `server/src/openRouterLimiter.ts` (add `priority` parameter)
- Test: `server/tests/openRouterLimiter.test.ts` (add priority-threading cases)

**Interfaces:**
- Consumes: `CallPriority` from `server/src/geminiLimiter.ts` (Task 1); the extended `GeminiCallLimiter.run` / `OpenRouterRateLimiter.run` (Tasks 1–2).
- Produces: `withOpenRouterLimiter(client, limiter, rateLimiter?, priority: CallPriority = 'live')` — passes `priority` into both `limiter.run(..., priority)` and `rateLimiter.run(..., priority)`.

- [ ] **Step 1: Write the failing tests**

In `server/tests/openRouterLimiter.test.ts`, change the import line for the rate limiter and add two `it(...)` blocks. First, add this import after the existing `import { GeminiCallLimiter } from '../src/geminiLimiter';` line:

```ts
import { OpenRouterRateLimiter } from '../src/openRouterRateLimiter';
```

Then add these two `it(...)` blocks immediately before the closing `});` of the `describe('withOpenRouterLimiter', ...)` block (the `fakeClient()` helper is already defined at the top of the file):

```ts
  it('threads an explicit backlog priority into both limiters', async () => {
    const client = fakeClient();
    const limiter = new GeminiCallLimiter(1);
    const rateLimiter = new OpenRouterRateLimiter(5, 2000);
    const limiterSpy = vi.spyOn(limiter, 'run');
    const rateSpy = vi.spyOn(rateLimiter, 'run');
    const wrapped = withOpenRouterLimiter(client, limiter, rateLimiter, 'backlog');

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(limiterSpy).toHaveBeenCalledWith(expect.any(Function), 'backlog');
    expect(rateSpy).toHaveBeenCalledWith(expect.any(Function), 'backlog');
  });

  it('defaults to live priority when none is given', async () => {
    const client = fakeClient();
    const limiter = new GeminiCallLimiter(1);
    const rateLimiter = new OpenRouterRateLimiter(5, 2000);
    const limiterSpy = vi.spyOn(limiter, 'run');
    const rateSpy = vi.spyOn(rateLimiter, 'run');
    const wrapped = withOpenRouterLimiter(client, limiter, rateLimiter);

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(limiterSpy).toHaveBeenCalledWith(expect.any(Function), 'live');
    expect(rateSpy).toHaveBeenCalledWith(expect.any(Function), 'live');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- openRouterLimiter`
Expected: FAIL — the current wrapper calls `limiter.run(...)` / `rateLimiter.run(...)` with a single argument, so the `toHaveBeenCalledWith(expect.any(Function), 'backlog' | 'live')` assertions do not match.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `server/src/openRouterLimiter.ts` with:

```ts
import type { OpenRouterClient } from './openRouterClient.js';
import type { GeminiCallLimiter, CallPriority } from './geminiLimiter.js';
import type { OpenRouterRateLimiter } from './openRouterRateLimiter.js';

export function withOpenRouterLimiter(
  client: OpenRouterClient,
  limiter: GeminiCallLimiter,
  rateLimiter?: OpenRouterRateLimiter,
  priority: CallPriority = 'live'
): OpenRouterClient {
  return {
    chat: {
      completions: {
        create(params) {
          const call = () => limiter.run(() => client.chat.completions.create(params), priority);
          return rateLimiter ? rateLimiter.run(call, priority) : call();
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- openRouterLimiter`
Expected: PASS — the two new cases plus the two pre-existing cases (which omit the priority arg and so hit the `'live'` default without behavior change).

- [ ] **Step 5: Commit**

```bash
git add server/src/openRouterLimiter.ts server/tests/openRouterLimiter.test.ts
git commit -m "Thread call priority through withOpenRouterLimiter"
```

---

### Task 4: Route the backlog path through an isolated OpenRouter budget

**Files:**
- Modify: `server/src/llmTypes.ts` (add `BacklogProviders`)
- Modify: `server/src/session.ts` (add `backlogProviders` field + reset in `start()`)
- Modify: `server/src/wsServer.ts` (add `backlogLlmClients` to `WsServerDeps`; build `backlogProviders` in the `start` handler; route `ensureBacklogCached`; parameterize `verifyTranslationsWithRetry`)
- Modify: `server/src/index.ts` (size limiters via env; build live + backlog OpenRouter clients; pass `backlogLlmClients`)
- Modify: `server/.env.example` (document the new env vars)
- Test: `server/tests/wsServer.test.ts` (add `backlogLlmClients` to test deps; add a routing test)

**Interfaces:**
- Consumes: `CallPriority` (Task 1); extended limiters (Tasks 1–2); `withOpenRouterLimiter(..., priority)` (Task 3); existing `getProvider(selection, notes, clients)` and `LlmClients` from `server/src/llmRegistry.ts`; existing `LlmProvider` from `server/src/llmTypes.ts`.
- Produces: `BacklogProviders { translation: LlmProvider; translationVerifier: LlmProvider }`; `Session.backlogProviders: BacklogProviders | null`; `WsServerDeps.backlogLlmClients: LlmClients`. The backlog fill's `translateBacklog` and `verifyTranslations` run through `session.backlogProviders` (which wrap the `backlog`-tagged OpenRouter client); the live path is unchanged and runs through `session.providers`.

- [ ] **Step 1: Write the failing test**

In `server/tests/wsServer.test.ts`, first add `backlogLlmClients` to the `deps` object in `beforeEach` (it currently ends the LLM-client lines with `llmClients: { gemini: geminiClient, openRouter: null },` around line 173). After that line add:

```ts
      backlogLlmClients: { gemini: geminiClient, openRouter: null },
```

Then add this test. Place it inside the `describe('wsServer', ...)` block, immediately after the existing `it('sends translated backlog to a viewer joining after segments already arrived', ...)` test:

```ts
  it('routes the on-subscribe backlog fill through backlogProviders, not the live providers', async () => {
    // A distinct Gemini client stands in for the backlog budget lane. In prod
    // both bundles share one Gemini client (OpenRouter-only isolation); here we
    // split them so we can assert *which* client the backlog fill used.
    const backlogGeminiClient = fakeGeminiClient({ translate: '{"translations":["B1","B2","B3"]}' });
    deps.backlogLlmClients = { gemini: backlogGeminiClient, openRouter: null };

    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    session.buffer.append('Line 1', Date.now());
    session.buffer.append('Line 2', Date.now());
    session.buffer.append('Line 3', Date.now());

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    const backlogMessage = (await waitForMessage(viewerSocket)) as { type: string };
    expect(backlogMessage.type).toBe('backlog');

    // The backlog translate ran on the backlog client...
    const backlogTranslateCalls = (backlogGeminiClient.models.generateContent as any).mock.calls.filter(isTranslateCall);
    expect(backlogTranslateCalls.length).toBeGreaterThan(0);
    // ...and NOT on the live client (no live segments were fed in this test).
    const liveTranslateCalls = (geminiClient.models.generateContent as any).mock.calls.filter(isTranslateCall);
    expect(liveTranslateCalls).toHaveLength(0);

    captureSocket.close();
    viewerSocket.close();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- wsServer`
Expected: FAIL — TypeScript rejects `backlogLlmClients` (not yet a `WsServerDeps` field), and the new test's `backlogTranslateCalls.length > 0` assertion fails because the backlog fill currently runs on `deps.llmClients` (the live `geminiClient`), leaving the distinct `backlogGeminiClient` uncalled.

- [ ] **Step 3: Add the `BacklogProviders` type (`llmTypes.ts`)**

In `server/src/llmTypes.ts`, add after the existing `RoleProviders` interface (the current end of the file):

```ts
export interface BacklogProviders {
  translation: LlmProvider;
  translationVerifier: LlmProvider;
}
```

- [ ] **Step 4: Add the `backlogProviders` field to `Session` (`session.ts`)**

In `server/src/session.ts`, update the `RoleProviders` type import to also import `BacklogProviders`:

```ts
import type { RoleProviders, BacklogProviders } from './llmTypes.js';
```

Add the field immediately after `providers: RoleProviders | null = null;`:

```ts
  providers: RoleProviders | null = null;
  backlogProviders: BacklogProviders | null = null;
```

And reset it in `start()` immediately after `this.providers = null;`:

```ts
    this.providers = null;
    this.backlogProviders = null;
```

- [ ] **Step 5: Add `backlogLlmClients` to `WsServerDeps` and build `backlogProviders` (`wsServer.ts`)**

In `server/src/wsServer.ts`, in the `WsServerDeps` interface, add the field immediately after `llmClients: LlmClients;`:

```ts
  llmClients: LlmClients;
  backlogLlmClients: LlmClients;
```

In the `start` message handler, immediately after the `deps.session.providers = { ... };` assignment (the block assigning `transcriptionVerifier` / `translation` / `translationVerifier`), add:

```ts
            deps.session.backlogProviders = {
              translation: getProvider(modelConfig.translation, promptConfig.translation, deps.backlogLlmClients),
              translationVerifier: getProvider(modelConfig.translationVerifier, promptConfig.translationVerifier, deps.backlogLlmClients),
            };
```

- [ ] **Step 6: Route the backlog fill and parameterize the verifier (`wsServer.ts`)**

In `server/src/wsServer.ts`, in `verifyTranslationsWithRetry`, add an optional `provider` parameter defaulting to the live verifier. Change the signature and the first `provider` binding. Current:

```ts
async function verifyTranslationsWithRetry(
  deps: WsServerDeps,
  items: VerificationItem[]
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};
  const provider = deps.session.providers!.translationVerifier;
```

New:

```ts
async function verifyTranslationsWithRetry(
  deps: WsServerDeps,
  items: VerificationItem[],
  provider: LlmProvider = deps.session.providers!.translationVerifier
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};
```

(Delete the old `const provider = deps.session.providers!.translationVerifier;` line — `provider` is now the parameter. The rest of the function body is unchanged.)

Confirm `LlmProvider` is imported in `wsServer.ts`; if it is not already, add it to the existing `import type { ... } from './llmTypes.js';` line (alongside `RoleProviders` / related types). 

In `ensureBacklogCached`, change the `translateBacklog` call to use the backlog provider. Current:

```ts
      translations = await deps.session.providers!.translation.translateBacklog(
        missingEntries.map((line) => line.english),
        language,
        deps.session.roleCaches.translation
      );
```

New:

```ts
      translations = await deps.session.backlogProviders!.translation.translateBacklog(
        missingEntries.map((line) => line.english),
        language,
        deps.session.roleCaches.translation
      );
```

And in the same function, change its verification call to pass the backlog verifier. Current:

```ts
    const verifications = await verifyTranslationsWithRetry(deps, verificationItems);
```

New:

```ts
    const verifications = await verifyTranslationsWithRetry(
      deps,
      verificationItems,
      deps.session.backlogProviders!.translationVerifier
    );
```

(Leave the identical call inside `prepareTranslationsForPublish` as the 2-argument form — it keeps the live verifier via the default.)

- [ ] **Step 7: Run the wsServer test to verify it passes**

Run: `npm test -- wsServer`
Expected: PASS — including the new routing test (the backlog fill now runs on `backlogGeminiClient` via `backlogProviders`). All pre-existing wsServer tests stay green: their default deps set `backlogLlmClients` to the same `geminiClient`, so backlog behavior is identical to today.

- [ ] **Step 8: Wire the two OpenRouter clients and env sizing (`index.ts`)**

In `server/src/index.ts`, add these imports alongside the existing local imports (the `GeminiCallLimiter` import already exists — extend it to also import `CallPriority`; add the `OpenRouterClient` type import):

```ts
import { GeminiCallLimiter, type CallPriority } from './geminiLimiter.js';
import type { OpenRouterClient } from './openRouterClient.js';
```

Replace the current limiter construction and single `openRouterClient` (the block from `const openRouterLimiter = new GeminiCallLimiter();` through the `openRouterClient` assignment ending in `: null;`) with:

```ts
const openRouterLimiter = new GeminiCallLimiter(
  process.env.OPENROUTER_MAX_CONCURRENT ? Number(process.env.OPENROUTER_MAX_CONCURRENT) : 8,
  process.env.OPENROUTER_BACKLOG_MAX_CONCURRENT ? Number(process.env.OPENROUTER_BACKLOG_MAX_CONCURRENT) : 2
);
const openRouterRateLimiter = new OpenRouterRateLimiter(
  process.env.OPENROUTER_MAX_CALLS_PER_WINDOW ? Number(process.env.OPENROUTER_MAX_CALLS_PER_WINDOW) : 5,
  process.env.OPENROUTER_RATE_WINDOW_MS ? Number(process.env.OPENROUTER_RATE_WINDOW_MS) : 2000,
  process.env.OPENROUTER_BACKLOG_MAX_CALLS_PER_WINDOW ? Number(process.env.OPENROUTER_BACKLOG_MAX_CALLS_PER_WINDOW) : 1
);
const openRouterBaseClient = process.env.OPENROUTER_API_KEY
  ? createOpenRouterClient(process.env.OPENROUTER_API_KEY)
  : null;
function buildOpenRouterClient(priority: CallPriority): OpenRouterClient | null {
  if (!openRouterBaseClient) return null;
  return withOpenRouterReasoningLogging(
    withOpenRouterCostTracking(
      withOpenRouterLimiter(openRouterBaseClient, openRouterLimiter, openRouterRateLimiter, priority),
      costTracker
    )
  );
}
const openRouterClient = buildOpenRouterClient('live');
const openRouterClientBacklog = buildOpenRouterClient('backlog');
```

In the `attachWsServer({ ... })` call, add `backlogLlmClients` immediately after the existing `llmClients` line:

```ts
  llmClients: { gemini: geminiClient, openRouter: openRouterClient },
  backlogLlmClients: { gemini: geminiClient, openRouter: openRouterClientBacklog },
```

- [ ] **Step 9: Document the new env vars (`.env.example`)**

Append to `server/.env.example`:

```
OPENROUTER_MAX_CONCURRENT=8
OPENROUTER_BACKLOG_MAX_CONCURRENT=2
OPENROUTER_BACKLOG_MAX_CALLS_PER_WINDOW=1
```

- [ ] **Step 10: Type-check and run the full suite**

Run: `npm run build`
Expected: no TypeScript errors — `index.ts` and the wsServer test deps both satisfy the new required `WsServerDeps.backlogLlmClients` field, and `buildOpenRouterClient` returns `OpenRouterClient | null` matching `LlmClients.openRouter`.

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 11: Commit**

```bash
git add server/src/llmTypes.ts server/src/session.ts server/src/wsServer.ts server/src/index.ts server/.env.example server/tests/wsServer.test.ts
git commit -m "Route on-subscribe backlog fill through an isolated OpenRouter budget"
```

---

## Self-Review

**Spec coverage:**
- Reservation- and priority-aware **concurrency** limiter → Task 1. ✓
- Reservation- and priority-aware **rate** limiter (incl. timer re-evaluation for the backlog sub-cap) → Task 2. ✓
- Priority threaded through `withOpenRouterLimiter` → Task 3. ✓
- Two client wrappers over one shared base client + shared limiters (`index.ts`) → Task 4 Step 8. ✓
- `WsServerDeps.backlogLlmClients`, `Session.backlogProviders`, `BacklogProviders` type, `start`-handler build → Task 4 Steps 3–5. ✓
- Backlog path (`ensureBacklogCached` translate + verify) routed through `backlogProviders`; live path unchanged via default parameter → Task 4 Step 6. ✓
- Env vars `OPENROUTER_MAX_CONCURRENT` / `OPENROUTER_BACKLOG_MAX_CONCURRENT` / `OPENROUTER_BACKLOG_MAX_CALLS_PER_WINDOW` with defaults 8 / 2 / 1, documented in `.env.example` → Task 4 Steps 8–9. ✓
- Backward compatibility (no-priority = live; sub-caps default to the totals) — asserted by keeping all existing limiter/wrapper tests green and by Task 1's explicit back-compat case → Tasks 1–3. ✓
- Aggregate OpenRouter load unchanged (defaults sit inside 8 and 5/2s) → Task 2's reserved-tokens test shows aggregate == max; Global Constraints. ✓
- OpenRouter-only scope; Gemini stays shared (known limitation) — no Gemini wiring added; `backlogLlmClients.gemini` is the same instance as `llmClients.gemini` in `index.ts` → Task 4 Step 8. ✓
- Routing regression guard (backlog uses backlog providers, live does not) → Task 4 Step 1 test. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps; every code step shows complete code and exact commands with expected output. ✓

**Type consistency:** `CallPriority` defined in `geminiLimiter.ts` (Task 1) and imported by `openRouterRateLimiter.ts` (Task 2), `openRouterLimiter.ts` (Task 3), and `index.ts` (Task 4). `run(fn, priority)` signature identical across both limiters and both their tests and the wrapper. `backlogMaxConcurrent` / `backlogMaxPerWindow` default to their respective totals in both the definition and `index.ts` construction. `BacklogProviders { translation; translationVerifier }` identical in `llmTypes.ts` (Step 3), `session.ts` field (Step 4), and the `start`-handler build (Step 5). `backlogLlmClients: LlmClients` identical in `WsServerDeps` (Step 5), `index.ts` (Step 8), and test deps (Step 1). `verifyTranslationsWithRetry`'s new `provider: LlmProvider` default matches the type returned by `getProvider` and stored in `session.providers` / `session.backlogProviders`. ✓
