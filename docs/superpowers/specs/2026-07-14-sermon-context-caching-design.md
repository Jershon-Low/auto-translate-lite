# Sermon & Feedback Context via Explicit Caching — Design

## Purpose

Today, `translateSegment` and `translationVerifier.ts` only know about the current sentence plus a short rolling window of preceding sentences ([2026-07-13-translation-context-and-segmentation-design.md](2026-07-13-translation-context-and-segmentation-design.md)). They have no visibility into:

- **This week's sermon content** — scripture references, proper nouns, series titles, guest speaker names — things Gemini can't infer from audio alone.
- **Accumulated accuracy feedback** — recurring mistakes noticed across past sessions (e.g. a name left untranslated) that keep recurring because nothing tells Gemini about them.

This design adds both as session-scoped context, using Gemini's **explicit context caching** so the cost of resending that context on every call doesn't dominate the app's operating cost.

## Scope

- Adds a required sermon-document upload (PDF/Word) to the capture page, extracted to plain text server-side.
- Adds an optional, standing feedback-notes file, editable in-browser from the capture page (no SSH needed).
- Wires both into a single per-session Gemini cache shared by `translateSegment` and `verifyTranslations`.
- Explicitly out of scope (deferred, see Future Extensions): auth/access control on the capture page and its new feedback-editing endpoint; deterministic glossary substitution as a hard-coded fallback; persisting the sermon document beyond a session.

## Design

### 1. Sermon document upload & extraction

- Capture page gains a **required** file input (`.pdf`, `.docx`) next to Start. Start stays disabled until a document is uploaded and text is successfully extracted.
- Server extracts plain text — `pdf-parse` for PDF, `mammoth` for `.docx` — rather than sending raw file bytes to Gemini's native document understanding. Sermon notes are text-heavy; native PDF ingestion tokenizes per page (image-based, ~258 tokens/page), which costs more than extracted text for this content type, and `.docx` isn't natively accepted by Gemini at all.
- Extracted text is capped (~8,000 tokens / ~30k characters); anything beyond that is truncated with a server-side log note.
- Extraction failure (corrupt file, scanned image-only PDF with no text layer, empty result) blocks Start with a clear error; volunteer re-uploads.
- Extracted text is held server-side as pending doc text — not sent to Gemini until Start is clicked, so an early upload with a delayed Start doesn't start burning cache time.

### 2. Feedback notes: standing file, edited in-browser

- A single server-side file (e.g. `server/data/feedback.txt`) holds freeform accuracy notes — plain text examples/corrections, same shape as real notes reviewed from the app's existing audit log of flagged/discarded translations.
- Capture page loads a "Feedback notes" textarea via `GET /feedback` (current file content, or empty string if none exists) on page load — independent of the sermon-doc upload, does not gate Start.
- An explicit **Save** button `PUT`s the full textarea content back, overwriting `feedback.txt`. No auto-save-per-keystroke.
- Saving an empty textarea triggers a client-side confirm ("Clear all feedback notes?") before overwriting, to guard against accidental data loss — no server-side versioning beyond that.
- Optional end-to-end: if the file is missing/empty/unreadable, the session runs with no feedback context, same as if the panel was never used.
- **Security note (explicitly deferred):** the capture page has no auth today, and this adds a "write text to a server file" endpoint on that same unauthenticated page. This inherits the existing trust model rather than expanding it in a new direction, but is worth flagging: anyone who found the capture page URL could rewrite this file. Out of scope for this pass per user direction — revisit later if the capture page ever gets access control.

### 3. Cache assembly & lifecycle

Clicking **Start** does two things (in addition to existing `Session.start()` behavior): creates the Gemini cache, then opens the Deepgram stream as today. The cache combines, under one `system_instruction`, clearly labeled so Gemini treats each part correctly:

1. The idiom/polarity/theology instruction block, currently duplicated between [gemini.ts](../../../.worktrees/auto-translate-lite/server/src/gemini.ts) and [translationVerifier.ts](../../../.worktrees/auto-translate-lite/server/src/translationVerifier.ts) — deduplicated into one shared block.
2. **"Known corrections from past sessions"** — the feedback.txt content, framed as notes to avoid repeating specific past mistakes.
3. **"This week's sermon material"** — the extracted sermon document, required.

TTL is set generously (e.g. 2 hours — comfortably past a typical service) rather than proactively refreshed; storage cost at that size is trivial (see Cost analysis). `translateSegment` and `verifyTranslations` both switch from inlining this instruction text to referencing the cache by name (`cachedContent`) in their `generateContent` calls.

Clicking **Stop** explicitly deletes the cache rather than waiting out the TTL, stopping storage billing immediately and matching the app's existing "nothing lingers past a session" approach to the transcript buffer.

### 4. What must stay out of the cache

Three things vary per call and are **not** part of the cached content — they remain in each call's own `contents`/`config`, exactly as today:

| Cached once per session (Start → Stop) | Stays per-call |
|---|---|
| Idiom/polarity/theology instructions | Target language list + the JSON `responseSchema` built from it |
| Feedback notes | `precedingContext` (rolling window) |
| Sermon document text | The sentence(s)/pairs being translated or verified |

This matters specifically because active languages change whenever a viewer joins, switches, or leaves — if the language list were baked into the cache, every join would force a cache rebuild. Gemini's `cachedContent` only covers the `system_instruction`/cached turn; each `generateContent` call still supplies its own `contents` and its own `config.responseSchema` independently, so a call can reference the cache while carrying a schema whose shape changes call-to-call. The cache itself is only ever created/destroyed on session Start/Stop, never per-language.

### 5. Cost analysis

Rates for `gemini-3.1-flash-lite` per Google's published pricing: standard input $0.25/1M tokens, **cached input $0.025/1M tokens (90% discount)**, cache storage $1.00/1M tokens/hour, output unaffected at $1.50/1M. ([Pricing](https://ai.google.dev/gemini-api/docs/pricing), [Caching](https://ai.google.dev/api/caching))

Assuming a combined cached block (instructions + feedback + sermon doc) of ~4,000 tokens and ~20 combined `translateSegment`+`verifyTranslations` calls/minute (consistent with the existing README's sentence-rate assumptions):

| Scenario | Extra tokens/hour from doc+feedback context | Extra cost/hour | Total cost/hour |
|---|---|---|---|
| Current baseline (no doc context) | — | — | $0.85–$1.20 |
| Doc context added, **no caching** (inlined every call) | 4.8M | +$1.20 | $2.05–$2.40 |
| Doc context added, **with explicit caching** | 4.8M reads @ 90% off + trivial storage | +$0.12–$0.13 | $0.97–$1.33 |

Inlining the sermon+feedback context into every call would roughly double the app's operating cost. Caching cuts that marginal cost by ~90%, keeping the feature within the app's existing "cheaper than every commercial competitor" positioning. Actual numbers will vary with real doc size and call rate — same "log every call, audit real usage" approach as the existing cost analysis applies here.

## Error Handling

Following the existing "retry once, then skip/fallback, never break the session" pattern:

- **Sermon doc extraction fails** → block Start, show a clear error, volunteer re-uploads. (Required, so no fallback path — Start simply can't proceed.)
- **Cache creation fails** (API error, or combined content under Gemini's ~2,048-token minimum) → fall back to inlining the full instructions+feedback+sermon text directly into every `translateSegment`/`verifyTranslations` call instead of referencing `cachedContent`. Log server-side that the session ran uncached, so it's visible when auditing cost afterward.
- **Cache reference goes stale mid-session** (possible on an unusually long service despite the generous TTL) → same inline fallback for the remainder of the session.
- **Feedback file unreadable/missing** → treated as empty/no feedback context; never blocks Start.
- **Feedback save with empty content** → client-side confirm before overwrite.

## Testing

- **Unit**: PDF/docx text extraction (fixture files → expected text; corrupt/scanned file → expected error).
- **Unit**: cache-content assembly (instructions + feedback + sermon text → correctly labeled combined block; missing feedback → block omitted, not an empty labeled section).
- **Unit**: fallback path (cache creation rejected → session proceeds with full text inlined instead of `cachedContent`, matching current prompt shape).
- **Unit**: `/feedback` `GET`/`PUT` endpoint (reads current file, overwrites, missing file → empty string).
- **Manual end-to-end**: full session with a real sermon doc + feedback file; confirm the cache is created at Start and deleted at Stop, and captions still land within the 5-second latency budget with the added context.
- **Out of scope**: whether the doc/feedback context actually *improves* translation accuracy — that's model behavior, not something this codebase unit-tests, same caveat as the existing test suite's stance on Deepgram/Gemini quality.

## Future Extensions (explicitly out of scope now)

- Access control on the capture page and the new `/feedback` write endpoint — currently inherits the capture page's existing no-auth trust model; revisit if that page ever gets locked down.
- Deterministic glossary substitution (e.g. a strict term→translation map applied as a guaranteed post-processing fix) as a supplement to soft context — feedback notes are context-only for now.
- Persisting the sermon document beyond a single session, or reusing one across multiple sessions without re-upload.
- Structuring feedback notes (e.g. a formal term/language/correction schema) instead of freeform text.
