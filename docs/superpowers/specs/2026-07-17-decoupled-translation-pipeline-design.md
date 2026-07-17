# Decoupled Translation Pipeline — Design

## Purpose

Today every capture-socket event that can trigger a Gemini call — a finalized speech segment (`onFinalSegment`) or an operator's Approve/Edit (`reinstate`) — is appended to a single `processingQueue` promise chain in [`wsServer.ts`](../../../server/src/wsServer.ts), and each step fully awaits its entire pipeline, including the `translation` model call, before the chain lets the next event start.

`transcriptionVerifier` and `translationVerifier` default to `gemini-3.1-flash-lite` (fast) but `translation` is commonly run on `gemini-3.5-flash` for quality. Because the whole queue is serialized on whichever call is slowest, running `translation` on the heavier model means:

- **Automatic mode**: after a few minutes of continuous speech, the queue visibly falls behind — each new segment's transcription-check can't even start until the previous segment's full pipeline (transcribe-check → translate → verify → publish) has finished.
- **Manual mode**: every finalized line requires operator action, and today's `reinstate` handler awaits a fresh `translate` call inline (always, if the operator edited the text) on that same shared queue — so approving one line blocks both the next approval and any speech transcribed while the operator was reviewing.

This design decouples the slow `translation` call from the ordered queue, without changing the ordering or context guarantees viewers and the operator currently rely on.

## Scope

- Split the current single `processingQueue` into a fast, strictly-ordered **ingest** chain and a **publish** chain that lets `translation` calls run concurrently across lines while still delivering to viewers in original order.
- Applies uniformly to both Automatic mode (`handleFinalSegment`) and Manual mode (`handleReinstate`) — the Enter-key stall and the auto-mode backlog are the same root cause and get the same fix.
- No change to `transcriptionVerifier`'s behavior, `TranscriptBuffer`'s public shape, the `GeminiCallLimiter` concurrency cap, or any client/viewer-facing message format.
- No change to `translateBacklog` / `ensureBacklogCached` (new-viewer language backfill) — that path is already decoupled from `processingQueue` via `deps.session.inFlightFills` and is unaffected by this change.
- Explicitly out of scope: raising the `GeminiCallLimiter` cap (currently 8; a tuning question to revisit after observing real behavior, not part of this change); decoupling `translationVerifier` from the ordered publish step (already fast, diminishing returns); speculative/out-of-order transcription-checking (rejected as Approach B during design discussion — too much context-correctness risk for a step that isn't the actual bottleneck).

## Design

### 1. Two chains instead of one (`wsServer.ts`)

`processingQueue` is replaced by:

- **`ingestQueue`** — everything that must stay strictly ordered and is cheap: transcription safety-check (`verifyTranscriptionWithRetry`, flash-lite by default), buffer mutation (`append` / `suppress` / `reinstate`), and the immediate `{ type: 'transcript' }` ack to the capture socket. Nothing here awaits a `translation` call.
- **`publishQueue`** — ordered *delivery* to viewers. A line's `translation` Gemini call is fired the instant `ingestQueue` decides the line is ready — not deferred — so multiple lines' calls can be in flight concurrently (still bounded by the existing 8-slot `GeminiCallLimiter`). `publishQueue` only serializes *waiting for, then sending,* each line's result, in the same order `ingestQueue` produced them.

Both `onFinalSegment` and `reinstate` continue to append to `ingestQueue` exactly as they do today (preserving relative ordering between spoken segments and operator actions); what changes is that each `ingestQueue` step returns as soon as buffer state is settled, instead of after translation completes.

### 2. `schedulePublish` — ordered, concurrent translation

```
function schedulePublish(line, precedingContext, deps, captureSocket):
  activeLanguages = deps.session.getActiveLanguages()
  workPromise = translateWithFallback(deps, line.english, activeLanguages, precedingContext)   // fires now
  publishQueue = publishQueue.then(async () =>
    translations = await workPromise        // already resolved if this line's call was fast/early
    await finishPublishing(line, translations, deps, captureSocket)   // existing verify + ordered viewer-send
  )
```

Because `schedulePublish` is always invoked *synchronously inside* an `ingestQueue` step, the order items land on `publishQueue` exactly matches `ingestQueue`'s processing order. A line whose translation finishes early still waits behind any earlier line's `publishQueue` entry before being sent to viewers — captions and edits stay in original order even though the underlying network calls overlap in time.

### 3. `schedulePrefetch` — background translation for not-yet-visible lines

Flagged (AI-unsafe) and manual-hold lines aren't shown to viewers yet, so their translation doesn't need to go through the ordered `publishQueue` at all — nothing else depends on the relative completion order of two lines that are both still pending approval.

```
function schedulePrefetch(line, precedingContext, deps):
  activeLanguages = deps.session.getActiveLanguages()
  translateWithFallback(deps, line.english, activeLanguages, precedingContext)
    .then(translations => { line.pendingTranslations = translations })
```

`line` is the object returned by `TranscriptBuffer.append`, which is the same reference stored inside the buffer's internal array (see existing `reinstate()`/`suppress()`, which already mutate line objects in place) — so this assignment is visible wherever the buffer is later read, no new buffer method needed.

### 4. `handleFinalSegmentFast` (replaces the body of `handleFinalSegment`)

```
recentLines = buffer.getRecent()
precedingContext = ... (unchanged)
transcriptionResult = await verifyTranscriptionWithRetry(english, precedingContext, ...)   // fast model, awaited

manualHold = session.mode === 'manual'
suppressed = manualHold || !transcriptionResult.safe
line = buffer.append(english, Date.now(), suppressed)
captureSocket.send({ type: 'transcript', id: line.id, english, flagged: suppressed, reason, pending: manualHold })

if suppressed:
  if !transcriptionResult.safe: log 'transcription_flagged'
  broadcast { type: 'line-removed', id: line.id } to viewers
  schedulePrefetch(line, precedingContext, deps)   // translations ready in the background for later approval
  return

schedulePublish(line, precedingContext, deps, captureSocket)
```

This step no longer computes `translations` up front via `Promise.all` the way today's code does — the transcription-check is the only Gemini call `ingestQueue` awaits, which is what keeps this step fast.

### 5. `handleReinstateFast` (replaces the body of `handleReinstate`)

```
trimmed = english.trim()
(validate empty / not-found — unchanged, synchronous)

line = buffer.reinstate(id, trimmed)
captureSocket.send({ type: 'transcript', id: line.id, english: line.english, flagged: false })

precedingContext = buffer.precedingContextFor(id, PRECEDING_CONTEXT_LINES)
schedulePublish(line, precedingContext, deps, captureSocket)   // reuses/extends line.pendingTranslations internally
```

The cache-reuse logic that exists today (skip re-translating languages already present in `pendingTranslations` when the text is unedited, translate fresh for all active languages when it's edited) moves inside `schedulePublish`'s `workPromise` construction, unchanged in behavior — it just no longer blocks `ingestQueue`. This is the change that unblocks the Enter key: the operator's next action, and any speech transcribed while they were reviewing, no longer waits on this line's `translate` call.

### 6. `handleAdminRemove`

Unchanged. It never awaited a translation call, so it simply moves onto `ingestQueue` as-is.

## Error Handling

- **Concurrent cache-error retries**: `translateWithFallback`'s existing behavior — on a cache-related error, null `deps.session.roleCaches.translation` and retry inline without the cache — is unaffected by running concurrently. If two in-flight calls hit the same stale cache at once, both null it (idempotent) and both retry inline; that burst costs a few extra tokens, not correctness.
- **Prefetch failure**: `translateWithFallback` already resolves to `{}` on total failure (logged via `logEvent`, never rejects), so a failed `schedulePrefetch` just leaves `pendingTranslations` empty; `handleReinstateFast` naturally falls back to a fresh translate for those languages, identical to today's cache-miss path.
- **Unbounded fan-out**: the existing 8-slot `GeminiCallLimiter` already caps true concurrency across all Gemini calls system-wide, so decoupling can't cause more than 8 `translate`/`verify` calls in flight at once — it only lets that existing cap actually get used, instead of the queue accidentally serializing everything down to ~1 call at a time.
- **Session stop mid-flight**: unchanged from today — `stop()` clears `roleCaches` and the buffer; any in-flight `workPromise` still resolves harmlessly (its `publishQueue`/prefetch continuation runs against a possibly-cleared session, matching existing behavior for in-flight calls at session boundaries).

## Testing

- **Unit (`wsServer.test.ts`)**: using the existing fake `GeminiClient` with a manually-controlled deferred promise for the translate branch —
  1. Two final segments sent back-to-back: assert the **second** segment's `transcript` ack arrives before the first segment's translate promise resolves (proves `ingestQueue` no longer blocks on translation).
  2. Two deferred translate promises resolved in **reverse** order (second finishes first): assert viewer `caption` messages still arrive in original speaking order (proves `publishQueue` ordering holds under concurrency).
  3. Manual mode: send `reinstate` while its translate promise is deliberately unresolved; assert the ack (and readiness to process the next queued `reinstate`/segment) doesn't wait on it.
  4. Flagged line: assert `pendingTranslations` populates on the buffer entry once its background translate resolves, without any `publishQueue`/viewer-facing message being sent.
- **Unit (`transcriptBuffer.test.ts`)**: no changes expected — `append`/`reinstate`/`suppress` already support post-hoc mutation of the returned line reference; add a regression test confirming a caller-side mutation of `pendingTranslations` on the returned object is visible via a later `peek()`.
- **Manual (browser)**: run a live session in Automatic mode with `translation` set to `gemini-3.5-flash` for several minutes of continuous speech; confirm the transcript feed keeps pace with speech instead of visibly lagging. Then switch to Manual mode and confirm pressing Enter (Approve) on one line doesn't delay the next line appearing in the pending queue.

## Known Simplifications

- `translationVerifier`'s Gemini call stays inside the ordered `publishQueue` step (not further decoupled) — it's fast by default, so this is a deliberate scope cut, not an oversight.
- No new backpressure mechanism beyond the existing `GeminiCallLimiter` cap — if that cap turns out too low/high under real load, it's a follow-up tuning change, not part of this design.

## Future Extensions (explicitly out of scope now)

- Also decoupling `translationVerifier` from the ordered publish step, if it stops being fast (e.g., if an admin configures it to a heavier model too).
- Adaptive/dynamic `GeminiCallLimiter` concurrency based on observed queue depth.
