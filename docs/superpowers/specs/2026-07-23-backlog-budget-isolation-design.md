# Backlog Budget Isolation — Design

## Purpose

Every OpenRouter call in the server, regardless of role or origin, is funneled
through **one** concurrency limiter (`GeminiCallLimiter`, max 8) and **one** rate
limiter (`OpenRouterRateLimiter`, 5 calls / 2s). Both are constructed once in
[index.ts](../../../server/src/index.ts) and applied opaquely by
[withOpenRouterLimiter](../../../server/src/openRouterLimiter.ts), which wraps the
single `openRouterClient` that all three role providers share. Because the live
per-segment path and the on-subscribe backlog fill use the **same provider
instances** ([session.providers](../../../server/src/session.ts)), a backlog fill
and a live caption compete directly in both queues.

The live path is:
[handleFinalSegmentFast](../../../server/src/wsServer.ts) (`verifyTranscription`
+ `translate`) and
[prepareTranslationsForPublish](../../../server/src/wsServer.ts)
(`verifyTranslations`). The backlog path is
[ensureBacklogCached](../../../server/src/wsServer.ts) (`translateBacklog` +
`verifyTranslations`), triggered when a viewer subscribes to (or reconnects to) a
language whose recent lines aren't cached.

This shared budget is a contributing cause of the **2026-07-19 Sunday service**
caption delay (see
[the backlog-translation-cap design](2026-07-21-backlog-translation-cap-design.md)
for the incident analysis). Its **Fix 1** bounds how many lines a *single*
backlog fill translates. But even a bounded fill still enters the same two queues
as live calls, and multiple concurrent fills (several viewers picking or
reconnecting to languages at once) can still put live captions behind backlog
work — most acutely in the rate limiter's FIFO queue, where at 5 calls / 2s a
handful of fills saturate the window and live calls wait their turn behind
backlog calls for rate tokens.

**Fix 2 (this design)** gives the backlog path a lower-priority share of the
**same** OpenRouter budget: a small reserved carve-out that backlog may never
exceed, plus strict live-first ordering when capacity frees. The result is that
live calls are not delayed behind backlog calls (within live's reserved share),
while the aggregate load OpenRouter sees is unchanged — the carve-out is *within*
today's 8 / 5-per-2s, not additive.

## Scope

- Make the OpenRouter concurrency limiter (`GeminiCallLimiter`) and rate limiter
  (`OpenRouterRateLimiter`) **reservation- and priority-aware**, in a
  backward-compatible way (existing constructions and the entire Gemini path are
  unchanged).
- Route the backlog fill (`translateBacklog` + its `verifyTranslations`) through
  a **second OpenRouter client wrapper** tagged `backlog`, via a new
  `session.backlogProviders` set. The live path continues to use
  `session.providers`.
- Keep the total OpenRouter budget constant: backlog is a carve-out inside the
  existing concurrency (8) and rate (5 / 2s) budgets, not an additional lane.
- Configurable via new env vars with conservative defaults (backlog ≤ 2
  concurrent, ≤ 1 call / 2s).
- Explicitly **out of scope**:
  - **Gemini budget isolation.** The Gemini concurrency limiter
    (`geminiLimiter`) is left shared. If `translation` or `translationVerifier`
    is configured to a Gemini model, a backlog burst can still contend with the
    live Gemini path. Documented as a known limitation; the limiter class gains
    the capability but the Gemini path is not wired to use it. See Future
    Extensions.
  - **Fix 1 (backlog size cap)** — already spec'd/planned separately; Fix 2
    composes with it.
  - **Fix 3 (live-queue back-pressure)** — bounding the live
    `ingestQueue`/`publishQueue`; not addressed here.
  - Any change to the provider/client interfaces, the model/prompt config, the
    Deepgram/session/viewer protocols, the cache/coalescing mechanics, or the
    live segment path itself.

## Design

### 1. Shared call-priority type

A single small union expresses which lane a call belongs to:

```ts
export type CallPriority = 'live' | 'backlog';
```

It is consumed by both limiter primitives and by `withOpenRouterLimiter`. It
lives in the lowest-level primitive module so both limiters can import it without
a cycle (`server/src/geminiLimiter.ts`, re-exported as needed).

### 2. Reservation- and priority-aware concurrency limiter (`geminiLimiter.ts`)

`GeminiCallLimiter` is the class already reused as the OpenRouter concurrency
limiter. It is extended so backlog gets a hard concurrency sub-cap and live is
always admitted first.

```ts
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
  // acquire/release/drain as described below.
}
```

Semantics:

- **Live admit:** allowed while `active < maxConcurrent`.
- **Backlog admit:** allowed while `active < maxConcurrent` **and**
  `backlogActive < backlogMaxConcurrent`.
- **`drain()`** (run after every enqueue and every release): admit **all eligible
  live waiters first, then all eligible backlog waiters**. Admitting live raises
  `active` and can exhaust capacity before backlog is considered — this is the
  priority. A live release decrements `active`; a backlog release decrements both
  `active` and `backlogActive`.
- **Reservation guarantee:** because `backlogActive ≤ backlogMaxConcurrent` at all
  times, at least `maxConcurrent − backlogMaxConcurrent` slots are never
  occupiable by backlog. With the defaults (8 and 2) live always has ≥ 6 slots
  that backlog cannot take, and any live call is admitted ahead of any queued
  backlog call.

**Backward compatibility:** `backlogMaxConcurrent` defaults to `maxConcurrent`
(no separate cap) and `priority` defaults to `'live'`. So existing constructions
— `new GeminiCallLimiter()` (the Gemini path) and `new GeminiCallLimiter(n)` (any
test) — with all callers passing no priority behave identically to the current
single-FIFO, single-cap limiter. The two-queue structure collapses to the live
queue only.

### 3. Reservation- and priority-aware rate limiter (`openRouterRateLimiter.ts`)

`OpenRouterRateLimiter` is extended the same way: a backlog sub-cap per window
plus live-first draining.

```ts
export class OpenRouterRateLimiter {
  private readonly startTimes: number[] = [];         // all starts in-window
  private readonly backlogStartTimes: number[] = [];  // backlog-only starts in-window
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
  // acquire/drain/prune as described below.
}
```

Semantics:

- **`drain()`:** prune expired entries from both arrays, then:
  1. Admit live while `startTimes.length < maxPerWindow` (record a start in
     `startTimes`).
  2. Admit backlog while `startTimes.length < maxPerWindow` **and**
     `backlogStartTimes.length < backlogMaxPerWindow` (record a start in **both**
     `startTimes` and `backlogStartTimes`).
- **Aggregate** stays ≤ `maxPerWindow` per window (unchanged from today). Live
  always has ≥ `maxPerWindow − backlogMaxPerWindow` tokens per window it can claim
  ahead of backlog. With the defaults (5 and 1), live always has ≥ 4 tokens / 2s.
- **Timer scheduling (the one added subtlety):** when a queue is still blocked
  after draining, wake at the **soonest possibly-relevant expiry** and re-drain:
  - Live is blocked only by the main window → candidate wait =
    `windowMs − (now − startTimes[0])`.
  - Backlog is blocked by the main window and/or its sub-cap → candidate wait =
    the expiry of whichever of `startTimes[0]` / `backlogStartTimes[0]` is
    relevant.
  - Schedule the timer at the minimum applicable candidate wait (`+1` ms), then
    on wake re-drain; if still blocked it reschedules. This is the same
    "wake-and-re-evaluate" pattern the current limiter already uses, generalized
    to two constraints, so it always makes progress even when only the backlog
    sub-cap is the binding constraint.

**Backward compatibility:** `backlogMaxPerWindow` defaults to `maxPerWindow` and
`priority` defaults to `'live'`, so the current construction
`new OpenRouterRateLimiter(5, 2000)` with live-only traffic behaves exactly as
today (single FIFO, single window cap).

### 4. Priority-threading wrapper (`openRouterLimiter.ts`)

`withOpenRouterLimiter` gains a trailing `priority` parameter and passes it into
both limiter calls:

```ts
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

Existing 2- and 3-argument callers (and the existing `withOpenRouterLimiter`
test) are unaffected — `priority` defaults to `'live'`.

### 5. Two client wrappers over one shared budget (`index.ts`)

Construct **one** shared limiter and **one** shared rate limiter with the
carve-out sizes, then build **two** OpenRouter client wrappers over the **same**
base HTTP client and the **same** limiter instances, differing only by the
priority tag. Both keep cost-tracking and reasoning-logging wraps so backlog
calls are still tracked and logged.

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

// buildOpenRouterClient(priority) applies, innermost-to-outermost:
//   withOpenRouterLimiter(base, openRouterLimiter, openRouterRateLimiter, priority)
//   -> withOpenRouterCostTracking(..., costTracker)
//   -> withOpenRouterReasoningLogging(...)
// over a single shared base = createOpenRouterClient(OPENROUTER_API_KEY).
const openRouterClientLive = OPENROUTER_API_KEY ? buildOpenRouterClient('live') : null;
const openRouterClientBacklog = OPENROUTER_API_KEY ? buildOpenRouterClient('backlog') : null;
```

`attachWsServer` is passed both bundles:

```ts
llmClients:        { gemini: geminiClient, openRouter: openRouterClientLive },
backlogLlmClients: { gemini: geminiClient, openRouter: openRouterClientBacklog },
```

`geminiClient` is **the same instance** in both bundles — Fix 2 isolates only the
OpenRouter budget (see Scope). When `OPENROUTER_API_KEY` is unset both OpenRouter
clients are `null`, exactly as today.

### 6. Backlog providers and routing (`wsServer.ts`, `session.ts`, `llmTypes.ts`)

- **`WsServerDeps`** gains `backlogLlmClients: LlmClients` (same shape as the
  existing `llmClients`).
- **`session.ts`** gains `backlogProviders: BacklogProviders | null = null`,
  reset to `null` in both `start()` and `stop()` alongside `providers`. The focused
  type (in `llmTypes.ts`) is:

  ```ts
  export interface BacklogProviders {
    translation: LlmProvider;
    translationVerifier: LlmProvider;
  }
  ```

  (Only these two roles are used by the backlog path; `transcriptionVerifier` is
  live-only.)
- **Start handler** ([wsServer.ts](../../../server/src/wsServer.ts)): immediately
  after building `deps.session.providers`, build the backlog set from the **same**
  model and prompt config but the backlog clients:

  ```ts
  deps.session.backlogProviders = {
    translation: getProvider(modelConfig.translation, promptConfig.translation, deps.backlogLlmClients),
    translationVerifier: getProvider(modelConfig.translationVerifier, promptConfig.translationVerifier, deps.backlogLlmClients),
  };
  ```

- **`ensureBacklogCached`**: the `translateBacklog` call uses
  `deps.session.backlogProviders!.translation`; its verification uses the backlog
  verifier via a parameterized retry helper (below).
- **`verifyTranslationsWithRetry`** gains an optional `provider` parameter,
  defaulting to the live verifier so the live caller
  (`prepareTranslationsForPublish`) is unchanged; `ensureBacklogCached` passes
  `deps.session.backlogProviders!.translationVerifier`:

  ```ts
  async function verifyTranslationsWithRetry(
    deps: WsServerDeps,
    items: VerificationItem[],
    provider: LlmProvider = deps.session.providers!.translationVerifier
  ): Promise<Record<string, VerificationResult>> { /* body unchanged except provider */ }
  ```

  The `cacheRef` (`deps.session.roleCaches.translationVerifier`) stays shared — the
  sermon context cache is budget-independent, and both paths already read/write
  the same `roleCaches`.

**Invariant:** `backlogProviders!` is safe wherever `providers!` is safe today.
`ensureBacklogCached` runs only when a subscribe found uncached backlog lines,
which requires a non-empty buffer, which requires the session to have started —
and the start handler assigns `providers` and `backlogProviders` together. A
viewer subscribing before any session start finds an empty buffer, so
`ensureBacklogCached` is never called (the `missingEntries.length > 0` guard in
`handleViewerConnection` is false).

### 7. Configuration

New env vars (documented in `server/.env.example`), all with defaults that
preserve today's aggregate budget:

| Var | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_MAX_CONCURRENT` | `8` | Total OpenRouter concurrency (unchanged value; now explicit/env-tunable). |
| `OPENROUTER_BACKLOG_MAX_CONCURRENT` | `2` | Max concurrent backlog calls; reserves `8 − 2 = 6` for live. |
| `OPENROUTER_BACKLOG_MAX_CALLS_PER_WINDOW` | `1` | Max backlog calls per rate window; reserves `5 − 1 = 4` for live. |

Existing `OPENROUTER_MAX_CALLS_PER_WINDOW` (5) and `OPENROUTER_RATE_WINDOW_MS`
(2000) are unchanged.

**Why these sizes:** backlog is best-effort scrollback fill, so a small carve-out
(2 concurrent, 1 call / window) is enough to make steady progress without
denting live's reserved share. Because the caps are *within* the existing totals,
the worst-case aggregate OpenRouter concurrency (8) and rate (5 / 2s) are exactly
what they are today — no new 429 risk. All three are env-tunable against real
services.

## Error Handling

- **No new failure modes.** The backlog providers are the same provider classes
  over a different-budgeted client. `ensureBacklogCached`'s existing error
  handling (translate failure → cache each line as its English fallback; verify
  failure → English fallback) is unchanged.
- **Deprioritization is not failure.** When the backlog carve-out is momentarily
  saturated, backlog calls **queue** (best-effort) rather than error; they resolve
  once capacity frees. Live calls are unaffected.
- **Shared `roleCaches`** cache-invalidation-on-error behavior
  (`isCacheRelatedError` → set the role cache to `null`) is unchanged; both paths
  already share `roleCaches`.
- **Missing `OPENROUTER_API_KEY`:** both OpenRouter clients are `null`, identical
  to today; a role configured to OpenRouter still throws the existing
  "OPENROUTER_API_KEY is not configured" from `getProvider`.

## Testing

**Concurrency limiter (`geminiLimiter.test.ts`):**
- Backlog concurrency never exceeds `backlogMaxConcurrent` while live can exceed
  it (e.g. max 4, backlog 1: many concurrent backlog calls run at most 1 at a
  time; many concurrent live calls run up to 4).
- Live priority: with both live and backlog waiters queued and one slot free, the
  live waiter is admitted first.
- Live is not starved by saturated backlog: with backlog holding its cap, live
  still reaches `maxConcurrent`.
- Backward compatibility: no-priority calls behave as today (FIFO up to
  `maxConcurrent`) — the existing limiter tests remain green.

**Rate limiter (`openRouterRateLimiter.test.ts`):**
- Backlog admissions per window ≤ `backlogMaxPerWindow`.
- Aggregate admissions per window ≤ `maxPerWindow`.
- Live priority: within a window, queued live calls are admitted before queued
  backlog calls.
- Live reserved tokens: with backlog demand high, live still gets
  `maxPerWindow − backlogMaxPerWindow` tokens per window without waiting behind
  backlog.
- Timer progress: when only the backlog sub-cap is the binding constraint, the
  limiter still wakes and admits backlog after the sub-window expires.
- Backward compatibility: no-priority calls behave as today — the existing rate
  limiter tests remain green.

**Wrapper (`openRouterLimiter.test.ts`):**
- `priority` is threaded into both `limiter.run` and `rateLimiter.run`; existing
  no-priority tests remain green.

**WebSocket wiring (`wsServer.test.ts`):**
- Add `backlogLlmClients` to the test deps object (required by the new
  `WsServerDeps` field; otherwise the build fails).
- An on-subscribe fill routes `translateBacklog` (and its verify) through
  `session.backlogProviders`, while the live segment path uses `session.providers`
  — asserted by injecting a **distinct** backlog client mock in
  `backlogLlmClients` and confirming the backlog fill used it and the live path
  did not. (Because the tests use Gemini providers and Fix 2's scope is
  OpenRouter-only, this guards the *routing wire*; the *budget* behavior is
  covered by the limiter unit tests above.)

**Build:** `npm run build` confirms `index.ts` and the test deps satisfy the new
required `WsServerDeps.backlogLlmClients` field. **Full suite:** `npm test` all
green.

**Manual (browser):** during a live session, let many lines accumulate, then have
several viewers subscribe/reconnect to new languages at once; confirm live
captions continue without a visible stall while backlog scrollback fills in
behind them.

## Known Simplifications

- **Reservation is by count, not weight.** A fixed backlog sub-cap (concurrency
  and per-window) is simpler to reason about and test than a dynamic/weighted
  scheduler, and maps directly onto the two shared budgets. Live's guarantee holds
  as long as concurrent live demand stays within its reserved share
  (`max − backlogMax`), which the conservative defaults make generous.
- **Backlog cannot borrow idle live capacity.** When live is idle, backlog is
  still capped at its carve-out rather than expanding to fill the whole budget.
  This is intentional: it keeps backlog's footprint bounded and predictable, and
  backlog is best-effort. (A weighted scheme could let backlog borrow; deferred.)
- **Same base HTTP client, two wrappers.** The live and backlog clients differ
  only by the priority tag they pass to the shared limiters; they share the base
  client, cost tracker, and reasoning logger. This keeps the isolation purely at
  the limiter boundary, with no duplicated HTTP/cost/logging machinery.

## Future Extensions (out of scope now)

- **Gemini budget isolation.** Wire a backlog-tagged Gemini client (and the
  reservation-aware `geminiLimiter`) so the guarantee holds when translation
  roles use Gemini. The limiter class already gains the capability here; only the
  Gemini client wrapper and a `backlogLlmClients.gemini` variant would be added.
- **Weighted / borrowable backlog share** that expands to use idle live capacity
  and shrinks under live pressure.
- **Lazy background fill** of beyond-cap scrollback (Fix 1's Future Extension)
  naturally rides on this backlog lane once it exists.
- **Fix 3 (live-queue back-pressure)** composes with this to self-heal any
  residual standing queue.
