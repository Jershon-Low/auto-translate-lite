# OpenRouter Reasoning ("Thinking") Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick a per-role reasoning/"thinking" effort (Off/Low/Medium/High) for roles routed through OpenRouter, forwarded as OpenRouter's `reasoning.effort` request parameter, with the model's returned reasoning text logged for debugging.

**Architecture:** Extend the existing `RoleModelSelection` openrouter variant with an optional `reasoning` field, thread it from admin-page state → `ModelConfig` → `getProvider()` → `OpenRouterProvider`'s request body, and add a new client-decorator wrapper (mirroring the existing cost-tracking/limiter wrappers) that logs `message.reasoning` from responses via the existing `logEvent` sink.

**Tech Stack:** TypeScript, Express (`server/`), Next.js/React (`web/`), Vitest for server tests, `openai` npm SDK pointed at OpenRouter's base URL.

## Global Constraints

- Reasoning values are exactly `'off' | 'low' | 'medium' | 'high'` — no `max_tokens`, no `exclude`, no `enabled` shorthand (all explicitly out of scope per the spec).
- `reasoning: 'off'` and `reasoning: undefined` are equivalent everywhere: both mean "omit the `reasoning` request param entirely." Never send `effort: 'none'`.
- This feature only touches OpenRouter-routed roles. Gemini-provider `RoleModelSelection` values and `GeminiProvider` are untouched.
- No new external API calls (no OpenRouter `/models` capability lookups) — the reasoning control is always shown/available, per the spec's "always show it" decision.
- Follow existing patterns exactly: client-decorator wrappers have the shape `(client: OpenRouterClient, ...deps) => OpenRouterClient`; `logEvent` is imported directly from `./logger.js` (not dependency-injected), matching every other call site in this codebase.

Spec: [docs/superpowers/specs/2026-07-18-openrouter-reasoning-mode-design.md](../specs/2026-07-18-openrouter-reasoning-mode-design.md)

---

### Task 1: `OpenRouterReasoningEffort` type and `OpenRouterProvider` request wiring

**Files:**
- Modify: `server/src/llmTypes.ts:9-11`
- Modify: `server/src/openRouterClient.ts:22-31`
- Modify: `server/src/openRouterProvider.ts:23-28,116-150`
- Test: `server/tests/openRouterProvider.test.ts`

**Interfaces:**
- Produces: `export type OpenRouterReasoningEffort = 'off' | 'low' | 'medium' | 'high';` from `llmTypes.ts`, and `RoleModelSelection`'s openrouter variant gains `reasoning?: OpenRouterReasoningEffort`.
- Produces: `OpenRouterProvider`'s constructor signature becomes `(client: OpenRouterClient, model: string, notes: string, reasoning?: OpenRouterReasoningEffort)`.
- Consumes: nothing new from other tasks.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/openRouterProvider.test.ts`, inside the existing `describe('OpenRouterProvider', ...)` block (after the last existing `it(...)`, before the closing `});`):

```ts
  it('includes reasoning.effort in the request when configured', async () => {
    const client = fakeClient('{"zh":"你好"}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes', 'high');
    await provider.translate('Hello', ['zh'], [], null);
    const call = (client.chat.completions.create as any).mock.calls[0][0];
    expect(call.reasoning).toEqual({ effort: 'high' });
  });

  it('omits the reasoning key when reasoning is "off" or unset', async () => {
    const client = fakeClient('{"zh":"你好"}');
    const providerOff = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes', 'off');
    await providerOff.translate('Hello', ['zh'], [], null);
    const offCall = (client.chat.completions.create as any).mock.calls[0][0];
    expect(offCall.reasoning).toBeUndefined();

    const providerUnset = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    await providerUnset.translate('Hello', ['zh'], [], null);
    const unsetCall = (client.chat.completions.create as any).mock.calls[1][0];
    expect(unsetCall.reasoning).toBeUndefined();
  });

  it('includes reasoning.effort in the json_object fallback retry as well', async () => {
    const client: OpenRouterClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(new Error('400 Invalid parameter: response_format is not supported for this model'))
            .mockResolvedValueOnce({ choices: [{ message: { content: '{"zh":"你好"}' } }] }),
        },
      },
    };
    const provider = new OpenRouterProvider(client, 'some-model', 'notes', 'medium');
    await provider.translate('Hello', ['zh'], [], null);
    const secondCall = (client.chat.completions.create as any).mock.calls[1][0];
    expect(secondCall.reasoning).toEqual({ effort: 'medium' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/openRouterProvider.test.ts`
Expected: the 3 new tests FAIL (`call.reasoning` is `undefined` even for the `'high'`/`'medium'` cases, since the constructor doesn't accept or use a 4th argument yet).

- [ ] **Step 3: Add `OpenRouterReasoningEffort` and extend `RoleModelSelection`**

In `server/src/llmTypes.ts`, replace lines 9-11:

```ts
export type OpenRouterReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export type RoleModelSelection =
  | { provider: 'gemini'; model: ModelId }
  | { provider: 'openrouter'; model: string; reasoning?: OpenRouterReasoningEffort };
```

- [ ] **Step 4: Extend `OpenRouterClient` request/response shapes**

In `server/src/openRouterClient.ts`, replace lines 22-31:

```ts
export interface OpenRouterChatCompletionParams {
  model: string;
  messages: OpenRouterMessage[];
  response_format: OpenRouterResponseFormat;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
}

export interface OpenRouterChatCompletionResponse {
  choices: Array<{ message: { content: string | null; reasoning?: string } }>;
  usage?: OpenRouterUsage;
}
```

- [ ] **Step 5: Thread `reasoning` through `OpenRouterProvider`**

In `server/src/openRouterProvider.ts`, replace line 2:

```ts
import type { LlmProvider, OpenRouterReasoningEffort } from './llmTypes.js';
```

Then update the constructor (lines 23-28):

```ts
export class OpenRouterProvider implements LlmProvider {
  constructor(
    private readonly client: OpenRouterClient,
    private readonly model: string,
    private readonly notes: string,
    private readonly reasoning?: OpenRouterReasoningEffort
  ) {}
```

Then in `requestJson()` (lines 116-150), add a computed params object and spread it into both `create()` calls:

```ts
  private async requestJson(
    schemaName: string,
    systemText: string,
    userText: string,
    schema: Record<string, unknown>
  ): Promise<unknown> {
    const messages: OpenRouterMessage[] = [
      { role: 'system', content: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: userText },
    ];
    const reasoningParam =
      this.reasoning && this.reasoning !== 'off' ? { reasoning: { effort: this.reasoning } } : {};

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
        ...reasoningParam,
      });
      return JSON.parse(response.choices[0]?.message.content ?? '{}');
    } catch (error) {
      if (!isUnsupportedResponseFormatError(error)) throw error;
      const fallbackMessages: OpenRouterMessage[] = [
        messages[0],
        {
          role: 'user',
          content: `${userText}\n\nRespond with a single JSON object matching this shape (no other text): ${JSON.stringify(schema)}`,
        },
      ];
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: fallbackMessages,
        response_format: { type: 'json_object' },
        ...reasoningParam,
      });
      return JSON.parse(response.choices[0]?.message.content ?? '{}');
    }
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/openRouterProvider.test.ts`
Expected: all tests PASS (the 3 new ones plus the pre-existing ones in this file).

- [ ] **Step 7: Commit**

```bash
git add server/src/llmTypes.ts server/src/openRouterClient.ts server/src/openRouterProvider.ts server/tests/openRouterProvider.test.ts
git commit -m "Add OpenRouterReasoningEffort and thread reasoning.effort through OpenRouterProvider"
```

---

### Task 2: Thread `reasoning` through `llmRegistry.getProvider`

**Files:**
- Modify: `server/src/llmRegistry.ts:19`
- Test: `server/tests/llmRegistry.test.ts`

**Interfaces:**
- Consumes: `OpenRouterProvider`'s 4-arg constructor from Task 1.
- Produces: `getProvider()` passes `selection.reasoning` through unchanged (no new exported types).

- [ ] **Step 1: Write the failing test**

Add to `server/tests/llmRegistry.test.ts`, inside the existing `describe('getProvider', ...)` block (after the last existing `it(...)`, before the closing `});`):

```ts
  it('passes the reasoning effort through to OpenRouterProvider', async () => {
    const client = fakeOpenRouterClient();
    (client.chat.completions.create as any).mockResolvedValue({ choices: [{ message: { content: '{"zh":"你好"}' } }] });
    const clients: LlmClients = { gemini: fakeGeminiClient(), openRouter: client };
    const provider = getProvider(
      { provider: 'openrouter', model: 'qwen/qwen3.6-flash', reasoning: 'high' },
      'notes',
      clients
    );
    await provider.translate('Hello', ['zh'], [], null);
    const call = (client.chat.completions.create as any).mock.calls[0][0];
    expect(call.reasoning).toEqual({ effort: 'high' });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/llmRegistry.test.ts`
Expected: FAIL — `call.reasoning` is `undefined` because `getProvider` doesn't pass `selection.reasoning` to `OpenRouterProvider` yet.

- [ ] **Step 3: Update `getProvider`**

In `server/src/llmRegistry.ts`, replace line 19:

```ts
  return new OpenRouterProvider(clients.openRouter, selection.model, notes, selection.reasoning);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/llmRegistry.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/llmRegistry.ts server/tests/llmRegistry.test.ts
git commit -m "Thread RoleModelSelection.reasoning through getProvider to OpenRouterProvider"
```

---

### Task 3: Reasoning logging wrapper, wired into client construction

**Files:**
- Create: `server/src/openRouterReasoningLogging.ts`
- Test: `server/tests/openRouterReasoningLogging.test.ts`
- Modify: `server/src/index.ts:19-21,38-43`

**Interfaces:**
- Consumes: `OpenRouterClient`, `OpenRouterChatCompletionResponse.choices[].message.reasoning` from Task 1.
- Produces: `export function withOpenRouterReasoningLogging(client: OpenRouterClient): OpenRouterClient` — same decorator shape as `withOpenRouterCostTracking`/`withOpenRouterLimiter`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/openRouterReasoningLogging.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withOpenRouterReasoningLogging } from '../src/openRouterReasoningLogging';
import type { OpenRouterClient } from '../src/openRouterClient';

function fakeClient(content: string, reasoning?: string): OpenRouterClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content, reasoning } }] }),
      },
    },
  };
}

describe('withOpenRouterReasoningLogging', () => {
  let tempDir: string;

  afterEach(async () => {
    delete process.env.LOG_FILE_PATH;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('logs an openrouter_reasoning event with model, schema name, and reasoning text when present', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reasoning-logging-test-'));
    process.env.LOG_FILE_PATH = join(tempDir, 'events.log');
    const client = fakeClient('{"zh":"你好"}', 'Thinking about tone...');
    const wrapped = withOpenRouterReasoningLogging(client);

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema', json_schema: { name: 'translate', schema: {} } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = await readFile(process.env.LOG_FILE_PATH!, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed).toMatchObject({
      level: 'info',
      event: 'openrouter_reasoning',
      model: 'qwen/qwen3.6-flash',
      schema: 'translate',
      reasoning: 'Thinking about tone...',
    });
  });

  it('does not log when message.reasoning is absent', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reasoning-logging-test-'));
    process.env.LOG_FILE_PATH = join(tempDir, 'events.log');
    const client = fakeClient('{"zh":"你好"}');
    const wrapped = withOpenRouterReasoningLogging(client);

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(readFile(process.env.LOG_FILE_PATH!, 'utf-8')).rejects.toThrow();
  });

  it('still returns the original response unchanged', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reasoning-logging-test-'));
    process.env.LOG_FILE_PATH = join(tempDir, 'events.log');
    const client = fakeClient('{"zh":"你好"}', 'thinking');
    const wrapped = withOpenRouterReasoningLogging(client);

    const response = await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(response).toEqual({ choices: [{ message: { content: '{"zh":"你好"}', reasoning: 'thinking' } }] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/openRouterReasoningLogging.test.ts`
Expected: FAIL with a module-not-found error (`../src/openRouterReasoningLogging` doesn't exist yet).

- [ ] **Step 3: Implement the wrapper**

Create `server/src/openRouterReasoningLogging.ts`:

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/openRouterReasoningLogging.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Wire the wrapper into client construction**

In `server/src/index.ts`, add the import after line 21 (`import { withOpenRouterLimiter } from './openRouterLimiter.js';`):

```ts
import { withOpenRouterReasoningLogging } from './openRouterReasoningLogging.js';
```

Replace lines 38-43:

```ts
const openRouterClient = process.env.OPENROUTER_API_KEY
  ? withOpenRouterReasoningLogging(
      withOpenRouterCostTracking(
        withOpenRouterLimiter(createOpenRouterClient(process.env.OPENROUTER_API_KEY), openRouterLimiter),
        costTracker
      )
    )
  : null;
```

- [ ] **Step 6: Run the full server test suite and typecheck**

Run: `cd server && npm test`
Expected: all tests PASS (no regressions).

Run: `cd server && npm run build`
Expected: compiles with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/openRouterReasoningLogging.ts server/tests/openRouterReasoningLogging.test.ts server/src/index.ts
git commit -m "Add withOpenRouterReasoningLogging and wire it into OpenRouter client construction"
```

---

### Task 4: Validate `reasoning` in `modelConfigStore`

**Files:**
- Modify: `server/src/modelConfigStore.ts:1-3,32-36`
- Test: `server/tests/modelConfigStore.test.ts`

**Interfaces:**
- Consumes: `OpenRouterReasoningEffort` from Task 1.
- Produces: `normalizeRoleSelection`/`validateModelConfig` accept an optional, validated `reasoning` field on openrouter selections (no new exports).

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/modelConfigStore.test.ts`, inside the existing `describe('validateModelConfig', ...)` block (after the `'accepts an openrouter role selection with any non-empty model id'` test, before `'rejects a config missing a role'`):

```ts
  it('accepts an openrouter selection with a valid reasoning effort', () => {
    const config: ModelConfig = {
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'openrouter', model: 'qwen/qwen3.6-flash', reasoning: 'high' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    };
    expect(validateModelConfig(config)).toEqual(config);
  });

  it('rejects an openrouter selection with an invalid reasoning value', () => {
    expect(
      validateModelConfig({
        transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        translation: { provider: 'openrouter', model: 'qwen/qwen3.6-flash', reasoning: 'extreme' },
        translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      })
    ).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/modelConfigStore.test.ts`
Expected: the "accepts ... valid reasoning effort" test FAILS (`reasoning` is silently dropped by `normalizeRoleSelection` today, so the result won't equal `config`). The "rejects ... invalid reasoning value" test currently PASSES by accident (any object with a non-empty `model` string validates regardless of extra fields) — that's fine, it will still pass after the real validation is added; the point of Step 1's fail check is the first test.

- [ ] **Step 3: Add validation**

In `server/src/modelConfigStore.ts`, update the import on line 3:

```ts
import { MODEL_IDS, type ModelId, type OpenRouterReasoningEffort, type RoleModelSelection } from './llmTypes.js';
```

Add a constant near the top of the file (after the imports, before `export interface ModelConfig`):

```ts
const OPENROUTER_REASONING_EFFORTS: OpenRouterReasoningEffort[] = ['off', 'low', 'medium', 'high'];
```

Replace lines 32-36 (the `if (candidate.provider === 'openrouter')` block inside `normalizeRoleSelection`):

```ts
  if (candidate.provider === 'openrouter') {
    if (typeof candidate.model !== 'string' || candidate.model.length === 0) return null;
    if (candidate.reasoning === undefined) {
      return { provider: 'openrouter', model: candidate.model };
    }
    if (!OPENROUTER_REASONING_EFFORTS.includes(candidate.reasoning as OpenRouterReasoningEffort)) return null;
    return { provider: 'openrouter', model: candidate.model, reasoning: candidate.reasoning as OpenRouterReasoningEffort };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/modelConfigStore.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modelConfigStore.ts server/tests/modelConfigStore.test.ts
git commit -m "Validate RoleModelSelection.reasoning on the openrouter branch of modelConfigStore"
```

---

### Task 5: Admin UI — Thinking dropdown

**Files:**
- Modify: `web/app/admin/page.tsx:8-17,38,142-162,262-296`

**Interfaces:**
- Consumes: `ModelConfig`/`RoleModelSelection` shape from Task 4 (via `GET`/`PUT /admin/model-config`, unchanged endpoints).
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Update page-local types**

Replace lines 8-11:

```ts
type GeminiModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';
type Provider = 'gemini' | 'openrouter';
type OpenRouterReasoningEffort = 'off' | 'low' | 'medium' | 'high';
type RoleModelSelection =
  | { provider: 'gemini'; model: GeminiModelId }
  | { provider: 'openrouter'; model: string; reasoning?: OpenRouterReasoningEffort };
```

- [ ] **Step 2: Add reasoning-effort options/labels constant**

Replace line 38 (`const GEMINI_MODEL_IDS: GeminiModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];`) with:

```ts
const GEMINI_MODEL_IDS: GeminiModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];
const REASONING_EFFORTS: OpenRouterReasoningEffort[] = ['off', 'low', 'medium', 'high'];
const REASONING_LABELS: Record<OpenRouterReasoningEffort, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};
```

- [ ] **Step 3: Preserve `reasoning` when a new model id is added**

In `addOpenRouterModel` (currently lines 142-162), replace the line `setModelConfig({ ...modelConfig, [role]: { provider: 'openrouter', model } });` with:

```ts
      setModelConfig({ ...modelConfig, [role]: { ...modelConfig[role], model } });
```

(This function only runs from the OpenRouter branch, so `modelConfig[role]` is always already `{ provider: 'openrouter', ... }` — spreading it preserves any `reasoning` the admin already picked instead of silently clearing it when they add a new model id.)

- [ ] **Step 4: Preserve `reasoning` when the model dropdown changes, and add the Thinking dropdown**

In the OpenRouter branch of the role-row render (currently lines 280-314), replace the whole `<div className="flex flex-col gap-1">...</div>` block with:

```tsx
                  <div className="flex flex-col gap-1">
                    <select
                      value={selection.model}
                      onChange={(event) => {
                        setModelConfig({ ...modelConfig, [role]: { ...selection, model: event.target.value } });
                        setModelSaveStatus('idle');
                      }}
                      className="border rounded p-1 text-sm"
                    >
                      {openRouterModels.length === 0 && <option value="">No models added yet</option>}
                      {openRouterModels.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-muted-foreground">Thinking</label>
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
                        {REASONING_EFFORTS.map((effort) => (
                          <option key={effort} value={effort}>
                            {REASONING_LABELS[effort]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newModelInputs[role]}
                        onChange={(event) => setNewModelInputs({ ...newModelInputs, [role]: event.target.value })}
                        placeholder="e.g. qwen/qwen3.6-flash"
                        className="border rounded p-1 text-sm flex-1"
                      />
                      <button
                        onClick={() => void addOpenRouterModel(role)}
                        disabled={newModelInputs[role].trim().length === 0}
                        className="bg-secondary text-secondary-foreground px-2 py-1 rounded text-sm disabled:opacity-50"
                      >
                        Add
                      </button>
                    </div>
                  </div>
```

Note the model-select's `onChange` changed from constructing a literal `{ provider: 'openrouter', model: event.target.value }` to `{ ...selection, model: event.target.value }` — otherwise picking a different model from the dropdown would silently drop the row's `reasoning` setting.

- [ ] **Step 5: Typecheck**

Run: `cd web && npm run lint`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Start both dev servers (`server` and `web`, per `.claude/launch.json`), open the admin page, log in, and confirm:
- Setting a role's provider to OpenRouter shows a "Thinking" dropdown (Off/Low/Medium/High) next to the model picker.
- Switching a role back to Gemini hides it; switching back to OpenRouter shows it reset to "Off".
- Picking a reasoning value, then a different model from the model dropdown, keeps the chosen reasoning value (doesn't reset to "Off").
- Typing a new model id and clicking "Add" keeps whatever reasoning value was already selected.
- Clicking "Save models" persists the choice; reloading the page shows the same reasoning value restored.

- [ ] **Step 7: Commit**

```bash
git add web/app/admin/page.tsx
git commit -m "Add per-role OpenRouter reasoning-effort dropdown to the admin models section"
```
