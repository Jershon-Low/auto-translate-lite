# OpenRouter LLM Provider — Design

## Purpose

Today [llmRegistry.ts](../../../server/src/llmRegistry.ts)'s `getProvider()` always constructs a `GeminiProvider` — the `LlmProvider` interface and per-role `ModelConfig` introduced in [2026-07-16-pluggable-llm-admin-config-design.md](2026-07-16-pluggable-llm-admin-config-design.md) is provider-shaped but has exactly one implementation. This design adds a second `LlmProvider` implementation that routes calls through [OpenRouter](https://openrouter.ai), a gateway exposing many providers' models (Qwen, DeepSeek, GPT, Claude, and Gemini itself) behind one OpenAI-compatible API and one API key — so an admin can pick, per role, whether a translation/verification task runs on Gemini directly or on any OpenRouter-hosted model, without a code change.

This is explicitly a second-provider addition, not a replacement: `GeminiProvider` and the native `@google/genai` call path are unchanged. (The user has separately noted a possible future move to route Gemini itself through OpenRouter via its Bring-Your-Own-Key section, which this design's shape doesn't foreclose — see Future Extensions.)

## Scope

- New `OpenRouterProvider` implementing the existing `LlmProvider` interface, using the `openai` npm SDK pointed at OpenRouter's base URL.
- Per-role model *selection* becomes provider-aware: each of the three roles (`transcriptionVerifier`, `translation`, `translationVerifier`) independently picks `{ provider: 'gemini', model: <existing ModelId> }` or `{ provider: 'openrouter', model: <any string> }`.
- A small persisted list of previously-used OpenRouter model ids, to back an admin-page dropdown/autocomplete (not a hard whitelist).
- Admin page gains a provider toggle per role and an "add a new OpenRouter model id" control.
- Cost tracking for OpenRouter calls, using OpenRouter's own returned `usage.cost` rather than a maintained pricing table.
- Extraction of the pure prompt task-text builders (currently inlined as template literals in `gemini.ts`/`transcriptionVerifier.ts`/`translationVerifier.ts`) into shared functions in `llmPrompts.ts`, so both providers give models identical task wording.
- Concurrency limiting for OpenRouter calls, reusing the existing `GeminiCallLimiter` semaphore.
- Explicitly out of scope: migrating Gemini calls themselves onto OpenRouter; a maintained per-OpenRouter-model pricing table; cross-provider automatic fallback (an OpenRouter role failing does not retry on Gemini); rate-limit/lockout on the "add model id" admin control; validating that a typed-in OpenRouter model id is real before saving it.

## Design

### 1. Provider-aware model selection

`llmTypes.ts` changes:

```ts
export type ModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash'; // unchanged
export const GEMINI_MODEL_IDS: ModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];

export type RoleModelSelection =
  | { provider: 'gemini'; model: ModelId }
  | { provider: 'openrouter'; model: string };
```

`ModelConfig` (in `modelConfigStore.ts`) changes from `Record<Role, ModelId>` to `Record<Role, RoleModelSelection>`. `DEFAULT_MODEL_CONFIG` is unchanged in effect — all three roles default to `{ provider: 'gemini', model: 'gemini-3.1-flash-lite' }`, preserving today's actual behavior and cost.

`validateModelConfig` gains a migration path: if a role's stored value is a bare string (today's on-disk format), and that string is a known `ModelId`, it's upgraded in memory to `{ provider: 'gemini', model: <string> }`. If a role's value is already an object, it must be `{ provider: 'gemini', model: <one of GEMINI_MODEL_IDS> }` or `{ provider: 'openrouter', model: <non-empty string> }`; anything else fails validation for the whole config, which falls back to `DEFAULT_MODEL_CONFIG` (matching today's whole-file fallback behavior, not partial/per-field recovery).

### 2. `OpenRouterProvider`

New `server/src/openRouterClient.ts`, hand-rolled interface analogous to `GeminiClient`:

```ts
import OpenAI from 'openai';

export interface OpenRouterUsage {
  cost?: number;
}

export interface OpenRouterClient {
  chat: {
    completions: {
      create(params: ChatCompletionCreateParams): Promise<{
        choices: Array<{ message: { content: string | null } }>;
        usage?: OpenRouterUsage;
      }>;
    };
  };
}

export function createOpenRouterClient(apiKey: string): OpenRouterClient {
  return new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' });
}
```

New `server/src/openRouterProvider.ts`:

```ts
export class OpenRouterProvider implements LlmProvider {
  constructor(
    private readonly client: OpenRouterClient,
    private readonly model: string,
    private readonly notes: string
  ) {}

  translate(englishText, languageCodes, precedingContext, _cacheRef): Promise<Record<string, string>> {
    const task = buildTranslateTaskText(languageCodes, englishText, precedingContext);
    return this.requestJson(task, `${this.notes}\n\n${TRANSLATION_FIXED_RULES}`, translateSchema(languageCodes));
  }
  // translateBacklog / verifyTranscription / verifyTranslations follow the same shape,
  // each using its matching builder from llmPrompts.ts and fixed-rules constant.
}
```

`OpenRouterProvider` ignores the `cacheRef` parameter entirely (it always receives `null` for OpenRouter-configured roles — see §4) — caching for OpenRouter happens per-request via `cache_control`, not via a session-created handle.

A private `requestJson()` helper on the class:
1. Builds `messages: [{ role: 'system', content: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: userText }]`.
2. Calls `client.chat.completions.create({ model, messages, response_format: { type: 'json_schema', json_schema: schema } })`.
3. If that call fails with an error indicating `response_format` / `json_schema` isn't supported by the model, retries once with `response_format: { type: 'json_object' }`, relying on the schema shape already being spelled out in the task text.
4. Parses `choices[0].message.content` as JSON (same `JSON.parse(... ?? '{}')` posture as the existing Gemini functions).
5. If `response.usage?.cost` is present, records it via the cost tracker (see §5).

### 3. Shared prompt task-text builders

`llmPrompts.ts` gains pure builder functions extracted from the three existing call-site files, each returning only the per-call variable text (sentence/pairs/context) — not the fixed rules or notes, which stay separate constants:

```ts
export function buildTranslateTaskText(languageCodes: string[], englishText: string, precedingContext: string[]): string
export function buildTranslateBacklogTaskText(englishLines: string[], languageCode: string): string
export function buildTranscriptionVerifierTaskText(english: string, precedingContext: string[]): string
export function buildTranslationVerifierTaskText(items: VerificationItem[]): string
```

`gemini.ts`, `transcriptionVerifier.ts`, and `translationVerifier.ts` are edited to call these builders instead of inlining the equivalent template literals — a pure extraction, not a behavior change, so their existing prompt-content assertions in `gemini.test.ts`/`transcriptionVerifier.test.ts`/`translationVerifier.test.ts` should continue to pass against byte-identical output. `OpenRouterProvider` calls the same builders, guaranteeing both providers give the model identical task wording; only the fixed rules/notes placement and JSON-request mechanics differ per provider.

### 4. Registry, clients, and caching

`llmRegistry.ts`:

```ts
export interface LlmClients {
  gemini: GeminiClient;
  openRouter: OpenRouterClient | null; // null when OPENROUTER_API_KEY is unset
}

export function getProvider(selection: RoleModelSelection, notes: string, clients: LlmClients): LlmProvider {
  if (selection.provider === 'gemini') return new GeminiProvider(clients.gemini, selection.model, notes);
  if (!clients.openRouter) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }
  return new OpenRouterProvider(clients.openRouter, selection.model, notes);
}
```

`index.ts` constructs `openRouter: process.env.OPENROUTER_API_KEY ? createOpenRouterClient(...) : null` alongside the existing (still-required) `GEMINI_API_KEY` read, and passes both clients down as `LlmClients`. The three `getProvider(...)` call sites in `wsServer.ts:139-141` (currently passing `modelConfig.<role>`, `promptConfig.<role>`, `deps.geminiClient`) change their last argument from `deps.geminiClient` to `deps.llmClients` (an `LlmClients`), and `WsServerDeps`'s `geminiClient` field is joined by an `llmClients: LlmClients` field built once at server start.

`sermonCache.ts`'s `createRoleCaches()` gains a guard: for any role whose `ModelConfig` entry has `provider: 'openrouter'`, skip the `client.caches.create()` call and return `null` for that role directly — Gemini's named-cache-handle API doesn't apply to it, and `OpenRouterProvider` doesn't need a `SermonCacheRef` (it marks its own system message `cache_control` on every call, letting OpenRouter/the upstream provider match repeated prefixes automatically, request to request, independent of any session-level object this codebase creates or tracks).

### 5. Cost tracking

`costTracker.ts` gains `recordOpenRouterUsage({ model, costUsd }: { model: string; costUsd: number }): void`, which adds `costUsd` straight to the running total — no pricing table lookup, since OpenRouter returns the real dollar cost inline on every `chat.completions.create()` response at `response.usage.cost` (confirmed against OpenRouter's usage-accounting docs: automatic on every response, no request opt-in needed, works as-is with the `openai` SDK). New `server/src/openRouterCostTracking.ts`, mirroring `geminiCostTracking.ts`'s `withCostTracking()` wrapper shape, reads `response.usage.cost` after each call and forwards it to `recordOpenRouterUsage`. This also means BYOK-routed calls (e.g. a Gemini model called through OpenRouter using your own Gemini key) report accurate upstream cost with no extra code, since OpenRouter's `usage.cost_details.upstream_inference_cost` is populated specifically for BYOK requests.

### 6. Concurrency limiting

`server/src/openRouterLimiter.ts` mirrors `geminiRateLimiting.ts`'s `withGeminiLimiter`, wrapping `OpenRouterClient` the same way, reusing the existing generic `GeminiCallLimiter` semaphore class (it's not actually Gemini-specific — just named for its first use) with its own instance/concurrency cap so a burst of OpenRouter calls can't starve or be starved by concurrent Gemini calls.

### 7. Known-model store and admin UI

New `server/src/openRouterModelsStore.ts`, same file-store pattern as `modelConfigStore.ts`, backed by `server/data/openrouter-models.json` — a flat JSON array of previously-used model id strings. `read()` returns `[]` by default; `addModel(id)` appends if not already present and persists. This is a UX convenience for the admin dropdown, not a whitelist — `PUT /admin/model-config` does not require an OpenRouter model id to already be in this list.

New routes in `app.ts`: `GET /admin/openrouter-models` (list) and `POST /admin/openrouter-models` (body `{ model: string }`, returns the updated list), both behind the existing `adminAuth` middleware.

`web/app/admin/page.tsx`: each role's row gets a provider toggle (Gemini / OpenRouter) next to its model dropdown. Gemini keeps today's `GEMINI_MODEL_IDS` `<select>`. OpenRouter shows a `<select>` populated from the fetched known-models list, plus a text input + "Add" button that `POST`s a new id, refreshes the list, and selects it for that role. `loadAll()` fetches `/admin/openrouter-models` alongside the three existing config endpoints.

### 8. Environment

`.env.example` gains `OPENROUTER_API_KEY=`. Unlike `GEMINI_API_KEY`, it is **not** required at server boot — existing deployments that never touch OpenRouter shouldn't be forced to set it. It's only needed lazily, when `getProvider()` is asked to construct an `OpenRouterProvider` for a role actually configured that way.

## Error Handling

- **`response_format: json_schema` unsupported by the model** → retry once with `response_format: json_object`, relying on the shape already spelled out in the task text (same one-retry posture as the existing Gemini cache-then-no-cache fallback in `wsServer.ts`).
- **Any other OpenRouter call failure** (network, auth, rate limit) → logs an error event (`openrouter_translation_failed` / `openrouter_verification_failed`, matching existing event-naming) and returns the same safe defaults the Gemini path already returns for that role today (empty translations object/array, or `{ safe: false, reason: 'verification unavailable' }`). No automatic fallback to Gemini — a role's behavior stays exactly what the admin configured.
- **`OPENROUTER_API_KEY` missing when a role needs it** → `getProvider()` throws; the caller (session Start) catches this per-role the same way a role-cache-create failure is caught today, logs it, and that role fails closed rather than crashing server boot.
- **Invalid `provider`/`model` shape in `PUT /admin/model-config`** → 400, prior file untouched (existing behavior, extended to the new shape).
- **Unrecognized/corrupt `openrouter-models.json`** → treated as an empty list, logged, never blocks session Start.

## Testing

- **Unit**: `llmRegistry.test.ts` — `getProvider` returns an `OpenRouterProvider` for `provider: 'openrouter'` selections, and throws when `clients.openRouter` is `null`.
- **Unit**: `openRouterProvider.test.ts` — model/messages/`response_format` sent correctly; `cache_control` present on the system message; JSON parsing for both schema and object-mode responses; the fallback retry on an unsupported-param error; cost extraction from `response.usage.cost` via a fake OpenAI-shaped client (mirroring `gemini.test.ts`'s `fakeClient()` pattern).
- **Unit**: `modelConfigStore.test.ts` — old bare-string format migrates to `{ provider: 'gemini', ... }`; new `{ provider, model }` shape validates for both providers; malformed/unknown provider falls back to `DEFAULT_MODEL_CONFIG`.
- **Unit**: `openRouterModelsStore.test.ts` — default empty list; write/read roundtrip; `addModel` dedups an already-known id.
- **Unit**: `sermonCache.test.ts` — an OpenRouter-configured role returns `null` without calling `client.caches.create`; Gemini-configured roles are unaffected.
- **Unit**: `openRouterCostTracking.test.ts` / `costTracker.test.ts` — `recordOpenRouterUsage` adds the given cost directly; the wrapper forwards `response.usage.cost` correctly, and no-ops when `usage` is absent.
- **Unit**: prompt-builder extraction — `gemini.test.ts`/`transcriptionVerifier.test.ts`/`translationVerifier.test.ts` continue to pass unmodified against the refactored call sites (byte-identical prompt output).
- **Existing `wsServer.test.ts`** stays green unmodified, since defaults remain all-Gemini.
- **Manual end-to-end**: point the `translation` role at an OpenRouter model (e.g. a Qwen model), confirm live captions still populate; point a role at a Gemini model routed *through* OpenRouter using BYOK and confirm it behaves the same as native Gemini; add a new OpenRouter model id from the admin page and confirm it persists and appears in the dropdown on reload.
- **Out of scope**: whether a given OpenRouter model's translation *quality* is better or worse than Gemini's — that's model behavior, not something this codebase unit-tests, consistent with the existing test suite's stance.

## Future Extensions (explicitly out of scope now)

- Migrating Gemini calls themselves onto OpenRouter (via BYOK), retiring the native `@google/genai` call path — the `RoleModelSelection`/`OpenRouterProvider` shape already supports pointing a role at a Gemini model id through OpenRouter without further changes; this design doesn't do that migration, only enables it.
- A maintained per-OpenRouter-model pricing table (not needed — `response.usage.cost` is authoritative).
- Cross-provider automatic fallback (OpenRouter failing does not retry on Gemini, or vice versa).
- Validating a typed-in OpenRouter model id actually exists before saving it to the known-models list.
- Rate-limiting/lockout on the "add a new model id" admin control.
- Surfacing OpenRouter's response-level edge cache (`X-OpenRouter-Cache`) — not useful for translation (each request differs by sentence) though could help if the verifier ever re-checks an identical line; not pursued here.
