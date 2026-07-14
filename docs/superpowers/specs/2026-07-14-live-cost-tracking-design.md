# Live Gemini + Deepgram Cost Tracking — Design

## Purpose

[README.md's "Cost analysis" section](../../../README.md) currently gives a *hand-derived estimate* (~$0.85–$1.20/hour) based on assumed token/audio rates, with a note that "the system logs every call, so real usage is easy to audit against these estimates once deployed." Nobody has actually done that audit — there's no code anywhere that reads the token counts Google already returns on every Gemini response, or converts Deepgram streaming duration into a dollar figure.

This design turns that estimate into a live, per-session running total shown to the person operating the capture page, plus a lifetime total that persists across sessions — so "what did this sermon cost" and "what have we spent so far" are answered by the app itself instead of a static README table.

## Scope

- Tracks **Gemini** cost from the real `usageMetadata` (prompt/candidates/cached token counts) Google returns on every `generateContent` call, across all current and future call sites (`translateSegment`, `translateBacklog`, `verifyTranslations`, and the in-flight `transcriptionVerifier.ts` — see "Sequencing with concurrent work" below).
- Tracks **Deepgram** cost from wall-clock recording duration (Start → Stop) × a configured per-minute rate.
- Shows a live "session cost / lifetime cost" readout on the capture page, updating as the session runs.
- Persists the lifetime total to disk (`server/data/cost.json`), surviving server restarts.
- Explicitly out of scope: Gemini context-cache *storage* cost (billed per token-hour while a sermon cache is alive — small relative to per-call translation cost, see "Known simplifications"); any live "billed dollars" API call to Google or Deepgram (neither exposes one for this kind of API key — see "Why not query Google directly").

## Why not query Google directly

The original idea was to get cost figures straight from Google rather than estimating. Worth stating plainly why that's not the mechanism here: `GEMINI_API_KEY` in this project is a Google AI Studio (Gemini Developer API) key, not a Vertex AI/GCP-billing-linked key. AI Studio doesn't expose a public API to query billed dollars for a key — usage is only visible by hand in the AI Studio console. Vertex AI keys *can* get real billed-dollar figures via the Cloud Billing API, but that data lags ~24 hours behind actual usage (billing export, not real-time), and would mean re-provisioning the API key onto a GCP project — out of scope for this pass.

What Google *does* give directly, on every single response, is `usageMetadata`: the exact number of tokens that call actually consumed (`promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`, `totalTokenCount`). That's not an estimate — it's Google's own count of what happened. The only estimated part is the dollar conversion, since that requires a price-per-token figure this codebase has to maintain itself (see "Pricing config"). Deepgram's streaming API has the same shape: no live per-request cost, but duration is knowable, and duration × published rate is the standard way this is done.

## Design

### 1. Pricing config

New `server/src/costPricing.ts`, reusing the exact rates already verified in [README.md's Cost analysis](../../../README.md) (mid-2026 published pricing) rather than re-deriving them:

- Gemini `gemini-3.1-flash-lite`: $0.25/1M input tokens, $1.50/1M output tokens, $0.025/1M cached-input tokens (90% discount, per the existing [sermon-context-caching design](2026-07-14-sermon-context-caching-design.md)).
- Deepgram `nova-3` streaming: $0.0077/min.

Each constant carries a one-line comment noting it needs manual updating if Google/Deepgram change published pricing — this file is a lookup table, not a live feed.

### 2. `CostTracker`

New `server/src/costTracker.ts`, following the same "small store with an explicit interface" shape as `feedbackStore.ts`:

```ts
interface CostTracker {
  recordGeminiUsage(usage: { promptTokens: number; candidatesTokens: number; cachedTokens: number }): void;
  recordDeepgramSeconds(seconds: number): void;
  resetSession(): void;
  getSessionCostUsd(): number;
  getLifetimeCostUsd(): number;
}
```

- `resetSession()` zeroes the session total; called when a capture session starts.
- Every `record*` call updates both the session total (in-memory) and the lifetime total (in-memory + persisted).
- Lifetime total loads from `server/data/cost.json` (`{ lifetimeUsd: number }`) at server startup, same missing-file-means-zero pattern as `feedbackStore.read()`'s missing-file-means-empty-string. Written back to disk after every update — call volume is one sentence's worth of Gemini calls every few seconds during a live sermon, which is negligible I/O for a local JSON write.

### 3. Gemini usage capture: transparent client wrapper

Rather than modifying `gemini.ts`, `translationVerifier.ts`, or the in-flight `transcriptionVerifier.ts` to each report usage individually, `index.ts` wraps the real `GeminiClient` once, at construction:

```ts
function withCostTracking(client: GeminiClient, tracker: CostTracker): GeminiClient {
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

The wrapped client is what gets passed into `attachWsServer(...)` as `geminiClient` — everywhere downstream (`gemini.ts`, `translationVerifier.ts`, `transcriptionVerifier.ts`, and any future module that calls `generateContent`) is completely unaware tracking exists. This is the reason to prefer this approach over instrumenting each call site: it can't miss a call site, present or future, and it requires zero changes to files another agent is actively modifying (see "Sequencing" below).

### 4. Deepgram usage capture: wall-clock duration

In `wsServer.ts`'s `handleCaptureConnection` (the function handling `'start'`/`'stop'` messages — **not** `handleFinalSegment`, which is where the concurrent transcription-check work is happening):

- On `'start'`, after the Deepgram connection is created, record `recordingStartedAt = Date.now()`.
- On `'stop'` (and on socket close, mirroring the existing cleanup-on-both-paths pattern already used for the sermon cache), compute `(Date.now() - recordingStartedAt) / 1000` seconds and call `costTracker.recordDeepgramSeconds(...)`.

This is a proxy for actual billed audio-minutes, not a byte-exact accounting — MediaRecorder streams continuously in real time while recording, so wall-clock duration and audio duration are the same thing to within network jitter (low single-digit milliseconds).

### 5. Broadcasting to the capture page

After each `record*` call, `wsServer.ts` sends the capture socket:

```json
{ "type": "cost", "sessionUsd": 0.0032, "lifetimeUsd": 14.82 }
```

This is a new, independent message type — it doesn't touch the existing `{ type: 'transcript', ... }` or `{ type: 'status', ... }` message shapes, so it doesn't interact with the concurrent transcription-check work's changes to the `transcript` message.

### 6. Capture page display

`capture/page.tsx` gains `sessionCostUsd`/`lifetimeCostUsd` state, updated on the new `'cost'` message, rendered near the existing status line — e.g. "Session: $0.0032 · Lifetime: $14.82". This is an additive change (new state, new message branch, new JSX element) rather than a modification of the existing `transcript` message branch or rendering block that the concurrent transcription-check work is changing.

## Sequencing with concurrent work

A separate in-progress effort (transcription-safety-check plan) is mid-flight in this same worktree: `server/src/transcriptionVerifier.ts` already exists (uncommitted), and its next step wires it into `wsServer.ts`'s `handleFinalSegment` and adds `flagged`/`reason` fields to the `transcript` message in `capture/page.tsx`. This design's touch points were deliberately chosen to avoid those exact spots:

| File | This design touches | Concurrent work touches |
|---|---|---|
| `wsServer.ts` | `handleCaptureConnection` (start/stop) | `handleFinalSegment` |
| `capture/page.tsx` | new `'cost'` branch + new display element | existing `transcript` branch + rendering block |
| Gemini call sites | none (transparent wrapper) | adds a new call site (`transcriptionVerifier.ts`) |

No direct line overlap is expected, but both still touch `wsServer.ts` and `capture/page.tsx`. When this design is implemented, re-read both files' current state first rather than assuming this spec's snapshot — if the transcription-check plan has landed by then, the diffs here should still apply cleanly since they're additive in different functions/branches; if it hasn't, note that its edits are still pending in the same file.

## Error Handling

- **`usageMetadata` missing from a response** (shouldn't normally happen, but the SDK types mark it optional) → skip recording for that call rather than throwing; a missed data point under-counts cost slightly but never breaks translation.
- **`cost.json` unreadable/corrupt at startup** → treat lifetime total as $0 and continue (same "never block the app over an optional feature" precedent as `feedbackStore`), logging a warning.
- **`cost.json` write fails** (disk full, permissions) → log a warning, keep the in-memory total for the running session; don't crash the session or block translation.
- **Deepgram 'stop' never arrives** (e.g. client crashes) → the existing `ws.on('close', ...)` handler already runs cleanup for the sermon cache; the same handler computes and records Deepgram seconds so a crashed session still gets billed for the audio it actually sent.

## Testing

- **Unit**: `costPricing.ts` rate lookups.
- **Unit**: `CostTracker` — recording Gemini usage and Deepgram seconds updates both session and lifetime totals correctly; `resetSession()` zeroes session but not lifetime; missing/corrupt `cost.json` on load falls back to $0 rather than throwing.
- **Unit**: `withCostTracking` wrapper — given a fake `GeminiClient` returning a response with `usageMetadata`, asserts `tracker.recordGeminiUsage` is called with the right numbers; given a response with no `usageMetadata`, asserts no crash and no recording.
- **Unit**: `wsServer.ts` — `'start'` then `'stop'` after a controlled delay records approximately the right number of Deepgram seconds; a `'cost'` message is sent to the capture socket after a Gemini call.
- **Manual**: run a real session, confirm the capture page's cost readout increases as sentences are spoken, confirm it resets to near-zero on a fresh Start, confirm the lifetime figure survives a server restart.

## Known simplifications

- Dollar figures are estimates (real token counts × a maintained pricing table), not Google-confirmed billed dollars — see "Why not query Google directly."
- Gemini context-cache *storage* cost (per-token-hour while a sermon cache is alive) isn't included, only per-call input/output/cached-input tokens — consistent with the existing [sermon-context-caching design](2026-07-14-sermon-context-caching-design.md)'s finding that storage cost is trivial relative to per-call cost.
- Deepgram cost uses wall-clock session duration as a proxy for billed audio-minutes, not a byte-exact accounting.
- No UI affordance to reset the lifetime total (e.g. "start a new billing period") — if that's ever needed, it's a manual edit to `cost.json`.

## Future Extensions (explicitly out of scope now)

- Per-model or per-call-type cost breakdown (e.g. "translation vs. verification vs. transcription-check" as separate line items) — today's design tracks one combined Gemini total.
- A historical log of cost per individual sermon/session (today only session-current and all-time-lifetime are tracked, not a list of past sessions).
- Alerting/budget caps (e.g. "warn if a session exceeds $X").
- Gemini context-cache storage cost accounting.
