# Backlog Translation Cap — Design

## Purpose

When a viewer subscribes to a language that isn't yet cached, `handleViewerConnection` in [wsServer.ts](../../../server/src/wsServer.ts) fills the gap by translating **every** uncached visible line in the buffer — up to the full 10-minute `BUFFER_WINDOW_MS` window — in a single `translateBacklog` call, followed by a single `verifyTranslations` call over the same set. The [viewer-subscribe-burst design](2026-07-16-viewer-subscribe-burst-design.md) added a per-language cache and in-flight coalescing so this only happens once per *new* language, but it deliberately left the size of that first fill unbounded (its testing plan calls this "a one-time delay for the fill").

That unbounded first fill is the trigger behind the caption delay observed during the **2026-07-19 Sunday service**. Analysis of the prod `events.log` for that service shows the fill firing repeatedly with a very large payload — e.g. at `02:13:08` a single `translate_backlog` for Spanish covered **335 buffered lines**, which then produced 335 verification fallbacks over the next ~75 seconds. This pattern repeated ~29 times across the service. Each fill is one very large, slow call to the reasoning translation model (`openai/gpt-5.6-luna`), and every backlog call shares the same fixed OpenRouter concurrency limiter (8) and rate limiter (5 calls / 2s) as the live per-segment path. The result was a self-inflicted standing queue: captions ran a large, growing offset behind the speaker. (No OpenRouter 429s appear in the log — this was local congestion, not an external rate limit.)

This design **caps how many lines a single backlog fill translates** to the most recent N visible lines. Lines older than the cap are shown untranslated (English), which is already the app's fallback for any uncached line. This bounds both the size of each `translateBacklog`/`verifyTranslations` call and the total work a single subscribe (or reconnect) can inject.

## Scope

- A configurable cap, `VIEWER_BACKLOG_TRANSLATE_LIMIT` (default **30**), on the number of most-recent visible lines a subscribe will backlog-translate.
- The selection of which lines to fill is extracted into a small, pure, unit-testable helper, separate from the WebSocket plumbing.
- The backlog **snapshot** sent to the viewer is unchanged: every visible line is still included; lines beyond the cap simply carry their English text as the translated value (existing `buildBacklogLine` fallback).
- Explicitly out of scope (each is a separate, independently-shippable task):
  - **Fix 2 — budget isolation:** giving backlog fills their own concurrency/rate budget so even a bounded fill never competes with the live path. Not addressed here.
  - **Fix 3 — live-queue back-pressure:** bounding the live `ingestQueue`/`publishQueue` and dropping stale work so any residual congestion self-heals. Not addressed here.
  - Lazily translating the older (beyond-cap) lines in the background — see Future Extensions.
  - Any change to the live segment path, the cache/coalescing mechanics, Deepgram/session/viewer protocols, or the `BUFFER_WINDOW_MS` buffer window itself.

## Design

### 1. `selectBacklogEntriesToTranslate` (new, `server/src/viewerBacklog.ts`)

A pure helper that decides which visible backlog lines a subscribe should translate, given the cap. Kept in its own module so it can be unit-tested without a live WebSocket or a mocked LLM client, and to keep `wsServer.ts` from growing further.

```ts
import type { CaptionLine } from './types.js';

// Of the visible backlog, return only the most-recent `limit` lines that are
// still uncached for this language. Older lines are intentionally excluded:
// they fall back to their English text in the backlog snapshot rather than
// being translated, bounding the size (and cost/latency) of a single fill.
export function selectBacklogEntriesToTranslate(
  visibleEntries: CaptionLine[],
  isCached: (line: CaptionLine) => boolean,
  limit: number
): CaptionLine[] {
  const recent = limit > 0 ? visibleEntries.slice(-limit) : [];
  return recent.filter((line) => !isCached(line));
}
```

- `visibleEntries` is the already-computed non-suppressed backlog (same value used today).
- `isCached` is a predicate closing over the session's `TranslationCache` and the target language, so the helper needs no knowledge of the cache's shape.
- Applying `.slice(-limit)` **before** the uncached filter is deliberate: the cap defines a *recent window*, and within that window we translate whatever is still missing. If the recent window is already fully cached (e.g. a reconnect of an active language), the result is empty and no call is made. A non-positive limit disables backlog translation entirely (every line falls back to English) — a valid, if extreme, configuration.

### 2. Cache-aware subscribe, capped (`handleViewerConnection`, wsServer.ts)

Replace the current missing-entry computation:

```
// today
visibleEntries = backlog.filter(line => !line.suppressed)
missingEntries = visibleEntries.filter(line => cache.get(language, line.id) === undefined)
```

with the capped selection:

```
// fix 1
visibleEntries = backlog.filter(line => !line.suppressed)
missingEntries = selectBacklogEntriesToTranslate(
  visibleEntries,
  line => cache.get(language, line.id) !== undefined,
  deps.viewerBacklogTranslateLimit
)
```

Everything else in `handleViewerConnection` is unchanged:
- `ensureBacklogCached(deps, language, missingEntries)` is still called (only when `missingEntries.length > 0`); its in-flight coalescing and recursive top-up are unaffected and now operate on a set of at most `limit` entries.
- The final snapshot is still `backlog.map(line => buildBacklogLine(line, cache, language))` over the **full** backlog. A beyond-cap line is simply never made "missing," so it is never translated; `buildBacklogLine` already maps an uncached line to `translated: line.english`.

### 3. Configuration and wiring

- New env var `VIEWER_BACKLOG_TRANSLATE_LIMIT`, parsed in [index.ts](../../../server/src/index.ts) with a default of **30**:
  ```ts
  viewerBacklogTranslateLimit: process.env.VIEWER_BACKLOG_TRANSLATE_LIMIT
    ? Number(process.env.VIEWER_BACKLOG_TRANSLATE_LIMIT)
    : 30,
  ```
- Add `viewerBacklogTranslateLimit: number` to the `WsServerDeps` interface, threaded through `attachWsServer` exactly like the existing `deepgramCostFlushIntervalMs` numeric dependency.
- Document the variable in `server/.env.example`.

**Why 30:** at a healthy line cadence this is roughly one to two minutes of recent scrollback — enough for a late joiner to catch the thread leading into the live captions — while keeping a single fill to one small, fast `translateBacklog`/`verifyTranslations` pair instead of a 300+-line call. It is env-tunable so it can be adjusted against real services without a code change.

## Error Handling

- **No new failure modes.** `ensureBacklogCached` is called exactly as before, only with a smaller `missingEntries` set; its existing error handling (translate failure → cache each missing line as its English fallback; verify failure → English fallback) is unchanged.
- **Beyond-cap lines** are never translated and therefore never fail; they render as English via the existing `buildBacklogLine` fallback, identical to how any uncached line renders today.
- **Cap pins older lines to English for the rest of their buffer lifetime.** A line older than the recent window on first subscribe is never backlog-translated by a later subscribe either (it stays beyond every subsequent recent window as the buffer moves forward, and eventually trims out). This matches the existing behavior where a cold-fill failure pins a line to English — the viewer-subscribe-burst design already accepts lines that are never retranslated once resolved.
- **Live path unaffected:** lines translated live (with an active viewer in that language) continue to be cached by the live-publish path regardless of the cap; the cap governs only the on-subscribe backlog fill.

## Testing

- **Unit (`viewerBacklog.test.ts`)** for `selectBacklogEntriesToTranslate`:
  - `M > limit`, none cached → returns exactly the last `limit` entries, in order.
  - `M <= limit`, none cached → returns all visible entries.
  - Recent window partially cached → returns only the uncached entries within the last `limit`.
  - All of the recent window cached → returns empty (no fill call would be made).
  - An uncached line *older* than the recent window → excluded (not returned).
  - `limit = 0` → returns empty.
- **Unit (`wsServer.test.ts`)**:
  - A viewer subscribing to a brand-new language against a buffer larger than the limit results in a `translateBacklog` call whose input length is `<= VIEWER_BACKLOG_TRANSLATE_LIMIT` (not the full buffer).
  - The `backlog` message returned to that viewer still contains **all** visible lines; the beyond-cap lines have `translated === english`.
  - A buffer smaller than the limit still translates every visible line (parity with pre-cap behavior for small buffers) — guards against a regression for the common small-backlog case.
- **Manual (browser):** start a session and let well over `limit` lines accumulate with no viewer on some language; subscribe a viewer to that language and confirm (a) recent lines appear translated quickly, (b) older lines appear in English, (c) live captions continue without a visible stall.

## Known Simplifications

- The cap is a **line count** over the recent window, not a time window. Line count maps directly onto the `translateBacklog` batch size (the thing we are bounding) and needs no clock; a time-based cap would be a second expiry concept to keep in sync with `BUFFER_WINDOW_MS` for little benefit.
- Beyond-cap lines are shown as English rather than translated. This is the accepted trade-off from the approved design (older scrollback in English), and reuses the existing uncached-line fallback rather than adding a new display state.
- The cap does not attempt to prioritize *which* older lines to translate — it always keeps the most recent window. A late joiner's most useful context is the lines immediately preceding "now," so recency is the right axis.

## Future Extensions (explicitly out of scope now)

- **Fix 2 (budget isolation):** a dedicated, lower-priority concurrency/rate budget for backlog fills so they never contend with the live path.
- **Fix 3 (live-queue back-pressure):** bounding the live `ingestQueue`/`publishQueue` and dropping stale work so any residual standing queue self-heals.
- **Lazy background fill** of the older (beyond-cap) lines, at low priority, so scrollback eventually becomes fully translated without a burst — naturally builds on Fix 2's separate budget.
