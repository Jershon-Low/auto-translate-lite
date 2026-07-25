# Late Translation Correction — Design

## Purpose

[Fix 3](2026-07-23-live-queue-backpressure-design.md) added a **publish-side staleness deadline**: if a line's translate+verify work doesn't resolve within `MAX_PUBLISH_LAG_MS` (default 8000), the line is force-published in its already-verified English text and the late translation is **discarded**. That bounds caption lag, but it also means a shed line stays English permanently — for that viewer, for the rest of the session.

In practice this fires far more often than "occasional congestion" implies. A normal Gemini translation for this app runs **~3 s**, comfortably inside the deadline — but with the translation role's **thinking mode set to high**, calls routinely exceed 8 s, so *nearly every line* sheds. The observed production symptom is a steady stream of `caption_lag_shed` / `reason: "publish_deadline"` entries, with those lines never becoming translated.

The key observation: when the deadline fires, that line's translation is **still running, and will usually finish a few seconds later, already verified** — `prepareTranslationsForPublish` completes verification *before* its promise resolves, so by the time we could read the result it has already passed the translation safety check. Fix 3 throws that value away purely because it arrived late.

This design **stops discarding it**. A deadline-shed line is published in English as it is today, marked in the viewer as still-working, and then **upgraded in place** when its own translation lands. No new LLM calls are made — this is the same in-flight work, kept instead of abandoned.

The alternative fix — raising `MAX_PUBLISH_LAG_MS` to fit thinking-high — is strictly worse: it delays first paint for every line *and* still offers no upgrade path when a call overruns the larger deadline. Showing English quickly and upgrading it is the better trade.

### Hard constraints preserved

- **The transcription safety check is untouched.** It still runs on every line, and a flagged transcription still never reaches a viewer. This design only concerns lines that already passed it and were already published.
- **No unverified translation is ever published.** A correction carries only a `PreparedLanguageResult` produced by `prepareTranslationsForPublish`, which means translation-verification already ran on it. The correction path performs no verification of its own and has no way to bypass it.
- **Caption ordering is preserved.** A correction patches an existing line by `id`; it never appends, and it can never be delivered before the caption it corrects (see §3).

## Scope

- Retain and use the in-flight `preparedPromise` on the publish-deadline path instead of abandoning it.
- A new viewer message, `caption-corrected`, delivered **exactly once** per shed line — either carrying the real translation, or carrying nothing and meaning "settle as-is."
- A new client line state, `awaitingCorrection`, rendered through the **same visual treatment as the existing `caption-pending` state** (they are unified — see §6).
- A bounded correction window, `MAX_CORRECTION_LAG_MS` (default **30000**), governing only whether a *live* patch is pushed; the translation cache is updated regardless. `0` disables the feature entirely.
- Explicitly **out of scope**:
  - **Correcting ingest-shed lines.** Lines shed by `handleFinalSegmentFast`'s backpressure branch (`reason: "ingest_backpressure"`) never start a translation at all — that is the entire point of that path, which exists to *remove* LLM load during congestion. Giving them a correction requires a background re-translate subsystem (queue of owed lines, trigger condition, budget, cap). Named as a Future Extension, consistent with Fix 3's own parking of it.
  - Any change to the deadline itself, the ingest-side shed, the lag tracker, or `MAX_PUBLISH_LAG_MS`.
  - Any change to the transcription or translation safety checks.
  - Re-translating lines that fell back to English for any *other* reason (verify-failure, translate error, backlog cap). Those are unchanged and remain visually indistinguishable from settled translations — see Known Simplifications.

## Design

### 1. Retaining the in-flight translation (`raceAgainstDeadline`, wsServer.ts)

Today the deadline path attaches only a swallow-catch so the abandoned promise can't become an unhandled rejection:

```ts
void preparedPromise.catch(() => {});
```

That line stays (it still guards the early-return path), but on the deadline-shed path the promise is now also handed to a correction scheduler. `raceAgainstDeadline` gains one responsibility: when it decides to shed, it reports that decision upward so the caller can schedule the follow-up. Both shed sites (the `remaining <= 0` early return and the `DEADLINE_REACHED` race outcome) are treated identically.

The scheduler is only armed when corrections are enabled (`deps.maxCorrectionLagMs > 0`) and records `shedAt = Date.now()`.

### 2. The terminal correction message

**Every deadline-shed line receives exactly one `caption-corrected` message, addressed to exactly the languages that were marked `awaitingCorrection` at shed time.** This is the core invariant, and it is what makes the client need no timers: the waiting state always has a guaranteed exit, delivered by the server.

**The target language set is a shed-time snapshot, not a re-derivation.** When the deadline fires, `raceAgainstDeadline` builds `englishFallbackResults(line, deps)` from `deps.session.getActiveLanguages()` *at that moment* — this is exactly the set of languages `sendPrepared` marks `awaitingCorrection: true` for. That set (`markedLanguages`) is captured once and threaded through to the correction; it is **not** re-derived later from the late translation results. The two sets can differ in two reachable ways, and re-deriving from the late results handles neither:

- **A viewer joins a new language during the window.** The translate request was built from the languages active at *ingest* time; the shed-time snapshot, taken later, can include a language the request never covered. That language has no entry in the late results but is still owed a terminal message.
- **Translation fails entirely for the line.** `translateWithFallback` exhausts both attempts and resolves to `{}`, so the late results are `[]` — truthy, but empty. Deriving the target set from an empty array yields no languages to message at all, even though every marked viewer is still owed one.

Iterating the snapshot instead of the late results is what makes both cases resolve correctly: every marked viewer gets exactly one message regardless of what the late results contain.

The message carries an optional payload:

| Shape | Meaning | When |
|---|---|---|
| `{ type, id, translated, flagged?, reason? }` | Upgrade: replace the text | A matching language entry exists in the late results, the window hasn't expired, and the text differs from what was published |
| `{ type, id }` | Settle: leave the text, clear the waiting state | No matching entry, window expired, or the result is not an improvement |

A settle message is deliberately *not* a text rewrite, so letting the window expire never produces the on-screen churn the window exists to prevent — it only stops the line from being marked as still-working.

`scheduleCorrection` runs once per shed line (not independently per language):

1. **Waits for the line's own caption to have gone out.** It awaits `sendPromise` — the ordered-send link for this line (§3) — before doing anything else, so the correction can never precede the caption it patches.
2. **Races the retained translation against the *remaining* window**, not a post-hoc timestamp comparison: `remaining = maxCorrectionLagMs - (Date.now() - shedAt)`. Nothing in the translate/verify chain has its own timeout — an LLM call can hang outright, never resolving and never rejecting — so this race is what guarantees exactly one terminal message even then. A rejection is folded into the same race (caught to `null`) rather than left as a separate branch, so a failed translate/verify also resolves through this one path.
3. **Re-checks three guards** before sending anything: the session id still matches the one captured at arm time (no cross-session correction), `line.suppressed` is still `false` (not admin-removed mid-flight), and `line.english` still equals `shedEnglish` — the English text snapshotted when the correction was armed. The third guard exists because `TranscriptBuffer.reinstate` mutates the same `CaptionLine` object in place: an admin who removes and reinstates a line *with edited text* while its original correction is still in flight leaves `line.suppressed` back at `false` without changing the object's identity, so the suppression guard alone would miss it. Comparing the live English against the snapshot is what stops a stale translation of the superseded text from overwriting the edit — both in the pushed message and in the cache write.
4. **Sends via `sendCorrection`**, which writes the cache for every language present in the late results unconditionally (regardless of the window — this is what lets a later subscriber, reconnect, or language switch pick up the real translation even after a settle), then iterates `markedLanguages`: a language with a matching, differing, in-window result is an upgrade; every other marked language is a settle.
5. **If the window expired before the translation arrived**, the translation may still land afterward. A separate continuation off the same retained promise — guarded by the same three checks (session id, suppression, `shedEnglish`), re-evaluated at that later point — writes it into the cache when it does. It is never pushed live, since the terminal message has already gone out.

A correction whose text equals what was already published (e.g. verification flagged the late translation, so `prepareTranslationsForPublish` itself fell back to English) is sent as the settle form: there is nothing to upgrade, and the state must still be cleared.

One `caption_corrected` log event is emitted per line (not per language) at delivery — `outcome: 'upgrade' | 'settle'`, `reason` on settle distinguishing `window_expired` / `no_result` / `not_an_improvement`, and `lagMs`. This is the operational signal the feature exists to restore (see Purpose): without it, there is no way to tell whether corrections are landing, how long they take, or what fraction expire.

### 3. Ordering: the correction can never precede its own caption

A shed line's English publish goes through `enqueueOrderedSend`, which appends a link to the serial `session.publishQueue`. The retained translation can resolve **while that link is still queued behind other work** — so a correction sent as soon as it resolves could reach the viewer *before* the caption it is meant to patch. The client's `findIndex` would miss, and (with the existing `caption` handler's semantics) an append would fabricate an out-of-order line.

Fix: `enqueueOrderedSend` returns the promise for the link it appended, and the correction is chained off **that specific link**:

```ts
const sendPromise = deps.session.publishQueue.then(async () => { /* existing body */ });
deps.session.publishQueue = sendPromise;
return sendPromise;
```

Chaining off the whole `publishQueue` would also be correct, but it would delay an already-late correction behind unrelated later captions. Chaining off the line's own link guarantees "after this line was sent" and nothing more.

The correction is otherwise sent **out of band** (not appended to `publishQueue`). This is safe precisely because it patches by `id` rather than appending: it has no ordering relationship to captions published after it, and forcing it through the serial queue would only make it later.

### 4. Configuration

- New env var `MAX_CORRECTION_LAG_MS`, parsed in [index.ts](../../../server/src/index.ts), default **30000**, threaded through `WsServerDeps` as `maxCorrectionLagMs: number` exactly like `maxPublishLagMs`.
- Documented in `server/.env.example`.

**Why 30 s:** with thinking-high the common case is a shed at 8 s and a resolution 2–5 s later, so the window is a wide safety margin rather than a routine cutoff. It exists to bound the pathological case — a long congested stretch resolving all at once and repainting a screenful of captions simultaneously.

**`0` is the kill switch, and disables the feature at the source:** the server does not mark shed lines as awaiting, does not retain the promise, and sends no correction — behaviour reverts exactly to Fix 3. (Marking-then-immediately-settling would be worse than doing nothing: it would produce a highlight flash on every shed line.)

### 5. Client state (`useViewerSocket.ts`)

`CaptionLine` gains `awaitingCorrection?: boolean`. The shed `caption` message carries `awaitingCorrection: true`, handled the same way `flagged` already is in the existing `caption` / `caption-inserted` branch.

A new branch handles `caption-corrected`:

- Locate by `id`. **If not found, ignore it** — do not append. Correcting a line the viewer does not have is meaningless, and appending would invent an out-of-order line. (The existing append-if-missing behaviour is right for `caption`, which may legitimately be a line's first appearance; it is wrong here.)
- Clear `awaitingCorrection`.
- If `translated` is present, replace `translated` (and `flagged` / `reason`).

**The data stays split — only the look is unified.** `pending` and `awaitingCorrection` are distinct fields with distinct meanings and distinct clearing conditions (`pending` has `translated: ''`; `awaitingCorrection` has `translated === english`). Collapsing them into one field would break the PDF export, which renders `line.translated` directly ([exportTranscriptPdf.ts](../../../web/lib/exportTranscriptPdf.ts)), and would lose the server-derived record of which lines are owed a correction.

### 6. Unified waiting treatment (`web/app/view/page.tsx`)

Rendering derives a single state:

```ts
const awaiting = line.pending || line.awaitingCorrection;
```

**Why unify.** During `caption-pending` the large text is `line.english`. After a deadline shed, the `caption` arrives with `translated === english` — *the same string*. At the moment of the shed, nothing changes on screen. Rendering the two states differently would introduce a visible transition at the exact instant the viewer experiences no change, leaking an internal 8-second timer into the UI. Unifying deletes that artifact. The distinction is real for the server (it decides whether a correction is owed) but has no viewer-facing meaning: same text, same significance, same exit condition.

The three existing `line.pending` checks become `awaiting`, which also delivers two behaviours for free:

- The small grey English duplicate stays hidden (a shed line currently renders its English *twice*, small-grey and large, because `english === translated`).
- The feedback flag button stays hidden — viewers should not be asked to report a translation that isn't final.

**Treatment: a left accent rule.**

- The row carries `border-l-2 pl-3` **at all times**, switching only colour: `border-transparent` when settled, `border-amber-500` when awaiting. Constant geometry means clearing the highlight causes **zero layout shift**, and the row's existing `transition-colors` animates the colour change for free.
- Because the border sits outside the padding box, wrapped lines all align to the same left edge and text can never flow underneath the marker — hanging-indent behaviour, structurally rather than by special-casing.
- Awaiting text renders one step smaller (`text-lg sm:text-xl`) than settled text (`text-xl sm:text-2xl`), at **full contrast**. Today's `italic text-muted-foreground/60` is dropped.

**Why full contrast, smaller.** Dimming was acceptable for a state that resolved in well under a second. Under this design the waiting state routinely persists for seconds and may persist up to the correction window, and low-contrast text is the wrong treatment for words a non-English speaker is stuck reading for that long. Rendering it slightly smaller achieves the same de-emphasis — settled translations stay visually primary, the English placeholder reads as secondary — without sacrificing legibility.

**No pulsing indicator.** An animated marker was considered and rejected: once the states are unified, this treatment fires on *every* line at every line's birth, so a motion cue would be constant across the entire feed while its benefit lands only on the minority of lines that actually wait a long time.

## Error Handling

- **Retained promise rejects** (translation or verification ultimately failed after its retry): folded into the same window-bound race as a success (caught to `null`), so it resolves through the same path as a window expiry — the settle form is sent, the waiting state clears, and the line keeps its English text.
- **Retained promise hangs** (an LLM call that never resolves and never rejects — nothing in the translate/verify chain has its own timeout): the correction window is the only thing that can rescue the viewer. `scheduleCorrection` races the retained promise against the *remaining* window measured from `shedAt`, so a hung call still produces exactly one settle once the window elapses rather than leaving the waiting state stuck forever.
- **The existing swallow-catch is retained** on `preparedPromise` so no path can produce an unhandled rejection, including when corrections are disabled and the promise is genuinely abandoned.
- **The scheduler's own body throws** (not expected in practice — a ws socket's `send()` only throws synchronously for a `CONNECTING` socket, and viewers are only ever registered once `OPEN` — but guarded on principle): logged as `correction_failed` rather than silently swallowed. This matters because the scheduler runs off `session.publishQueue`; an unnoticed throw here would otherwise silently kill every subsequent line's correction with no trace.
- **Line suppressed mid-flight:** no correction is sent (§2, guard 3 of `scheduleCorrection`). `line-removed` has already replaced the line on the viewer.
- **Line suppressed and reinstated with edited text mid-flight:** also no correction is sent, and the cache is not overwritten with the stale translation. Because `TranscriptBuffer.reinstate` mutates the same `CaptionLine` object, `line.suppressed` alone would read `false` again after such a reinstate and miss this case; the correction path additionally compares the line's current English against `shedEnglish`, the text it was actually shed with, and bails when they no longer match.
- **Session stopped / restarted before resolution:** the correction is dropped. The scheduler captures the session id at shed time and does not send if it no longer matches, so a correction from a previous session can never patch a line in a new one.
- **Viewer disconnected:** `getViewersForLanguage` simply returns no sockets for that language; the cache write has already happened, so a reconnect gets the corrected text via backlog.
- **A viewer joins a new language during the correction window:** the shed-time snapshot (§2) marks them `awaitingCorrection` because `getActiveLanguages()` is re-read at shed time, but the translate request itself was built from the languages active at *ingest*, so the late results never contain an entry for the new language. They still receive exactly one terminal message — a settle — because the correction iterates the shed-time snapshot rather than the late results.
- **Translation fails entirely for the line:** the late results resolve to `[]` — truthy, but with no entry for any language. Every marked viewer still receives exactly one settle, for the same reason as above.
- **Viewer's language changed between shed and correction:** the correction is only sent for the languages marked at shed time (§2), so a viewer now on a different language receives no terminal message for that line — but this cannot strand them in the waiting state. Switching language re-sends `subscribe`, and the resulting `backlog` message **replaces the entire line list** (`setLines(message.lines)`), and backlog lines carry no `awaitingCorrection`. The waiting state is therefore cleared by the switch itself. This is the one path where the "exactly one terminal message" invariant is satisfied by a backlog reset rather than by a `caption-corrected`, and it is why the client must never treat a missing correction as a state it has to time out of.
- **Unknown `id` at the client:** ignored, never appended (§5).

## Testing

**Server (`wsServer.test.ts`)**, with a small `maxPublishLagMs` and a translate mock slower than it:

- A deadline-shed line is followed by exactly one `caption-corrected` carrying the real translation, and the viewer's caption text is upgraded.
- The correction **never arrives before** that line's own `caption` — assert message order at the viewer even when the publish queue has other work queued ahead.
- When the correction window has expired, the cache is still updated (a fresh subscriber's backlog carries the real translation) but the pushed message is the **settle** form with no `translated`.
- Corrections disabled (`maxCorrectionLagMs: 0`): the shed caption carries no `awaitingCorrection`, and no `caption-corrected` is ever sent.
- A line admin-removed after shed but before resolution receives **no** correction.
- A late translation that verification flags is delivered as the settle form, never as flagged translated text reaching the viewer in `hide` mode.
- **Exactly one terminal message per shed line** — no line is left in the waiting state (the invariant that replaces client-side timers).
- **A viewer who joins a new language during the correction window is not stranded**: two viewers on different languages, where the late results contain a translation for only one — both receive a terminal message (one upgrade, one settle).
- **Translation failing entirely for the line still settles every marked viewer**, not zero: an empty-but-truthy late results array must not collapse the target language set.
- **A stale correction cannot overwrite an admin's edit**: a line shed, then admin-removed and reinstated with different text while the original correction is still in flight, never receives a `caption-corrected` carrying a translation of the superseded English, and the cache under that id is never overwritten with it either.
- **A hung translation** (never resolves, never rejects) still settles once the correction window itself elapses.

**Client (`useViewerSocket`)**:

- `caption-corrected` patches by id, clears `awaitingCorrection`, replaces `translated`.
- `caption-corrected` for an unknown id is ignored and does **not** append.
- `awaiting` is true across the whole `caption-pending` → shed `caption` → `caption-corrected` sequence, with no gap (the shed caption must not momentarily clear it).

**Manual (browser):** run a session with the translation role on thinking-high so most lines shed; confirm captions appear promptly in English with the rule, upgrade in place a few seconds later, and that the rule clears on every line with none left marked.

## Known Simplifications

- **A viewer who joins between a shed and its correction sees no rule.** Backlog lines carry no awaiting state, so the line arrives looking settled and then silently updates when the correction lands. Carrying awaiting state through the backlog would require tracking owed corrections in session state; not worth it for a sub-30 s window.
- **Only deadline-shed lines are ever corrected.** A line that is English for any other reason (ingest shed, verify failure, translate error, backlog cap) is visually identical to a real translation, exactly as today. The rule means "still working," not "this is untranslated" — deliberately, since marking the latter honestly would have to include verifier-rejected lines and would make the safety filter's decisions visible to viewers, which `hide` mode exists to prevent.
- **Corrections reflow the feed.** Swapping English for a translation rewraps the line, and the size step adds to it. A correction to a line above the viewport therefore shifts scroll position for someone reading back; browser scroll anchoring absorbs most of this. At thinking-high shed rates this happens continuously, so it is a characteristic of the feature rather than an edge case. The correction window bounds the worst case (a long stretch resolving at once).
- **The PDF export still renders a shed line's English twice** (small grey + large), and a pending line's translation as empty. Both are pre-existing, live in a different surface, and are unchanged here.

## Future Extensions (out of scope now)

- **Lazy re-translate for ingest-shed lines**, giving every shed line a correction rather than only deadline-shed ones. Needs a queue of owed lines, a trigger (idle / caught-up), a budget to spend from — naturally Fix 2's isolated backlog budget — and a cap. Deliberately separate: it re-introduces LLM load on the one path that exists to shed it, and its scheduling policy deserves its own review.
- **Suppressing the size step** if the reflow proves distracting in the room, keeping the rule as the only signal.
- **A delayed motion cue** on lines that have waited past some threshold, if "still working" proves insufficiently legible from the rule alone.
