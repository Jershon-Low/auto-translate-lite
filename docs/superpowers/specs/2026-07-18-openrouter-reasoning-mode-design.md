# OpenRouter Reasoning ("Thinking") Mode — Design

## Purpose

[2026-07-18-openrouter-provider-design.md](2026-07-18-openrouter-provider-design.md) added `OpenRouterProvider`, letting an admin route any of the three LLM roles (`transcriptionVerifier`, `translation`, `translationVerifier`) through OpenRouter instead of Gemini. OpenRouter normalizes "reasoning"/"thinking" tokens across providers (OpenAI o-series, Gemini's own thinking models, Claude extended thinking, DeepSeek R1, etc.) behind a single request field. This design lets an admin control that field per role, for OpenRouter-routed roles only.

This is explicitly OpenRouter-only. Native Gemini calls (`GeminiProvider`, `@google/genai`) have their own separate thinking-config mechanism and are untouched — see Future Extensions.

## Scope

- Per-role reasoning effort selection (`off` / `low` / `medium` / `high`), stored alongside the existing per-role OpenRouter model id.
- Admin page gains a "Thinking" dropdown next to the model picker, shown only for rows currently set to the OpenRouter provider.
- `OpenRouterProvider` forwards the selected effort as OpenRouter's `reasoning.effort` request parameter.
- The model's returned reasoning text (`message.reasoning`, separate from the JSON-schema-parsed answer) is logged via the existing event logger for debugging, not stored or surfaced anywhere else.
- Explicitly out of scope: gating the dropdown on OpenRouter's per-model capability metadata (`GET /models/{slug}`); a "guaranteed off" mode using `reasoning.effort: 'none'`; `reasoning.max_tokens` token-budget control; `reasoning.exclude`; showing reasoning text in the admin UI; extending reasoning control to native Gemini roles.

## Design

### 1. Data model

`llmTypes.ts` — `RoleModelSelection`'s OpenRouter variant gains an optional field:

```ts
export type OpenRouterReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export type RoleModelSelection =
  | { provider: 'gemini'; model: ModelId }
  | { provider: 'openrouter'; model: string; reasoning?: OpenRouterReasoningEffort };
```

`reasoning` absent and `reasoning: 'off'` are equivalent at request time: both omit OpenRouter's `reasoning` object entirely, i.e. today's behavior. This means existing on-disk `ModelConfig` entries (which predate this field) need no migration — they're already valid under the new type.

**Deliberate limitation:** a `<select>` element cannot distinguish "never configured" from "admin explicitly chose Off," so this design does not attempt to send an authoritative `reasoning.effort: 'none'` override for the small set of models that default reasoning to on. "Off" here means "don't request reasoning," not "guarantee no reasoning" — consistent with this codebase's existing stance of not validating that OpenRouter will honor every param (see the original provider design's fallback retry for unsupported `response_format`).

### 2. `OpenRouterProvider`

`openRouterProvider.ts` — constructor gains a 4th parameter:

```ts
constructor(
  private readonly client: OpenRouterClient,
  private readonly model: string,
  private readonly notes: string,
  private readonly reasoning?: OpenRouterReasoningEffort
) {}
```

In `requestJson()`, both the primary and the `json_object`-fallback request bodies conditionally include:

```ts
...(this.reasoning && this.reasoning !== 'off' ? { reasoning: { effort: this.reasoning } } : {}),
```

`openRouterClient.ts` — `OpenRouterChatCompletionParams` gains optional `reasoning?: { effort: 'low' | 'medium' | 'high' }`; the response `message` shape gains optional `reasoning?: string` (OpenRouter returns the model's reasoning text here, separate from `content`, which stays the clean JSON the existing `JSON.parse` call already expects — no change to response parsing).

### 3. Reasoning logging

New `server/src/openRouterReasoningLogging.ts`, mirroring the existing `withOpenRouterCostTracking`/`withOpenRouterLimiter` client-decorator shape (same `OpenRouterClient` in, `OpenRouterClient` out; wraps `create()`; inspects the response after the call):

```ts
import type { OpenRouterClient } from './openRouterClient.js';
import { logEvent } from './logger.js';

export function withOpenRouterReasoningLogging(client: OpenRouterClient): OpenRouterClient {
  return {
    chat: {
      completions: {
        async create(params) {
          const response = await client.chat.completions.create(params);
          const reasoning = response.choices[0]?.message?.reasoning;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            void logEvent('info', {
              event: 'openrouter_reasoning',
              model: params.model,
              schema: params.response_format.type === 'json_schema' ? params.response_format.json_schema.name : undefined,
              reasoning,
            });
          }
          return response;
        },
      },
    },
  };
}
```

`index.ts` composes it alongside the existing wrappers (order among cost-tracking/reasoning-logging doesn't matter since both only observe the response; the limiter stays innermost, around the raw client, unchanged):

```ts
withOpenRouterReasoningLogging(
  withOpenRouterCostTracking(
    withOpenRouterLimiter(createOpenRouterClient(process.env.OPENROUTER_API_KEY), openRouterLimiter),
    costTracker
  )
)
```

This logs to the same `data/events.log` sink (via `logEvent`) that other OpenRouter/translation events already use — no new log destination.

### 4. Validation

`modelConfigStore.ts` — `normalizeRoleSelection()`'s `openrouter` branch additionally validates `candidate.reasoning`: if present, must be one of `'off' | 'low' | 'medium' | 'high'`; if absent, that's fine (treated as `'off'`). Any other value fails validation for the whole config, falling back to `DEFAULT_MODEL_CONFIG` — same whole-file-fallback posture the store already has for every other field.

### 5. Admin UI

`web/app/admin/page.tsx` — in the existing OpenRouter branch of each role's row (currently ~lines 280–314), a second `<select>` is added next to the model picker:

```tsx
<select
  value={selection.reasoning ?? 'off'}
  onChange={(event) => {
    const reasoning = event.target.value as OpenRouterReasoningEffort;
    setModelConfig({
      ...modelConfig,
      [role]: { ...selection, reasoning: reasoning === 'off' ? undefined : reasoning },
    });
    setModelSaveStatus('idle');
  }}
  className="border rounded p-1 text-sm"
>
  <option value="off">Off</option>
  <option value="low">Low</option>
  <option value="medium">Medium</option>
  <option value="high">High</option>
</select>
```

Rendered only inside the `selection.provider === 'openrouter'` branch — Gemini rows are unchanged. Switching a role's provider away from OpenRouter and back drops any previously-set `reasoning`, consistent with the existing reset-to-`openRouterModels[0]` behavior on provider switch (page.tsx:247–255). The page-local `RoleModelSelection` type (page.tsx:10) is updated to match the server type.

## Error Handling

- Invalid `reasoning` value in `PUT /admin/model-config` → 400 via existing `validateModelConfig` failure path, prior file untouched (same as any other invalid field today).
- OpenRouter rejecting or ignoring the `reasoning` param for a given model → no special handling; per OpenRouter's own documented behavior, unsupported params are silently ignored by default (no `require_parameters` is set by this codebase), so this surfaces as "the model didn't actually think harder," not an error.
- `message.reasoning` absent or empty on a response → logging is skipped, not treated as an error.

## Testing

- **Unit — `openRouterProvider.test.ts`**: constructing with `reasoning: 'high'` includes `reasoning: { effort: 'high' }` in both the primary and fallback request bodies; `reasoning: 'off'` and `reasoning: undefined` both omit the `reasoning` key entirely.
- **Unit — `openRouterReasoningLogging.test.ts`** (new): forwards `create()` params/response unchanged; calls `logEvent('info', ...)` with model/schema/reasoning when `message.reasoning` is a non-empty string; does not call `logEvent` when it's absent or empty.
- **Unit — `modelConfigStore.test.ts`**: each of the 4 `reasoning` values validates on the openrouter branch; an invalid value fails the whole config to `DEFAULT_MODEL_CONFIG`; a stored selection with no `reasoning` field still validates (pre-existing configs unaffected).
- **Manual**: set a role's provider to OpenRouter with a reasoning-capable model, effort "High"; confirm `data/events.log` gains `openrouter_reasoning` entries; confirm translations/verifications still parse correctly (JSON schema output unaffected by reasoning text arriving in a separate field).
- **Out of scope**: measuring whether higher reasoning effort actually improves translation/verification quality — model behavior, not something this codebase unit-tests (same stance as the original OpenRouter provider design).

## Future Extensions (explicitly out of scope now)

- Gating the dropdown on OpenRouter's `GET /models/{slug}` reasoning-capability metadata, so it's only shown/enabled for models that actually support it.
- An authoritative "force off" using `reasoning.effort: 'none'`, once there's a clean way to distinguish "unset" from "explicitly off" in the stored config (e.g. if the admin UI moves away from a plain `<select>` default).
- `reasoning.max_tokens` (Anthropic-style token-budget control) as an alternative/addition to effort levels.
- `reasoning.exclude` control, or surfacing reasoning text in the admin UI itself rather than only the event log.
- Extending a thinking-mode control to native Gemini roles via `thinkingConfig` — a separate, provider-specific mechanism not covered by this design.
