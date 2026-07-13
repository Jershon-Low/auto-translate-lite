# Translation Context & Deepgram Segmentation — Design

## Purpose

Two related quality problems with live captions/translations, addressed together:

1. **No cross-sentence context.** `translateSegment` (the live, per-sentence translation path) translates each sentence in complete isolation, with no memory of what was said immediately before. This hurts pronoun resolution, recurring terminology, and tone continuity.
2. **Fragmented Deepgram segments.** The server currently treats every Deepgram `is_final: true` transcript event as a complete "line," but `is_final` just means a chunk of audio has been transcribed and won't be revised — it fires every second or two regardless of sentence structure. This produces one-word or mid-sentence fragments (e.g. "benefit" / "from it.") instead of full sentences, which degrades both the live transcript and the transcript buffer used for translation context.

These reinforce each other: fixing segmentation first means the "preceding sentences" context fed to Gemini is made of real sentences instead of arbitrary chunks.

## Scope

- Fixes segmentation at the source ([deepgram.ts](../../../.worktrees/auto-translate-lite/server/src/deepgram.ts)), so every downstream consumer (capture-page transcript, transcript buffer, live translation) benefits automatically.
- Adds preceding-sentence context to the **live** translation path only (`translateSegment`).
- Explicitly out of scope: `translateBacklog` (the on-demand catch-up path) is untouched — it already receives multiple lines in one batch call, which gives it cross-sentence context for free. `translationVerifier.ts` is untouched — it judges a single English/translated pair for faithfulness, which doesn't need history.

## Design

### 1. Deepgram segmentation fix

Deepgram's streaming API distinguishes:
- `is_final: true` — this chunk of transcript is locked in, but is not necessarily a complete utterance.
- `speech_final: true` — Deepgram's endpointing/VAD detected an actual pause; the utterance is considered complete.
- `UtteranceEnd` — a separate event (requires `interim_results: true`, already set, plus `utterance_end_ms` added to the connection config) that fires after a configurable silence gap, as a safety net for cases where `speech_final` doesn't fire cleanly.

`createDeepgramConnection` will accumulate transcript text from `is_final` chunks (joined with spaces) into a per-connection buffer, and only invoke `callbacks.onFinalSegment(...)` — the existing callback contract `wsServer.ts` already consumes — when one of these flush conditions is met:

- `speech_final: true` on a transcript event, or
- an `UtteranceEnd` event fires, or
- **5 seconds** have elapsed since the buffer started accumulating with no natural pause detected (safety-net force-flush, so an uninterrupted run-on sentence doesn't stall captions indefinitely)

On `finish()`, any text still sitting in the buffer is flushed as a final segment before the connection closes, so trailing words at the end of a session aren't silently dropped.

Following the existing pattern in [transcriptBuffer.ts](../../../.worktrees/auto-translate-lite/server/src/transcriptBuffer.ts) (pure logic takes `nowMs` as an explicit parameter rather than reading the clock itself), the accumulation state transitions stay a pure, unit-testable function; only the actual `setTimeout` scheduling for the 5-second safety net lives in `createDeepgramConnection` itself.

`onFinalSegment`'s contract to callers does not change — it fires with a complete sentence string, same as today, just on real utterance boundaries instead of arbitrary chunk boundaries. No changes needed in `wsServer.ts` for this part.

### 2. Preceding-sentence context for live translation

`translateSegment` (in [gemini.ts](../../../.worktrees/auto-translate-lite/server/src/gemini.ts)) gains a new parameter: `precedingContext: string[]`, defaulting to an empty array.

`wsServer.ts::handleFinalSegment` sources this from the session's existing rolling buffer (`session.buffer.getRecent()`), taking up to the **3 lines immediately preceding** the current one (the current line has already been appended to the buffer by this point, so it's excluded from the slice).

When `precedingContext` is non-empty, the prompt gains a clearly-delimited block instructing Gemini to use those lines as reference only, not as text to translate:

```
For context, here are the immediately preceding sentences from the same sermon (do not translate these — they're for reference only, e.g. to resolve pronouns or match terminology):
1. "..."
2. "..."
3. "..."

Now translate only this sentence: "..."
```

When `precedingContext` is empty (e.g. the first sentences of a session), the prompt is byte-for-byte what it is today — no behavior change for that case.

## Error Handling

No changes to existing error handling. `handleFinalSegment` keeps its retry-once-then-skip behavior for Gemini calls. If the transcript buffer has fewer than 3 prior lines (start of a session), whatever is available is used — no special-casing needed since it's just a slice.

## Testing

- **`deepgram.test.ts`**: multiple `is_final` chunks accumulate and join until `speech_final` triggers a flush; an `UtteranceEnd` event triggers a flush of whatever is buffered; the 5-second safety net force-flushes without a natural pause (fake timers); `finish()` flushes any remaining buffered text; existing `extractFinalTranscript` unit tests continue to pass or are folded into the new accumulator tests as appropriate.
- **`gemini.test.ts`**: the context block appears in the prompt when `precedingContext` is passed with content; the prompt is unchanged from current behavior when `precedingContext` is omitted or empty.
- **`wsServer.test.ts`**: the last-3-lines slice (excluding the current line) is correctly read from `session.buffer` and passed through to `translateSegment`.
- **Manual verification**: run against a recorded sermon clip with natural pauses and at least one long unbroken sentence (>5s), confirm caption lines are now full sentences rather than fragments, and confirm the 5-second safety net doesn't produce excessive caption delay in practice.

## Future Extensions (explicitly out of scope now)

- Punctuation-based early-flush heuristic (checking `smart_format` output for terminal punctuation) as an additional latency optimization on top of `speech_final`/`UtteranceEnd` — not needed unless the 5-second safety net proves too conservative in practice.
- Extending preceding-context to `translateBacklog` or `translationVerifier` — not needed today since batch translation already has implicit context and verification doesn't need history.
- Time-based (rather than fixed-count) context window for translation.
