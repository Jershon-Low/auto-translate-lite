# Late Translation Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the publish deadline sheds a caption to English, stop discarding its still-running translation — mark the line as still-working in the viewer, and upgrade it in place when the (already-verified) translation lands.

**Architecture:** `raceAgainstDeadline` starts returning *why* it resolved (`{ results, shedAt }`) instead of just results. When it shed and corrections are enabled, the published caption carries `awaitingCorrection: true`, and the retained `preparedPromise` is chained off that line's own ordered-send link to deliver exactly one terminal `caption-corrected` message — either an upgrade (real translation) or a settle (clear the waiting state, no text change). The client renders `pending || awaitingCorrection` through one unified treatment.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node.js, `ws`, Vitest (server). Next.js 16 / React 19 / Tailwind (web — no test runner).

## Global Constraints

- ESM imports within `server/src` use `.js` specifiers, even though source files are `.ts`.
- Env var name (exact): `MAX_CORRECTION_LAG_MS`. Default when unset: `30000`. `0` disables the feature entirely.
- `WsServerDeps` field name (exact): `maxCorrectionLagMs: number`.
- Viewer message type (exact): `caption-corrected`. Client line field (exact): `awaitingCorrection`.
- **Safety invariant (never violate):** a correction may only ever carry a `PreparedLanguageResult` produced by `prepareTranslationsForPublish` — which means translation-verification has already run on it. The correction path performs no verification of its own and must never construct translated text from any other source. The transcription safety check and the suppression branch in `handleFinalSegmentFast` are not touched by this plan.
- **Ordering invariant:** a `caption-corrected` must never reach a viewer before the `caption` it patches. It is chained off that line's own ordered-send link, never sent eagerly on translation resolution.
- Only deadline-shed lines are correctable. Ingest-shed lines (`publishEnglish`) must carry `shedAt: null` and are never corrected — that path exists to remove LLM load.
- Server commands run from `server/`: tests `npm test` (Vitest), build `npm run build`. Web commands run from `web/`: `npm run build`, `npm run lint`. **`web/` has no test runner** — do not add one.
- Spec: `docs/superpowers/specs/2026-07-25-late-translation-correction-design.md`.

---

### Task 1: Deadline outcome plumbing + `awaitingCorrection` flag

Refactors `raceAgainstDeadline` to report the shed decision, threads the new config, and marks shed captions. No correction is sent yet (Task 2).

**Files:**
- Modify: `server/src/wsServer.ts` (`WsServerDeps`, new `DeadlineOutcome`, `raceAgainstDeadline`, `enqueueOrderedSend`, `enqueuePublish`, `publishEnglish`, `sendPrepared`)
- Modify: `server/src/index.ts` (thread `MAX_CORRECTION_LAG_MS`)
- Modify: `server/.env.example`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Produces:
  - `WsServerDeps.maxCorrectionLagMs: number`
  - `interface DeadlineOutcome { results: PreparedLanguageResult[] | null; shedAt: number | null }` — `shedAt` is the shed timestamp, or `null` when the translation won the race.
  - `enqueueOrderedSend(line, enqueuedAt, outcomePromise: Promise<DeadlineOutcome>, viewerMessageType): Promise<void>` — now **returns** the promise for the link it appended (Task 2 chains the correction off it).
  - `sendPrepared(line, results, deps, viewerMessageType, awaitingCorrection = false)` — new trailing parameter, adds `awaitingCorrection: true` to the viewer payload when set.

- [ ] **Step 1: Add the dep and thread config**

In `server/src/wsServer.ts`, add to `WsServerDeps` immediately after `maxPublishLagMs: number;` (currently line 85):

```ts
  maxPublishLagMs: number;
  maxCorrectionLagMs: number;
```

In `server/src/index.ts`, in the `attachWsServer({ ... })` call, add immediately after the `maxPublishLagMs:` line:

```ts
  maxCorrectionLagMs: process.env.MAX_CORRECTION_LAG_MS ? Number(process.env.MAX_CORRECTION_LAG_MS) : 30000,
```

Append to `server/.env.example`:

```
MAX_CORRECTION_LAG_MS=30000
```

In `server/tests/wsServer.test.ts`, add to the `deps = { ... }` object immediately after `maxPublishLagMs: 60000,`:

```ts
      maxPublishLagMs: 60000,
      maxCorrectionLagMs: 0,
```

> `0` (feature off) is deliberate for the shared test fixture: it keeps every pre-existing test — including the Fix 3 back-pressure tests that assert exact caption payloads — byte-identical. Correction tests opt in by setting `deps.maxCorrectionLagMs` themselves. This mirrors how Fix 3 chose `maxPublishLagMs: 60000` to neutralize itself for older tests.

- [ ] **Step 2: Write the failing test**

Add this `describe` block at the end of the top-level `describe('wsServer', ...)` in `server/tests/wsServer.test.ts`, immediately before its closing `});`:

```ts
  describe('late translation correction — shed marking', () => {
    it('marks a deadline-shed caption as awaiting a correction when corrections are enabled', async () => {
      deps.maxPublishLagMs = 30;
      deps.maxCorrectionLagMs = 30000;
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
      await delay(120);

      const caption = messages.find((m) => m.type === 'caption');
      expect(caption).toEqual({
        type: 'caption',
        id: expect.any(String),
        english: 'Hello everyone',
        translated: 'Hello everyone',
        awaitingCorrection: true,
      });

      captureSocket.close();
      viewerSocket.close();
    });

    it('does not mark a shed caption when corrections are disabled', async () => {
      deps.maxPublishLagMs = 30;
      deps.maxCorrectionLagMs = 0;
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
      await delay(120);

      const caption = messages.find((m) => m.type === 'caption');
      expect(caption).not.toHaveProperty('awaitingCorrection');

      captureSocket.close();
      viewerSocket.close();
    });

    it('never marks an ingest-shed caption as awaiting a correction', async () => {
      deps.maxPublishLagMs = 8000;
      deps.maxCorrectionLagMs = 30000;

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      // Drive publish lag over the threshold so the next segment is ingest-shed.
      session.liveLag.enqueue(Date.now() - 20000);

      const messages: any[] = [];
      viewerSocket.on('message', (data) => messages.push(JSON.parse(data.toString())));

      capturedCallbacks!.onFinalSegment('Behind line');
      await delay(80);

      const caption = messages.find((m) => m.type === 'caption');
      expect(caption).toEqual({
        type: 'caption',
        id: expect.any(String),
        english: 'Behind line',
        translated: 'Behind line',
      });

      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- wsServer`
Expected: the first test FAILS — the shed caption has no `awaitingCorrection` property yet. (The second and third tests should already pass; they are guardrails that must stay green after Step 4.) A TypeScript error on `deps.maxCorrectionLagMs` resolves once Step 1's interface edit is in place.

- [ ] **Step 4: Add `DeadlineOutcome` and refactor `raceAgainstDeadline`**

In `server/src/wsServer.ts`, add the interface immediately after the `DEADLINE_REACHED` declaration (currently line 132):

```ts
const DEADLINE_REACHED = Symbol('deadline-reached');

// What raceAgainstDeadline decided, not just what it produced. `shedAt` is the
// moment the deadline fired (and therefore the clock the correction window is
// measured from), or null when the translation won the race and no correction
// is owed.
interface DeadlineOutcome {
  results: PreparedLanguageResult[] | null;
  shedAt: number | null;
}
```

Replace the whole of `raceAgainstDeadline` (currently lines 149-179) with:

```ts
async function raceAgainstDeadline(
  preparedPromise: Promise<PreparedLanguageResult[] | null>,
  deadlineMs: number,
  line: CaptionLine,
  deps: WsServerDeps
): Promise<DeadlineOutcome> {
  // Attach a handler immediately so a rejection is never left unhandled,
  // regardless of which branch below runs (the early-return path never
  // otherwise touches preparedPromise).
  void preparedPromise.catch(() => {});

  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    void logEvent('warn', { event: 'caption_lag_shed', reason: 'publish_deadline', english: line.english });
    return { results: englishFallbackResults(line, deps), shedAt: Date.now() };
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof DEADLINE_REACHED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_REACHED), remaining);
  });
  try {
    const outcome = await Promise.race([preparedPromise, timeout]);
    if (outcome === DEADLINE_REACHED) {
      void logEvent('warn', { event: 'caption_lag_shed', reason: 'publish_deadline', english: line.english });
      return { results: englishFallbackResults(line, deps), shedAt: Date.now() };
    }
    return { results: outcome, shedAt: null };
  } finally {
    clearTimeout(timer!);
  }
}
```

- [ ] **Step 5: Thread the outcome through `enqueueOrderedSend` and its callers**

Replace `enqueueOrderedSend` (currently lines 220-245) with — note it now **returns** the send promise:

```ts
  function enqueueOrderedSend(
    line: CaptionLine,
    enqueuedAt: number,
    outcomePromise: Promise<DeadlineOutcome>,
    viewerMessageType: 'caption' | 'caption-inserted'
  ): Promise<void> {
    const tracker = deps.session.liveLag;
    tracker.enqueue(enqueuedAt);
    const sendPromise = deps.session.publishQueue.then(async () => {
      let outcome: DeadlineOutcome;
      try {
        outcome = await outcomePromise;
      } catch (error) {
        void logEvent('error', {
          event: 'publish_failed',
          english: line.english,
          error: error instanceof Error ? error.message : String(error),
        });
        outcome = { results: null, shedAt: null };
      } finally {
        tracker.dequeue();
      }
      // Tell the viewer a correction may follow only when one is actually owed:
      // the line was shed at the deadline AND corrections are enabled.
      const awaitingCorrection = outcome.shedAt !== null && deps.maxCorrectionLagMs > 0;
      sendPrepared(line, outcome.results, deps, viewerMessageType, awaitingCorrection);
      reportLag(deps, deps.session.liveLag.lagMs(Date.now()));
    });
    deps.session.publishQueue = sendPromise;
    return sendPromise;
  }
```

Replace `enqueuePublish` (currently lines 247-255) with:

```ts
  const enqueuePublish: EnqueuePublish = (line, workPromise, viewerMessageType = 'caption') => {
    const enqueuedAt = Date.now();
    // Translate + verify still starts immediately (not gated on the queue), as before.
    const preparedPromise = workPromise.then((translations) =>
      prepareTranslationsForPublish(line, translations, deps)
    );
    const outcomePromise = raceAgainstDeadline(preparedPromise, enqueuedAt + deps.maxPublishLagMs, line, deps);
    enqueueOrderedSend(line, enqueuedAt, outcomePromise, viewerMessageType);
  };
```

Replace `publishEnglish` (currently lines 257-259) with — an ingest-shed line is never correctable, hence `shedAt: null`:

```ts
  const publishEnglish = (line: CaptionLine, viewerMessageType: 'caption' | 'caption-inserted' = 'caption'): void => {
    enqueueOrderedSend(
      line,
      Date.now(),
      Promise.resolve({ results: englishFallbackResults(line, deps), shedAt: null }),
      viewerMessageType
    );
  };
```

- [ ] **Step 6: Add the `awaitingCorrection` payload field in `sendPrepared`**

Change `sendPrepared`'s signature and payload (currently lines 631-657) — only the signature line and the `payload` construction change:

```ts
function sendPrepared(
  line: CaptionLine,
  results: PreparedLanguageResult[] | null,
  deps: WsServerDeps,
  viewerMessageType: 'caption' | 'caption-inserted',
  awaitingCorrection = false
): void {
  if (results === null) return;

  for (const { language, translated, flagged, reason } of results) {
    deps.session.translationCache.set(
      language,
      line.id,
      flagged ? { translated, flagged: true, reason: reason! } : { translated, flagged: false }
    );

    const payload = JSON.stringify({
      type: viewerMessageType,
      id: line.id,
      english: line.english,
      translated,
      ...(flagged ? { flagged: true, reason } : {}),
      ...(awaitingCorrection ? { awaitingCorrection: true } : {}),
    });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- wsServer`
Expected: PASS — all three new tests, plus every pre-existing test unchanged (the shared fixture's `maxCorrectionLagMs: 0` keeps shed captions byte-identical for them).

- [ ] **Step 8: Type-check and run the full suite**

Run: `npm run build`
Expected: no TypeScript errors.

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/wsServer.ts server/src/index.ts server/.env.example server/tests/wsServer.test.ts
git commit -m "Report the deadline-shed decision and mark shed captions"
```

---

### Task 2: Deliver the `caption-corrected` message

**Files:**
- Modify: `server/src/wsServer.ts` (new `scheduleCorrection` + `sendCorrection`, wired into `enqueuePublish`)
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `DeadlineOutcome`, the `Promise<void>` returned by `enqueueOrderedSend`, and `deps.maxCorrectionLagMs` (all from Task 1).
- Produces: viewer message `caption-corrected` — `{ type, id, translated?, flagged?, reason? }`. Presence of `translated` means "upgrade the text"; absence means "settle: clear the waiting state, leave the text as-is".

- [ ] **Step 1: Write the failing test**

Add this `describe` block in `server/tests/wsServer.test.ts` immediately after the `late translation correction — shed marking` block from Task 1:

```ts
  describe('late translation correction — delivery', () => {
    // Sheds at 30ms, translation resolves at 200ms, correction window is wide.
    function mockSlowTranslate(): void {
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
        return new Promise((resolve) => setTimeout(() => resolve({ text: '{"zh":"你好"}' }), 200));
      });
    }

    async function startSessionWithViewer(): Promise<{ captureSocket: WebSocket; viewerSocket: WebSocket; messages: any[] }> {
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
      return { captureSocket, viewerSocket, messages };
    }

    it('upgrades a shed line in place when its translation lands inside the window', async () => {
      deps.maxPublishLagMs = 30;
      deps.maxCorrectionLagMs = 30000;
      mockSlowTranslate();

      const { captureSocket, viewerSocket, messages } = await startSessionWithViewer();
      capturedCallbacks!.onFinalSegment('Hello everyone');
      await delay(400);

      const caption = messages.find((m) => m.type === 'caption');
      expect(caption).toMatchObject({ translated: 'Hello everyone', awaitingCorrection: true });

      const corrections = messages.filter((m) => m.type === 'caption-corrected');
      expect(corrections).toEqual([
        { type: 'caption-corrected', id: caption.id, translated: '你好' },
      ]);

      captureSocket.close();
      viewerSocket.close();
    });

    it('sends the correction after the caption it patches, never before', async () => {
      deps.maxPublishLagMs = 30;
      deps.maxCorrectionLagMs = 30000;
      mockSlowTranslate();

      const { captureSocket, viewerSocket, messages } = await startSessionWithViewer();
      capturedCallbacks!.onFinalSegment('Hello everyone');
      await delay(400);

      const types = messages.map((m) => m.type);
      expect(types.indexOf('caption')).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('caption-corrected')).toBeGreaterThan(types.indexOf('caption'));

      captureSocket.close();
      viewerSocket.close();
    });

    it('settles without new text — but still caches the translation — once the window has expired', async () => {
      deps.maxPublishLagMs = 30;
      deps.maxCorrectionLagMs = 1; // expires long before the 200ms translation lands
      mockSlowTranslate();

      const { captureSocket, viewerSocket, messages } = await startSessionWithViewer();
      capturedCallbacks!.onFinalSegment('Hello everyone');
      await delay(400);

      const caption = messages.find((m) => m.type === 'caption');
      const corrections = messages.filter((m) => m.type === 'caption-corrected');
      // Exactly one terminal message, carrying no replacement text.
      expect(corrections).toEqual([{ type: 'caption-corrected', id: caption.id }]);

      // The real translation still reached the cache, so a fresh subscriber gets it.
      const laterViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(laterViewer);
      laterViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlog = await waitForMessage(laterViewer);
      expect(backlog.lines).toEqual([
        { id: caption.id, english: 'Hello everyone', translated: '你好' },
      ]);

      laterViewer.close();
      captureSocket.close();
      viewerSocket.close();
    });

    it('sends no correction for a line removed by an admin before the translation lands', async () => {
      deps.maxPublishLagMs = 30;
      deps.maxCorrectionLagMs = 30000;
      mockSlowTranslate();

      const { captureSocket, viewerSocket, messages } = await startSessionWithViewer();
      capturedCallbacks!.onFinalSegment('Hello everyone');
      await delay(120); // shed has happened; translation still in flight

      const caption = messages.find((m) => m.type === 'caption');
      session.buffer.suppress(caption.id);
      await delay(300);

      expect(messages.filter((m) => m.type === 'caption-corrected')).toEqual([]);

      captureSocket.close();
      viewerSocket.close();
    });

    it('sends no correction when corrections are disabled', async () => {
      deps.maxPublishLagMs = 30;
      deps.maxCorrectionLagMs = 0;
      mockSlowTranslate();

      const { captureSocket, viewerSocket, messages } = await startSessionWithViewer();
      capturedCallbacks!.onFinalSegment('Hello everyone');
      await delay(400);

      expect(messages.filter((m) => m.type === 'caption-corrected')).toEqual([]);

      captureSocket.close();
      viewerSocket.close();
    });

    it('settles rather than upgrading when the late translation is flagged unsafe', async () => {
      deps.maxPublishLagMs = 30;
      deps.maxCorrectionLagMs = 30000;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":false,"reason":"polarity flip"}}' });
        }
        return new Promise((resolve) => setTimeout(() => resolve({ text: '{"zh":"耶稣不爱你"}' }), 200));
      });

      const { captureSocket, viewerSocket, messages } = await startSessionWithViewer();
      capturedCallbacks!.onFinalSegment('Jesus loves you');
      await delay(400);

      const caption = messages.find((m) => m.type === 'caption');
      // hide mode: the flagged translation must never reach the viewer, so the
      // terminal message clears the waiting state without replacing the text.
      expect(messages.filter((m) => m.type === 'caption-corrected')).toEqual([
        { type: 'caption-corrected', id: caption.id },
      ]);

      warnSpy.mockRestore();
      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- wsServer`
Expected: FAIL — no `caption-corrected` message is ever sent, so the upgrade/ordering/settle/flagged tests fail. (The admin-removed and corrections-disabled tests assert *absence* and should already pass; they are guardrails.)

- [ ] **Step 3: Implement `sendCorrection`**

Add immediately after `sendPrepared` in `server/src/wsServer.ts`:

```ts
// Delivers the single terminal message a deadline-shed line is owed. The cache
// is written regardless of the correction window — a viewer who joins,
// reconnects, or switches language later should get the real translation from
// their backlog — while the window governs only whether text is rewritten on a
// screen someone is currently reading. A message with no `translated` means
// "settle": clear the waiting state, leave the text alone.
function sendCorrection(
  deps: WsServerDeps,
  line: CaptionLine,
  results: PreparedLanguageResult[] | null,
  withinWindow: boolean
): void {
  // With no results (the translation ultimately failed) there is nothing to
  // cache and nothing to upgrade, but every viewer still needs its waiting
  // state cleared — so settle each currently-active language.
  const languages = results ? results.map((result) => result.language) : deps.session.getActiveLanguages();

  for (const language of languages) {
    const result = results?.find((entry) => entry.language === language);

    if (result) {
      deps.session.translationCache.set(
        language,
        line.id,
        result.flagged
          ? { translated: result.translated, flagged: true, reason: result.reason! }
          : { translated: result.translated, flagged: false }
      );
    }

    // Only rewrite the viewer's text when there is genuinely something new to
    // show. A verification failure makes prepareTranslationsForPublish fall
    // back to the English we already published, which is a settle, not an
    // upgrade.
    const isUpgrade = result !== undefined && withinWindow && result.translated !== line.english;
    const payload = JSON.stringify({
      type: 'caption-corrected',
      id: line.id,
      ...(isUpgrade
        ? {
            translated: result.translated,
            ...(result.flagged ? { flagged: true, reason: result.reason } : {}),
          }
        : {}),
    });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}
```

- [ ] **Step 4: Implement `scheduleCorrection`**

Add immediately after `sendCorrection`:

```ts
// Waits for the retained translation and delivers the line's terminal message.
// Gated on `sendPromise` — the ordered-send link for this line's own English
// caption — because the translation can resolve while that link is still
// queued behind other work, and a correction that overtook its own caption
// would patch a line the viewer does not have yet.
function scheduleCorrection(
  deps: WsServerDeps,
  line: CaptionLine,
  preparedPromise: Promise<PreparedLanguageResult[] | null>,
  shedAt: number,
  sendPromise: Promise<void>
): void {
  const sessionId = deps.session.id;
  void (async () => {
    await sendPromise;

    let results: PreparedLanguageResult[] | null;
    try {
      results = await preparedPromise;
    } catch {
      // Translation/verification ultimately failed. Still settle, so the line
      // does not stay marked as still-working forever.
      results = null;
    }

    // A correction from a previous session must never patch a line in a new
    // one; Session.start() assigns a fresh id.
    if (deps.session.id !== sessionId) return;
    // Admin-removed while the translation was in flight — the viewer already
    // got line-removed, so there is no line left to correct.
    if (line.suppressed) return;

    sendCorrection(deps, line, results, Date.now() - shedAt <= deps.maxCorrectionLagMs);
  })();
}
```

- [ ] **Step 5: Arm the correction from `enqueuePublish`**

Replace `enqueuePublish` (from Task 1 Step 5) with:

```ts
  const enqueuePublish: EnqueuePublish = (line, workPromise, viewerMessageType = 'caption') => {
    const enqueuedAt = Date.now();
    // Translate + verify still starts immediately (not gated on the queue), as before.
    const preparedPromise = workPromise.then((translations) =>
      prepareTranslationsForPublish(line, translations, deps)
    );
    const outcomePromise = raceAgainstDeadline(preparedPromise, enqueuedAt + deps.maxPublishLagMs, line, deps);
    const sendPromise = enqueueOrderedSend(line, enqueuedAt, outcomePromise, viewerMessageType);

    if (deps.maxCorrectionLagMs > 0) {
      // .catch is required, not optional: outcomePromise rejects when
      // preparedPromise rejects before the deadline, and this is a second
      // subscription to it — without the catch that rejection is unhandled on
      // this branch even though enqueueOrderedSend handles its own.
      void outcomePromise
        .then((outcome) => {
          if (outcome.shedAt === null) return;
          scheduleCorrection(deps, line, preparedPromise, outcome.shedAt, sendPromise);
        })
        .catch(() => {});
    }
  };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- wsServer`
Expected: PASS — all six delivery tests, plus Task 1's three, plus every pre-existing test.

- [ ] **Step 7: Type-check and run the full suite**

Run: `npm run build`
Expected: no TypeScript errors.

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "Upgrade deadline-shed captions when their translation lands"
```

---

### Task 3: Client — unified waiting state and in-place correction

**Files:**
- Modify: `web/lib/useViewerSocket.ts` (`CaptionLine`, `caption` handler, new `caption-corrected` handler)
- Modify: `web/app/view/page.tsx` (derived `awaiting`, row rule, caption sizing)

**Interfaces:**
- Consumes: the `awaitingCorrection` field on `caption` messages and the `caption-corrected` message from Tasks 1-2.
- Produces: `CaptionLine.awaitingCorrection?: boolean`.

> `web/` has **no test runner** — verification for this task is `npm run build`, `npm run lint`, and the manual browser check in Step 5. Do not add a test framework.

- [ ] **Step 1: Add the field and the correction handler**

In `web/lib/useViewerSocket.ts`, add to the `CaptionLine` interface after `pending?: boolean;`:

```ts
  pending?: boolean;
  awaitingCorrection?: boolean;
```

In the `caption` / `caption-inserted` branch, carry the flag through on the rebuilt line — change the `resolved` object to:

```ts
            const resolved = {
              id: message.id,
              english: message.english,
              translated: message.translated,
              ...(message.flagged ? { flagged: true, reason: message.reason } : {}),
              ...(message.awaitingCorrection ? { awaitingCorrection: true } : {}),
            };
```

Add a new branch immediately after the `caption` / `caption-inserted` branch (before the `line-removed` branch):

```ts
        } else if (message.type === 'caption-corrected') {
          setLines((previous) => {
            const index = previous.findIndex((line) => line.id === message.id);
            // Unlike 'caption', never append: correcting a line this viewer
            // doesn't have is meaningless, and appending would invent a line
            // out of order.
            if (index === -1) return previous;
            const next = [...previous];
            const existing = next[index];
            // A correction with no `translated` is a settle: clear the waiting
            // state, keep the text that's already on screen.
            next[index] = {
              ...existing,
              awaitingCorrection: false,
              ...(message.translated !== undefined
                ? {
                    translated: message.translated,
                    ...(message.flagged
                      ? { flagged: true, reason: message.reason }
                      : { flagged: false, reason: undefined }),
                  }
                : {}),
            };
            return next;
          });
          setStatus('live');
```

- [ ] **Step 2: Derive the unified waiting state in the view**

In `web/app/view/page.tsx`, the caption list is currently a single expression-bodied `lines.map((line, index) => line.removed ? (...) : (...))`. Convert it to a block-bodied callback so `awaiting` can be computed once per line, replacing the whole `{lines.map(...)}` expression with:

```tsx
        {lines.map((line, index) => {
          if (line.removed) {
            return (
              <div key={line.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex-1 border-t border-dashed" />
                <span>Line removed</span>
                <span className="flex-1 border-t border-dashed" />
              </div>
            );
          }

          // 'pending' (translation not started) and 'awaitingCorrection'
          // (published as English, upgrade may follow) are distinct on the
          // server but identical to a viewer: same text on screen, same
          // meaning, same exit condition. Render them as one state.
          const awaiting = Boolean(line.pending || line.awaitingCorrection);

          return (
            <div
              key={line.id}
              className={`flex items-start gap-2 hover:bg-accent/50 p-2 pl-3 rounded-md border-l-2 transition-colors ${
                awaiting ? 'border-amber-500' : 'border-transparent'
              }`}
            >
              <div className="flex-1 min-w-0">
                {!awaiting && <p className="text-sm text-muted-foreground">{line.english}</p>}
                <p
                  className={`transition-all duration-500 ${
                    awaiting ? 'text-lg sm:text-xl' : 'text-xl sm:text-2xl'
                  } ${!awaiting && line.flagged ? 'text-rose-400' : ''}`}
                >
                  {awaiting ? line.english : line.translated}
                </p>
                {!awaiting && line.flagged && line.reason && (
                  <p className="text-xs text-rose-400/80">{line.reason}</p>
                )}
              </div>
              {!awaiting && renderLineFeedback(index, line)}
            </div>
          );
        })}
```

The `removed` branch is reproduced verbatim from the current code — it is unchanged, but the callback's conversion to a block body means it must be written out rather than left implicit.

Three things this changes deliberately:
- The border is present at **all** times, switching only colour, so clearing the highlight causes no layout shift. Because the border sits outside the padding box, wrapped text aligns to one left edge and never runs underneath it.
- Awaiting text is one size step smaller at **full contrast**; the previous `italic text-muted-foreground/60` is gone. Dimming was fine for a sub-second flash but is the wrong treatment for text a viewer may read for many seconds.
- `!awaiting &&` now guards the small English duplicate, the flag button, and the flagged styling — a shed line has `english === translated` and would otherwise render its English twice.

- [ ] **Step 3: Build and lint**

Run from `web/`: `npm run build`
Expected: build succeeds with no TypeScript errors.

Run from `web/`: `npm run lint`
Expected: no new lint errors.

- [ ] **Step 4: Verify the server still passes**

Run from `server/`: `npm test`
Expected: all suites PASS (this task changes no server code; this is a regression guard).

- [ ] **Step 5: Manual browser verification**

Start both apps (`npm run dev` in `server/` and in `web/`), set `MAX_PUBLISH_LAG_MS` low enough that lines shed (e.g. `2000`) so the path is easy to trigger, then open the capture page and a viewer:

- A new line appears immediately with the amber left rule, English text, one size down, at full contrast — and **no** small grey English duplicate above it and **no** flag button.
- A few seconds later the text swaps to the translation, the rule fades to transparent, the text steps up a size, and the flag button appears.
- Multi-line captions wrap with every line flush to the same left edge — no text under the rule.
- Set `MAX_CORRECTION_LAG_MS=0`, restart the server, and confirm behaviour matches today: shed lines show plain English with no rule and no later swap.

- [ ] **Step 6: Commit**

```bash
git add web/lib/useViewerSocket.ts web/app/view/page.tsx
git commit -m "Show a unified waiting state and apply corrections in place"
```

---

## Self-Review

**Spec coverage:**
- Retain the in-flight promise instead of abandoning it → Task 1 Step 4 (`DeadlineOutcome.shedAt`) + Task 2 Step 5 (`scheduleCorrection` receives `preparedPromise`). ✓
- Exactly one terminal `caption-corrected` per shed line, upgrade or settle → Task 2 Steps 3-4 + tests for both shapes. ✓
- Cache written regardless of window; window governs only the live push → Task 2 Step 3 (`sendCorrection` caches before the `isUpgrade` check) + the window-expired test asserting a fresh subscriber's backlog carries the translation. ✓
- Ordering: correction never precedes its caption → Task 1 Step 5 (`enqueueOrderedSend` returns the link promise) + Task 2 Step 4 (`await sendPromise`) + explicit ordering test. ✓
- `MAX_CORRECTION_LAG_MS` (default 30000), `0` disables at source → Task 1 Step 1 + Task 2 Step 5 (`if (deps.maxCorrectionLagMs > 0)`) + Task 1's "no mark when disabled" test + Task 2's "no correction when disabled" test. ✓
- Ingest-shed lines never correctable → Task 1 Step 5 (`publishEnglish` passes `shedAt: null`) + dedicated test. ✓
- Suppressed mid-flight → no correction → Task 2 Step 4 guard + test. ✓
- Session restarted → no cross-session correction → Task 2 Step 4 `sessionId` guard. ✓
- Client field, patch-by-id, never append on unknown id → Task 3 Step 1. ✓
- Unified `awaiting` treatment, rule-only, full contrast, one size down, no duplicate English, no flag button → Task 3 Step 2. ✓
- Flagged late translation settles rather than leaking flagged text in hide mode → Task 2 Step 3 (`result.translated !== line.english`) + test. ✓

**Placeholder scan:** No TBD/TODO/vague steps; every code step carries complete code, every run step names the command and expected result. ✓

**Type consistency:**
- `DeadlineOutcome` shape identical across its definition (T1S4), `raceAgainstDeadline`'s return (T1S4), `enqueueOrderedSend`'s parameter (T1S5), `publishEnglish`'s literal (T1S5), and the `outcome.shedAt` reads (T1S5, T2S5). ✓
- `enqueueOrderedSend` returns `Promise<void>`, consumed as `sendPromise` in T2S5 and awaited as `sendPromise` in `scheduleCorrection`'s signature (T2S4). ✓
- `sendPrepared`'s new trailing `awaitingCorrection = false` matches its only two call sites (the `enqueueOrderedSend` body, which passes it; `sendCorrection` does not call it). ✓
- `maxCorrectionLagMs: number` identical in `WsServerDeps` (T1S1), `index.ts` (T1S1), and the test fixture (T1S1). ✓
- `caption-corrected` payload shape identical between `sendCorrection` (T2S3), the server tests (T2S1), and the client handler (T3S1): `translated` optional, `flagged`/`reason` only alongside `translated`. ✓
- `awaitingCorrection` field name identical in the server payload (T1S6), `CaptionLine` (T3S1), the `resolved` object (T3S1), the correction handler (T3S1), and the `awaiting` derivation (T3S2). ✓
