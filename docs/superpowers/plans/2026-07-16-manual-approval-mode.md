# Manual Approval Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Manual mode to the capture page: every finalized transcription line is held until the AV operator approves (as-is or edited) or rejects it, as an alternative to today's Automatic mode where only AI-flagged lines are held.

**Architecture:** Reuse the existing suppress/reinstate machinery end to end. `Session` gains a `mode` field; suppression at append time becomes `mode === 'manual' || AI check unsafe` instead of only the AI check. The translation already computed in parallel with the safety check is now retained on the buffer entry (instead of discarded) and reused when the operator approves unedited text, skipping a redundant Gemini translate call. Approve/Edit both go through the existing `reinstate` message; Reject is a client-side-only dismissal. A capture-page pending-approval queue with two rebindable keyboard shortcuts (default Enter/Space) lets the operator triage quickly.

**Tech Stack:** Node.js/TypeScript server (`ws`, Vitest for tests), Next.js/React capture page client (no test runner configured for `web/` — verify via the dev server in browser, matching this project's existing convention for that directory).

**Design doc:** [docs/superpowers/specs/2026-07-16-manual-approval-mode-design.md](../specs/2026-07-16-manual-approval-mode-design.md)

## Global Constraints

- Preserve every existing message shape exactly for the automatic-mode/AI-flag and admin-remove paths (no `pending` key present) so all currently-passing tests in `server/tests/wsServer.test.ts` keep passing unchanged.
- `PRECEDING_CONTEXT_LINES = 7` and `BUFFER_WINDOW_MS = 10 * 60 * 1000` are unchanged.
- No new npm dependencies in either `server/` or `web/`.
- `web/` has no unit test runner configured (only `lint`) — capture-page changes are verified manually via the dev server in the browser, per this project's existing convention (all prior capture-page features — Reinstate, admin-remove — were verified the same way).
- No `window.confirm()` for manual-mode Approve/Edit/Reject — confirm is preserved only on the existing automatic-mode AI-flag Reinstate path (gated on `line.pending` being false).
- Keyboard shortcuts are single non-modifier keys only, always act on the oldest item in the pending queue, and are ignored while any input/textarea/contenteditable has focus.
- `Session.mode` defaults to `'automatic'` and is **not** reset by `Session.start()` — it is an operator preference, not per-session data (unlike `buffer`, `sermonCache`, `translationCache`, `inFlightFills`, which are all cleared on `start()`).

---

## Task 1: `CaptionLine` gains `pendingTranslations`, `TranscriptBuffer` gains `peek()`

**Files:**
- Modify: `server/src/types.ts`
- Modify: `server/src/transcriptBuffer.ts`
- Test: `server/tests/transcriptBuffer.test.ts`

**Interfaces:**
- Produces: `CaptionLine.pendingTranslations?: Record<string, string>`; `TranscriptBuffer.append(english: string, timestampMs?: number, suppressed?: boolean, pendingTranslations?: Record<string, string>): CaptionLine`; `TranscriptBuffer.peek(id: string, nowMs?: number): CaptionLine | null`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/transcriptBuffer.test.ts`, inside the existing `describe('TranscriptBuffer', ...)` block, after the two existing `append()` tests (after line 38, before `describe('reinstate', ...)`):

```ts
  it('append() stores pendingTranslations when provided', () => {
    const buffer = new TranscriptBuffer();
    const line = buffer.append('Hidden', 1000, true, { zh: '你好' });
    expect(line.pendingTranslations).toEqual({ zh: '你好' });
  });

  it('append() leaves pendingTranslations undefined when not provided', () => {
    const buffer = new TranscriptBuffer();
    const line = buffer.append('Hello', 1000);
    expect(line.pendingTranslations).toBeUndefined();
  });

  describe('peek', () => {
    it('returns the matching line without mutating its suppressed state', () => {
      const buffer = new TranscriptBuffer();
      const line = buffer.append('Hidden', 1000, true, { zh: '你好' });
      expect(buffer.peek(line.id, 1000)).toEqual(line);
      expect(buffer.peek(line.id, 1000)?.suppressed).toBe(true);
    });

    it('returns null for an unknown id', () => {
      const buffer = new TranscriptBuffer();
      expect(buffer.peek('does-not-exist', 1000)).toBeNull();
    });

    it('returns null once the line has been trimmed out of the 10-minute window', () => {
      const buffer = new TranscriptBuffer();
      const line = buffer.append('Old', 0);
      const elevenMinutesLater = 11 * 60 * 1000;
      expect(buffer.peek(line.id, elevenMinutesLater)).toBeNull();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm test -- tests/transcriptBuffer.test.ts`
Expected: FAIL — `pendingTranslations` is not assignable / `buffer.peek is not a function`.

- [ ] **Step 3: Implement**

In `server/src/types.ts`, replace the whole file:

```ts
export interface CaptionLine {
  id: string;
  timestampMs: number;
  english: string;
  suppressed: boolean;
  pendingTranslations?: Record<string, string>;
}
```

In `server/src/transcriptBuffer.ts`, replace the `append` method (lines 9-14) with:

```ts
  append(
    english: string,
    timestampMs: number = Date.now(),
    suppressed: boolean = false,
    pendingTranslations?: Record<string, string>
  ): CaptionLine {
    const line: CaptionLine = { id: randomUUID(), timestampMs, english, suppressed, pendingTranslations };
    this.lines.push(line);
    this.trim(timestampMs);
    return line;
  }

  peek(id: string, nowMs: number = Date.now()): CaptionLine | null {
    this.trim(nowMs);
    return this.lines.find((candidate) => candidate.id === id) ?? null;
  }
```

(Insert `peek` as a new method — a good spot is directly after `append`, before the existing `getRecent`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm test -- tests/transcriptBuffer.test.ts`
Expected: PASS, all tests in the file (existing + new) green.

- [ ] **Step 5: Commit**

```bash
git add server/src/types.ts server/src/transcriptBuffer.ts server/tests/transcriptBuffer.test.ts
git commit -m "Add pendingTranslations to CaptionLine and TranscriptBuffer.peek()"
```

---

## Task 2: `Session` gains a `mode` field

**Files:**
- Modify: `server/src/session.ts`
- Test: `server/tests/session.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Session.mode: 'automatic' | 'manual'` (default `'automatic'`, not reset by `start()`).

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/session.test.ts`, at the end of the `describe('Session', ...)` block (after the last existing test, before the closing `});`):

```ts

  it('defaults mode to automatic', () => {
    const session = new Session();
    expect(session.mode).toBe('automatic');
  });

  it('start() does not reset mode — it is an operator preference, not session data', () => {
    const session = new Session();
    session.mode = 'manual';
    session.start();
    expect(session.mode).toBe('manual');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm test -- tests/session.test.ts`
Expected: FAIL — `Property 'mode' does not exist on type 'Session'`.

- [ ] **Step 3: Implement**

In `server/src/session.ts`, add a new field after `inFlightFills` (line 13), before the `private viewers` line:

```ts
  mode: 'automatic' | 'manual' = 'automatic';
```

Do not touch `start()` or `stop()` — `mode` must not be reset by either.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm test -- tests/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/session.ts server/tests/session.test.ts
git commit -m "Add Session.mode field for automatic/manual approval control"
```

---

## Task 3: Mode-aware suppression at append time, with translation caching

**Files:**
- Modify: `server/src/wsServer.ts`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `Session.mode` (Task 2), `TranscriptBuffer.append(..., pendingTranslations)` (Task 1).
- Produces: capture socket now receives `pending: true` on the `transcript` message when a line is held because of manual mode (in addition to the existing `flagged`/`reason`); handles new `{ type: 'set-mode', mode }` capture-socket message.

- [ ] **Step 1: Write the failing tests**

Add a new `describe('manual approval mode', ...)` block in `server/tests/wsServer.test.ts`, placed after the existing `describe('admin-remove', ...)` block (i.e. near the end of the file, as a sibling top-level describe inside `describe('wsServer', ...)`):

```ts
  describe('manual approval mode', () => {
    it('suppresses every safe line as pending when the session is in manual mode', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording
      captureSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const viewerMessages: any[] = [];
      viewerSocket.on('message', (data) => viewerMessages.push(JSON.parse(data.toString())));

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const transcript = await transcriptPromise;

      expect(transcript).toEqual({
        type: 'transcript',
        id: expect.any(String),
        english: 'Hello everyone',
        flagged: true,
        reason: 'Pending manual approval',
        pending: true,
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(viewerMessages).toEqual([{ type: 'line-removed', id: transcript.id }]);

      const recent = session.buffer.getRecent();
      expect(recent[0]).toMatchObject({ id: transcript.id, suppressed: true });
      expect(recent[0].pendingTranslations).toEqual({ zh: '你好' });

      captureSocket.close();
      viewerSocket.close();
    });

    it('combines the AI flag reason with the manual-approval reason when both apply', async () => {
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const transcript = await transcriptPromise;

      expect(transcript).toEqual({
        type: 'transcript',
        id: expect.any(String),
        english: 'Jesus is not the son of God',
        flagged: true,
        reason: 'Pending manual approval — AI also flagged: likely mis-heard negation',
        pending: true,
      });

      captureSocket.close();
    });

    it('switching from manual back to automatic mid-session only affects new lines, leaving already-pending lines suppressed', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));

      const firstTranscriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('First line');
      const firstTranscript = await firstTranscriptPromise;
      expect(firstTranscript.pending).toBe(true);

      captureSocket.send(JSON.stringify({ type: 'set-mode', mode: 'automatic' }));

      const secondTranscriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Second line');
      const secondTranscript = await secondTranscriptPromise;
      expect(secondTranscript).toEqual({ type: 'transcript', id: expect.any(String), english: 'Second line' });

      const recent = session.buffer.getRecent();
      expect(recent.find((line) => line.id === firstTranscript.id)?.suppressed).toBe(true);
      expect(recent.find((line) => line.id === secondTranscript.id)?.suppressed).toBe(false);

      captureSocket.close();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm test -- tests/wsServer.test.ts`
Expected: FAIL — the new tests time out or get an unexpected `transcript` shape (no `pending` field, `set-mode` is unhandled).

- [ ] **Step 3: Implement**

In `server/src/wsServer.ts`, add a new branch to the capture-socket message handler's if/else chain (in `handleCaptureConnection`), immediately after the existing `else if (message.type === 'admin-remove')` block (after line 144, before the chain's closing `}`):

```ts
          } else if (message.type === 'set-mode') {
            deps.session.mode = message.mode === 'manual' ? 'manual' : 'automatic';
          }
```

Replace `handleFinalSegment` (lines 266-299) in full:

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
  const sermonCache = deps.session.sermonCache;
  const activeLanguages = deps.session.getActiveLanguages();

  const [transcriptionResult, translations] = await Promise.all([
    verifyTranscriptionWithRetry(deps.geminiClient, english, precedingContext, sermonCache),
    translateWithFallback(deps, english, activeLanguages, precedingContext, sermonCache),
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
  await finishPublishing(line, translations, deps, captureSocket);
}
```

Note what did **not** change: `finishPublishing`, `translateWithFallback`, `verifyTranscriptionWithRetry`, `verifyTranslationsWithRetry`, `handleAdminRemove`, and the viewer-side subscribe handler are all untouched by this task.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm test -- tests/wsServer.test.ts`
Expected: PASS — all tests in the file, including every pre-existing one (this confirms the automatic-mode/AI-flag/admin-remove message shapes are unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "Suppress every line pending approval in manual mode, caching its translation"
```

---

## Task 4: Reinstate reuses cached translations for unedited approvals

**Files:**
- Modify: `server/src/wsServer.ts`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `TranscriptBuffer.peek()` (Task 1), `CaptionLine.pendingTranslations` (Task 1/3).
- Produces: no new message shapes — `reinstate`/`caption-inserted` behavior is unchanged from the outside; only the number of Gemini calls it takes changes.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('manual approval mode', ...)` block from Task 3, after its last test:

```ts

    it('approving an unedited manual-mode line reuses the cached translation instead of calling Gemini again', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const pending = await transcriptPromise;

      const translateCallsBeforeApprove = (geminiClient.models.generateContent as any).mock.calls.filter(
        isTranslateCall
      ).length;

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      captureSocket.send(JSON.stringify({ type: 'reinstate', id: pending.id, english: pending.english }));
      await ackPromise;
      const inserted = await insertedPromise;

      expect(inserted).toEqual({
        type: 'caption-inserted',
        id: pending.id,
        english: 'Hello everyone',
        translated: '你好',
      });

      const translateCallsAfterApprove = (geminiClient.models.generateContent as any).mock.calls.filter(
        isTranslateCall
      ).length;
      expect(translateCallsAfterApprove).toBe(translateCallsBeforeApprove);

      captureSocket.close();
      viewerSocket.close();
    });

    it('approving translates only languages that became active after the line was held, reusing the rest from cache', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));

      // No viewers yet: the line is held with an empty translation cache.
      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const pending = await transcriptPromise;
      expect(session.buffer.getRecent()[0].pendingTranslations).toEqual({});

      // A viewer joins zh after the line was held but before it's approved.
      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: [] (the line is suppressed, not included)

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      captureSocket.send(JSON.stringify({ type: 'reinstate', id: pending.id, english: pending.english }));
      await ackPromise;
      const inserted = await insertedPromise;

      expect(inserted).toEqual({
        type: 'caption-inserted',
        id: pending.id,
        english: 'Hello everyone',
        translated: '你好',
      });

      captureSocket.close();
      viewerSocket.close();
    });

    it('editing the text before approving discards the cache and re-translates', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      captureSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));
      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const pending = await transcriptPromise;

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":true,"reason":"ok"}}' });
        }
        return Promise.resolve({ text: '{"zh":"大家好"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      captureSocket.send(JSON.stringify({ type: 'reinstate', id: pending.id, english: 'Hello, everyone!' }));
      await ackPromise;
      const inserted = await insertedPromise;

      expect(inserted).toEqual({
        type: 'caption-inserted',
        id: pending.id,
        english: 'Hello, everyone!',
        translated: '大家好',
      });

      captureSocket.close();
      viewerSocket.close();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm test -- tests/wsServer.test.ts`
Expected: FAIL — the "reuses the cached translation" test fails because `translateCallsAfterApprove` is greater than `translateCallsBeforeApprove` (today's `handleReinstate` always re-translates).

- [ ] **Step 3: Implement**

Replace `handleReinstate` (lines 219-248) in full:

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
      newLanguages.length > 0
        ? await translateWithFallback(deps, trimmed, newLanguages, precedingContext, deps.session.sermonCache)
        : {};
    translations = {
      ...Object.fromEntries(cachedLanguages.map((language) => [language, cachedTranslations[language]])),
      ...freshTranslations,
    };
  } else {
    translations = await translateWithFallback(deps, trimmed, activeLanguages, precedingContext, deps.session.sermonCache);
  }

  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  await finishPublishing(line, translations, deps, captureSocket, 'caption-inserted');
}
```

`finishPublishing` is unchanged — it still runs `verifyTranslationsWithRetry` on whatever `translations` it's given, whether those came from cache or a fresh call, so safety verification is never skipped even when the translate step is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm test -- tests/wsServer.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "Reuse cached translations on unedited reinstate, translating only newly-active languages"
```

---

## Task 5: Capture page — mode toggle and pending-approval queue

**Files:**
- Modify: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: `{ type: 'transcript', ..., pending?: boolean }` and `{ type: 'set-mode', mode }` (Task 3).
- Produces: `const pendingQueue: TranscriptLine[]`, `sendReinstate(id: string)` (extended, pre-existing name), `rejectLine(id: string)` — Task 6 wires keyboard shortcuts to all three.

- [ ] **Step 1: Extend the `TranscriptLine` type**

In `web/app/capture/page.tsx`, replace the `TranscriptLine` type (lines 10-20):

```ts
type TranscriptLine = {
  id: string;
  text: string;
  flagged: boolean;
  reason?: string;
  pending?: boolean;
  dismissed?: boolean;
  reinstateState?: 'editing' | 'pending' | 'error';
  editedText?: string;
  reinstateError?: string;
  removeState?: 'pending' | 'error';
  removeError?: string;
};
```

- [ ] **Step 2: Add mode state**

After the existing state declarations (after line 55, `const [isFollowing, setIsFollowing] = useState(true);`), add:

```ts
  const [mode, setModeState] = useState<'automatic' | 'manual'>('automatic');
  const modeRef = useRef<'automatic' | 'manual'>('automatic');

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  function setMode(newMode: 'automatic' | 'manual') {
    setModeState(newMode);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'set-mode', mode: newMode }));
    }
  }
```

This block must be followed immediately by the `pendingQueue` declaration, even though nothing in this task reads it yet — Task 6 adds `useEffect` hooks below this point that take `pendingQueue` in their dependency array, and a `const` referenced by a hook must be declared earlier in the function body than that hook (temporal dead zone), so it belongs here rather than down by the `return` statement:

```ts
  const pendingQueue = transcriptLines.filter((line) => line.pending && !line.dismissed);
```

- [ ] **Step 3: Send the current mode on (re)connect, and carry `pending` through the transcript handler**

In `connectSocket` (lines 217-270): inside `socket.onopen` (lines 257-260), add a `set-mode` send right after the `start` send:

```ts
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'start' }));
      socket.send(JSON.stringify({ type: 'set-mode', mode: modeRef.current }));
      void ensureRecorderStreaming(socket);
    };
```

In the same function's `onmessage` handler, replace the `transcript` branch (lines 225-238):

```ts
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => {
          const index = previous.findIndex((line) => line.id === message.id);
          const updated: TranscriptLine = {
            id: message.id,
            text: message.english,
            flagged: Boolean(message.flagged),
            reason: message.reason,
            pending: Boolean(message.pending),
          };
          if (index === -1) return [...previous.slice(-49), updated];
          const next = [...previous];
          next[index] = updated;
          return next;
        });
```

- [ ] **Step 4: Skip the confirm dialog for manual-mode approve/edit**

Replace `sendReinstate` (lines 311-323):

```ts
  function sendReinstate(id: string) {
    if (status !== 'recording') return;
    const line = transcriptLines.find((entry) => entry.id === id);
    if (!line) return;
    const editedText = (line.editedText ?? line.text).trim();
    if (editedText.length === 0) return;
    if (!line.pending) {
      const confirmed = window.confirm(`Flagged: "${line.reason ?? 'no reason given'}". Send this line to viewers?`);
      if (!confirmed) return;
    }
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, reinstateState: 'pending' } : entry))
    );
    socketRef.current?.send(JSON.stringify({ type: 'reinstate', id, english: editedText }));
  }
```

(Only the new `if (!line.pending) { ... }` guard around the existing `window.confirm` call is new; everything else in the function is unchanged. `line.pending` is `true` for manual-mode holds and `false`/`undefined` for automatic-mode AI-flags and admin-removed lines, so their confirm behavior is unchanged.)

- [ ] **Step 5: Add `rejectLine`**

Immediately after `sendAdminRemove` (after line 333), add:

```ts

  function rejectLine(id: string) {
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, dismissed: true } : entry))
    );
  }
```

- [ ] **Step 6: Render the mode toggle and queue panel**

`pendingQueue` was already declared in Step 2, immediately after `setMode`. In the JSX, add the mode toggle right after the existing Start/Stop `<div className="flex gap-4">...</div>` block (after line 368's closing `</div>`, before the `<p className="text-sm text-muted-foreground">Status: {status}</p>` line):

```tsx
      <div className="flex items-center gap-3 text-sm">
        <span className="font-medium">Mode:</span>
        <button
          onClick={() => setMode('automatic')}
          className={mode === 'automatic' ? 'underline font-semibold' : 'text-muted-foreground'}
        >
          Automatic
        </button>
        <button
          onClick={() => setMode('manual')}
          className={mode === 'manual' ? 'underline font-semibold' : 'text-muted-foreground'}
        >
          Manual
        </button>
        {mode === 'manual' && <span className="text-muted-foreground">{pendingQueue.length} pending</span>}
      </div>
```

Then add the pending-approval queue panel right before the existing full transcript feed's `<div className="relative w-full max-w-xl">` (before line 374):

```tsx
      {mode === 'manual' && (
        <div className="w-full max-w-xl flex flex-col gap-2">
          <label className="text-sm font-medium">Pending approval ({pendingQueue.length})</label>
          {pendingQueue.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waiting.</p>
          ) : (
            <div className="border rounded divide-y max-h-64 overflow-y-auto text-sm">
              {pendingQueue.map((line) => (
                <div key={line.id} className="p-2 flex flex-col gap-1">
                  <p>{line.text}</p>
                  {line.reason && <p className="text-xs text-muted-foreground">{line.reason}</p>}
                  {line.reinstateState === 'editing' && status === 'recording' ? (
                    <div className="flex flex-col gap-1">
                      <textarea
                        value={line.editedText ?? line.text}
                        onChange={(event) => updateEditedText(line.id, event.target.value)}
                        rows={2}
                        className="w-full border rounded p-1 text-xs"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => sendReinstate(line.id)}
                          disabled={(line.editedText ?? line.text).trim().length === 0}
                          className="bg-primary text-primary-foreground px-2 py-1 rounded text-xs disabled:opacity-50"
                        >
                          Send
                        </button>
                        <button onClick={() => cancelEditing(line.id)} className="text-xs underline">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => sendReinstate(line.id)}
                        disabled={status !== 'recording' || line.reinstateState === 'pending'}
                        className="bg-primary text-primary-foreground px-2 py-1 rounded text-xs disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => beginEditing(line.id, line.text)}
                        disabled={status !== 'recording' || line.reinstateState === 'pending'}
                        className="underline text-xs disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button onClick={() => rejectLine(line.id)} className="underline text-xs text-destructive">
                        Reject
                      </button>
                    </div>
                  )}
                  {line.reinstateState === 'error' && (
                    <p className="text-xs text-destructive">Couldn&apos;t approve ({line.reinstateError}) — try again.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 7: Manually verify in the browser**

Run: start both servers per the project's existing dev setup (`server`: `npm run dev`; `web`: `npm run dev`), open the capture page.

Check:
1. Click **Manual** — the mode toggle highlights Manual, "0 pending" shows.
2. Click **Start**, speak (or otherwise trigger a final segment) — the line appears in "Pending approval" with an Approve/Edit/Reject row, and does **not** appear on any viewer tab.
3. Click **Approve** — no confirm dialog appears, the line disappears from the pending queue, and (with a viewer tab open and subscribed) the line appears on the viewer near-instantly.
4. Trigger another line, click **Edit**, change the text, click **Send** — no confirm dialog, the corrected text appears on the viewer.
5. Trigger another line, click **Reject** — it disappears from the pending queue; scroll the full transcript feed below and confirm the row is still there, struck through, with its own Reinstate control still available (unmodified from today).
6. Switch to **Automatic** mid-session with the pending queue non-empty — confirm the already-queued line stays in the queue, and a newly-spoken line flows straight to the viewer without ever appearing in the queue.
7. Click **Remove** (existing feature) on a line you just Approved — confirm it still works, matching today's admin-remove behavior.

- [ ] **Step 8: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "Add manual-mode toggle and pending-approval queue to the capture page"
```

---

## Task 6: Capture page — rebindable keyboard shortcuts for Approve/Reject

**Files:**
- Modify: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: `pendingQueue`, `sendReinstate`, `rejectLine` (Task 5).

- [ ] **Step 1: Add shortcut-binding state and persistence**

After the `mode`/`modeRef` block added in Task 5 Step 2, add:

```ts
  const [approveKey, setApproveKey] = useState('Enter');
  const [rejectKey, setRejectKey] = useState(' ');
  const [rebindingAction, setRebindingAction] = useState<'approve' | 'reject' | null>(null);
  const [rebindError, setRebindError] = useState<string | null>(null);

  useEffect(() => {
    const storedApprove = window.localStorage.getItem('captureApproveKey');
    const storedReject = window.localStorage.getItem('captureRejectKey');
    if (storedApprove) setApproveKey(storedApprove);
    if (storedReject) setRejectKey(storedReject);
  }, []);

  function displayKey(key: string): string {
    return key === ' ' ? 'Space' : key;
  }
```

- [ ] **Step 2: Add the rebind-capture effect**

Immediately after the block from Step 1, add:

```ts
  useEffect(() => {
    if (!rebindingAction) return;
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      const key = event.key;
      const otherKey = rebindingAction === 'approve' ? rejectKey : approveKey;
      if (key === otherKey) {
        setRebindError("Approve and Reject can't share a key.");
        return;
      }
      if (rebindingAction === 'approve') {
        setApproveKey(key);
        window.localStorage.setItem('captureApproveKey', key);
      } else {
        setRejectKey(key);
        window.localStorage.setItem('captureRejectKey', key);
      }
      setRebindError(null);
      setRebindingAction(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rebindingAction, approveKey, rejectKey]);
```

- [ ] **Step 3: Add the triage shortcut effect**

Immediately after the block from Step 2 (`pendingQueue` is already in scope — it was declared in Task 5 Step 2):

```ts
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (rebindingAction) return;
      const target = event.target as HTMLElement | null;
      const isEditable = Boolean(
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      );
      if (isEditable) return;
      const oldest = pendingQueue[0];
      if (!oldest) return;
      if (event.key === approveKey) {
        event.preventDefault();
        sendReinstate(oldest.id);
      } else if (event.key === rejectKey) {
        event.preventDefault();
        rejectLine(oldest.id);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingQueue, approveKey, rejectKey, rebindingAction]);
```

- [ ] **Step 4: Render the rebind controls, and highlight the oldest queued line**

Add the rebind controls right after the mode-toggle `<div>` added in Task 5 Step 6:

```tsx
      <div className="flex items-center gap-3 text-sm">
        <span className="font-medium">Shortcuts:</span>
        <button
          onClick={() => {
            setRebindError(null);
            setRebindingAction('approve');
          }}
          className="underline"
        >
          Approve: {rebindingAction === 'approve' ? 'press a key…' : displayKey(approveKey)}
        </button>
        <button
          onClick={() => {
            setRebindError(null);
            setRebindingAction('reject');
          }}
          className="underline"
        >
          Reject: {rebindingAction === 'reject' ? 'press a key…' : displayKey(rejectKey)}
        </button>
        {rebindError && <span className="text-destructive text-xs">{rebindError}</span>}
      </div>
```

In the pending-approval queue JSX from Task 5 Step 6, change `{pendingQueue.map((line) => (` to `{pendingQueue.map((line, index) => (`, add a highlight to the row wrapper, and label the first row's buttons with the bound key:

```tsx
                <div key={line.id} className={`p-2 flex flex-col gap-1 ${index === 0 ? 'bg-accent/30' : ''}`}>
```

```tsx
                      <button
                        onClick={() => sendReinstate(line.id)}
                        disabled={status !== 'recording' || line.reinstateState === 'pending'}
                        className="bg-primary text-primary-foreground px-2 py-1 rounded text-xs disabled:opacity-50"
                      >
                        {index === 0 ? `Approve (${displayKey(approveKey)})` : 'Approve'}
                      </button>
                      <button
                        onClick={() => beginEditing(line.id, line.text)}
                        disabled={status !== 'recording' || line.reinstateState === 'pending'}
                        className="underline text-xs disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button onClick={() => rejectLine(line.id)} className="underline text-xs text-destructive">
                        {index === 0 ? `Reject (${displayKey(rejectKey)})` : 'Reject'}
                      </button>
```

- [ ] **Step 5: Manually verify in the browser**

Check:
1. With the pending queue non-empty, press **Enter** — the oldest queued line is approved (same effect as clicking its Approve button), and the queue's next item becomes the new "oldest" (highlighted row).
2. Press **Space** — the oldest queued line is rejected.
3. Click into the feedback notes textarea, type a sentence containing spaces and press Enter inside it — confirm neither keystroke triggers Approve/Reject (the shortcut listener ignores keys while a text field has focus) and the textarea behaves normally.
4. Click "Approve: Enter" to start rebinding, press `a` — the label updates to "Approve: a"; press `a` again in the transcript area (not while rebinding) and confirm it now approves the oldest line.
5. Try to rebind Reject to the same key currently bound to Approve — confirm the inline error "Approve and Reject can't share a key." appears and the previous binding is retained.
6. Reload the page — confirm the rebindings persisted (read from `localStorage`).

- [ ] **Step 6: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "Add rebindable Enter/Space keyboard shortcuts for pending-queue triage"
```

---

## Self-Review Notes

- **Spec coverage:** mode toggle + persistence semantics → Task 2/5; append-time suppression + reason text → Task 3; translation caching + reinstate reuse → Task 1/4; Reject as client-only dismissal → Task 5; Remove still works on approved lines → verified manually in Task 5 Step 7 (no code change needed, confirmed by reading `handleAdminRemove`, which operates on any buffer entry by id regardless of history); keyboard shortcuts + rebind + scope guard → Task 6.
- **Deviation from the design doc, noted here for transparency:** the design doc's Section 2 described caching `{ text, safe }` per language (translation *and* verification outcome). The implementation instead caches only the raw translation (`Record<string, string>`) and always re-runs verification at actual publish time via the existing, unmodified `finishPublishing`/`verifyTranslationsWithRetry`. This is strictly safer (verification is never skipped, and never stale) and cheaper (no extra verify call for lines that are ultimately rejected and never approved) — same user-visible behavior, better-justified internals.
