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

**Every deadline-shed line receives exactly one `caption-corrected` message.** This is the core invariant, and it is what makes the client need no timers: the waiting state always has a guaranteed exit, delivered by the server.

The message carries an optional payload:

| Shape | Meaning | When |
|---|---|---|
| `{ type, id, translated, flagged?, reason? }` | Upgrade: replace the text | Translation resolved within the window |
| `{ type, id }` | Settle: leave the text, clear the waiting state | Window expired, translation failed, or the result is not an improvement |

A settle message is deliberately *not* a text rewrite, so letting the window expire never produces the on-screen churn the window exists to prevent — it only stops the line from being marked as still-working.

Per-language, once the retained promise resolves to `PreparedLanguageResult[]`:

1. **Write the cache unconditionally.** `session.translationCache.set(language, line.id, ...)` with the real result, regardless of the window. This costs nothing and means any viewer who joins, reconnects, or switches language afterwards receives the real translation via the normal backlog path.
2. **Decide whether to push.** If `Date.now() - shedAt <= deps.maxCorrectionLagMs`, send the upgrade to `getViewersForLanguage(language)`. Otherwise send the settle form.
3. **Suppression re-check.** If `line.suppressed` is true at resolution time (admin-removed while the translation was still running), send nothing — the viewer already received `line-removed` for it, and the line no longer exists on their screen.

A correction whose text equals what was already published (e.g. verification flagged the late translation, so `prepareTranslationsForPublish` itself fell back to English) is sent as the settle form: there is nothing to upgrade, and the state must still be cleared.

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

- **Retained promise rejects** (translation or verification ultimately failed after its retry): send the settle form so the waiting state clears. The line keeps its English text, which is the same outcome as today.
- **The existing swallow-catch is retained** so no path can produce an unhandled rejection, including when corrections are disabled and the promise is genuinely abandoned.
- **Line suppressed mid-flight:** no correction is sent (§2.3). `line-removed` has already replaced the line on the viewer.
- **Session stopped / restarted before resolution:** the correction is dropped. The scheduler captures the session id at shed time and does not send if it no longer matches, so a correction from a previous session can never patch a line in a new one.
- **Viewer disconnected:** `getViewersForLanguage` simply returns no sockets for that language; the cache write has already happened, so a reconnect gets the corrected text via backlog.
- **Viewer's language changed between shed and correction:** the correction is only sent for the languages present in the resolved result, so a viewer now on a different language receives no terminal message for that line — but this cannot strand them in the waiting state. Switching language re-sends `subscribe`, and the resulting `backlog` message **replaces the entire line list** (`setLines(message.lines)`), and backlog lines carry no `awaitingCorrection`. The waiting state is therefore cleared by the switch itself. This is the one path where the "exactly one terminal message" invariant is satisfied by a backlog reset rather than by a `caption-corrected`, and it is why the client must never treat a missing correction as a state it has to time out of.
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
