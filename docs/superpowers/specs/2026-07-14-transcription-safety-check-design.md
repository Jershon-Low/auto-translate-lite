# Transcription Safety Check (Christianity Misrepresentation) — Design

## Purpose

The existing safety net ([`translationVerifier.ts`](../../../.worktrees/auto-translate-lite/server/src/translationVerifier.ts)) only checks *translations* against their English source for polarity inversion and misrepresentation. It assumes the English transcript itself is trustworthy. It isn't: Deepgram speech-to-text occasionally mishears a word — dropping or inserting a negation, mishearing a name — and can produce an English line that confidently states something false about God, Jesus, the Holy Spirit, or core Christian belief, even though the preacher said something correct. That bad line then gets translated and verified as if it were ground truth, because the verifier only ever compares translation-to-English, never English-to-reality.

This design adds a second, independent Gemini check on the **English transcript line itself**, before translation, to catch this failure mode.

## Scope

- New Gemini call that checks a single finalized English transcript line for confident misrepresentation of God/Jesus/Holy Spirit/core Christian belief, framed around STT mishearing rather than judging sermon content generally.
- Runs on **every** finalized segment for the whole session, independent of whether any viewer is currently connected — not gated by active languages like translation/verification are today.
- Flagged lines are suppressed entirely: never appended to the transcript buffer (so they can never leak into a future viewer's backlog), never broadcast to any viewer. The AV operator's capture-page transcript feed still receives them, marked as flagged, for operational awareness.
- Explicitly out of scope: judging the preacher's actual (correctly transcribed) words as theologically controversial — this only targets transcription errors. Generic content moderation (profanity, off-topic remarks, PII) is not part of this check.

## Design

### 1. New module: `transcriptionVerifier.ts`

Mirrors the existing `translationVerifier.ts` file, as a separate concern from translation-pair safety:

```ts
export interface TranscriptionCheckResult {
  safe: boolean;
  reason: string;
}

export async function verifyTranscription(
  client: GeminiClient,
  english: string,
  precedingContext: string[],
  sermonCache: SermonCacheRef | null
): Promise<TranscriptionCheckResult>
```

One call per finalized segment — there's a single English line to judge, not a set of language pairs, so this isn't batched the way `verifyTranslations` batches languages into one structured-JSON call. Uses the same `gemini-3.1-flash-lite` model and (when available) the session's `sermonCache`, consistent with the other two Gemini calls in the pipeline.

**Prompt framing:** told this line was auto-transcribed live from an Australian church sermon and that speech-to-text occasionally mishears words (drops/inserts a "not", mishears a name); asked whether the line, taken at face value, confidently states something false about God, Jesus, the Holy Spirit, or core Christian belief. Same idiom-aware guardrail as the existing verifier — Australian slang/dry humor/informal phrasing is not itself a red flag. Takes `precedingContext` (the last 2–3 prior lines) so it isn't judging a sentence stripped of context.

### 2. Integration into `wsServer.ts` — `handleFinalSegment`

Today's flow is: append to buffer → return early if no active viewers → translate → verify → broadcast. This changes to:

```
compute precedingContext from the buffer (before appending the new line)
run in parallel:
  - verifyTranscriptionWithRetry(english, precedingContext, sermonCache)   [always runs]
  - translateSegment(...)   [only if activeLanguages.length > 0, otherwise skipped]
await both

if transcription check is unsafe:
  log 'transcription_flagged' { english, reason }
  send { type: 'transcript', english, flagged: true, reason } to the capture socket
  return   // not appended to buffer; nothing broadcast to any viewer

// safe path — unchanged from today onward:
append to buffer
send { type: 'transcript', english } to the capture socket
if activeLanguages.length === 0: return
verify translations (existing verifyTranslationsWithRetry) → broadcast per language
```

`verifyTranscriptionWithRetry` follows the same fail-safe pattern as `verifyTranslationsWithRetry`: try with `sermonCache`, on failure retry once without it, and if that also fails, treat the line as **unsafe** (suppress it) rather than assuming safe — consistent with the app's existing "fail-safe fallback, not fail-open" posture.

**Why suppression must happen before the buffer append, and must run even with zero active viewers:** the transcript buffer is exactly what gets replayed as "backlog" the next time any viewer subscribes to any language. If the check only ran while viewers were already connected, a bad line spoken before anyone joined (e.g. during an opening prayer) could sit unchecked in the buffer and surface later in someone's backlog. Running the check on every segment, before it ever reaches the buffer, guarantees a flagged line never reaches a viewer — live or backlog, in any language, ever.

**Capture page behavior:** the AV operator's own transcript view still receives flagged lines (with `flagged: true` and the reason), so the operator has visibility into what's being caught — this is the one place suppression doesn't apply, by design, since it never reaches a congregation member either way.

### 3. Logging

New structured log event `transcription_flagged` (fields: `english`, `reason`), following the same audit pattern as the existing `translation_fallback` event, so flagged lines are reviewable after a service alongside existing mistranslation logs.

## Error Handling

Same "retry once, then fail safe" pattern used elsewhere in the app:

- Gemini call fails with `sermonCache` → retry once without it.
- Retry also fails → treat as unsafe, suppress the line, log `transcription_flagged` with a generic "verification unavailable" reason (mirrors how `verifyTranslationsWithRetry` degrades today).
- This means a Gemini outage causes segments to be silently dropped rather than shown — an intentional tradeoff, consistent with the existing translation-verification failure mode (a segment whose translation can't be verified is also dropped/falls back rather than shown unchecked).

## Cost Impact

This call is **not** viewer-gated like `translateSegment`/`verifyTranslations` — it runs for every finalized sentence of the entire session, including stretches with zero connected viewers (worship, announcements before anyone's joined, etc.). This is a real increase in Gemini call volume beyond what the current README cost analysis models, which assumes translation-related calls scale with active viewer/language count. Updating the README's cost table with this as a third, viewer-count-independent cost line is deferred to the implementation plan rather than computed here.

## Testing

- **Unit** (`transcriptionVerifier.test.ts`, mirroring `translationVerifier.test.ts`): mocked `GeminiClient`, asserts prompt content/schema shape, cache passthrough, and the retry-then-fail-safe sequence on repeated failures.
- **Unit** (`wsServer.test.ts` additions):
  - Flagged line → not appended to buffer, no broadcast to any viewer/language, capture socket receives the transcript event with `flagged: true`.
  - Safe line → behavior unchanged from today.
  - Segment finalized while `activeLanguages.length === 0` → transcription check still runs and can still suppress a line from ever entering the buffer.
- **Out of scope**: whether the check actually catches real STT-mishearing cases in practice — that's model behavior, same caveat the existing test suite already applies to Deepgram/Gemini quality.

## Future Extensions (explicitly out of scope now)

- Broadening the check beyond Christianity-misrepresentation to general content moderation (profanity, off-topic, PII).
- Judging correctly-transcribed sermon content itself as controversial, rather than only targeting transcription errors.
- Surfacing flagged-line history in a UI rather than only structured server logs.
