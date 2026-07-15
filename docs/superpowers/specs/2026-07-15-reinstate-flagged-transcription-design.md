# Reinstate a Flagged Transcription — Design

## Purpose

When [`verifyTranscription`](../../../server/src/transcriptionVerifier.ts) flags a transcript line as unsafe (confidently misrepresenting God/Jesus/the Holy Spirit — usually caused by Deepgram mishearing a word), the line is suppressed entirely: never appended to the session's transcript buffer, never translated, never shown to any viewer. Only the AV operator on the capture page sees it, struck through, with no way to act on it. If the flag was a false positive, or the underlying mishearing is fixable (e.g. Deepgram dropped a "not," or misheard a name), the correct line is simply lost for the rest of the service.

This design adds a **Reinstate** action on the capture page: the operator can review a flagged line, optionally correct its wording, and — after an explicit confirmation — send it into the live transcript exactly where it was originally spoken, for every viewer regardless of when they joined.

This directly follows up on the "Surfacing flagged-line history in a UI" item explicitly deferred in [2026-07-14-transcription-safety-check-design.md](2026-07-14-transcription-safety-check-design.md#future-extensions-explicitly-out-of-scope-now), taken further: not just visibility, but recovery.

## Scope

- A **Reinstate** action per flagged line on the capture page, gated by a confirmation dialog that shows the AI's stated flag reason.
- An inline **edit box** on reinstate, pre-filled with the original transcribed text, so the operator can correct an STT mishearing before sending — or leave it unchanged as a simple override.
- Correct chronological positioning: a reinstated line appears at the exact point in the transcript where it was originally spoken, for every viewer — whether they were connected at flag time, joined in between, or join after reinstatement.
- The transcription-misrepresentation check itself is skipped on reinstate (the operator has manually vouched for the line); the existing translation-safety check (`translationVerifier.ts`) still runs on the (possibly corrected) English text.
- Explicitly out of scope: editing lines that were never flagged; un-reinstating (re-suppressing) a line once sent; bulk reinstate of multiple lines at once; any change to how the transcription-misrepresentation check itself decides what to flag.

## Design

### 1. Buffer & type changes

`server/src/types.ts` — `CaptionLine` gains a `suppressed: boolean` field:

```ts
export interface CaptionLine {
  id: string;
  timestampMs: number;
  english: string;
  suppressed: boolean;
}
```

`server/src/transcriptBuffer.ts` — `append()` takes the suppressed flag:

```ts
append(english: string, suppressed: boolean, timestampMs: number = Date.now()): CaptionLine
```

The key change: **flagged lines are now appended to the buffer** (with `suppressed: true`) instead of being dropped. The buffer becomes the single source of truth for "everything that was finalized, in order, and whether it's currently visible" — this is what makes correct-position splicing possible later. `getRecent()`/`trim()` behavior (10-minute rolling window, `BUFFER_WINDOW_MS`) is unchanged and applies uniformly to suppressed and visible entries alike.

Add a lookup/mutation method used by reinstate:

```ts
reinstate(id: string, english: string): CaptionLine | null
```

Returns `null` if no entry with that id exists (trimmed out of the window) or the entry is not currently suppressed (already reinstated). Otherwise mutates that entry in place — `english` updated to the (possibly edited) text, `suppressed` set to `false` — and returns it. Mutating in place, rather than removing and re-appending, is what preserves the line's original position and id.

### 2. `handleFinalSegment` (`server/src/wsServer.ts`)

```
compute precedingContext from buffer entries before the new line (existing behavior, unchanged)
run verifyTranscriptionWithRetry(...) and translateWithFallback(...) in parallel (existing behavior, unchanged)

if transcription check is unsafe:
  line = buffer.append(english, suppressed: true)
  log 'transcription_flagged' { english, reason }
  send { type: 'transcript', id: line.id, english, flagged: true, reason } to capture socket
  broadcast { type: 'line-removed', id: line.id } to all current viewers
  return

// safe path — unchanged except every message now carries the buffer entry's id
line = buffer.append(english, suppressed: false)
send { type: 'transcript', id: line.id, english } to capture socket
... translate/verify/broadcast per language as today, each caption message includes id: line.id
```

### 3. Reinstate handling (new, in `handleCaptureConnection`)

Capture socket sends `{ type: 'reinstate', id, english }`. Handled through the same `processingQueue` serialization already used for finalized segments, to avoid concurrent buffer mutation races:

```
processingQueue = processingQueue.then(() => handleReinstate(id, english, deps, ws))
```

`handleReinstate`:

```
if english.trim() is empty:
  send { type: 'reinstate-error', id, error: 'empty text' } to capture socket
  return

line = deps.session.buffer.reinstate(id, english.trim())
if line === null:
  send { type: 'reinstate-error', id, error: 'not found' } to capture socket
  return

precedingContext = buffer entries before line's position, filtered to suppressed === false,
                   mapped to .english, last PRECEDING_CONTEXT_LINES
activeLanguages = deps.session.getActiveLanguages()

translations = translateWithFallback(deps, line.english, activeLanguages, precedingContext, deps.session.sermonCache)
verifications = verifyTranslationsWithRetry(...)   // same as the existing safe path — translation-safety net still applies

send { type: 'transcript', id: line.id, english: line.english, flagged: false } to capture socket

for each active language with a safe, non-empty translation:
  broadcast { type: 'caption-inserted', id: line.id, english: line.english, translated } to that language's current viewers
```

Note the transcription-misrepresentation check (`verifyTranscription`) is **not** re-run here — that's the entire point of a manual operator override. The translation-safety check is unchanged and still applies, same as any normal line.

### 4. Viewer backlog building (`handleViewerConnection`'s `subscribe` handler)

Walks `buffer.getRecent()` in order and, for each entry:
- `suppressed: true` → `{ id, english: '', translated: '', removed: true }` (no translation call, nothing sensitive sent).
- `suppressed: false` → translated as today (batched via `translateBacklog` + `verifyTranslationsWithRetry`, unchanged), with `id` included in the resulting line.

This is what guarantees every viewer — regardless of when they subscribe relative to a flag or reinstate — sees a consistent, correctly-positioned transcript. Today, only viewers connected *at the exact moment of flagging* ever see a placeholder; anyone who joins later sees no gap at all. This fixes that inconsistency as a side effect.

### 5. Viewer WebSocket protocol (`web/lib/useViewerSocket.ts`)

`CaptionLine` (client) gains `id: string`. Message handling:
- `backlog` → stored as-is (already carries `id` per line from the server).
- `caption` → append `{ id, english, translated }`.
- `line-removed` → append `{ id, english: '', translated: '', removed: true }`.
- `caption-inserted` (new) → find the array entry with matching `id` and replace it in place (`removed: false`, fills `english`/`translated`). If no match is found, append instead as a defensive fallback so nothing is silently lost.

`web/app/view/page.tsx`: list `key` changes from `index` to `line.id` — now correct, since an entry's content can be replaced in place rather than the array only ever growing.

`web/lib/exportTranscriptPdf.ts`: no changes required — it only reads `english`/`translated`/`removed` off whatever `lines` array it's given.

### 6. Capture page (`web/app/capture/page.tsx`)

`transcriptLines` state becomes:

```ts
{ id: string; text: string; flagged: boolean; reason?: string; reinstateStatus?: 'editing' | 'pending' | 'error' }[]
```

- Upserted by `id` on every `transcript` message: existing `id` → update that row in place; new `id` → append. This single upsert path naturally handles both the initial flag and the later reinstate ack (which reuses the `transcript` message type with `flagged: false`).
- Reset to `[]` in `start()` (alongside the existing `sessionCostUsd` reset) — a fresh feed per session, so ids from a prior session can never be reinstated into a new one.
- Each flagged row renders: struck-through text, the flag reason, and a **Reinstate** button.
  - Click → row enters `editing` state: an inline text box appears, pre-filled with the current text, editable, with **Send** / **Cancel**. Send is disabled while the trimmed value is empty.
  - Send → `window.confirm('Flagged: "<reason>". Send this line to viewers?')`. On confirm, row moves to `pending` (button disabled, "Reinstating…"), and `{ type: 'reinstate', id, english: editedText.trim() }` is sent.
  - Cancel → row returns to its normal flagged display, no message sent.
- On a `transcript` message with matching `id` and `flagged: false` → row settles into normal (non-flagged, non-strikethrough) styling.
- On `reinstate-error` with matching `id` → row returns to `editing` state with an inline error message ("Couldn't reinstate — try again"), same visual pattern as the existing `feedbackError`/`uploadError` inline errors.
- The Reinstate button and edit box are only shown/enabled while `status === 'recording'` — prevents sending into a closed or reconnecting socket.

## Error Handling

- **Buffer-trimmed line** (operator waits past the 10-minute `BUFFER_WINDOW_MS`): `buffer.reinstate()` returns `null` → `reinstate-error`, operator sees an inline error. Inherent limit of the existing rolling buffer, unchanged by this feature.
- **Double-reinstate** (rapid double-click, or two operator tabs): server re-checks `suppressed === true` inside `buffer.reinstate()` before mutating; a second attempt on an already-reinstated line gets `reinstate-error` rather than double-broadcasting. Client-side `pending` state (button disabled) prevents the common case.
- **Blank edited text**: rejected client-side (Send disabled) and defensively on the server (`reinstate-error`).
- **Session stopped/restarted mid-flag**: `start()`/`stop()` already clear `transcriptLines` client-side and `buffer.clear()` server-side; a stale flagged line's `id` from a prior session has nothing to look up, so a reinstate attempt (which shouldn't be reachable anyway, since `transcriptLines` is cleared) fails cleanly via the not-found path.
- **Translation/Gemini failure during reinstate**: identical fail-safe behavior to the existing safe-line path. The buffer entry still flips to unsuppressed and the capture page still un-flags the row (the corrected English is preserved for future backlogs), but if translation totally fails, no `caption-inserted` reaches currently-connected viewers for that language — same degraded-mode precedent as the rest of the pipeline (a segment whose translation can't be verified is dropped/falls back rather than shown unchecked).

## Testing

- **Unit (`transcriptBuffer.test.ts`)**: `append` stores `suppressed`; `reinstate` mutates the matching entry's `english`/`suppressed` in place and preserves its id/position; `reinstate` on an unknown id returns `null`; `reinstate` on an already-unsuppressed entry returns `null`; trimmed (expired) entries are unreachable via `reinstate`.
- **Unit (`wsServer.test.ts`)**:
  - Flagged line → appended to buffer as `suppressed: true`; capture socket gets `flagged: true` with `id` + `reason`; all currently-connected viewers get `line-removed` with matching `id`; buffer entry is present but not included in any viewer broadcast content.
  - A viewer subscribing *between* flag and reinstate gets a `removed: true` placeholder at the correct backlog position (same `id` the original flag used).
  - Reinstate with unedited text → buffer entry's `suppressed` flips to `false`; capture socket gets `transcript` with `flagged: false` and matching `id`; active-language viewers get `caption-inserted` with matching `id`.
  - Reinstate with edited text → buffer entry's `english` is updated; a subsequent viewer's backlog reflects the corrected wording, not the original mishearing.
  - Reinstate on unknown/trimmed/already-reinstated id → `reinstate-error`, no buffer mutation, no broadcast to any viewer.
  - Reinstate with blank/whitespace-only text → `reinstate-error`, no buffer mutation.
  - Existing safe-path and translation-verification tests updated only to account for the added `id` field on messages — no behavioral change there.
- **Manual (browser)**: flag a line (e.g. via a deliberately mis-transcribed test phrase), confirm it shows struck-through with a reason on the capture page; open two viewer tabs in different languages — one connected before the flag, one that subscribes after the flag but before reinstate — confirm both show a "Line removed" placeholder at the right spot; reinstate with an edited correction; confirm both viewer tabs update that exact line in place (not appended at the end) with the corrected translation; open a third viewer tab after reinstating and confirm its backlog shows the corrected line directly, with no placeholder.

## Known Simplifications

- No way to re-suppress a line once reinstated (one-directional action, matching the "Reinstate" name).
- No bulk reinstate — one line at a time, consistent with this being a rare, deliberate operator override rather than routine workflow.
- The 10-minute buffer trim window applies to suppressed lines exactly as it does to visible ones — a flag not acted on within 10 minutes becomes permanently unrecoverable through this UI (still exists in the `transcription_flagged` structured log for post-service review, per the original safety-check design).
- Editing is confirmation-gated by a native `window.confirm()`, consistent with the existing `Clear all feedback notes?` pattern elsewhere on the capture page — not a custom modal component.

## Future Extensions (explicitly out of scope now)

- Editing lines that were never flagged.
- Re-suppressing a previously reinstated line.
- Bulk reinstate of multiple flagged lines at once.
- Surfacing flagged-and-never-reinstated lines anywhere outside structured server logs after a session ends.
