# Pluggable LLM Providers & Admin Configuration — Design

## Purpose

Today all three Gemini roles — transcription verification ([transcriptionVerifier.ts](../../../server/src/transcriptionVerifier.ts)), translation ([gemini.ts](../../../server/src/gemini.ts)), and translation verification ([translationVerifier.ts](../../../server/src/translationVerifier.ts)) — hardcode `const MODEL = 'gemini-3.1-flash-lite'` independently in three places, with prompt text inlined as template literals. There's no way to change which model handles a role, or tweak a role's prompt, without editing code and redeploying. There's also a real token-cost gap: the static instruction blocks (Aussie-slang guidance, polarity rules, "how to refer to God/Jesus/Holy Spirit" rules, Ciel/Planetshakers naming notes) are identical on every call but are sent as plain text, not part of [sermonCache.ts](../../../server/src/sermonCache.ts)'s cached `systemInstruction` — so they're billed at full price on every single line, all service long.

This design:
- Introduces an `LlmProvider` abstraction so a role's model can be swapped without touching call-site code, starting with two Gemini models (`gemini-3.1-flash-lite`, `gemini-3.5-flash`) and leaving room for other providers later.
- Adds a passcode-gated admin page to pick each role's model and edit each role's situational prompt notes, both persisted to disk.
- Generalizes the sermon-context cache into one cache per role, folding the static instruction blocks into it — closing the token-cost gap above regardless of whether a sermon document was uploaded.
- Trims verifier output tokens by leaving `reason` empty on the (common) safe case.

## Scope

- New `LlmProvider` interface + `GeminiProvider` implementation + a registry keyed by model id.
- Per-role (transcriptionVerifier / translation / translationVerifier) model selection, persisted to `server/data/model-config.json`.
- Per-role editable "notes" text (the situational/style content, not the safety rules), persisted to `server/data/prompt-config.json`.
- Per-role Gemini cache, replacing the single shared cache in `sermonCache.ts`.
- New `web/app/admin` page: passcode login, 3 model dropdowns, 3 notes textareas.
- Simple shared-passcode auth (`ADMIN_PASSCODE` env var) gating the new `/admin/*` REST routes and the new page — the first auth of any kind in this app.
- Verifier `reason` field left empty when `safe: true`.
- Explicitly out of scope (see Future Extensions): implementing any non-Gemini provider; hot-swapping config into an already-running session; rate-limiting/lockout or multi-admin accounts on the passcode; automatic model escalation-on-flag.

## Design

### 1. `LlmProvider` abstraction

New `server/src/llm/types.ts`:

```ts
export type ModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';
export const MODEL_IDS: ModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];

export interface LlmProvider {
  translate(text: string, languageCodes: string[], precedingContext: string[], cacheRef: CacheRef | null): Promise<Record<string, string>>;
  translateBacklog(lines: string[], languageCode: string, cacheRef: CacheRef | null): Promise<string[]>;
  verifyTranscription(text: string, precedingContext: string[], cacheRef: CacheRef | null): Promise<TranscriptionCheckResult>;
  verifyTranslations(items: VerificationItem[], cacheRef: CacheRef | null): Promise<Record<string, VerificationResult>>;
}
```

Four methods map onto three roles: `translate`/`translateBacklog` both belong to the **translation** role (today `translateBacklog` — used by the manual-approval reinstate flow — takes no cache argument at all; this design brings it in line with `translateSegment` so it also benefits from per-role caching). `verifyTranscription` is the **transcriptionVerifier** role; `verifyTranslations` is the **translationVerifier** role.

`server/src/llm/geminiProvider.ts` holds `GeminiProvider`, constructed with `(client: GeminiClient, model: ModelId)`. It's the existing logic from `gemini.ts`/`transcriptionVerifier.ts`/`translationVerifier.ts`, moved in and parametrized by `this.model` instead of a hardcoded constant. Both `ModelId` values map to the same `GeminiProvider` class today (just a different model string) — a future non-Gemini provider would be a new class implementing the same interface, registered alongside it.

`server/src/llm/registry.ts`:
```ts
export function getProvider(model: ModelId, client: GeminiClient): LlmProvider {
  return new GeminiProvider(client, model); // only branch today; future providers add cases here
}
```

Call sites in `wsServer.ts` stop importing `gemini.ts`/`transcriptionVerifier.ts`/`translationVerifier.ts` functions directly and instead resolve `getProvider(currentModelConfig.<role>, client)` once per session start and call through it.

### 2. Per-role model config (persisted)

New `server/src/modelConfigStore.ts`, following the existing `feedbackStore.ts` file-store pattern, backed by `server/data/model-config.json`:

```json
{ "transcriptionVerifier": "gemini-3.1-flash-lite", "translation": "gemini-3.1-flash-lite", "translationVerifier": "gemini-3.1-flash-lite" }
```

Defaults match **today's actual behavior** (all three roles on Flash-Lite) — shipping this feature changes nothing about running cost until an admin deliberately switches a dropdown. `PUT` validates each value is a member of `MODEL_IDS` and that all three role keys are present; invalid payloads are rejected with 400 and the file is left untouched. Read once at `Session.start()` (see §4) — changes made mid-service take effect on the *next* Start, matching how the existing sermon-doc/feedback-notes context already only takes effect at Start, not hot-reloaded mid-session.

### 3. Per-role prompt notes (persisted)

New `server/src/promptConfigStore.ts` → `server/data/prompt-config.json`, one editable string per role:

```json
{
  "transcriptionVerifier": "BAHASA INDONESIA: Do NOT flag a line just because it uses the word \"Allah\"...\n\nCIEL is a cafe in Melbourne, do not remove\nPlanetshakers is the church in Melbourne, do not remove",
  "translation": "This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. \"heaps,\" \"no worries,\" \"keen,\" \"arvo,\" \"she'll be right,\" \"having a go\")...",
  "translationVerifier": "Do NOT flag a translation just because it is idiomatic or non-literal..."
}
```

Defaults are today's actual situational text, extracted verbatim out of the three prompt-builder functions. The **safety-critical rules** in each role (preserve polarity/negation, don't misrepresent God/Jesus/Holy Spirit, only flag on inversion/contradiction) stay as hardcoded constants in `server/src/llm/prompts.ts` and are never exposed for editing — the admin page renders them as read-only reference text above each notes textarea, so an admin has context without a path to accidentally delete the safety net. Each role's final prompt is assembled as `[fixed safety rules] + [editable notes] + [per-line content]`.

### 4. Per-role Gemini cache (the caching fix, generalized)

`sermonCache.ts` changes from one shared cache to three. Gemini's `cachedContent` is pinned to a single model and a single fixed `systemInstruction` string, so one cache can no longer serve three roles with three different fixed instruction blocks. New shape:

```ts
export interface RoleCaches {
  transcriptionVerifier: CacheRef | null;
  translation: CacheRef | null;
  translationVerifier: CacheRef | null;
}

export async function createRoleCaches(client, modelConfig: ModelConfig, promptConfig: PromptConfig, feedbackText: string, sermonText: string): Promise<RoleCaches>
```

Each role's cache `systemInstruction` = `[that role's fixed safety rules] + [that role's editable notes] + [shared: known corrections from feedback.txt] + [shared: this week's sermon material]`, created against that role's currently-configured model. Because the fixed rules + notes are always substantial (~150–250 words per role) regardless of whether a sermon doc was uploaded, every role now clears Gemini's minimum cacheable-content threshold on its own — closing today's gap where a short/absent sermon doc meant no caching happened at all and the static blocks were paid for in full on every call.

Lifecycle stays tied to session Start/Stop exactly as today: `createRoleCaches` runs once on Start (reading whatever model/prompt config is persisted at that moment), all three caches are torn down on Stop. If creating any one role's cache fails, that role falls back to inlining its full instruction text per-call (existing fallback pattern from the original sermon-caching design) — the other two roles are unaffected.

### 5. Verifier output-token trim

`translationVerifier.ts` and `transcriptionVerifier.ts` keep `reason: string` as a required schema field (Gemini requires declared fields to be populated), but the fixed prompt rules now state: when `safe` is `true`, set `reason` to `""`; only write an explanation when `safe` is `false`. This cuts output tokens on the common case without changing the schema shape anything downstream depends on.

### 6. Admin page

New `web/app/admin/page.tsx`:
- **Passcode gate**: a single passcode input. On submit, the page attempts `GET /admin/model-config` with header `x-admin-passcode: <value>`; a 200 stores the passcode in `sessionStorage` and reveals the page, a 401 shows "Incorrect passcode." No separate login endpoint needed.
- **Model section**: 3 labeled dropdowns (shadcn `select`, added via `npx shadcn add select` — not yet installed in this project), one per role, options are the two `MODEL_IDS`. Save button `PUT`s `/admin/model-config`.
- **Prompt notes section**: 3 labeled blocks, each showing the role's fixed safety rules as read-only text followed by a textarea (shadcn `textarea`, also newly added) bound to that role's editable notes. Save button `PUT`s `/admin/prompt-config`.
- Every request from this page attaches the stored passcode as `x-admin-passcode`; a 401 on any request clears `sessionStorage` and drops back to the passcode gate.

### 7. Admin auth

New `server/src/adminAuth.ts` — Express middleware comparing the `x-admin-passcode` header against `process.env.ADMIN_PASSCODE`. Mounted in front of the four new `/admin/*` routes only (`GET/PUT /admin/model-config`, `GET/PUT /admin/prompt-config`); every other existing route (including the capture page's own endpoints) is untouched and keeps today's no-auth trust model. Missing or unset `ADMIN_PASSCODE` env var → middleware rejects all requests with 401 (fails closed, not open).

## Error Handling

- **Invalid model id or missing role key in `PUT /admin/model-config`** → 400, prior file untouched.
- **Per-role cache creation fails** → that role falls back to inlining its full instruction text per-call (existing pattern); other roles unaffected; logged server-side same as today.
- **`model-config.json`/`prompt-config.json` missing, unreadable, or corrupt** → treated as "use hardcoded defaults," logged server-side; never blocks session Start (same posture as `feedbackStore.ts` treating a missing feedback file as empty).
- **Wrong or missing passcode** → 401 with a generic message (no hint whether the passcode exists/is close); no lockout or rate-limiting this pass.
- **Config changed mid-service** → has no effect on the in-flight session; applies starting the next Start. This is a deliberate simplification, not an oversight — avoids mid-flight cache invalidation and races with in-progress translations.

## Testing

- **Unit**: `getProvider` returns a `GeminiProvider` configured with the requested model for both `MODEL_IDS` values.
- **Unit**: `modelConfigStore`/`promptConfigStore` GET/PUT round-trip; PUT rejects unknown model ids and incomplete payloads; missing/corrupt file falls back to defaults.
- **Unit**: `adminAuth` middleware — missing header, wrong passcode, unset env var all → 401; correct passcode → `next()`.
- **Unit**: per-role cache assembly — fixed rules + notes + shared corrections/sermon text combine in the right order per role; each cache is created against that role's configured model.
- **Unit**: verifier output — `safe: true` response has `reason: ""`; `safe: false` response has a non-empty `reason`.
- **Manual end-to-end**: start a session with translation set to `gemini-3.5-flash` and both verifiers on `gemini-3.1-flash-lite`; confirm captions still land within the existing latency budget. Edit a role's prompt notes, restart the session, confirm the edit shows up in that role's model behavior. Confirm the admin page is unreachable without the correct passcode, and that the capture page itself needs no passcode.
- **Out of scope**: whether a given model choice or notes edit *improves* translation quality — that's model behavior, not something this codebase unit-tests, consistent with the existing test suite's stance.

## Future Extensions (explicitly out of scope now)

- Any non-Gemini provider (Claude, DeepSeek, GPT) — the interface is shaped for it, but no second provider class is implemented this pass.
- Escalate-on-flag automatic model routing (discussed separately, not requested here).
- Hot-reloading model/prompt config into an already-running session.
- Passcode rate-limiting/lockout, multiple admin accounts, or an audit log of who changed what and when.
- Splitting `web/app/admin/page.tsx` into smaller components if it grows past a single-file size, following whatever pattern `capture/page.tsx` eventually adopts.
