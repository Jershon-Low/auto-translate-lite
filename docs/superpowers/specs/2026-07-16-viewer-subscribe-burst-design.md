# Viewer Subscribe Burst — Design

## Purpose

Every viewer subscribe (`handleViewerConnection` in [wsServer.ts](../../../server/src/wsServer.ts)) calls `translateBacklog` + `verifyTranslations` against the *entire* visible backlog (up to the 10-minute `BUFFER_WINDOW_MS` window), from scratch, regardless of whether that language has already been translated for other viewers. Most of that work is redundant: when a language is already active, its lines were already translated and verified once, live, in `finishPublishing`, and that result is simply thrown away instead of reused.

This becomes a real problem at the start of a service, when many viewers open the page and subscribe within the same few seconds. Each one fires its own full-backlog translate + verify call to Gemini, all in the same short window — competing for Gemini's rate limit and stacking CPU/network load on the instance, independent of how many viewers the instance could otherwise comfortably hold (see prior discussion: viewer fan-out itself is cheap; this backlog-refill path is the actual bottleneck).

This design removes the redundant work at its source (a per-language translation cache, reused across subscribes) and adds a bounded concurrency limiter around all outbound Gemini calls as a generic safety net for whatever burst load remains.

## Scope

- A per-session, per-language cache of already-computed (and safety-resolved) line translations, populated for free as a side effect of the existing live-publish path, and consulted on every subscribe so only genuinely new lines/languages hit Gemini.
- In-flight request coalescing so multiple viewers subscribing to the same not-yet-cached language within the same instant produce one Gemini call, not one per viewer.
- A shared, fixed-concurrency limiter around every outbound Gemini call (`translateSegment`, `translateBacklog`, `verifyTranslations`), as a safety net independent of the caching fix.
- Explicitly out of scope: changes to the live segment-processing path's behavior or output (translation/verification results are unchanged, just reused); any change to Deepgram/session/viewer WebSocket protocols; persisting the cache beyond a single session; rate-limiting or throttling on the client/viewer side; a queueing UI or "please wait" state for viewers — the limiter only adds latency under genuine overload, which is preferable to failed requests.

## Design

### 1. `TranslationCache` (new, `server/src/translationCache.ts`)

```ts
export class TranslationCache {
  get(language: string, lineId: string): string | undefined
  set(language: string, lineId: string, translated: string): void
  clear(): void
}
```

Backed by `Map<string /* language */, Map<string /* lineId */, string /* resolved translated text */>>`. The cached value is whatever was actually shown to live viewers for that line — i.e. the post-verification `outgoing` value from `finishPublishing` (the real translation if `safe`, otherwise the English fallback) — so a cache hit is always exactly consistent with what viewers already saw live.

Owned by `Session` (`session.translationCache = new TranslationCache()`), alongside `buffer`. `Session.start()` assigns a **fresh** `TranslationCache` instance (`session.translationCache = new TranslationCache()`), rather than calling `.clear()` on the existing one — see Error Handling for why this matters (an in-flight fill from the just-stopped session must not be able to write into the new session's cache).

### 2. Populating the cache on live publish (`finishPublishing`, wsServer.ts)

Inside the existing per-language loop (wsServer.ts:192-208), after computing `outgoing`, add:

```ts
deps.session.translationCache.set(language, line.id, outgoing);
```

No new Gemini calls — this reuses a value already being computed and sent today.

### 3. Updating the cache on reinstate (`handleReinstate`, wsServer.ts)

`handleReinstate` already recomputes translations for a reinstated (edited) line and calls `finishPublishing`, which now writes fresh cache entries for that `line.id` as part of step 2 above — overwriting whatever (if anything) was cached before. No separate code path needed; this falls out of step 2 automatically since reinstate flows through `finishPublishing` too.

### 4. Cache-aware subscribe (`handleViewerConnection`, wsServer.ts)

Replace the current "translate the whole visible backlog" block with:

```
visibleEntries = backlog.filter(line => !line.suppressed)
missingEntries = visibleEntries.filter(line => cache.get(language, line.id) === undefined)

if missingEntries.length > 0:
  await ensureBacklogCached(language, missingEntries)   // see section 5

visibleLines = visibleEntries.map(line => ({
  id: line.id,
  english: line.english,
  translated: cache.get(language, line.id) ?? line.english,   // defensive fallback
}))
```

The existing verification step is gone from this path entirely for cache hits — verification already happened once, live, and its result is baked into the cached value. The final `lines` assembly (mapping suppressed entries to the `removed: true` placeholder) is unchanged.

### 5. Filling the gap, with in-flight coalescing (new helper in `wsServer.ts`, alongside `translateWithFallback`/`verifyTranslationsWithRetry`)

`Session` gains a second map, `inFlightFills: Map<string /* language */, Promise<void>>`, next to `translationCache`. The helper itself lives in `wsServer.ts` since it needs `deps.geminiClient` and `deps.session`, matching where the other Gemini-orchestration helpers (`translateWithFallback`, `verifyTranslationsWithRetry`) already live:

```
async function ensureBacklogCached(deps, language, missingEntries):
  cache = deps.session.translationCache
  fills = deps.session.inFlightFills

  existing = fills.get(language)
  if existing:
    await existing
    stillMissing = missingEntries.filter(line => cache.get(language, line.id) === undefined)
    if stillMissing.length === 0: return
    return ensureBacklogCached(deps, language, stillMissing)   // small follow-up batch, rare

  const fillPromise = (async () => {
    translations = await translateBacklog(deps.geminiClient, missingEntries.map(l => l.english), language)
    verificationItems = missingEntries
      .map((line, i) => ({ id: line.id, english: line.english, translated: translations[i] }))
      .filter(item => item.translated)
    verifications = await verifyTranslationsWithRetry(deps.geminiClient, verificationItems, deps.session.sermonCache)

    for (line, i) of missingEntries:
      translated = translations[i]
      safe = translated && verifications[line.id]?.safe === true
      cache.set(language, line.id, safe ? translated : line.english)
  })()

  fills.set(language, fillPromise)
  try { await fillPromise }
  finally { fills.delete(language) }
```

Concurrent subscribers to the same uncached language within the same window await the same `fillPromise` instead of each starting their own `translateBacklog`/`verifyTranslations` call. The recursive top-up after awaiting handles the (rare) case where a subscriber's missing set isn't fully covered by the in-flight batch (e.g. the buffer grew a line between the two subscribes) — normally `stillMissing` is empty and the recursion terminates immediately.

`inFlightFills` lives alongside `translationCache` on `Session` and is replaced with a fresh, empty `Map` in `Session.start()` for the same reason `translationCache` is replaced rather than cleared: a fill still in progress from the just-stopped session holds a reference to the *old* map and cache, so it can only ever resolve into objects the new session no longer uses.

### 6. `GeminiCallLimiter` (new, `server/src/geminiLimiter.ts`)

```ts
export class GeminiCallLimiter {
  constructor(maxConcurrent: number = 8)
  run<T>(fn: () => Promise<T>): Promise<T>
}
```

A minimal async semaphore: an internal counter and a FIFO queue of waiters. `run` waits for a free slot, invokes `fn`, and releases the slot in a `finally` (so a thrown/rejected call still frees its slot). No timeout, no rejection on saturation — callers simply queue.

One shared instance is constructed alongside the `GeminiClient` (wherever `createGeminiClient` is currently called, e.g. `index.ts`) and threaded down to `translateSegment`, `translateBacklog` (`gemini.ts`), and `verifyTranslations` (`translationVerifier.ts`) — each wraps its `client.models.generateContent(...)` call in `limiter.run(...)`. One shared limiter across all three call sites is deliberate: Gemini's account-level rate limit doesn't distinguish which function called it, so the cap must be shared, not per-function.

Default cap of **8** concurrent calls — comfortably above normal steady-state load (one live segment's translate+verify+transcription-check calls, i.e. 2-3 concurrent, plus occasional cache-fill calls), while bounding worst-case burst (e.g. several new languages activating in the same instant) instead of firing unbounded parallel requests at Gemini.

## Error Handling

- **Cache-fill failure** (Gemini error while filling `missingEntries`): identical fallback shape to today — `translateWithFallback`'s existing retry-without-sermon-cache pattern applies to `verifyTranslationsWithRetry` already; if translation itself fails, `ensureBacklogCached` should catch and treat all `missingEntries` as failed-safe (cache each as English fallback, same as `outgoing = line.english` in the live path), logged via the existing `logEvent('error', ...)` pattern, so a subscribe never hangs or throws on the client — worst case, that viewer briefly sees English for those lines until a later successful fill overwrites the cache.
- **Coalesced waiter whose fill ultimately failed**: since failures are cached as English fallback (not left empty), the recursive top-up in step 5 sees those ids as no-longer-missing and doesn't retry them for every waiter — avoiding a thundering-herd retry loop on a Gemini outage.
- **Limiter**: no new failure mode — a queued call can wait arbitrarily long only if calls ahead of it hang; existing Gemini call sites already have no explicit timeout today, so this doesn't change worst-case latency characteristics, only adds queueing before a call starts.
- **Session restart mid-fill**: an in-flight `fillPromise` from a stopped session may still resolve after `session.start()` has moved on to a new session. Because `Session.start()` replaces `translationCache` and `inFlightFills` with fresh instances rather than clearing them in place, that late-resolving promise's `cache.set(...)` calls land on the orphaned old instance, not the new session's cache — no stale or cross-session writes are possible.

## Testing

- **Unit (`translationCache.test.ts`)**: `set`/`get` roundtrip per `(language, lineId)`; `get` on an unset key returns `undefined`; `clear()` empties all languages; independent languages don't collide on the same `lineId`.
- **Unit (`geminiLimiter.test.ts`)**: up to `maxConcurrent` calls run immediately/concurrently; the `(maxConcurrent + 1)`th call doesn't start until one of the first `maxConcurrent` resolves; a rejected call still frees its slot for the next queued call.
- **Unit (`wsServer.test.ts`)**:
  - A second viewer subscribing to a language already active (already has live-published lines) triggers zero additional `translateBacklog`/`verifyTranslations` calls — assert the mocked Gemini client's call count is unchanged from before the second subscribe.
  - Two viewers subscribing to the same brand-new language at effectively the same time (both subscribe calls fired before either resolves) result in exactly one `translateBacklog` call and one `verifyTranslations` call, not two.
  - A viewer subscribing to a language after one prior line was reinstated-with-edits sees the corrected translation, not a stale cached one.
  - `finishPublishing` populates the cache for every active language on a normal live segment.
- **Manual (browser)**: start a session, let a few lines publish live with one viewer language active; open a second viewer tab in the same language and confirm the backlog renders instantly (no visible translate-on-subscribe delay); open a viewer in a brand-new language and confirm it still works (one-time delay for the fill), then open a third viewer in that same new language and confirm it's instant.

## Known Simplifications

- The cache lives only in memory for the lifetime of a `Session` — no persistence across a capture restart, consistent with `buffer` and `sermonCache` today.
- No cache eviction beyond the existing 10-minute backlog trim (`transcriptBuffer`'s `BUFFER_WINDOW_MS`) — cached entries for trimmed-out lines simply become unreachable (never looked up again) rather than being explicitly pruned; this matches the buffer's own trim-by-filter approach and avoids adding a second expiry mechanism to keep in sync.
- The concurrency limiter cap (8) is a fixed constant, not configurable via environment/config today — acceptable since this is a safety net, not a tuned production parameter; can become an env var later if real usage shows it needs adjusting.
- Coalescing is per-language only, not per-exact-missing-set — a second subscriber whose missing set is a strict subset of the first's still just waits for the whole in-flight batch rather than a more precise partial wait; acceptable since the two sets are almost always identical in the burst scenario this targets.

## Future Extensions (explicitly out of scope now)

- Making the limiter cap configurable.
- Persisting the translation cache across capture restarts (would require keying on more than session-local line ids).
- Precomputing translations for all viewer-selectable languages proactively (rather than lazily on first subscribe) to eliminate the first-viewer-per-language delay entirely.
