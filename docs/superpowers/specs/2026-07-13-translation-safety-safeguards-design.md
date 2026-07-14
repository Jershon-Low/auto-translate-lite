# Translation Safety Safeguards — Design

## Context

Auto Translate Lite pipes live sermon speech through Deepgram (English STT) into Gemini (`translateSegment`) and pushes the result straight to viewer WebSocket connections with no accuracy check beyond a plain retry-on-API-failure. A single bad model output can go live with nobody able to catch it, which is unacceptable for theological content.

This spec adds safeguards to reduce the chance of a meaning-inverting or theologically damaging mistranslation reaching viewers, given two hard constraints:

- **No human moderator.** The stream runs fully unattended — nobody is watching translated output live, so safeguards must be fully automated end-to-end.
- **Latency budget:** the existing single Gemini call (translate) may be extended with roughly one additional Gemini round-trip, but not more.

The church is Australian, and sermons include Australian slang, idioms, and jokes (e.g. "no worries," "arvo," "having a go," dry understatement). This needs to be reflected in the translation prompt so idiomatic phrasing isn't flattened or literally mistranslated — and the safety check below needs to know about it too, so it doesn't mistake correct idiomatic translation for a meaning change.

## Approach

Two layers, adding at most one extra Gemini call per segment:

1. **Hardened translate prompt** (existing call, no added latency) — explicit instructions to preserve polarity/negation, avoid misrepresenting God/Jesus/the Holy Spirit, translate literally when unsure, and correctly handle Australian slang/idiom/humor for intended meaning rather than literal wording.
2. **Independent verifier call** (one new Gemini call, batched across every active language in a single request) — given the English source and all candidate translations, checks each one for polarity flips, sentiment inversion, or misrepresentation of who God/Jesus is or does. This is a genuinely separate judgment call (source + candidate in, pass/fail + reason out), not the same model grading its own translation in the same breath.

Any language that fails verification — or where the verifier call itself errors out — falls back to displaying the plain English line instead of a translation, and the incident is logged for the team to review after the service.

### Alternatives considered

- **Prompt-only hardening, no verifier:** cheapest, but leaves a single unchecked model call as the only thing standing between spoken English and a viewer's screen — the same failure mode as the incident that motivated this work. Rejected.
- **Deterministic glossary of pinned phrases** (e.g. "Jesus loves you" → fixed reference translation, bypassing the model): considered, but rejected as unnecessary upkeep once the verifier call is in place — the verifier plus hardened prompt is expected to catch the same class of error without a glossary to maintain across 12 languages.
- **Full back-translation (translate → translate back to English → compare) per language:** most thorough, but costs two extra calls per language rather than one batched call total, well outside the latency budget. Rejected.

## Components

### 1. Hardened translate prompt (`server/src/gemini.ts`)

Extend the prompt used in `translateSegment` (and `translateBacklog`) with:

- This is a live Australian church sermon; expect Australian slang, idioms, self-deprecating humor, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she'll be right," "having a go"). Translate for the speaker's intended meaning and tone, not word-for-word — but don't let idiomatic phrasing get flattened into something overly formal, or literally mistranslated into an unrelated meaning.
- Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa.
- Don't add, remove, or reinterpret theological meaning. When unsure, translate literally rather than paraphrasing.
- Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.

No schema change — this only changes the prompt text.

### 2. Verifier module (new `server/src/translationVerifier.ts`)

```ts
export interface VerificationResult {
  safe: boolean;
  reason: string;
}

export async function verifyTranslations(
  client: GeminiClient,
  englishText: string,
  translations: Record<string, string>
): Promise<Record<string, VerificationResult>>
```

- Single Gemini call, batched across every language code present in `translations`.
- Prompt gives the English source and all candidate translations, and asks: does each translation preserve the original's meaning and polarity, and does it avoid misrepresenting who God/Jesus/the Holy Spirit is or does? Explicitly notes that idiomatic, non-literal renderings of slang/jokes are expected and fine — only flag genuine polarity flips, sentiment inversions, or theological misrepresentation, not stylistic looseness.
- JSON schema: `{ [langCode]: { safe: boolean, reason: string } }`, `required` on every language code passed in, mirroring the pattern already used in `translateSegment`.
- If the call throws, the caller treats it as "unverified" for every language (see below) rather than retrying indefinitely — one retry, same pattern as the existing `translateSegment` retry in `wsServer.ts`.

### 3. Integration (`server/src/wsServer.ts`)

**`handleFinalSegment`** (live captions): after `translateSegment` returns, call `verifyTranslations` with the same English text and the returned translations.

- For each language: if `safe` is `false`, or the verifier call failed after its retry, replace `translated` with the plain English line before sending to viewers of that language.
- Log every fallback via `console.warn` with structured JSON: `{ event: 'translation_fallback', timestamp, language, english, discardedTranslation, reason }`. This is picked up by pm2's existing log capture (`ecosystem.config.js`) for post-service review — no live monitoring required.

**`translateBacklog`** (join-time history for new viewers): same treatment. After translating the backlog for a joining viewer's language, verify each line (batched in one call covering the whole backlog for that language) and fall back individual lines to English on failure, with the same logging.

### 4. Error handling

- Verifier call fails twice (initial + one retry): treat as unverified, fall back to English for every language in that segment. Fail-safe, not fail-open — an unverified translation is never trusted by default.
- Existing `translateSegment` failure handling (retry-once, skip segment on repeated failure) is unchanged.

## Testing

- `translationVerifier.test.ts` (new): unit tests against the mockable `GeminiClient` interface (same pattern as `gemini.test.ts`) covering:
  - A translation flagged unsafe by the mock verifier response.
  - A translation the mock marks safe.
  - Verifier call throwing → treated as unverified.
- `gemini.test.ts`: extend to assert the hardened prompt text includes the Australian slang/idiom context and the polarity-preservation instruction (string-contains assertions, consistent with existing prompt tests).
- `wsServer.test.ts`: extend `handleFinalSegment` coverage with a case where the verifier flags one of several active languages — assert that language's viewers receive the English fallback while other languages still receive their translation, and that a `console.warn` fallback log fires.
