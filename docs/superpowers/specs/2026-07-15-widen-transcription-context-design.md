# Widen Preceding Context Window — Design

## Purpose

`handleFinalSegment` in [wsServer.ts](../../../server/src/wsServer.ts) computes one `precedingContext` array (currently the last 3 transcript lines) and passes it to both the transcription safety checker and the translator. In practice, 3 lines isn't enough: a multi-sentence rhetorical point (e.g. "It doesn't say I'll give you everything... period. There's a condition...") can read as a mis-heard negation when the checker only sees the tail end of the argument, even though the full run of thought makes the meaning clear. The transcript buffer already retains up to 10 minutes of history — the checker just wasn't being given enough of it.

## Scope

- Widen the shared preceding-context window from 3 lines to 7 lines, applied identically to both `verifyTranscription` (transcription safety check) and `translateSegment` (translation), since they already share one computed window.
- Extract the line count into a named constant rather than a bare magic number, since it's asserted directly in a test and is the kind of value likely to get tuned again later.
- Out of scope: changing `translateBacklog` (unaffected — it doesn't use a preceding-context window), changing how many lines the transcript buffer retains (10 minutes, already far more than 7 lines' worth), and any change to the transcription/translation prompt wording itself.

## Design

In `server/src/wsServer.ts`, add `const PRECEDING_CONTEXT_LINES = 7;` near the top of the file (alongside the existing top-level declarations), and change `handleFinalSegment`'s `recentLines.slice(-3)` to `recentLines.slice(-PRECEDING_CONTEXT_LINES)`. No other production code changes: `transcriptionVerifier.ts`'s and `gemini.ts`'s `buildContextBlock` functions already number and render however many lines they're given, with no hardcoded assumption about the count.

## Cost impact

Both `verifyTranscription` and `translateSegment` calls will carry roughly 2.3x more preceding-context text per call (3 → 7 lines). This is a small absolute increase (a handful of sentences), but applies to every segment on every session, including the transcription check, which already runs regardless of viewer count. No action needed beyond noting it — the live cost tracking feature already added will surface the real-world effect.

## Testing

- Update the existing `wsServer.test.ts` test "includes up to the last 3 preceding lines as translation context" to push 8 buffer lines (rather than 4) and assert only the last 7 appear in the translate call's `contents`, preserving the existing "drops the oldest line beyond the window" assertion shape.
- No new test files or new behaviors — this is a constant-value change to existing, already-tested code paths.
