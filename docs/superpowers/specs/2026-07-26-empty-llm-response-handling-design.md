# Empty LLM responses must fail, not resolve empty

Status: implemented, 2026-07-26.

## Report

Viewers on Japanese or Korean intermittently saw the English line where the
translation should be — the small grey English original *and* the large caption
both in English, no red flag. Scattered single lines, random mid-service, not
correlated with joining. Nothing in `events.log` marked those lines: they
recorded as ordinary successful captions.

## Cause

Every provider entry point coerced a missing response body into an empty object:

```
openRouterProvider.ts:137,153  JSON.parse(response.choices[0]?.message.content ?? '{}')
gemini.ts:76                   JSON.parse(response.text ?? '{}')
gemini.ts:106                  JSON.parse(response.text ?? '{"translations":[]}')
translationVerifier.ts:59      JSON.parse(response.text ?? '{}')
transcriptionVerifier.ts:47    JSON.parse(response.text ?? '{}')
```

`OpenRouterChatCompletionResponse` declares `content: string | null`, so a null
body is an expected shape, not an exotic one. Because `?? '{}'` produced a
successful parse, no exception was thrown, the retry-then-log paths in wsServer
(`translateWithFallback`, `verifyTranslationsWithRetry`,
`verifyTranscriptionWithRetry`) never fired, and nothing was logged.

Downstream, `prepareTranslationsForPublish` read the empty object as "none of
the requested languages came back" and did `if (!translated) continue`, dropping
the language with no record.

Likely trigger for ja/ko specifically: translation runs at `reasoning: "high"`
with no `max_tokens` set, and those two languages produce the longest
deliberation (honorifics, politeness levels). A null `content` from a reasoning
model typically means the response ended with the budget spent on reasoning.
Unproven — `finish_reason` is not currently captured.

### Two distinct viewer outcomes

The empty response produced different symptoms depending on its timing relative
to the publish deadline:

- **Slow empty response** (what was reported). The deadline fired first,
  `englishFallbackResults` published English to every active language with
  `awaitingCorrection`, then the correction found no result for that language,
  sent a bare `caption-corrected`, and the amber state cleared leaving English.
  Grey English + big English, no red.
- **Fast empty response** (found while writing tests). The empty
  `PreparedLanguageResult[]` won the deadline race, so `sendPrepared` iterated
  nothing, sent nothing, and — because `shedAt` was null — owed no correction.
  The viewer was stranded on the pending line permanently, with no terminal
  message ever arriving.

The second is strictly worse and was never reported, presumably because
translation is slow enough in production (792 of 792 lines hit the deadline in
the 2026-07-26 05:27 session) that the first path dominates.

## Design

**`parseLlmJson(content, role)`** (`llmResponse.ts`) replaces all six sites. It
throws on null, undefined, empty, or whitespace-only bodies, naming the role.
The existing retry-then-log paths then handle it and still swallow the error, so
nothing escapes to a caller. The message deliberately omits the word "cache" —
`isCacheRelatedError` matches `/cache/i` to decide whether to drop a role's
context cache for the session, and an empty body says nothing about the cache.

**English fallback for a missing language.** `prepareTranslationsForPublish` now
emits a result for every active language, falling back to `line.english` when
the model omitted one, so each language always receives exactly one caption.
This is the same outcome a failed verification already produces.

**Placeholders are not cached.** Those fallback results carry
`untranslated: true`, and both `sendPrepared` and `cacheCorrectedTranslations`
skip caching them. Caching English would make `selectBacklogEntriesToTranslate`
treat the line as already done, so a viewer joining later would be served the
placeholder forever instead of getting a real translation through
`ensureBacklogCached`. An existing test pinned this invariant and caught the
regression when the first version of this change cached them.

**Per-language correction outcomes.** `sendCorrection` returned a single
`hasUpgrade` boolean OR'd across languages, so a line that upgraded for Spanish
but never translated for Japanese logged as a clean `upgrade`. It now returns
`{ upgraded, settled }`, and `caption_corrected` carries `settledLanguages`
whenever a line upgraded for some languages but not others.

## Observability added

- `translation_missing_language` — names the omitted languages and what the
  model did return. One entry per line, not per language.
- `settledLanguages` on `caption_corrected` — the partial-failure case that was
  previously indistinguishable from success.
- `translation_failed` / `verification_failed` /
  `transcription_verification_failed` now actually fire for empty responses;
  before, they only fired on thrown errors.

## Not done

Setting an explicit `max_tokens` and logging `finish_reason` would confirm the
ja/ko hypothesis rather than leaving it inferred. `finish_reason` is not in
`OpenRouterChatCompletionResponse` today.
