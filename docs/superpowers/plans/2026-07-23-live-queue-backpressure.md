# Live-Queue Back-Pressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live caption pipeline self-heal when it falls behind, by force-publishing a line's already-verified English when its translation misses a staleness deadline, and by skipping translation for newly-ingested lines while the pipeline is behind.

**Architecture:** A new pure `LiveLagTracker` (`server/src/liveLag.ts`) measures how long the oldest un-published line has waited in the publish path. `createEnqueuePublish` gains a per-line staleness deadline (`MAX_PUBLISH_LAG_MS`, default 8000): a line that can't be published *translated* in time is published in English instead. `handleFinalSegmentFast` consults the tracker and, when lag is over the threshold, skips translation and publishes English directly. The only thing shed is translation (English is always safe); the per-line transcription safety check and caption ordering are untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node.js, `ws`, Vitest.

## Global Constraints

- ESM imports within `server/src` use `.js` specifiers (e.g. `'./liveLag.js'`), even though the source files are `.ts`.
- Env var name (exact): `MAX_PUBLISH_LAG_MS`. Default when unset: `8000`.
- `WsServerDeps` field name (exact): `maxPublishLagMs: number`.
- `Session` field name (exact): `liveLag: LiveLagTracker`; plus edge-log flags `isBehind: boolean` and `ingestLagHigh: boolean`.
- **Safety invariant (never violate):** the transcription safety check runs on every line and a flagged transcription is never published. Back-pressure only ever skips *translation*, degrading to the line's English text. No line is ever dropped; caption ordering through the serial `publishQueue` is preserved.
- Server-only change. No files under `web/` are touched: the viewer already renders a `caption` whose `translated` equals its `english`, and already handles the `caption-pending` → `caption` transition.
- Run server commands from the `server/` directory. Tests: `npm test` (Vitest). Type-check/build: `npm run build`.
- Spec: `docs/superpowers/specs/2026-07-23-live-queue-backpressure-design.md`.

---

### Task 1: Pure lag tracker (`LiveLagTracker`)

**Files:**
- Create: `server/src/liveLag.ts`
- Test: `server/tests/liveLag.test.ts`

**Interfaces:**
- Produces: `class LiveLagTracker` with `enqueue(atMs: number): void`, `dequeue(): void`, `lagMs(nowMs: number): number` (age of the oldest still-pending entry, or `0` when empty), and `get size(): number`. Strict FIFO: entries leave in the order they entered.

- [ ] **Step 1: Write the failing test**

Create `server/tests/liveLag.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LiveLagTracker } from '../src/liveLag';

describe('LiveLagTracker', () => {
  it('reports zero lag when empty', () => {
    const tracker = new LiveLagTracker();
    expect(tracker.lagMs(1000)).toBe(0);
    expect(tracker.size).toBe(0);
  });

  it('reports the age of the single pending entry', () => {
    const tracker = new LiveLagTracker();
    tracker.enqueue(1000);
    expect(tracker.lagMs(6000)).toBe(5000);
    expect(tracker.size).toBe(1);
  });

  it('tracks the oldest entry as the head, FIFO', () => {
    const tracker = new LiveLagTracker();
    tracker.enqueue(1000);
    tracker.enqueue(3000);
    // Oldest (1000) drives lag.
    expect(tracker.lagMs(4000)).toBe(3000);
    tracker.dequeue();
    // Now the head is 3000.
    expect(tracker.lagMs(4000)).toBe(1000);
    expect(tracker.size).toBe(1);
  });

  it('returns to zero lag once fully drained', () => {
    const tracker = new LiveLagTracker();
    tracker.enqueue(1000);
    tracker.dequeue();
    expect(tracker.lagMs(9000)).toBe(0);
    expect(tracker.size).toBe(0);
  });

  it('never reports negative lag if the clock reference precedes the entry', () => {
    const tracker = new LiveLagTracker();
    tracker.enqueue(5000);
    expect(tracker.lagMs(4000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- liveLag`
Expected: FAIL — cannot resolve `../src/liveLag` / `LiveLagTracker is not a constructor`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/liveLag.ts`:

```ts
// Tracks how long the oldest not-yet-published line has waited in the live
// publish path, so the pipeline can measure — and shed against — its own lag.
// A strict FIFO: lines enter (enqueue) in spoken order and leave (dequeue) in
// the same order publishQueue sends them, so the head is always the oldest
// un-published line. See
// docs/superpowers/specs/2026-07-23-live-queue-backpressure-design.md.
export class LiveLagTracker {
  private pending: number[] = [];

  enqueue(atMs: number): void {
    this.pending.push(atMs);
  }

  dequeue(): void {
    this.pending.shift();
  }

  // Age of the oldest still-pending line, or 0 when the publish path is empty.
  lagMs(nowMs: number): number {
    if (this.pending.length === 0) return 0;
    return Math.max(0, nowMs - this.pending[0]);
  }

  get size(): number {
    return this.pending.length;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- liveLag`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/liveLag.ts server/tests/liveLag.test.ts
git commit -m "Add LiveLagTracker for live publish-path lag"
```

---

### Task 2: Publish-side staleness deadline (+ config, deps, Session wiring)

**Files:**
- Modify: `server/src/session.ts` (import `LiveLagTracker`; add `liveLag` field; reset in `start()`)
- Modify: `server/src/wsServer.ts` (add `maxPublishLagMs` to `WsServerDeps`; refactor `createEnqueuePublish`; add `englishFallbackResults`, `raceAgainstDeadline`; update both call sites)
- Modify: `server/src/index.ts` (thread `MAX_PUBLISH_LAG_MS` into `attachWsServer`)
- Modify: `server/.env.example` (document the variable)
- Test: `server/tests/wsServer.test.ts` (add `maxPublishLagMs` to test deps; add deadline tests)

**Interfaces:**
- Consumes: `LiveLagTracker` from Task 1.
- Produces:
  - `WsServerDeps.maxPublishLagMs: number` — max ms a line may wait in the publish path before it is force-published in English.
  - `createEnqueuePublish(deps): Publisher` where `interface Publisher { enqueuePublish: EnqueuePublish; publishEnglish: (line: CaptionLine, viewerMessageType?: 'caption' | 'caption-inserted') => void }`. `enqueuePublish` keeps its existing `(line, workPromise, viewerMessageType?) => void` shape but now applies the deadline. `publishEnglish` publishes the line's English fallback with no LLM work (consumed in Task 3).
  - `Session.liveLag: LiveLagTracker`.

- [ ] **Step 1: Add `liveLag` to `Session`**

In `server/src/session.ts`, add the import near the other local imports (after the `TranslationCache` import on line 4):

```ts
import { LiveLagTracker } from './liveLag.js';
```

Add the field alongside the queue fields (immediately after `publishQueue: Promise<void> = Promise.resolve();`):

```ts
  liveLag: LiveLagTracker = new LiveLagTracker();
```

In `start()`, reset it alongside the queue resets (immediately after `this.publishQueue = Promise.resolve();`):

```ts
    this.liveLag = new LiveLagTracker();
```

- [ ] **Step 2: Add the `maxPublishLagMs` dep and write the failing test**

In `server/src/wsServer.ts`, add the field to `WsServerDeps` immediately after `deepgramCostFlushIntervalMs: number;`:

```ts
  deepgramCostFlushIntervalMs: number;
  maxPublishLagMs: number;
```

In `server/tests/wsServer.test.ts`, add the dep to the `deps = { ... }` object (immediately after `deepgramCostFlushIntervalMs: 5000,`, around line 188). Use a large default so every existing test is unaffected (their translations resolve fast, so a 60s deadline never fires and lag never crosses it):

```ts
      deepgramCostFlushIntervalMs: 5000,
      maxPublishLagMs: 60000,
```

Then add this new `describe` block at the end of the top-level `describe('wsServer', () => {`, immediately before its closing `});` (the last line of the file):

```ts
  describe('live-queue back-pressure — publish deadline', () => {
    it('publishes the English line when its translation misses the staleness deadline', async () => {
      deps.maxPublishLagMs = 30;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((m) => m[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        // Translation is slower than the 30ms deadline.
        return new Promise((resolve) => setTimeout(() => resolve({ text: '{"zh":"你好"}' }), 300));
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const messages: any[] = [];
      viewerSocket.on('message', (data) => messages.push(JSON.parse(data.toString())));

      capturedCallbacks!.onFinalSegment('Hello everyone');
      // Past both the 30ms deadline and the 300ms slow translate: the deadline
      // must have published English, and the late translation must be discarded
      // (no second caption).
      await delay(350);

      const captions = messages.filter((m) => m.type === 'caption');
      expect(captions).toEqual([
        { type: 'caption', id: expect.any(String), english: 'Hello everyone', translated: 'Hello everyone' },
      ]);

      captureSocket.close();
      viewerSocket.close();
    });

    it('keeps caption order when deadline-shed English lines drain the queue', async () => {
      deps.maxPublishLagMs = 30;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((m) => m[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        // Both lines translate slower than the deadline, so both are shed to English.
        return new Promise((resolve) => setTimeout(() => resolve({ text: '{"zh":"译"}' }), 300));
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const messages: any[] = [];
      viewerSocket.on('message', (data) => messages.push(JSON.parse(data.toString())));

      capturedCallbacks!.onFinalSegment('Line 1');
      await waitForMessage(captureSocket); // Line 1 transcript ack
      capturedCallbacks!.onFinalSegment('Line 2');
      await waitForMessage(captureSocket); // Line 2 transcript ack

      await delay(400);

      const captions = messages.filter((m) => m.type === 'caption');
      expect(captions).toEqual([
        { type: 'caption', id: expect.any(String), english: 'Line 1', translated: 'Line 1' },
        { type: 'caption', id: expect.any(String), english: 'Line 2', translated: 'Line 2' },
      ]);

      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- wsServer`
Expected: FAIL — TypeScript error that `maxPublishLagMs` is not assignable to the deps type (field not yet on `WsServerDeps`) resolves after Step 2's interface edit, but the new tests still FAIL because today translation is always awaited: the viewer receives the translated caption (`你好` / `译`), never the English fallback.

- [ ] **Step 4: Refactor `createEnqueuePublish` to apply the deadline (`wsServer.ts`)**

No new imports are needed: `CaptionLine` (`import type { CaptionLine } from './types.js';`), `PreparedLanguageResult` (interface defined in this file), `WsServerDeps`, and `logEvent` are all already in scope. Confirm the `CaptionLine` import is present before proceeding.

Immediately above `function createEnqueuePublish` (currently line 111), add the `Publisher` interface, the deadline sentinel, and the two helpers:

```ts
interface Publisher {
  enqueuePublish: EnqueuePublish;
  publishEnglish: (line: CaptionLine, viewerMessageType?: 'caption' | 'caption-inserted') => void;
}

const DEADLINE_REACHED = Symbol('deadline-reached');

// Publish the line's already-verified English text for every active language.
// Mirrors prepareTranslationsForPublish's guards so a line suppressed
// (admin-removed) mid-flight is still never published. English is always safe:
// the line has already passed the transcription safety check.
function englishFallbackResults(line: CaptionLine, deps: WsServerDeps): PreparedLanguageResult[] | null {
  if (line.suppressed) return null;
  return deps.session
    .getActiveLanguages()
    .map((language) => ({ language, translated: line.english, flagged: false }));
}

// Resolve to the verified translation results if they arrive before the
// staleness deadline; otherwise resolve to the English fallback and let the
// (now-stale) translation be discarded. Bounds how far behind a caption can
// fall to ~maxPublishLagMs.
async function raceAgainstDeadline(
  preparedPromise: Promise<PreparedLanguageResult[] | null>,
  deadlineMs: number,
  line: CaptionLine,
  deps: WsServerDeps
): Promise<PreparedLanguageResult[] | null> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    void logEvent('warn', { event: 'caption_lag_shed', reason: 'publish_deadline', english: line.english });
    return englishFallbackResults(line, deps);
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof DEADLINE_REACHED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_REACHED), remaining);
  });
  try {
    const outcome = await Promise.race([preparedPromise, timeout]);
    if (outcome === DEADLINE_REACHED) {
      void logEvent('warn', { event: 'caption_lag_shed', reason: 'publish_deadline', english: line.english });
      return englishFallbackResults(line, deps);
    }
    return outcome;
  } finally {
    clearTimeout(timer!);
  }
}
```

Then replace the entire `createEnqueuePublish` function (currently lines 111-136) with:

```ts
function createEnqueuePublish(deps: WsServerDeps): Publisher {
  // Shared tail: record the line in the lag tracker, then append one ordered
  // link to publishQueue that sends the pre-computed results in order and
  // dequeues afterward. Capturing `tracker` here (not re-reading it inside the
  // async link) keeps enqueue and dequeue on the same instance even if the
  // session restarts mid-flight.
  function enqueueOrderedSend(
    line: CaptionLine,
    enqueuedAt: number,
    resultsPromise: Promise<PreparedLanguageResult[] | null>,
    viewerMessageType: 'caption' | 'caption-inserted'
  ): void {
    const tracker = deps.session.liveLag;
    tracker.enqueue(enqueuedAt);
    deps.session.publishQueue = deps.session.publishQueue.then(async () => {
      let results: PreparedLanguageResult[] | null;
      try {
        results = await resultsPromise;
      } catch (error) {
        void logEvent('error', {
          event: 'publish_failed',
          english: line.english,
          error: error instanceof Error ? error.message : String(error),
        });
        results = null;
      } finally {
        tracker.dequeue();
      }
      sendPrepared(line, results, deps, viewerMessageType);
    });
  }

  const enqueuePublish: EnqueuePublish = (line, workPromise, viewerMessageType = 'caption') => {
    const enqueuedAt = Date.now();
    // Translate + verify still starts immediately (not gated on the queue), as before.
    const preparedPromise = workPromise.then((translations) =>
      prepareTranslationsForPublish(line, translations, deps)
    );
    const resultsPromise = raceAgainstDeadline(preparedPromise, enqueuedAt + deps.maxPublishLagMs, line, deps);
    enqueueOrderedSend(line, enqueuedAt, resultsPromise, viewerMessageType);
  };

  const publishEnglish = (line: CaptionLine, viewerMessageType: 'caption' | 'caption-inserted' = 'caption'): void => {
    enqueueOrderedSend(line, Date.now(), Promise.resolve(englishFallbackResults(line, deps)), viewerMessageType);
  };

  return { enqueuePublish, publishEnglish };
}
```

- [ ] **Step 5: Update the two `createEnqueuePublish` call sites (`wsServer.ts`)**

In `handleCaptureConnection`, change the assignment (currently line 210):

```ts
  const enqueuePublish = createEnqueuePublish(deps);
```
to:
```ts
  const { enqueuePublish } = createEnqueuePublish(deps);
```

In `handleReviewConnection`, change the assignment (currently line 367):

```ts
  const enqueuePublish = createEnqueuePublish(deps);
```
to:
```ts
  const { enqueuePublish } = createEnqueuePublish(deps);
```

> `publishEnglish` is wired into `handleCaptureConnection` in Task 3; leaving it undestructured here is intentional.

- [ ] **Step 6: Thread the env var in `index.ts`**

In `server/src/index.ts`, in the `attachWsServer({ ... })` call, add the field immediately after `deepgramCostFlushIntervalMs: 5000,` (line 99):

```ts
  deepgramCostFlushIntervalMs: 5000,
  maxPublishLagMs: process.env.MAX_PUBLISH_LAG_MS ? Number(process.env.MAX_PUBLISH_LAG_MS) : 8000,
```

- [ ] **Step 7: Document the variable in `.env.example`**

Append to `server/.env.example`:

```
MAX_PUBLISH_LAG_MS=8000
```

- [ ] **Step 8: Run the new tests to verify they pass**

Run: `npm test -- wsServer`
Expected: PASS — including both `live-queue back-pressure — publish deadline` tests. All existing wsServer tests remain green (their `maxPublishLagMs` is 60000, so the deadline never fires and no line is shed).

- [ ] **Step 9: Type-check and run the full suite**

Run: `npm run build`
Expected: no TypeScript errors (confirms `index.ts`, `session.ts`, and the test deps all satisfy the new required fields, and `Publisher` destructuring type-checks).

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 10: Commit**

```bash
git add server/src/session.ts server/src/wsServer.ts server/src/index.ts server/.env.example server/tests/wsServer.test.ts
git commit -m "Force-publish English when a caption misses its staleness deadline"
```

---

### Task 3: Ingest-side load shed + lag observability

**Files:**
- Modify: `server/src/session.ts` (add `isBehind`, `ingestLagHigh` flags; reset in `start()`)
- Modify: `server/src/wsServer.ts` (add `reportLag`, `reportIngestLag`; call `reportLag` after each publish; add the ingest-shed branch and `receivedAt` plumbing in `handleFinalSegmentFast`; wire `publishEnglish` through `handleCaptureConnection`)
- Test: `server/tests/wsServer.test.ts` (add ingest-shed + safety-under-lag tests)

**Interfaces:**
- Consumes: `Publisher.publishEnglish` and `Session.liveLag` from Task 2.
- Produces:
  - `Session.isBehind: boolean`, `Session.ingestLagHigh: boolean` — edge-log state, reset per session.
  - `handleFinalSegmentFast(english, deps, captureSocket, enqueuePublish, publishEnglish, schedulePrefetch, receivedAt)` — new `publishEnglish` and `receivedAt` parameters.

- [ ] **Step 1: Add the edge-log flags to `Session`**

In `server/src/session.ts`, add both flags immediately after the `liveLag` field from Task 2:

```ts
  isBehind: boolean = false;
  ingestLagHigh: boolean = false;
```

In `start()`, reset them immediately after the `this.liveLag = new LiveLagTracker();` line from Task 2:

```ts
    this.isBehind = false;
    this.ingestLagHigh = false;
```

- [ ] **Step 2: Write the failing tests**

In `server/tests/wsServer.test.ts`, add this `describe` block immediately after the `live-queue back-pressure — publish deadline` block from Task 2 (still inside the top-level `describe('wsServer', ...)`):

```ts
  describe('live-queue back-pressure — ingest load shed', () => {
    it('sheds translation for a newly ingested line when the pipeline is behind', async () => {
      deps.maxPublishLagMs = 8000;

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      // Simulate a standing publish backlog: an entry that has been waiting 20s,
      // so lagMs (~20000) is over the 8000ms threshold at the next ingest.
      session.liveLag.enqueue(Date.now() - 20000);

      const messages: any[] = [];
      viewerSocket.on('message', (data) => messages.push(JSON.parse(data.toString())));

      capturedCallbacks!.onFinalSegment('Behind line');
      await delay(50);

      // The viewer gets English, and no translate call was made for this line.
      const captions = messages.filter((m) => m.type === 'caption');
      expect(captions).toEqual([
        { type: 'caption', id: expect.any(String), english: 'Behind line', translated: 'Behind line' },
      ]);
      const translateCalls = (geminiClient.models.generateContent as any).mock.calls.filter(isTranslateCall);
      expect(translateCalls.some((c: any) => c[0].contents.includes('Behind line'))).toBe(false);

      captureSocket.close();
      viewerSocket.close();
    });

    it('still suppresses a flagged transcription even when the pipeline is behind', async () => {
      deps.maxPublishLagMs = 8000;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      // Even deeply behind, a flagged transcription must never reach viewers.
      session.liveLag.enqueue(Date.now() - 20000);

      const messages: any[] = [];
      viewerSocket.on('message', (data) => messages.push(JSON.parse(data.toString())));

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const transcript = await transcriptPromise;
      expect(transcript).toMatchObject({ flagged: true });

      await delay(50);
      // Only a line-removed — never a caption — reaches the viewer.
      expect(messages).toEqual([{ type: 'line-removed', id: transcript.id }]);
      expect(session.buffer.getRecent()[0]).toMatchObject({ id: transcript.id, suppressed: true });

      warnSpy.mockRestore();
      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- wsServer`
Expected: FAIL on the first new test — today a behind line is still translated, so a translate call for `Behind line` is made and the caption is `你好`, not English. (The second test may already pass, since suppression happens before any shed decision; it is a guardrail that must stay green after Step 4.)

- [ ] **Step 4: Add lag reporting and the ingest-shed branch (`wsServer.ts`)**

Add both edge-log helpers immediately below `raceAgainstDeadline` (added in Task 2):

```ts
// Edge-triggered so a long congested stretch produces one "engaged" log and one
// "disengaged" log, not one per line. Publish-path lag: how far behind the
// oldest un-published line is.
function reportLag(deps: WsServerDeps, lagMs: number): void {
  const behind = lagMs >= deps.maxPublishLagMs;
  if (behind && !deps.session.isBehind) {
    deps.session.isBehind = true;
    void logEvent('warn', { event: 'caption_backpressure_engaged', lagMs: Math.round(lagMs) });
  } else if (!behind && deps.session.isBehind) {
    deps.session.isBehind = false;
    void logEvent('info', { event: 'caption_backpressure_disengaged', lagMs: Math.round(lagMs) });
  }
}

// Ingest-path lag: how long a segment waited in the (un-sheddable) ingest queue
// before processing began. Measured only — surfaces a slow transcription
// verifier that back-pressure cannot fix.
function reportIngestLag(deps: WsServerDeps, ingestWaitMs: number): void {
  const high = ingestWaitMs >= deps.maxPublishLagMs;
  if (high && !deps.session.ingestLagHigh) {
    deps.session.ingestLagHigh = true;
    void logEvent('warn', { event: 'ingest_lag_high', ingestWaitMs: Math.round(ingestWaitMs) });
  } else if (!high && deps.session.ingestLagHigh) {
    deps.session.ingestLagHigh = false;
    void logEvent('info', { event: 'ingest_lag_cleared', ingestWaitMs: Math.round(ingestWaitMs) });
  }
}
```

In `enqueueOrderedSend` (inside `createEnqueuePublish`, from Task 2), add the disengage report immediately after the `sendPrepared(...)` call so a draining queue logs recovery:

```ts
      sendPrepared(line, results, deps, viewerMessageType);
      reportLag(deps, deps.session.liveLag.lagMs(Date.now()));
```

Change the `handleFinalSegmentFast` signature (currently lines 617-623) to add `publishEnglish` and `receivedAt`:

```ts
async function handleFinalSegmentFast(
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket,
  enqueuePublish: EnqueuePublish,
  publishEnglish: (line: CaptionLine, viewerMessageType?: 'caption' | 'caption-inserted') => void,
  schedulePrefetch: (line: CaptionLine, precedingContext: string[]) => void,
  receivedAt: number
): Promise<void> {
```

At the very top of `handleFinalSegmentFast`'s body (immediately after the opening `{`, before `const recentLines = ...`), measure ingest wait:

```ts
  reportIngestLag(deps, Date.now() - receivedAt);
```

Replace the visible-line tail of `handleFinalSegmentFast` (currently lines 678-680):

```ts
  const activeLanguages = deps.session.getActiveLanguages();
  const workPromise = translateWithFallback(deps, english, activeLanguages, precedingContext);
  enqueuePublish(line, workPromise);
```

with the lag-gated version:

```ts
  const lagMs = deps.session.liveLag.lagMs(Date.now());
  reportLag(deps, lagMs);
  if (lagMs >= deps.maxPublishLagMs) {
    // Behind: skip translation entirely and publish the (already
    // transcription-verified) English now, so the live LLM budget frees up and
    // the pipeline catches up.
    void logEvent('warn', { event: 'caption_lag_shed', reason: 'ingest_backpressure', english, lagMs: Math.round(lagMs) });
    publishEnglish(line);
    return;
  }

  const activeLanguages = deps.session.getActiveLanguages();
  const workPromise = translateWithFallback(deps, english, activeLanguages, precedingContext);
  enqueuePublish(line, workPromise);
```

- [ ] **Step 5: Wire `publishEnglish` and `receivedAt` through `handleCaptureConnection` (`wsServer.ts`)**

Change the destructure in `handleCaptureConnection` (from Task 2 Step 5):

```ts
  const { enqueuePublish } = createEnqueuePublish(deps);
```
to:
```ts
  const { enqueuePublish, publishEnglish } = createEnqueuePublish(deps);
```

Replace the `onFinalSegment` handler (currently lines 252-262) so it captures the receive time and passes both new arguments:

```ts
              onFinalSegment: (text) => {
                const receivedAt = Date.now();
                deps.session.ingestQueue = deps.session.ingestQueue
                  .then(() => handleFinalSegmentFast(text, deps, ws, enqueuePublish, publishEnglish, schedulePrefetch, receivedAt))
                  .catch((error) => {
                    void logEvent('error', {
                      event: 'segment_processing_failed',
                      english: text,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  });
              },
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `npm test -- wsServer`
Expected: PASS — both `live-queue back-pressure — ingest load shed` tests, and the Task 2 deadline tests, and every pre-existing test (unaffected: `maxPublishLagMs` is 60000 and no lag is seeded, so neither shed path triggers).

- [ ] **Step 7: Type-check and run the full suite**

Run: `npm run build`
Expected: no TypeScript errors.

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/session.ts server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "Shed translation at ingest when behind; add edge-triggered lag logging"
```

---

## Self-Review

**Spec coverage:**
- Pure, unit-testable `LiveLagTracker` measuring oldest-pending age → Task 1. ✓
- Publish-side staleness deadline → English fallback, late translation discarded → Task 2 Step 4 (`raceAgainstDeadline`, `englishFallbackResults`) + deadline test. ✓
- Ingest-side load shed (skip translation → publish English while behind) → Task 3 Step 4 (lag-gated tail) + ingest-shed test. ✓
- `MAX_PUBLISH_LAG_MS` env (default 8000), threaded through `WsServerDeps`, documented in `.env.example` → Task 2 Steps 2, 6, 7. ✓
- `Session.liveLag` reset per session → Task 2 Step 1; `isBehind`/`ingestLagHigh` reset per session → Task 3 Step 1. ✓
- Edge-triggered publish-lag logging (engaged/disengaged) → Task 3 Step 4 (`reportLag`, called at ingest and after each publish). ✓
- Ingest-wait measurement → Task 3 Steps 4-5 (`receivedAt` + `reportIngestLag`). ✓
- Safety invariant: transcription check on every line, flagged never published, only translation shed → suppression branch untouched (shed is after it); Task 3 Step 2 second test asserts it. ✓
- Caption ordering preserved → shed lines flow through the same serial `publishQueue`; Task 2 ordering test + the pre-existing "publishes captions in original order" test (must stay green). ✓
- `publishEnglish` guards mirror `prepareTranslationsForPublish` (suppressed → `null`) → Task 2 Step 4 `englishFallbackResults`. ✓
- No `web/` changes → confirmed in Global Constraints. ✓

**Placeholder scan:** No TBD/TODO/vague steps; every code step shows complete code and every run step shows the command and expected result. ✓

**Type consistency:**
- `LiveLagTracker` methods (`enqueue`/`dequeue`/`lagMs`/`size`) identical across Task 1 definition, Task 1 test, and Task 2/3 usage. ✓
- `maxPublishLagMs: number` identical in `WsServerDeps` (Task 2 Step 2), `index.ts` (Step 6), and test deps (Step 2). ✓
- `Publisher` shape (`enqueuePublish`, `publishEnglish`) identical between definition (Task 2 Step 4), destructures (Task 2 Step 5, Task 3 Step 5), and the `publishEnglish` parameter type in `handleFinalSegmentFast` (Task 3 Step 4). ✓
- `handleFinalSegmentFast` argument order in the call site (Task 3 Step 5) matches the new signature (Task 3 Step 4): `(text, deps, ws, enqueuePublish, publishEnglish, schedulePrefetch, receivedAt)`. ✓
- `englishFallbackResults` / `raceAgainstDeadline` return `Promise<PreparedLanguageResult[] | null>` matching what `enqueueOrderedSend` awaits and `sendPrepared` accepts. ✓
