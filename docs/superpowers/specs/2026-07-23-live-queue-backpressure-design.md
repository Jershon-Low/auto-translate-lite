# Live-Queue Back-Pressure — Design

## Purpose

The live caption pipeline runs on two serial, unbounded promise-chain queues held on [`Session`](../../../server/src/session.ts) and driven from [`wsServer.ts`](../../../server/src/wsServer.ts):

- **`ingestQueue`** — each Deepgram final segment appends `handleFinalSegmentFast` to the chain. That function `await`s the **transcription safety check** (`verifyTranscriptionWithRetry`, one LLM call) before the next segment is processed. The check runs on every line and gates whether a line is ever shown to viewers.
- **`publishQueue`** — each line's turn `await`s that line's translate + **translation safety check** (`prepareTranslationsForPublish`), then performs the ordered `sendPrepared` to viewers. Translation is the slow, throughput-limited work (on the `2026-07-19` service, the reasoning model `openai/gpt-5.6-luna`).

Neither queue is bounded and nothing sheds stale work. Once a standing backlog forms — congestion, a slow model, or a burst of fast speech — each line falls a little further behind the previous one and the pipeline never catches up. This is the core symptom of the **2026-07-19 Sunday service**: captions ran minutes behind live speech. That incident's *trigger* — unbounded on-subscribe backlog fills — is addressed by Fix 1 ([backlog cap](2026-07-21-backlog-translation-cap-design.md)) and Fix 2 (budget isolation). This design, **Fix 3**, adds the back-pressure that lets any residual standing queue self-heal regardless of cause.

This design makes the **publish path self-draining** and **sheds load at ingest when the pipeline is behind**, using a single lag signal and a single tunable threshold. The only thing ever shed is *translation*, which degrades to the line's **English** text — already a first-class, always-safe fallback in this app (used today for uncached, verify-failed, and translate-failed lines).

### Hard constraints preserved (README "Safety features")

- **The transcription safety check runs on every line, for the whole session, and is never shed.** A flagged transcription is still suppressed in `handleFinalSegmentFast` and never reaches viewers. Back-pressure only skips the *translation* of lines that have **already passed** the transcription check.
- **No unverified/flagged translation is ever published.** When we shed, we publish the line's already-verified **English transcript**, never a half-finished or unverified translation.
- **No line is ever dropped**, and **caption ordering is preserved** — every line is still sent exactly once, in spoken order, through the serial `publishQueue`.

## Scope

- A new pure, unit-testable `LiveLagTracker` (`server/src/liveLag.ts`) measuring how long the oldest not-yet-published line has waited in the publish path.
- A **publish-side staleness deadline**: a line that cannot be published *translated* within `MAX_PUBLISH_LAG_MS` of entering the publish path is published in **English** instead, and the late translation is discarded.
- An **ingest-side load shed**: when current publish lag is at/over `MAX_PUBLISH_LAG_MS`, a newly-ingested (already transcription-verified) line skips translation and is published in **English** immediately — removing translate/verify load so the live LLM budget frees up and the pipeline catches up.
- One env knob, `MAX_PUBLISH_LAG_MS` (default **8000**), threaded through `WsServerDeps`, documented in `server/.env.example`.
- **Edge-triggered** structured logging when the pipeline crosses into / out of the "behind" state (publish path), plus an ingest-queue-wait measurement, so congestion is visible in real time (it was invisible on 2026-07-19).
- Explicitly **out of scope**:
  - **Shedding ingest work.** We deliberately never drop or skip a segment's transcription check (see Known Simplifications). The ingest queue stays unbounded-but-measured.
  - Sending a corrected translated caption *after* a line has been published in English (English is terminal for a shed line, matching today's verify-failure behavior).
  - Gating the background `schedulePrefetch` (suppressed-line pre-warm) under lag — a one-line load reduction left out to keep scope tight (see Future Extensions).
  - Any change to the transcription/translation *models*, the OpenRouter limiters, Fix 1's backlog cap, Fix 2's budget isolation, the buffer window, or the Deepgram/session/viewer protocols.
  - Any `web/` change: the viewer already renders a `caption` whose `translated` equals its `english`, and already handles the `caption-pending` → `caption` transition.

## Design

### 1. `LiveLagTracker` (new, `server/src/liveLag.ts`)

A strict FIFO of the enqueue timestamps of lines currently in the publish path. Lines enter (`enqueue`) in spoken order and leave (`dequeue`) in the same order `publishQueue` sends them, so the head is always the oldest un-published line.

```ts
// Tracks how long the oldest not-yet-published line has waited in the live
// publish path, so the pipeline can measure — and shed against — its own lag.
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

- `lagMs` reads **0 when caught up** (empty path), so a service pause followed by fresh speech never inherits a stale-high reading.
- `enqueue`/`dequeue` are strict FIFO: every publish-path entry point (§3, §4) enqueues exactly once and dequeues exactly once.
- `shift()` is O(n), but n is bounded by the lag threshold divided by the inter-line interval (tens of entries at most) — negligible.

### 2. `Session` wiring

Add one field and one flag, both reset on `start()` (alongside the existing `ingestQueue`/`publishQueue` resets):

```ts
liveLag: LiveLagTracker = new LiveLagTracker();
isBehind: boolean = false;      // publish-path edge-log state
ingestLagHigh: boolean = false; // ingest-wait edge-log state
```

`start()` reassigns `this.liveLag = new LiveLagTracker()` and sets both flags to `false`, so a new session begins with an empty path and a clean "not behind" state. (Reassigning a fresh instance — rather than mutating — matches how `translationCache` is reset, and closures in §3 capture the tracker instance at enqueue time so an operator stop→start mid-flight cannot cross-contaminate the counts.)

### 3. Publish-side staleness deadline (`createEnqueuePublish`, wsServer.ts)

`createEnqueuePublish` currently returns a single `enqueuePublish` function. It will return an object with two entry points that share one ordered-send tail:

```ts
interface Publisher {
  enqueuePublish: EnqueuePublish;                          // translate+verify, with deadline
  publishEnglish: (line: CaptionLine, type?: 'caption' | 'caption-inserted') => void; // shed: English now
}
```

The shared tail enqueues into the lag tracker and appends one ordered link to `publishQueue` that sends a pre-computed results promise, then dequeues:

```ts
function createEnqueuePublish(deps: WsServerDeps): Publisher {
  function enqueueOrderedSend(
    line: CaptionLine,
    enqueuedAt: number,
    resultsPromise: Promise<PreparedLanguageResult[] | null>,
    viewerMessageType: 'caption' | 'caption-inserted'
  ): void {
    // Capture the tracker instance now so enqueue and the later dequeue always
    // act on the same tracker even if the session restarts mid-flight.
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
      reportLag(deps, deps.session.liveLag.lagMs(Date.now())); // catches "disengaged" as the queue drains
    });
  }

  const enqueuePublish: EnqueuePublish = (line, workPromise, viewerMessageType = 'caption') => {
    const enqueuedAt = Date.now();
    const deadlineMs = enqueuedAt + deps.maxPublishLagMs;

    // Translate + verify still starts immediately (not gated on the queue), as today.
    const preparedPromise = workPromise.then((translations) =>
      prepareTranslationsForPublish(line, translations, deps)
    );

    const resultsPromise = raceAgainstDeadline(preparedPromise, deadlineMs, line, deps);
    enqueueOrderedSend(line, enqueuedAt, resultsPromise, viewerMessageType);
  };

  const publishEnglish = (line: CaptionLine, viewerMessageType: 'caption' | 'caption-inserted' = 'caption') => {
    const enqueuedAt = Date.now();
    enqueueOrderedSend(
      line,
      enqueuedAt,
      Promise.resolve(englishFallbackResults(line, deps)),
      viewerMessageType
    );
  };

  return { enqueuePublish, publishEnglish };
}
```

The deadline race resolves to the verified translation results if they arrive in time, or to the English fallback if the deadline passes first:

```ts
const DEADLINE_REACHED = Symbol('deadline');

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

The English fallback mirrors `prepareTranslationsForPublish`'s guards so a line suppressed (admin-removed) mid-flight is still never published, and every active language gets the (already transcription-verified) English text:

```ts
function englishFallbackResults(line: CaptionLine, deps: WsServerDeps): PreparedLanguageResult[] | null {
  if (line.suppressed) return null;
  return deps.session
    .getActiveLanguages()
    .map((language) => ({ language, translated: line.english, flagged: false }));
}
```

Because it flows through the existing `sendPrepared`, a shed line **caches its English** (`{ translated: english, flagged: false }`) exactly like a verify-failure does today — so late-joining viewers stay consistent and the line is not re-translated on a later backlog fill during congestion.

**Reinstates are safe:** the deadline is measured from `enqueuedAt = Date.now()` (when the line enters the publish path), **not** the line's spoken timestamp. An operator reinstate carries an old `timestampMs` but enters the publish path *now*, so it gets a full window and is never wrongly shed.

### 4. Ingest-side load shed (`handleFinalSegmentFast`, wsServer.ts)

The transcription safety check and append are **unchanged**. Only the visible-line tail changes: before translating, consult current lag and, if behind, publish English instead of issuing translate/verify work.

```
// after the line is appended and caption-pending is broadcast (all unchanged):
const nowMs = Date.now();
const lagMs = deps.session.liveLag.lagMs(nowMs);
reportLag(deps, lagMs); // catches "engaged"

if (lagMs >= deps.maxPublishLagMs) {
  void logEvent('warn', { event: 'caption_lag_shed', reason: 'ingest_backpressure', english, lagMs: Math.round(lagMs) });
  publishEnglish(line);   // English fallback, no translate/verify LLM calls
  return;
}

const activeLanguages = deps.session.getActiveLanguages();
const workPromise = translateWithFallback(deps, english, activeLanguages, precedingContext);
enqueuePublish(line, workPromise);
```

**Feedback loop:** lag ≥ threshold → new lines publish English (no LLM demand) → in-flight translations finish faster → `publishQueue` drains → `lagMs` falls below threshold → translation resumes automatically. The flagged/manual-hold suppression branch above this code is untouched, so a shed decision can never bypass the transcription check.

### 5. Ingest-wait observability (`onFinalSegment` → `handleFinalSegmentFast`)

We cannot shed ingest, but we can **measure** it so the one unshed-able path is never invisible again. Capture when a segment is received and how long it waited before processing began:

```ts
onFinalSegment: (text) => {
  const receivedAt = Date.now();
  deps.session.ingestQueue = deps.session.ingestQueue
    .then(() => handleFinalSegmentFast(text, deps, ws, enqueuePublish, publishEnglish, schedulePrefetch, receivedAt))
    .catch(/* unchanged */);
},
```

At the top of `handleFinalSegmentFast`, edge-triggered logging (symmetric with the publish path, same threshold) surfaces a slow transcription verifier without per-line spam:

```ts
const ingestWaitMs = Date.now() - receivedAt;
reportIngestLag(deps, ingestWaitMs);
```

`reportIngestLag` flips `session.ingestLagHigh` and logs `ingest_lag_high` engaged/cleared as `ingestWaitMs` crosses `maxPublishLagMs`.

### 6. Edge-triggered lag reporting

```ts
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
```

`reportIngestLag` is the same shape against `session.ingestLagHigh` / `ingest_lag_high`. `reportLag` is called at the ingest decision (§4, catches the engage transition) and after each publish dequeue (§3, catches the disengage/drain transition).

### 7. Configuration and wiring

- New env var `MAX_PUBLISH_LAG_MS`, parsed in [`index.ts`](../../../server/src/index.ts) with a default of **8000**:
  ```ts
  maxPublishLagMs: process.env.MAX_PUBLISH_LAG_MS ? Number(process.env.MAX_PUBLISH_LAG_MS) : 8000,
  ```
- Add `maxPublishLagMs: number` to `WsServerDeps`, threaded through `attachWsServer` exactly like the existing `deepgramCostFlushIntervalMs` numeric dependency.
- Document the variable in `server/.env.example`.
- Update the two `createEnqueuePublish` call sites: `handleCaptureConnection` destructures `{ enqueuePublish, publishEnglish }` and passes both into `handleFinalSegmentFast`; `handleReviewConnection` destructures `{ enqueuePublish }` only (reinstate uses the translate path).

**Why 8000 ms:** roughly the point past which a live caption is no longer tracking the speaker usefully, while comfortably above the normal translate+verify round-trip so healthy operation is never shed. It is env-tunable so it can be adjusted against a real service without a code change. One knob governs the publish deadline, the ingest-shed threshold, and both edge-log thresholds (see Known Simplifications).

## Error Handling

- **No new failure modes for the LLM calls.** `translateWithFallback`, `verifyTranslationsWithRetry`, and `verifyTranscriptionWithRetry` are called exactly as before (or, for shed lines, not at all). Their existing retry/English-fallback behavior is unchanged.
- **Shed lines never fail:** the English text is already present on the line and already transcription-verified; publishing it involves no network call.
- **Suppressed-mid-flight lines** are still never published: both `prepareTranslationsForPublish` and `englishFallbackResults` return `null` for a suppressed line, and `sendPrepared(null)` is a no-op.
- **Tracker integrity:** every publish-path entry point enqueues once; the `finally` in the ordered link dequeues once (even when the send is skipped or the prepare rejects), so the tracker cannot leak or desynchronize. The dequeue acts on the tracker instance captured at enqueue time.
- **Timer hygiene:** the deadline timer is always `clearTimeout`-ed once the race settles, so a fast translation leaves no dangling timer.
- **Discarded late translation:** when the deadline fires, the still-running `preparedPromise` is abandoned; if it later resolves it is simply unreferenced. No second `sendPrepared` occurs for that line (the ordered link runs once), so there is no double-send and no out-of-order correction.

## Testing

- **Unit (`server/tests/liveLag.test.ts`)** for `LiveLagTracker`:
  - `lagMs` returns `0` on an empty tracker.
  - After `enqueue(t0)`, `lagMs(t0 + 5000)` returns `5000`.
  - FIFO: `enqueue(t0); enqueue(t1)` then `dequeue()` leaves `t1` as the head; `lagMs` reflects `t1`.
  - `dequeue` to empty returns `lagMs` to `0`.
- **Integration (`server/tests/wsServer.test.ts`)**, with `maxPublishLagMs` set small (e.g. `50`) and a translate mock that resolves after a longer delay:
  - **Publish deadline → English:** a viewer receives a `caption` whose `translated === english` (not the mock translation) when the translation misses the deadline.
  - **Ingest shed → no translate call:** after lag is driven over threshold, a newly-appended segment produces **no** `translate`/`translateBacklog` call and is published in English.
  - **Ordering preserved:** interleaved fast and slow lines arrive at the viewer in spoken order.
  - **Safety invariant holds:** a segment the transcription verifier flags is still suppressed (viewer gets `line-removed`, never a `caption`) regardless of lag — shedding never bypasses the transcription check.
- **Manual (browser):** start a session, subscribe a viewer, then induce lag (e.g. a slow model / rapid speech); confirm captions fall no more than ~`MAX_PUBLISH_LAG_MS` behind and visibly recover (translations resume) once speech slows, with `caption_backpressure_engaged`/`disengaged` events in the log stream.

## Known Simplifications

- **One knob for four uses.** `MAX_PUBLISH_LAG_MS` governs the publish deadline, the ingest-shed threshold, and both edge-log thresholds. A separate hysteresis band (shed above X, resume below Y < X) would reduce thrashing at the boundary but adds a second concept; revisit only if boundary flapping is observed in real logs.
- **Past-deadline lines go straight to English** without attempting to salvage an already-resolved translation. This can discard a translation that happened to finish at the deadline, but keeps the race logic simple and deterministically testable. The waste is bounded because §4 stops *starting* translations once we are behind.
- **Ingest is measured, never shed.** Dropping or skipping a segment would either lose verified spoken content or skip its safety check — both unacceptable — so the ingest queue stays unbounded. The self-heal is entirely on the sheddable translation path; shedding translation frees the shared live budget, which is what keeps the transcription verifier (and thus ingest) healthy. If measurement ever shows the verifier itself as the sustained bottleneck, that is a model/throughput follow-up, not something Fix 3 can safely shed.
- **Lag is measured from publish-path entry, not from when speech was spoken.** It captures the publish path's own contribution (the dominant, controllable cost); the separate `ingest_lag_high` measurement covers the ingest contribution. Capturing Deepgram's audio timestamps to compute true end-to-end lag is out of scope.

## Future Extensions (out of scope now)

- **Gate `schedulePrefetch` under lag:** skip the background suppressed-line translation pre-warm while `isBehind`, freeing a little more live budget during congestion. One line, same rationale; left out to keep this change focused.
- **Separate hysteresis thresholds** for engage vs. disengage if boundary thrashing appears.
- **End-to-end lag** via Deepgram segment timestamps, surfaced to the operator UI as a live "captions N s behind" indicator.
- **Lazy re-translation** of lines that were published in English during congestion, once the pipeline is caught up and idle (builds naturally on Fix 2's separate budget).
