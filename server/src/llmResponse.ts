// An LLM call that comes back with no content is a *failure*, not an empty
// result — and every provider entry point used to paper over it with
// `?? '{}'`, turning it into a successful parse of an empty object.
//
// Callers then read that as "none of the keys I asked for came back": the
// translate path dropped every requested language via
// prepareTranslationsForPublish's `if (!translated) continue`, so a viewer
// silently got English with no red flag, no retry, and nothing in the log. The
// 2026-07-26 report of Japanese/Korean lines arriving untranslated traced back
// to exactly this, and was invisible in events.log for the same reason.
//
// Throwing instead routes an empty body into the retry-then-log paths that
// already exist in wsServer (translateWithFallback,
// verifyTranslationsWithRetry, verifyTranscriptionWithRetry) — all of which
// swallow the error after logging, so this never escapes to a caller.
//
// The message deliberately avoids the word "cache": isCacheRelatedError
// matches /cache/i to decide whether to drop a role's context cache for the
// rest of the session, and an empty response says nothing about the cache.
export function parseLlmJson(content: string | null | undefined, role: string): unknown {
  if (content === null || content === undefined || content.trim().length === 0) {
    throw new Error(`empty ${role} response`);
  }
  return JSON.parse(content);
}
