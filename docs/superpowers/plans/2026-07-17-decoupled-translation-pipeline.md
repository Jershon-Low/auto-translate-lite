# Decoupled Translation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the growing caption backlog (and the manual-approval Enter-key stall) caused by the `translation` Gemini call serializing every downstream step in `server/src/wsServer.ts`.

**Architecture:** Split the single `processingQueue` promise chain into a fast, strictly-ordered `ingestQueue` (transcription safety-check + buffer mutation + immediate ack) and a `publishQueue` that only serializes *delivery* to viewers — the `translation` Gemini call itself fires immediately and can run concurrently across lines (still bounded by the existing `GeminiCallLimiter`).

**Tech Stack:** TypeScript, Node.js, `ws` (WebSocket), Vitest.

## Global Constraints

- No new dependencies.
- Every existing test in `server/tests/wsServer.test.ts` must keep passing unmodified — this is a behavior-preserving decoupling, not a feature change, except for the two explicitly-approved differences: (a) flagged/manual-hold lines' translations now populate `pendingTranslations` asynchronously instead of synchronously at append time, (b) the `reinstate` (Enter-key) ack and subsequent ingest processing no longer wait on that line's translate call.
- Caption/viewer delivery order must remain identical to today's spoken/approved order, even though translate calls now run concurrently.
- Run `npm test` from `server/` after every task; run `npm run build` (tsc) after every task that touches `.ts` files, since this project has no separate lint step gating merges.

---

## File Structure

Only one source file changes: `server/src/wsServer.ts` (currently 535 lines — this change adds ~40 net lines, still well within a single cohesive "WebSocket message handling" responsibility, so no split is warranted). Test additions go into the existing `server/tests/wsServer.test.ts`, which already contains black-box tests of this exact module via real WebSocket connections and a fake `GeminiClient` — no new test file needed.

- **Modify:** `server/src/wsServer.ts`
  - `finishPublishing` — drop its internal capture-socket ack send (Task 1).
  - `handleCaptureConnection` — rename `processingQueue` to `ingestQueue`, add `publishQueue` plus two new closures `enqueuePublish` and `schedulePrefetch` (Task 2).
  - `handleFinalSegment` → `handleFinalSegmentFast` — sends its ack immediately, defers translation via `enqueuePublish`/`schedulePrefetch` instead of awaiting it (Task 2).
  - `handleReinstate` → `handleReinstateFast` + new `buildReinstateTranslation` helper — sends its ack immediately, defers translation via `enqueuePublish` (Task 3).
  - `handleAdminRemove` — unchanged in behavior, only the queue variable it's wired to is renamed (Task 2).
- **Modify:** `server/tests/wsServer.test.ts` — new tests proving the ingest queue no longer blocks on translation, and that publish order is preserved under concurrency (Tasks 2 and 3).

---

## Task 1: Move the capture-socket ack out of `finishPublishing`

Pure refactor, no observable behavior change. This is required groundwork: once `handleFinalSegmentFast`/`handleReinstateFast` (Tasks 2–3) send their own ack *before* translation starts, `finishPublishing` must not also send one later — that would produce a duplicate `transcript` message. Doing this relocation as its own task, verified against the full existing suite, means Tasks 2–3 can each move the (already-relocated) ack call earlier without touching `finishPublishing` again.

**Files:**
- Modify: `server/src/wsServer.ts:205-286` (`finishPublishing`, `handleReinstate`)
- Modify: `server/src/wsServer.ts:304-352` (`handleFinalSegment`)

**Interfaces:**
- Produces: `finishPublishing(line: CaptionLine, translations: Record<string, string>, deps: WsServerDeps, viewerMessageType?: 'caption' | 'caption-inserted'): Promise<void>` — the `captureSocket` parameter is removed; callers are now responsible for sending the `{ type: 'transcript', ... }` ack themselves before calling this function.

- [ ] **Step 1: Run the full existing suite as a baseline**

Run: `cd server && npm test`
Expected: PASS (all current tests green — this is the behavior we must not break).

- [ ] **Step 2: Remove the ack send from `finishPublishing` and drop its `captureSocket` parameter**

In `server/src/wsServer.ts`, change:

```ts
async function finishPublishing(
  line: CaptionLine,
  translations: Record<string, string>,
  deps: WsServerDeps,
  captureSocket: WebSocket,
  viewerMessageType: 'caption' | 'caption-inserted' = 'caption'
): Promise<void> {
  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));

  const activeLanguages = deps.session.getActiveLanguages();
```

to:

```ts
async function finishPublishing(
  line: CaptionLine,
  translations: Record<string, string>,
  deps: WsServerDeps,
  viewerMessageType: 'caption' | 'caption-inserted' = 'caption'
): Promise<void> {
  const activeLanguages = deps.session.getActiveLanguages();
```

- [ ] **Step 3: Send the ack from `handleReinstate` before calling `finishPublishing`**

In `handleReinstate`, change the tail:

```ts
  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  await finishPublishing(line, translations, deps, captureSocket, 'caption-inserted');
}
```

to:

```ts
  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));
  await finishPublishing(line, translations, deps, 'caption-inserted');
}
```

- [ ] **Step 4: Send the ack from `handleFinalSegment`'s safe path before calling `finishPublishing`**

Change the tail of `handleFinalSegment`:

```ts
  const line = deps.session.buffer.append(english);
  await finishPublishing(line, translations, deps, captureSocket);
}
```

to:

```ts
  const line = deps.session.buffer.append(english);
  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));
  await finishPublishing(line, translations, deps);
}
```

- [ ] **Step 5: Run the full suite again to confirm zero behavior change**

Run: `cd server && npm test`
Expected: PASS (identical results to Step 1 — same tests, same pass count).

- [ ] **Step 6: Type-check**

Run: `cd server && npm run build`
Expected: PASS with no TypeScript errors (confirms the `captureSocket` parameter removal didn't leave a stale reference anywhere).

- [ ] **Step 7: Commit**

```bash
git add server/src/wsServer.ts
git commit -m "refactor: move capture-socket ack out of finishPublishing

Relocates the transcript ack to each caller, immediately before it
calls finishPublishing, with no behavior change. Groundwork for
decoupling translation from the processing queue: once callers start
sending this ack before translation begins (next tasks), finishPublishing
must not also send one later."
```

---

## Task 2: Split into `ingestQueue`/`publishQueue`; decouple `handleFinalSegment`

**Files:**
- Modify: `server/src/wsServer.ts:67-194` (`handleCaptureConnection`)
- Modify: `server/src/wsServer.ts:304-352` (`handleFinalSegment` → `handleFinalSegmentFast`)
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `finishPublishing(line, translations, deps, viewerMessageType?)` from Task 1. `translateWithFallback(deps, english, activeLanguages, precedingContext): Promise<Record<string,string>>` (existing, unchanged, `server/src/wsServer.ts:354-381`). `verifyTranscriptionWithRetry(deps, english, precedingContext): Promise<TranscriptionCheckResult>` (existing, unchanged, `server/src/wsServer.ts:383-405`). `CaptionLine` type from `server/src/types.ts` (has mutable optional `pendingTranslations?: Record<string,string>`).
- Produces:
  - `type EnqueuePublish = (line: CaptionLine, workPromise: Promise<Record<string, string>>, viewerMessageType?: 'caption' | 'caption-inserted') => void` — Task 3 takes this as a parameter.
  - `handleFinalSegmentFast(english: string, deps: WsServerDeps, captureSocket: WebSocket, enqueuePublish: EnqueuePublish, schedulePrefetch: (line: CaptionLine, precedingContext: string[]) => void): Promise<void>` — replaces `handleFinalSegment` as the `onFinalSegment` callback body.
  - The `ingestQueue` variable name (renamed from `processingQueue`) — Task 3 wires `reinstate` onto it.

- [ ] **Step 1: Write the new tests (they will fail against today's code)**

Add to `server/tests/wsServer.test.ts`, inside the top-level `describe('wsServer', ...)` block (e.g. after the existing `'falls back to English when the verifier call fails after retry'` test, before the `'falls back to English in the backlog...'` tests):

```ts
  describe('decoupled translation pipeline', () => {
    it("does not block a second segment's ack on the first segment's pending translate call", async () => {
      let resolveFirstTranslate!: (value: { text: string }) => void;
      const firstTranslate = new Promise<{ text: string }>((resolve) => {
        resolveFirstTranslate = resolve;
      });

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        if (params.contents.includes('Sentence: "Line 1"')) return firstTranslate;
        return Promise.resolve({ text: '{"zh":"你好2"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      // A subscribed viewer is required so activeLanguages is non-empty —
      // translateWithFallback short-circuits without calling Gemini at all
      // when there are zero active languages, which would make firstTranslate
      // irrelevant and defeat the point of this test.
      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const firstAckPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Line 1');
      const firstAck = await firstAckPromise;
      expect(firstAck).toEqual({ type: 'transcript', id: expect.any(String), english: 'Line 1' });

      // Line 1's translate call is still pending (firstTranslate unresolved).
      // A second segment must still get its ack without waiting for it.
      const secondAckPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Line 2');
      const secondAck = await secondAckPromise;
      expect(secondAck).toEqual({ type: 'transcript', id: expect.any(String), english: 'Line 2' });

      resolveFirstTranslate({ text: '{"zh":"你好1"}' });
      captureSocket.close();
      viewerSocket.close();
    });

    it('publishes captions to viewers in original order even when a later line translates first', async () => {
      let resolveFirstTranslate!: (value: { text: string }) => void;
      const firstTranslate = new Promise<{ text: string }>((resolve) => {
        resolveFirstTranslate = resolve;
      });

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        if (params.contents.includes('Sentence: "Line 1"')) return firstTranslate;
        return Promise.resolve({ text: '{"zh":"你好2"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const viewerMessages: any[] = [];
      viewerSocket.on('message', (data) => viewerMessages.push(JSON.parse(data.toString())));

      capturedCallbacks!.onFinalSegment('Line 1');
      await waitForMessage(captureSocket); // Line 1 ack
      capturedCallbacks!.onFinalSegment('Line 2');
      await waitForMessage(captureSocket); // Line 2 ack

      // Line 2's translate call already resolved. Give its publish work a
      // chance to run, and confirm it does NOT jump ahead of Line 1.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(viewerMessages).toEqual([]);

      resolveFirstTranslate({ text: '{"zh":"你好1"}' });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(viewerMessages).toEqual([
        { type: 'caption', id: expect.any(String), english: 'Line 1', translated: '你好1' },
        { type: 'caption', id: expect.any(String), english: 'Line 2', translated: '你好2' },
      ]);

      captureSocket.close();
      viewerSocket.close();
    });

    it('prefetches translations for a suppressed line in the background without publishing them', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []
      const viewerMessages: any[] = [];
      viewerSocket.on('message', (data) => viewerMessages.push(JSON.parse(data.toString())));

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const transcript = await transcriptPromise;
      expect(transcript).toMatchObject({ flagged: true });

      // Prefetch runs detached from the ingest queue; give its promise chain
      // a tick to settle, then confirm the buffer entry was filled in and
      // nothing was sent to the (still-suppressed) viewer.
      await new Promise((resolve) => setImmediate(resolve));
      const stored = session.buffer.peek(transcript.id);
      expect(stored?.pendingTranslations).toEqual({ zh: '你好' });
      expect(viewerMessages).toEqual([]);

      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd server && npx vitest run tests/wsServer.test.ts -t "decoupled translation pipeline"`
Expected: FAIL — the first test times out or fails because `secondAck` never arrives (today's `processingQueue` blocks segment 2 on segment 1's pending translate call).

- [ ] **Step 3: Rename the queue, add `publishQueue`, and add the two new closures**

In `handleCaptureConnection`, change:

```ts
function handleCaptureConnection(ws: WebSocket, deps: WsServerDeps): void {
  let deepgramConnection: DeepgramConnection | null = null;
  let processingQueue: Promise<void> = Promise.resolve();
  let recordingStartedAt: number | null = null;
  let unsubscribeCost: (() => void) | null = null;

  function finalizeDeepgramCost(): void {
    if (recordingStartedAt !== null) {
      const elapsedSeconds = (Date.now() - recordingStartedAt) / 1000;
      deps.costTracker.recordDeepgramSeconds(elapsedSeconds);
      recordingStartedAt = null;
    }
  }
```

to:

```ts
function handleCaptureConnection(ws: WebSocket, deps: WsServerDeps): void {
  let deepgramConnection: DeepgramConnection | null = null;
  let ingestQueue: Promise<void> = Promise.resolve();
  let publishQueue: Promise<void> = Promise.resolve();
  let recordingStartedAt: number | null = null;
  let unsubscribeCost: (() => void) | null = null;

  function finalizeDeepgramCost(): void {
    if (recordingStartedAt !== null) {
      const elapsedSeconds = (Date.now() - recordingStartedAt) / 1000;
      deps.costTracker.recordDeepgramSeconds(elapsedSeconds);
      recordingStartedAt = null;
    }
  }

  // Fires the translate call immediately (so multiple lines' calls can run
  // concurrently, bounded by GeminiCallLimiter), but only lets its result
  // reach viewers once every earlier-queued line has already been published —
  // so captions stay in original order even though the network calls overlap.
  function enqueuePublish(
    line: CaptionLine,
    workPromise: Promise<Record<string, string>>,
    viewerMessageType: 'caption' | 'caption-inserted' = 'caption'
  ): void {
    publishQueue = publishQueue
      .then(async () => {
        const translations = await workPromise;
        await finishPublishing(line, translations, deps, viewerMessageType);
      })
      .catch((error) => {
        void logEvent('error', {
          event: 'publish_failed',
          english: line.english,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  // For lines not yet visible to viewers (AI-flagged or manual-hold): warms
  // pendingTranslations in the background so an operator's later Approve can
  // often skip re-translating, without blocking the ingest queue or being
  // ordered against any other line's publish.
  function schedulePrefetch(line: CaptionLine, precedingContext: string[]): void {
    const activeLanguages = deps.session.getActiveLanguages();
    void translateWithFallback(deps, line.english, activeLanguages, precedingContext).then((translations) => {
      line.pendingTranslations = translations;
    });
  }
```

- [ ] **Step 4: Rewrite `handleFinalSegment` as `handleFinalSegmentFast`**

Replace the whole function (currently `server/src/wsServer.ts:304-352`):

```ts
async function handleFinalSegment(
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket
): Promise<void> {
  const recentLines = deps.session.buffer.getRecent();
  const precedingContext = recentLines
    .filter((recentLine) => !recentLine.suppressed)
    .slice(-PRECEDING_CONTEXT_LINES)
    .map((recentLine) => recentLine.english);
  const activeLanguages = deps.session.getActiveLanguages();

  const [transcriptionResult, translations] = await Promise.all([
    verifyTranscriptionWithRetry(deps, english, precedingContext),
    translateWithFallback(deps, english, activeLanguages, precedingContext),
  ]);

  const manualHold = deps.session.mode === 'manual';

  if (!transcriptionResult.safe || manualHold) {
    if (!transcriptionResult.safe) {
      void logEvent('warn', { event: 'transcription_flagged', english, reason: transcriptionResult.reason });
    }
    const reason = manualHold
      ? transcriptionResult.safe
        ? 'Pending manual approval'
        : `Pending manual approval — AI also flagged: ${transcriptionResult.reason}`
      : transcriptionResult.reason;
    const line = deps.session.buffer.append(english, Date.now(), true, translations);
    captureSocket.send(
      JSON.stringify({
        type: 'transcript',
        id: line.id,
        english,
        flagged: true,
        reason,
        ...(manualHold ? { pending: true } : {}),
      })
    );
    const removedPayload = JSON.stringify({ type: 'line-removed', id: line.id });
    for (const viewerSocket of deps.session.getAllViewers()) {
      viewerSocket.send(removedPayload);
    }
    return;
  }

  const line = deps.session.buffer.append(english);
  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));
  await finishPublishing(line, translations, deps);
}
```

with:

```ts
type EnqueuePublish = (
  line: CaptionLine,
  workPromise: Promise<Record<string, string>>,
  viewerMessageType?: 'caption' | 'caption-inserted'
) => void;

async function handleFinalSegmentFast(
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket,
  enqueuePublish: EnqueuePublish,
  schedulePrefetch: (line: CaptionLine, precedingContext: string[]) => void
): Promise<void> {
  const recentLines = deps.session.buffer.getRecent();
  const precedingContext = recentLines
    .filter((recentLine) => !recentLine.suppressed)
    .slice(-PRECEDING_CONTEXT_LINES)
    .map((recentLine) => recentLine.english);

  const transcriptionResult = await verifyTranscriptionWithRetry(deps, english, precedingContext);
  const manualHold = deps.session.mode === 'manual';
  const suppressed = manualHold || !transcriptionResult.safe;

  const line = deps.session.buffer.append(english, Date.now(), suppressed);

  if (suppressed) {
    if (!transcriptionResult.safe) {
      void logEvent('warn', { event: 'transcription_flagged', english, reason: transcriptionResult.reason });
    }
    const reason = manualHold
      ? transcriptionResult.safe
        ? 'Pending manual approval'
        : `Pending manual approval — AI also flagged: ${transcriptionResult.reason}`
      : transcriptionResult.reason;
    captureSocket.send(
      JSON.stringify({
        type: 'transcript',
        id: line.id,
        english,
        flagged: true,
        reason,
        ...(manualHold ? { pending: true } : {}),
      })
    );
    const removedPayload = JSON.stringify({ type: 'line-removed', id: line.id });
    for (const viewerSocket of deps.session.getAllViewers()) {
      viewerSocket.send(removedPayload);
    }
    schedulePrefetch(line, precedingContext);
    return;
  }

  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));
  const activeLanguages = deps.session.getActiveLanguages();
  const workPromise = translateWithFallback(deps, english, activeLanguages, precedingContext);
  enqueuePublish(line, workPromise);
}
```

- [ ] **Step 5: Wire `onFinalSegment` and `admin-remove` to the renamed/new queues**

In the `'start'` message handler, change:

```ts
            deepgramConnection = deps.createDeepgramConnection(deps.deepgramApiKey, {
              onFinalSegment: (text) => {
                processingQueue = processingQueue
                  .then(() => handleFinalSegment(text, deps, ws))
                  .catch((error) => {
```

to:

```ts
            deepgramConnection = deps.createDeepgramConnection(deps.deepgramApiKey, {
              onFinalSegment: (text) => {
                ingestQueue = ingestQueue
                  .then(() => handleFinalSegmentFast(text, deps, ws, enqueuePublish, schedulePrefetch))
                  .catch((error) => {
```

And change the `'admin-remove'` branch:

```ts
          } else if (message.type === 'admin-remove') {
            processingQueue = processingQueue
              .then(() => handleAdminRemove(message.id, deps, ws))
```

to:

```ts
          } else if (message.type === 'admin-remove') {
            ingestQueue = ingestQueue
              .then(() => handleAdminRemove(message.id, deps, ws))
```

Leave the `'reinstate'` branch's `processingQueue` reference as-is for now — Task 3 updates it (this will not compile until Task 3 lands; that's expected and fixed in the same PR-equivalent, or rename this occurrence to `ingestQueue` too right now to keep the build green between tasks — see note below).

> **Note:** Since `processingQueue` is being renamed everywhere it's used, and TypeScript will fail to compile with a stray reference, also rename it in the `'reinstate'` branch in this step (mechanical rename only, `handleReinstate` itself is untouched until Task 3):
>
> ```ts
>           } else if (message.type === 'reinstate') {
>             ingestQueue = ingestQueue
>               .then(() => handleReinstate(message.id, message.english, deps, ws))
> ```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `cd server && npx vitest run tests/wsServer.test.ts -t "decoupled translation pipeline"`
Expected: PASS (all 3 new tests green).

- [ ] **Step 7: Run the full suite**

Run: `cd server && npm test`
Expected: PASS — every existing test plus the 3 new ones.

- [ ] **Step 8: Type-check**

Run: `cd server && npm run build`
Expected: PASS with no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "feat: decouple translation from the ingest queue for final segments

Splits processingQueue into a fast ingestQueue (transcription-check +
buffer mutation + ack) and a publishQueue that only orders viewer
delivery. The translate call now fires immediately per line instead of
blocking the next segment's transcription-check, fixing the caption
backlog that builds up under a slower translation model. Flagged/manual-
hold lines prefetch their translation in the background instead of
computing it synchronously before the line is even shown to the operator."
```

---

## Task 3: Decouple `handleReinstate` (the manual-approval Enter key)

**Files:**
- Modify: `server/src/wsServer.ts:67-194` (`'reinstate'` message wiring — fix the temporary mechanical rename from Task 2 to call the new handler)
- Modify: `server/src/wsServer.ts:242-286` (`handleReinstate` → `handleReinstateFast` + new `buildReinstateTranslation`)
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `EnqueuePublish` type and `enqueuePublish` closure from Task 2. `translateWithFallback` (existing). `ingestQueue` variable (renamed in Task 2).
- Produces: `handleReinstateFast(id: string, english: string, deps: WsServerDeps, captureSocket: WebSocket, enqueuePublish: EnqueuePublish): Promise<void>` — replaces `handleReinstate` as the `'reinstate'` message handler body.

- [ ] **Step 1: Write the new test (it will fail against today's code)**

Add inside the existing `describe('reinstate', () => { ... })` block in `server/tests/wsServer.test.ts` (after `flagALine`'s definition, alongside the other reinstate tests):

```ts
    it("does not block the ingest queue on reinstate's translate call in manual mode", async () => {
      let resolveReinstateTranslate!: (value: { text: string }) => void;
      const heldTranslate = new Promise<{ text: string }>((resolve) => {
        resolveReinstateTranslate = resolve;
      });

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        if (params.contents.includes('Sentence: "Edited line"')) return heldTranslate;
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      // A subscribed viewer is required so activeLanguages is non-empty —
      // translateWithFallback short-circuits without calling Gemini at all
      // when there are zero active languages, which would make heldTranslate
      // irrelevant and defeat the point of this test.
      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      captureSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));

      const pendingAckPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Original line');
      const pendingAck = await pendingAckPromise;
      expect(pendingAck).toMatchObject({ type: 'transcript', english: 'Original line', flagged: true, pending: true });

      // Approve with edited text (the operator corrected the transcription
      // before pressing Enter) — this always pays a fresh, uncached translate
      // call, which is the case that used to stall the queue.
      const reinstateAckPromise = waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'reinstate', id: pendingAck.id, english: 'Edited line' }));
      const reinstateAck = await reinstateAckPromise;
      expect(reinstateAck).toEqual({ type: 'transcript', id: pendingAck.id, english: 'Edited line' });

      // The reinstate's translate call (heldTranslate) is still pending. The
      // ingest queue must still process a new segment without waiting on it.
      const nextAckPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Next segment');
      const nextAck = await nextAckPromise;
      expect(nextAck).toMatchObject({ english: 'Next segment' });

      resolveReinstateTranslate({ text: '{"zh":"编辑后的行"}' });
      captureSocket.close();
      viewerSocket.close();
    });
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `cd server && npx vitest run tests/wsServer.test.ts -t "does not block the ingest queue on reinstate"`
Expected: FAIL — `nextAck` never arrives, because today's `handleReinstate` awaits the edited-text translate call on the same queue that also processes `onFinalSegment`.

- [ ] **Step 3: Add `buildReinstateTranslation` and rewrite `handleReinstate` as `handleReinstateFast`**

Replace the whole function (currently `server/src/wsServer.ts:242-286`, after Task 1's edits):

```ts
async function handleReinstate(
  id: string,
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket
): Promise<void> {
  const trimmed = english.trim();
  if (trimmed.length === 0) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'empty text' }));
    return;
  }

  const existing = deps.session.buffer.peek(id);
  if (existing === null || !existing.suppressed) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  const originalEnglish = existing.english;
  const cachedTranslations = existing.pendingTranslations ?? {};
  const precedingContext = deps.session.buffer.precedingContextFor(id, PRECEDING_CONTEXT_LINES);
  const activeLanguages = deps.session.getActiveLanguages();

  let translations: Record<string, string>;
  if (trimmed === originalEnglish) {
    const cachedLanguages = activeLanguages.filter((language) => cachedTranslations[language] !== undefined);
    const newLanguages = activeLanguages.filter((language) => cachedTranslations[language] === undefined);
    const freshTranslations =
      newLanguages.length > 0 ? await translateWithFallback(deps, trimmed, newLanguages, precedingContext) : {};
    translations = {
      ...Object.fromEntries(cachedLanguages.map((language) => [language, cachedTranslations[language]])),
      ...freshTranslations,
    };
  } else {
    translations = await translateWithFallback(deps, trimmed, activeLanguages, precedingContext);
  }

  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));
  await finishPublishing(line, translations, deps, 'caption-inserted');
}
```

with:

```ts
function buildReinstateTranslation(
  deps: WsServerDeps,
  trimmed: string,
  originalEnglish: string,
  cachedTranslations: Record<string, string>,
  precedingContext: string[],
  activeLanguages: string[]
): Promise<Record<string, string>> {
  if (trimmed !== originalEnglish) {
    return translateWithFallback(deps, trimmed, activeLanguages, precedingContext);
  }
  const cachedLanguages = activeLanguages.filter((language) => cachedTranslations[language] !== undefined);
  const newLanguages = activeLanguages.filter((language) => cachedTranslations[language] === undefined);
  const cachedEntries = Object.fromEntries(cachedLanguages.map((language) => [language, cachedTranslations[language]]));
  if (newLanguages.length === 0) return Promise.resolve(cachedEntries);
  return translateWithFallback(deps, trimmed, newLanguages, precedingContext).then((fresh) => ({
    ...cachedEntries,
    ...fresh,
  }));
}

async function handleReinstateFast(
  id: string,
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket,
  enqueuePublish: EnqueuePublish
): Promise<void> {
  const trimmed = english.trim();
  if (trimmed.length === 0) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'empty text' }));
    return;
  }

  const existing = deps.session.buffer.peek(id);
  if (existing === null || !existing.suppressed) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  const originalEnglish = existing.english;
  const cachedTranslations = existing.pendingTranslations ?? {};
  const precedingContext = deps.session.buffer.precedingContextFor(id, PRECEDING_CONTEXT_LINES);
  const activeLanguages = deps.session.getActiveLanguages();

  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));

  const workPromise = buildReinstateTranslation(
    deps,
    trimmed,
    originalEnglish,
    cachedTranslations,
    precedingContext,
    activeLanguages
  );
  enqueuePublish(line, workPromise, 'caption-inserted');
}
```

- [ ] **Step 4: Wire the `'reinstate'` message handler to the new function**

Change:

```ts
          } else if (message.type === 'reinstate') {
            ingestQueue = ingestQueue
              .then(() => handleReinstate(message.id, message.english, deps, ws))
```

to:

```ts
          } else if (message.type === 'reinstate') {
            ingestQueue = ingestQueue
              .then(() => handleReinstateFast(message.id, message.english, deps, ws, enqueuePublish))
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `cd server && npx vitest run tests/wsServer.test.ts -t "does not block the ingest queue on reinstate"`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `cd server && npm test`
Expected: PASS — every existing test plus the 4 new ones from Tasks 2–3 (this confirms the two existing tests in the `reinstate` describe block, `'reinstates with unedited text'` and `'reinstates with edited text'`, still pass unmodified against the new code path).

- [ ] **Step 7: Type-check**

Run: `cd server && npm run build`
Expected: PASS with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "feat: decouple translation from the ingest queue for reinstate

handleReinstateFast now mutates the buffer and acks the operator
immediately, then enqueues its translate call (fresh or cache-augmented
via buildReinstateTranslation) onto the same ordered publishQueue used
by final segments. Pressing Enter to approve a line no longer blocks the
next approval or any speech transcribed while the operator was
reviewing."
```

---

## Task 4: Regression pass and manual verification

**Files:** none (verification only).

- [ ] **Step 1: Full automated regression**

Run: `cd server && npm test && npm run build`
Expected: All tests PASS, build succeeds with zero TypeScript errors.

- [ ] **Step 2: Manual verification — auto-mode backlog**

Using the `run` skill (or `npm run dev` in `server/` plus the existing capture-page client), start a live session with the `translation` model role set to `gemini-3.5-flash` (Admin → model config, or directly in the model-config JSON file the app reads via `ModelConfigStore`) and speak continuously (or feed several final segments in quick succession) for a few minutes. Confirm the capture page's transcript feed keeps pace with speech instead of visibly falling behind, and that viewer captions still appear in the correct spoken order.

- [ ] **Step 3: Manual verification — manual-mode Enter key**

Switch the session to Manual mode, edit an operator-side transcription line, and press Enter/Approve. Confirm the pending-approval queue accepts the next line immediately (no visible stall), and that the approved line's translation still appears correctly on the viewer page a moment later, in the correct position relative to other lines.

- [ ] **Step 4: Note any follow-up tuning**

If either manual check reveals the `GeminiCallLimiter`'s 8-slot cap is now the binding constraint (i.e., ingest keeps up but publish still lags because too many translate calls are queued waiting for a limiter slot), record that as a separate follow-up — raising the cap is explicitly out of scope for this change (see the design doc's Scope section) and should be its own small, separately-tested change.
