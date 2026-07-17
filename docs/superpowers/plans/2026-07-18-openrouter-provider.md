# OpenRouter LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `OpenRouterProvider` as a second `LlmProvider` implementation alongside `GeminiProvider`, so each of the three LLM roles (transcription verifier, translation, translation verifier) can independently be configured to use Gemini directly or any model available through OpenRouter, with matching cost tracking, caching, and admin UI support.

**Architecture:** Per-role model config becomes a `{ provider: 'gemini' | 'openrouter', model }` pair (migrating transparently from today's bare-string format). `llmRegistry.ts`'s `getProvider()` branches on `provider` to construct either a `GeminiProvider` (unchanged) or a new `OpenRouterProvider`, which uses the `openai` npm SDK pointed at OpenRouter's base URL, shares prompt task-text with Gemini via new builder functions in `llmPrompts.ts`, marks its system message `cache_control` for provider-side caching, and reads real per-call cost from `response.usage.cost`.

**Tech Stack:** Node/TypeScript/Express/vitest (server), Next.js/React/Tailwind (web); adds the `openai` npm package as the only new dependency.

## Global Constraints

- Default behavior and cost must not change until an admin explicitly configures a role to use OpenRouter — `DEFAULT_MODEL_CONFIG` stays all-Gemini, and a legacy on-disk bare-string `model-config.json` must load identically to before.
- No automatic cross-provider fallback: an OpenRouter role failing does not retry on Gemini, or vice versa.
- No maintained per-OpenRouter-model pricing table — cost comes from `response.usage.cost` on each call.
- `OPENROUTER_API_KEY` is optional at server boot (unlike `GEMINI_API_KEY`), only required lazily when a role is actually configured to use OpenRouter.
- Follow the existing flat `server/src/*.ts` layout — no new subdirectories.
- Every new/changed prompt-producing function must keep the existing Gemini call sites' output byte-identical (existing `gemini.test.ts`/`transcriptionVerifier.test.ts`/`translationVerifier.test.ts` assertions must pass unmodified).

---

### Task 1: `openai` dependency and `openRouterClient.ts`

**Files:**
- Modify: `server/package.json`
- Create: `server/src/openRouterClient.ts`
- Test: `server/tests/openRouterClient.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `OpenRouterMessageContent`, `OpenRouterMessage`, `OpenRouterUsage`, `OpenRouterChatCompletionParams`, `OpenRouterChatCompletionResponse`, `OpenRouterClient`, `createOpenRouterClient(apiKey: string): OpenRouterClient` — every later task that touches OpenRouter imports these exact names from `./openRouterClient.js`.

- [ ] **Step 1: Install the `openai` package**

Run: `cd server && npm install openai`

Expected: `server/package.json`'s `dependencies` gains an `"openai": "^..."` entry and `server/package-lock.json` updates.

- [ ] **Step 2: Write `openRouterClient.ts`**

```ts
// server/src/openRouterClient.ts
import OpenAI from 'openai';

export interface OpenRouterMessageContent {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface OpenRouterMessage {
  role: 'system' | 'user';
  content: string | OpenRouterMessageContent[];
}

export interface OpenRouterUsage {
  cost?: number;
}

export type OpenRouterResponseFormat =
  | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> } }
  | { type: 'json_object' };

export interface OpenRouterChatCompletionParams {
  model: string;
  messages: OpenRouterMessage[];
  response_format: OpenRouterResponseFormat;
}

export interface OpenRouterChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage?: OpenRouterUsage;
}

export interface OpenRouterClient {
  chat: {
    completions: {
      create(params: OpenRouterChatCompletionParams): Promise<OpenRouterChatCompletionResponse>;
    };
  };
}

export function createOpenRouterClient(apiKey: string): OpenRouterClient {
  // Cast: the installed `openai` SDK's own types are a much richer superset of
  // the minimal shape this app actually calls (mirrors the hand-rolled
  // GeminiClient pattern in gemini.ts) — the cast just narrows what callers see.
  return new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' }) as unknown as OpenRouterClient;
}
```

- [ ] **Step 3: Write the test**

```ts
// server/tests/openRouterClient.test.ts
import { describe, it, expect } from 'vitest';
import { createOpenRouterClient } from '../src/openRouterClient';

describe('createOpenRouterClient', () => {
  it('returns a client exposing chat.completions.create as a callable function', () => {
    const client = createOpenRouterClient('fake-api-key');
    expect(typeof client.chat.completions.create).toBe('function');
  });
});
```

- [ ] **Step 4: Run the test and the TypeScript build**

Run: `cd server && npx vitest run tests/openRouterClient.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, no type errors. If `tsc` reports the `OpenAI` instance isn't assignable to `OpenRouterClient`, the cast in Step 2 (`as unknown as OpenRouterClient`) already handles it — no further change needed.

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/package-lock.json server/src/openRouterClient.ts server/tests/openRouterClient.test.ts
git commit -m "Add openai dependency and a hand-rolled OpenRouterClient interface"
```

---

### Task 2: Shared prompt task-text builders

**Files:**
- Modify: `server/src/llmPrompts.ts`
- Modify: `server/src/gemini.ts`
- Modify: `server/src/transcriptionVerifier.ts`
- Modify: `server/src/translationVerifier.ts`
- Test: `server/tests/llmPrompts.test.ts` (new)
- Test: `server/tests/gemini.test.ts`, `server/tests/transcriptionVerifier.test.ts`, `server/tests/translationVerifier.test.ts` (must pass unmodified)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildTranslateTaskText(languageCodes, englishText, precedingContext, instructionBlock = '')`, `buildTranslateBacklogTaskText(englishLines, languageCode, instructionBlock = '')`, `buildTranscriptionVerifierTaskText(english, precedingContext)`, `buildTranslationVerifierTaskText(items: { id: string; english: string; translated: string }[])` — Task 8 (`openRouterProvider.ts`) calls these exact functions.

- [ ] **Step 1: Add the builder functions to `llmPrompts.ts`**

Append to the end of `server/src/llmPrompts.ts` (keep the existing five constants at the top unchanged):

```ts
function buildTranslateContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (do not translate these — they're for reference only, e.g. to resolve pronouns or match terminology):
${numbered}

`;
}

export function buildTranslateTaskText(
  languageCodes: string[],
  englishText: string,
  precedingContext: string[],
  instructionBlock = ''
): string {
  return `Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal.

${instructionBlock}${buildTranslateContextBlock(precedingContext)}Sentence: "${englishText}"`;
}

export function buildTranslateBacklogTaskText(englishLines: string[], languageCode: string, instructionBlock = ''): string {
  return `Translate each of these sentences, spoken during a live Australian church sermon, into language code "${languageCode}". Return the translations in the exact same order as the input.

${instructionBlock}Sentences: ${JSON.stringify(englishLines)}`;
}

function buildVerifierContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (not to be evaluated themselves — only for resolving pronouns or continuing a thought):\n${numbered}\n\n`;
}

export function buildTranscriptionVerifierTaskText(english: string, precedingContext: string[]): string {
  return `${buildVerifierContextBlock(precedingContext)}Line: "${english}"

Return whether it is safe and a short reason.`;
}

export function buildTranslationVerifierTaskText(items: { id: string; english: string; translated: string }[]): string {
  const pairs = items
    .map((item, index) => `${index + 1}. [id: "${item.id}"] English: "${item.english}" | Translation: "${item.translated}"`)
    .join('\n');
  return `Pairs:
${pairs}

Return, for each id, whether it is safe and a short reason.`;
}
```

- [ ] **Step 2: Write `llmPrompts.test.ts`**

```ts
// server/tests/llmPrompts.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildTranslateTaskText,
  buildTranslateBacklogTaskText,
  buildTranscriptionVerifierTaskText,
  buildTranslationVerifierTaskText,
} from '../src/llmPrompts';

describe('buildTranslateTaskText', () => {
  it('produces the intro line and the sentence, with no instruction block by default', () => {
    const text = buildTranslateTaskText(['zh'], 'Hello', []);
    expect(text).toBe(
      'Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: zh. Keep the tone natural and spoken, not overly formal.\n\n' +
        'Sentence: "Hello"'
    );
  });

  it('inserts the given instruction block between the intro and the sentence', () => {
    const text = buildTranslateTaskText(['zh'], 'Hello', [], 'NOTES AND RULES\n\n');
    expect(text).toContain('NOTES AND RULES\n\nSentence: "Hello"');
  });

  it('includes preceding context between the instruction block and the sentence', () => {
    const text = buildTranslateTaskText(['zh'], 'Hello', ['Hi everyone']);
    expect(text).toContain('Hi everyone');
    expect(text).toContain('do not translate these');
  });
});

describe('buildTranslateBacklogTaskText', () => {
  it('produces the intro line and the JSON-encoded sentence list', () => {
    const text = buildTranslateBacklogTaskText(['Hello', 'Bye'], 'zh');
    expect(text).toBe(
      'Translate each of these sentences, spoken during a live Australian church sermon, into language code "zh". Return the translations in the exact same order as the input.\n\n' +
        'Sentences: ["Hello","Bye"]'
    );
  });
});

describe('buildTranscriptionVerifierTaskText', () => {
  it('produces the line and instruction footer, with no context block when none given', () => {
    const text = buildTranscriptionVerifierTaskText('Jesus loves you', []);
    expect(text).toBe('Line: "Jesus loves you"\n\nReturn whether it is safe and a short reason.');
  });

  it('includes preceding context lines when given', () => {
    const text = buildTranscriptionVerifierTaskText('He rose again', ['Jesus died', 'Three days later']);
    expect(text).toContain('Jesus died');
    expect(text).toContain('Three days later');
  });
});

describe('buildTranslationVerifierTaskText', () => {
  it('numbers each pair with its id, English, and translation', () => {
    const text = buildTranslationVerifierTaskText([
      { id: 'zh', english: 'Hello', translated: '你好' },
      { id: 'ko', english: 'Hello', translated: '안녕' },
    ]);
    expect(text).toBe(
      'Pairs:\n1. [id: "zh"] English: "Hello" | Translation: "你好"\n2. [id: "ko"] English: "Hello" | Translation: "안녕"\n\n' +
        'Return, for each id, whether it is safe and a short reason.'
    );
  });
});
```

- [ ] **Step 3: Run the new test**

Run: `cd server && npx vitest run tests/llmPrompts.test.ts`
Expected: PASS.

- [ ] **Step 4: Refactor `gemini.ts` to call the builders**

In `server/src/gemini.ts`:
- Change the import line to: `import { TRANSLATION_FIXED_RULES, buildTranslateTaskText, buildTranslateBacklogTaskText } from './llmPrompts.js';`
- Delete the local `buildContextBlock` function entirely.
- In `translateSegment`, replace the `contents:` value:
  ```ts
      contents: buildTranslateTaskText(languageCodes, englishText, precedingContext, instructionBlock),
  ```
- In `translateBacklog`, replace the `contents:` value:
  ```ts
      contents: buildTranslateBacklogTaskText(englishLines, languageCode, instructionBlock),
  ```

Nothing else in the file changes — `instructionBlock` is still computed exactly as before in each function.

- [ ] **Step 5: Refactor `transcriptionVerifier.ts` to call the builder**

In `server/src/transcriptionVerifier.ts`:
- Change the import line to:
  ```ts
  import { thinkingConfigFor, type GeminiClient, type SermonCacheRef } from './gemini.js';
  import {
    TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO,
    TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO,
    buildTranscriptionVerifierTaskText,
  } from './llmPrompts.js';
  ```
- Delete the local `buildContextBlock` function entirely.
- Replace the `contents:` value:
  ```ts
      contents: `${cacheRouterMarker}${instructionBlock}${buildTranscriptionVerifierTaskText(english, precedingContext)}`,
  ```

- [ ] **Step 6: Refactor `translationVerifier.ts` to call the builder**

In `server/src/translationVerifier.ts`:
- Change the import line to:
  ```ts
  import { thinkingConfigFor, type GeminiClient, type SermonCacheRef } from './gemini.js';
  import {
    TRANSLATION_VERIFIER_FIXED_RULES_INTRO,
    TRANSLATION_VERIFIER_FIXED_RULES_OUTRO,
    buildTranslationVerifierTaskText,
  } from './llmPrompts.js';
  ```
- Delete the local `const pairs = items.map(...).join('\n');` computation entirely — this file never had a separate context-block function, just the inline `pairs` variable, which the builder now computes internally.
- Replace the `contents:` value:
  ```ts
      contents: `${cacheRouterMarker}${instructionBlock}${buildTranslationVerifierTaskText(items)}`,
  ```

- [ ] **Step 7: Run the full existing suite for these three files to confirm byte-identical output**

Run: `cd server && npx vitest run tests/gemini.test.ts tests/transcriptionVerifier.test.ts tests/translationVerifier.test.ts`
Expected: PASS, with no changes to those test files — this confirms the refactor produced byte-identical prompts.

- [ ] **Step 8: Commit**

```bash
git add server/src/llmPrompts.ts server/src/gemini.ts server/src/transcriptionVerifier.ts server/src/translationVerifier.ts server/tests/llmPrompts.test.ts
git commit -m "Extract shared prompt task-text builders for reuse by a future OpenRouter provider"
```

---

### Task 3: Provider-aware model config with legacy migration

**Files:**
- Modify: `server/src/llmTypes.ts`
- Modify: `server/src/modelConfigStore.ts`
- Test: `server/tests/modelConfigStore.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RoleModelSelection` (from `llmTypes.ts`); `ModelConfig` (role values are now `RoleModelSelection`), `DEFAULT_MODEL_CONFIG`, `validateModelConfig(value): ModelConfig | null` (from `modelConfigStore.ts`, migrating legacy bare-string values) — Tasks 4, 7, 9, 11 all consume this exact `RoleModelSelection` shape.

- [ ] **Step 1: Add `RoleModelSelection` to `llmTypes.ts`**

Add this type below the existing `export const MODEL_IDS: ModelId[] = [...]` line in `server/src/llmTypes.ts` (nothing else in the file changes):

```ts
export type RoleModelSelection =
  | { provider: 'gemini'; model: ModelId }
  | { provider: 'openrouter'; model: string };
```

- [ ] **Step 2: Write the failing tests for provider-aware config**

Replace the full contents of `server/tests/modelConfigStore.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelConfigStore, validateModelConfig, DEFAULT_MODEL_CONFIG, type ModelConfig } from '../src/modelConfigStore';

describe('createModelConfigStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the default config when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const store = createModelConfigStore(join(tempDir, 'model-config.json'));
    expect(await store.read()).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('writes then reads back the same config, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const filePath = join(tempDir, 'nested', 'model-config.json');
    const store = createModelConfigStore(filePath);
    const config: ModelConfig = {
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'openrouter', model: 'qwen/qwen3.6-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    };
    await store.write(config);
    expect(await store.read()).toEqual(config);
  });

  it('falls back to the default config when the file is corrupt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const filePath = join(tempDir, 'model-config.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const store = createModelConfigStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('falls back to the default config when the file has an unrecognized model id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const filePath = join(tempDir, 'model-config.json');
    await writeFile(
      filePath,
      JSON.stringify({ transcriptionVerifier: 'gpt-5', translation: 'gemini-3.5-flash', translationVerifier: 'gemini-3.1-flash-lite' }),
      'utf-8'
    );
    const store = createModelConfigStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('migrates a legacy on-disk bare-string config to the { provider, model } shape when reading', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const filePath = join(tempDir, 'model-config.json');
    await writeFile(
      filePath,
      JSON.stringify({
        transcriptionVerifier: 'gemini-3.1-flash-lite',
        translation: 'gemini-3.5-flash',
        translationVerifier: 'gemini-3.1-flash-lite',
      }),
      'utf-8'
    );
    const store = createModelConfigStore(filePath);
    expect(await store.read()).toEqual({
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'gemini', model: 'gemini-3.5-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    });
  });
});

describe('validateModelConfig', () => {
  it('accepts a config already using the { provider, model } shape and returns it unchanged', () => {
    const config: ModelConfig = {
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'openrouter', model: 'qwen/qwen3.6-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    };
    expect(validateModelConfig(config)).toEqual(config);
  });

  it('migrates a legacy bare Gemini model-id string to { provider: "gemini", model }', () => {
    const legacy = {
      transcriptionVerifier: 'gemini-3.1-flash-lite',
      translation: 'gemini-3.5-flash',
      translationVerifier: 'gemini-3.1-flash-lite',
    };
    expect(validateModelConfig(legacy)).toEqual({
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'gemini', model: 'gemini-3.5-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    });
  });

  it('accepts an openrouter role selection with any non-empty model id', () => {
    const config: ModelConfig = {
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translationVerifier: { provider: 'openrouter', model: 'deepseek/deepseek-chat' },
    };
    expect(validateModelConfig(config)).toEqual(config);
  });

  it('rejects a config missing a role', () => {
    expect(validateModelConfig({ transcriptionVerifier: 'gemini-3.1-flash-lite', translation: 'gemini-3.5-flash' })).toBeNull();
  });

  it('rejects a legacy bare string that is not a known Gemini model id', () => {
    expect(
      validateModelConfig({ transcriptionVerifier: 'gpt-5', translation: 'gemini-3.5-flash', translationVerifier: 'gemini-3.1-flash-lite' })
    ).toBeNull();
  });

  it('rejects an openrouter selection with an empty model id', () => {
    expect(
      validateModelConfig({
        transcriptionVerifier: { provider: 'openrouter', model: '' },
        translation: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      })
    ).toBeNull();
  });

  it('rejects an unrecognized provider value', () => {
    expect(
      validateModelConfig({
        transcriptionVerifier: { provider: 'openai', model: 'gpt-5' },
        translation: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      })
    ).toBeNull();
  });

  it('rejects a non-object value', () => {
    expect(validateModelConfig(null)).toBeNull();
    expect(validateModelConfig('gemini-3.1-flash-lite')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/modelConfigStore.test.ts`
Expected: FAIL — `ModelConfig`'s type and `validateModelConfig`'s behavior don't match yet.

- [ ] **Step 4: Rewrite `modelConfigStore.ts`**

Replace the full contents of `server/src/modelConfigStore.ts`:

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MODEL_IDS, type ModelId, type RoleModelSelection } from './llmTypes.js';

export interface ModelConfig {
  transcriptionVerifier: RoleModelSelection;
  translation: RoleModelSelection;
  translationVerifier: RoleModelSelection;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
  translation: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
  translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
};

export interface ModelConfigStore {
  read(): Promise<ModelConfig>;
  write(config: ModelConfig): Promise<void>;
}

function normalizeRoleSelection(value: unknown): RoleModelSelection | null {
  if (typeof value === 'string') {
    // Legacy on-disk/PUT format: a bare Gemini model id string.
    return MODEL_IDS.includes(value as ModelId) ? { provider: 'gemini', model: value as ModelId } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.provider === 'gemini') {
    return MODEL_IDS.includes(candidate.model as ModelId) ? { provider: 'gemini', model: candidate.model as ModelId } : null;
  }
  if (candidate.provider === 'openrouter') {
    return typeof candidate.model === 'string' && candidate.model.length > 0
      ? { provider: 'openrouter', model: candidate.model }
      : null;
  }
  return null;
}

export function validateModelConfig(value: unknown): ModelConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const roles: (keyof ModelConfig)[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
  const result = {} as ModelConfig;
  for (const role of roles) {
    const normalized = normalizeRoleSelection(candidate[role]);
    if (!normalized) return null;
    result[role] = normalized;
  }
  return result;
}

export function createModelConfigStore(filePath: string): ModelConfigStore {
  return {
    async read(): Promise<ModelConfig> {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const validated = validateModelConfig(JSON.parse(raw));
        return validated ?? DEFAULT_MODEL_CONFIG;
      } catch {
        return DEFAULT_MODEL_CONFIG;
      }
    },
    async write(config: ModelConfig): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(config), 'utf-8');
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/modelConfigStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/llmTypes.ts server/src/modelConfigStore.ts server/tests/modelConfigStore.test.ts
git commit -m "Make ModelConfig provider-aware, migrating legacy bare-string Gemini config on read"
```

---

### Task 4: Skip Gemini cache creation for OpenRouter-configured roles

**Files:**
- Modify: `server/src/sermonCache.ts`
- Test: `server/tests/sermonCache.test.ts`

**Interfaces:**
- Consumes: `RoleModelSelection`, provider-aware `ModelConfig` (Task 3).
- Produces: `createRoleCaches` unchanged in name/return type, but now returns `null` for any role configured to `provider: 'openrouter'` without calling `client.caches.create`.

- [ ] **Step 1: Update the test fixture and add the new case**

In `server/tests/sermonCache.test.ts`, replace the `modelConfig` fixture:

```ts
const modelConfig: ModelConfig = {
  transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
  translation: { provider: 'gemini', model: 'gemini-3.5-flash' },
  translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
};
```

Add this new test inside the `describe('createRoleCaches', ...)` block, after the last existing `it(...)`:

```ts
  it("skips Gemini cache creation for a role configured to use OpenRouter, returning null for that role without calling client.caches.create", async () => {
    const client = fakeClientWithCaches();
    const mixedModelConfig: ModelConfig = {
      transcriptionVerifier: { provider: 'openrouter', model: 'qwen/qwen3.6-flash' },
      translation: { provider: 'gemini', model: 'gemini-3.5-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    };
    const caches = await createRoleCaches(client, mixedModelConfig, promptConfig, '', PADDING);
    expect(caches.transcriptionVerifier).toBeNull();
    expect(caches.translation).not.toBeNull();
    expect(caches.translationVerifier).not.toBeNull();
    const createCalls = (client.caches.create as any).mock.calls.map((call: any) => call[0].model);
    expect(createCalls).toEqual(['gemini-3.5-flash', 'gemini-3.1-flash-lite']);
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `cd server && npx vitest run tests/sermonCache.test.ts`
Expected: FAIL on the new test — `createOneRoleCache` still tries to call `client.caches.create` with an OpenRouter model id.

- [ ] **Step 3: Update `createOneRoleCache` and `createRoleCaches` in `sermonCache.ts`**

In `server/src/sermonCache.ts`, add a new import line alongside the existing ones at the top of the file:

```ts
import type { RoleModelSelection } from './llmTypes.js';
```

Change `createOneRoleCache`'s second parameter and add the provider guard as its first line:

```ts
async function createOneRoleCache(
  client: GeminiClient,
  selection: RoleModelSelection,
  fixedAndNotes: string,
  sharedContext: string,
  displayName: string
): Promise<SermonCacheRef | null> {
  if (selection.provider !== 'gemini') return null;

  const instruction = sharedContext.length > 0 ? `${fixedAndNotes}\n\n${sharedContext}` : fixedAndNotes;
  if (instruction.length < MIN_CACHEABLE_CHARS) return null;

  try {
    const cache = await client.caches.create({
      model: selection.model,
      config: { systemInstruction: instruction, ttl: CACHE_TTL, displayName },
    });
    return cache.name ? { name: cache.name } : null;
  } catch (error) {
    void logEvent('error', {
      event: 'role_cache_create_failed',
      role: displayName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
```

`createRoleCaches` itself needs no change — it already passes `modelConfig.transcriptionVerifier` / `.translation` / `.translationVerifier` straight through as the second argument, which now carries the `{ provider, model }` shape automatically.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/sermonCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sermonCache.ts server/tests/sermonCache.test.ts
git commit -m "Skip Gemini context-cache creation for roles configured to use OpenRouter"
```

---

### Task 5: OpenRouter-aware cost tracking

**Files:**
- Modify: `server/src/costTracker.ts`
- Test: `server/tests/costTracker.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CostTracker.recordOpenRouterUsage({ model, costUsd }: { model: string; costUsd: number }): void` — Task 6 (`openRouterCostTracking.ts`) calls this exact method.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/costTracker.test.ts`, inside the `describe('createCostTracker', ...)` block, after the existing `recordGeminiUsage` tests:

```ts
  it('adds the given OpenRouter cost directly to the running total, with no pricing lookup', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    tracker.recordOpenRouterUsage({ model: 'qwen/qwen3.6-flash', costUsd: 0.0042 });

    expect(tracker.getSessionCostUsd()).toBeCloseTo(0.0042, 6);
    expect(tracker.getLifetimeCostUsd()).toBeCloseTo(0.0042, 6);
  });

  it('accumulates OpenRouter and Gemini costs together in the same running total', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    tracker.recordGeminiUsage({
      model: 'gemini-3.1-flash-lite',
      promptTokens: 1_000_000,
      candidatesTokens: 100_000,
      cachedTokens: 0,
    });
    tracker.recordOpenRouterUsage({ model: 'qwen/qwen3.6-flash', costUsd: 0.01 });

    // Gemini: 1,000,000 non-cached @ $0.25/1M = $0.25; 100,000 output @ $1.50/1M = $0.15. Plus $0.01 OpenRouter.
    expect(tracker.getSessionCostUsd()).toBeCloseTo(0.41, 6);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/costTracker.test.ts`
Expected: FAIL — `recordOpenRouterUsage` doesn't exist yet.

- [ ] **Step 3: Add `recordOpenRouterUsage` to `costTracker.ts`**

In `server/src/costTracker.ts`, add to the `CostTracker` interface, right after `recordGeminiUsage(usage: GeminiUsage): void;`:

```ts
  recordOpenRouterUsage(usage: { model: string; costUsd: number }): void;
```

Add to the returned object in `createCostTracker`, right after the `recordGeminiUsage` method:

```ts
    recordOpenRouterUsage(usage: { model: string; costUsd: number }): void {
      addCost(usage.costUsd);
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/costTracker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/costTracker.ts server/tests/costTracker.test.ts
git commit -m "Add recordOpenRouterUsage, recording OpenRouter's own returned cost with no pricing table"
```

---

### Task 6: `openRouterCostTracking.ts` wrapper

**Files:**
- Create: `server/src/openRouterCostTracking.ts`
- Test: `server/tests/openRouterCostTracking.test.ts`

**Interfaces:**
- Consumes: `OpenRouterClient` (Task 1), `CostTracker.recordOpenRouterUsage` (Task 5).
- Produces: `withOpenRouterCostTracking(client: OpenRouterClient, tracker: CostTracker): OpenRouterClient` — Task 10 (`index.ts` wiring) calls this exact function.

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/openRouterCostTracking.test.ts
import { describe, it, expect, vi } from 'vitest';
import { withOpenRouterCostTracking } from '../src/openRouterCostTracking';
import type { OpenRouterClient } from '../src/openRouterClient';
import type { CostTracker } from '../src/costTracker';

function fakeClient(content: string, usage?: { cost?: number }): OpenRouterClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }], usage }),
      },
    },
  };
}

function fakeCostTracker(): CostTracker {
  return {
    recordGeminiUsage: vi.fn(),
    recordOpenRouterUsage: vi.fn(),
    recordDeepgramSeconds: vi.fn(),
    resetSession: vi.fn(),
    getSessionCostUsd: vi.fn().mockReturnValue(0),
    getLifetimeCostUsd: vi.fn().mockReturnValue(0),
    onUpdate: vi.fn().mockReturnValue(() => {}),
  };
}

describe('withOpenRouterCostTracking', () => {
  it('records the model and cost from response.usage.cost, and still returns the original response', async () => {
    const client = fakeClient('{}', { cost: 0.0037 });
    const tracker = fakeCostTracker();
    const wrapped = withOpenRouterCostTracking(client, tracker);

    const response = await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(response).toEqual({ choices: [{ message: { content: '{}' } }], usage: { cost: 0.0037 } });
    expect(tracker.recordOpenRouterUsage).toHaveBeenCalledWith({ model: 'qwen/qwen3.6-flash', costUsd: 0.0037 });
  });

  it('does not record usage when the response has no usage field', async () => {
    const client = fakeClient('{}', undefined);
    const tracker = fakeCostTracker();
    const wrapped = withOpenRouterCostTracking(client, tracker);

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(tracker.recordOpenRouterUsage).not.toHaveBeenCalled();
  });

  it('does not record usage when usage.cost is absent', async () => {
    const client = fakeClient('{}', {});
    const tracker = fakeCostTracker();
    const wrapped = withOpenRouterCostTracking(client, tracker);

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(tracker.recordOpenRouterUsage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/openRouterCostTracking.test.ts`
Expected: FAIL — `../src/openRouterCostTracking` doesn't exist yet.

- [ ] **Step 3: Write `openRouterCostTracking.ts`**

```ts
// server/src/openRouterCostTracking.ts
import type { OpenRouterClient } from './openRouterClient.js';
import type { CostTracker } from './costTracker.js';

export function withOpenRouterCostTracking(client: OpenRouterClient, tracker: CostTracker): OpenRouterClient {
  return {
    chat: {
      completions: {
        async create(params) {
          const response = await client.chat.completions.create(params);
          if (typeof response.usage?.cost === 'number') {
            tracker.recordOpenRouterUsage({ model: params.model, costUsd: response.usage.cost });
          }
          return response;
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/openRouterCostTracking.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/openRouterCostTracking.ts server/tests/openRouterCostTracking.test.ts
git commit -m "Add withOpenRouterCostTracking, reading real per-call cost from response.usage.cost"
```

---

### Task 7: `openRouterLimiter.ts` wrapper

**Files:**
- Create: `server/src/openRouterLimiter.ts`
- Test: `server/tests/openRouterLimiter.test.ts`

**Interfaces:**
- Consumes: `OpenRouterClient` (Task 1), the existing `GeminiCallLimiter` class (`server/src/geminiLimiter.ts`, unchanged).
- Produces: `withOpenRouterLimiter(client: OpenRouterClient, limiter: GeminiCallLimiter): OpenRouterClient` — Task 10 (`index.ts` wiring) calls this exact function.

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/openRouterLimiter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { withOpenRouterLimiter } from '../src/openRouterLimiter';
import { GeminiCallLimiter } from '../src/geminiLimiter';
import type { OpenRouterClient } from '../src/openRouterClient';

function fakeClient(): OpenRouterClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content: '{}' } }] }),
      },
    },
  };
}

describe('withOpenRouterLimiter', () => {
  it('routes chat.completions.create calls through the limiter and returns the original response', async () => {
    const client = fakeClient();
    const limiter = new GeminiCallLimiter(1);
    const runSpy = vi.spyOn(limiter, 'run');
    const wrapped = withOpenRouterLimiter(client, limiter);

    const response = await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(response).toEqual({ choices: [{ message: { content: '{}' } }] });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent calls beyond the limiter cap', async () => {
    const client = fakeClient();
    let concurrent = 0;
    let maxConcurrent = 0;
    (client.chat.completions.create as any).mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return { choices: [{ message: { content: '{}' } }] };
    });
    const limiter = new GeminiCallLimiter(2);
    const wrapped = withOpenRouterLimiter(client, limiter);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        wrapped.chat.completions.create({
          model: 'qwen/qwen3.6-flash',
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
        })
      )
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/openRouterLimiter.test.ts`
Expected: FAIL — `../src/openRouterLimiter` doesn't exist yet.

- [ ] **Step 3: Write `openRouterLimiter.ts`**

```ts
// server/src/openRouterLimiter.ts
import type { OpenRouterClient } from './openRouterClient.js';
import type { GeminiCallLimiter } from './geminiLimiter.js';

export function withOpenRouterLimiter(client: OpenRouterClient, limiter: GeminiCallLimiter): OpenRouterClient {
  return {
    chat: {
      completions: {
        create(params) {
          return limiter.run(() => client.chat.completions.create(params));
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/openRouterLimiter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/openRouterLimiter.ts server/tests/openRouterLimiter.test.ts
git commit -m "Add withOpenRouterLimiter, reusing GeminiCallLimiter's semaphore for OpenRouter calls"
```

---

### Task 8: `OpenRouterProvider`

**Files:**
- Create: `server/src/openRouterProvider.ts`
- Test: `server/tests/openRouterProvider.test.ts`

**Interfaces:**
- Consumes: `OpenRouterClient`, `OpenRouterMessage` (Task 1); `buildTranslateTaskText`, `buildTranslateBacklogTaskText`, `buildTranscriptionVerifierTaskText`, `buildTranslationVerifierTaskText`, and the five fixed-rules constants (Task 2, `llmPrompts.ts`); `LlmProvider` (`llmTypes.ts`, unchanged); `SermonCacheRef` (`gemini.ts`, unchanged); `TranscriptionCheckResult` (`transcriptionVerifier.ts`, unchanged); `VerificationItem`, `VerificationResult` (`translationVerifier.ts`, unchanged).
- Produces: `OpenRouterProvider` class implementing `LlmProvider`, constructed as `new OpenRouterProvider(client: OpenRouterClient, model: string, notes: string)` — Task 9 (`llmRegistry.ts`) constructs this exact class.

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/openRouterProvider.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OpenRouterProvider } from '../src/openRouterProvider';
import type { OpenRouterClient } from '../src/openRouterClient';

function fakeClient(content: string): OpenRouterClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }),
      },
    },
  };
}

describe('OpenRouterProvider', () => {
  it('translate() sends the model, a system message with cache_control containing the notes, and a json_schema response_format', async () => {
    const client = fakeClient('{"zh":"你好"}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'custom notes');
    const result = await provider.translate('Hello', ['zh'], [], null);
    expect(result).toEqual({ zh: '你好' });

    const call = (client.chat.completions.create as any).mock.calls[0][0];
    expect(call.model).toBe('qwen/qwen3.6-flash');
    expect(call.messages[0].role).toBe('system');
    expect(call.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(call.messages[0].content[0].text).toContain('custom notes');
    expect(call.messages[1].role).toBe('user');
    expect(call.messages[1].content).toContain('Hello');
    expect(call.response_format.type).toBe('json_schema');
  });

  it('skips the API call and returns an empty object when no languages are active', async () => {
    const client = fakeClient('{}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.translate('Hello', [], [], null);
    expect(result).toEqual({});
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('translateBacklog() returns translations in the same order as the input lines', async () => {
    const client = fakeClient('{"translations":["你好","再见"]}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.translateBacklog(['Hello', 'Goodbye'], 'zh', null);
    expect(result).toEqual(['你好', '再见']);
  });

  it('translateBacklog() skips the API call and returns an empty array for an empty backlog', async () => {
    const client = fakeClient('{"translations":[]}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.translateBacklog([], 'zh', null);
    expect(result).toEqual([]);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('verifyTranscription() returns the parsed safe/reason result', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.verifyTranscription('Jesus loves you', [], null);
    expect(result).toEqual({ safe: true, reason: '' });
  });

  it('verifyTranscription() treats a well-formed but incomplete response as unsafe', async () => {
    const client = fakeClient('{"unexpected":"shape"}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.verifyTranscription('Hello', [], null);
    expect(result).toEqual({ safe: false, reason: 'malformed response' });
  });

  it('verifyTranslations() batches every item into a single call', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""},"ko":{"safe":true,"reason":""}}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.verifyTranslations(
      [
        { id: 'zh', english: 'Hello', translated: '你好' },
        { id: 'ko', english: 'Hello', translated: '안녕' },
      ],
      null
    );
    expect(result).toEqual({ zh: { safe: true, reason: '' }, ko: { safe: true, reason: '' } });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('verifyTranslations() skips the API call and returns an empty object when there are no items', async () => {
    const client = fakeClient('{}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.verifyTranslations([], null);
    expect(result).toEqual({});
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('retries once with json_object mode when the model rejects json_schema response_format, keeping the same system message', async () => {
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
    const provider = new OpenRouterProvider(client, 'some-model', 'custom notes');
    const result = await provider.translate('Hello', ['zh'], [], null);
    expect(result).toEqual({ zh: '你好' });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    const secondCall = (client.chat.completions.create as any).mock.calls[1][0];
    expect(secondCall.response_format).toEqual({ type: 'json_object' });
    expect(secondCall.messages[0].content[0].text).toContain('custom notes');
  });

  it('does not retry and rethrows when the failure is unrelated to response_format support', async () => {
    const client: OpenRouterClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
        },
      },
    };
    const provider = new OpenRouterProvider(client, 'some-model', 'notes');
    await expect(provider.translate('Hello', ['zh'], [], null)).rejects.toThrow('401 Unauthorized');
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/openRouterProvider.test.ts`
Expected: FAIL — `../src/openRouterProvider` doesn't exist yet.

- [ ] **Step 3: Write `openRouterProvider.ts`**

```ts
// server/src/openRouterProvider.ts
import type { OpenRouterClient, OpenRouterMessage } from './openRouterClient.js';
import type { LlmProvider } from './llmTypes.js';
import type { SermonCacheRef } from './gemini.js';
import type { TranscriptionCheckResult } from './transcriptionVerifier.js';
import type { VerificationItem, VerificationResult } from './translationVerifier.js';
import {
  TRANSLATION_FIXED_RULES,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_INTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_OUTRO,
  buildTranslateTaskText,
  buildTranslateBacklogTaskText,
  buildTranscriptionVerifierTaskText,
  buildTranslationVerifierTaskText,
} from './llmPrompts.js';

function isUnsupportedResponseFormatError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /response_format|json_schema/i.test(message);
}

export class OpenRouterProvider implements LlmProvider {
  constructor(
    private readonly client: OpenRouterClient,
    private readonly model: string,
    private readonly notes: string
  ) {}

  async translate(
    englishText: string,
    languageCodes: string[],
    precedingContext: string[],
    _cacheRef: SermonCacheRef | null
  ): Promise<Record<string, string>> {
    if (languageCodes.length === 0) return {};
    const properties: Record<string, { type: string }> = {};
    for (const code of languageCodes) properties[code] = { type: 'string' };
    const userText = buildTranslateTaskText(languageCodes, englishText, precedingContext);
    const systemText = `${this.notes}\n\n${TRANSLATION_FIXED_RULES}`;
    const parsed = await this.requestJson('translate', systemText, userText, {
      type: 'object',
      properties,
      required: languageCodes,
      additionalProperties: false,
    });
    return (parsed ?? {}) as Record<string, string>;
  }

  async translateBacklog(
    englishLines: string[],
    languageCode: string,
    _cacheRef: SermonCacheRef | null
  ): Promise<string[]> {
    if (englishLines.length === 0) return [];
    const userText = buildTranslateBacklogTaskText(englishLines, languageCode);
    const systemText = `${this.notes}\n\n${TRANSLATION_FIXED_RULES}`;
    const parsed = (await this.requestJson('translate_backlog', systemText, userText, {
      type: 'object',
      properties: { translations: { type: 'array', items: { type: 'string' } } },
      required: ['translations'],
      additionalProperties: false,
    })) as { translations?: string[] } | null;
    return parsed?.translations ?? [];
  }

  async verifyTranscription(
    english: string,
    precedingContext: string[],
    _cacheRef: SermonCacheRef | null
  ): Promise<TranscriptionCheckResult> {
    const userText = buildTranscriptionVerifierTaskText(english, precedingContext);
    const systemText = `${TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO}\n\n${this.notes}\n\n${TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO}`;
    const parsed = await this.requestJson('verify_transcription', systemText, userText, {
      type: 'object',
      properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['safe', 'reason'],
      additionalProperties: false,
    });
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).safe === 'boolean' &&
      typeof (parsed as Record<string, unknown>).reason === 'string'
    ) {
      return parsed as TranscriptionCheckResult;
    }
    return { safe: false, reason: 'malformed response' };
  }

  async verifyTranslations(
    items: VerificationItem[],
    _cacheRef: SermonCacheRef | null
  ): Promise<Record<string, VerificationResult>> {
    if (items.length === 0) return {};
    const properties: Record<string, Record<string, unknown>> = {};
    for (const item of items) {
      properties[item.id] = {
        type: 'object',
        properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['safe', 'reason'],
        additionalProperties: false,
      };
    }
    const userText = buildTranslationVerifierTaskText(items);
    const systemText = `${TRANSLATION_VERIFIER_FIXED_RULES_INTRO}\n\n${this.notes}\n\n${TRANSLATION_VERIFIER_FIXED_RULES_OUTRO}`;
    const parsed = await this.requestJson('verify_translations', systemText, userText, {
      type: 'object',
      properties,
      required: items.map((item) => item.id),
      additionalProperties: false,
    });
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, VerificationResult>) : {};
  }

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

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
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
      });
      return JSON.parse(response.choices[0]?.message.content ?? '{}');
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/openRouterProvider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/openRouterProvider.ts server/tests/openRouterProvider.test.ts
git commit -m "Add OpenRouterProvider implementing LlmProvider via the openai SDK"
```

---

### Task 9: `llmRegistry.ts` provider branching

**Files:**
- Modify: `server/src/llmRegistry.ts`
- Test: `server/tests/llmRegistry.test.ts`

**Interfaces:**
- Consumes: `RoleModelSelection` (Task 3), `OpenRouterClient` (Task 1), `OpenRouterProvider` (Task 8), `GeminiProvider` (unchanged).
- Produces: `LlmClients { gemini: GeminiClient; openRouter: OpenRouterClient | null }`, `getProvider(selection: RoleModelSelection, notes: string, clients: LlmClients): LlmProvider` — Task 10 (`wsServer.ts`, `index.ts`) uses this exact signature.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `server/tests/llmRegistry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { getProvider, type LlmClients } from '../src/llmRegistry';
import { GeminiProvider } from '../src/geminiProvider';
import { OpenRouterProvider } from '../src/openRouterProvider';
import type { GeminiClient } from '../src/gemini';
import type { OpenRouterClient } from '../src/openRouterClient';

function fakeGeminiClient(): GeminiClient {
  return {
    models: { generateContent: vi.fn() },
    caches: { create: vi.fn(), delete: vi.fn() },
  };
}

function fakeOpenRouterClient(): OpenRouterClient {
  return { chat: { completions: { create: vi.fn() } } };
}

describe('getProvider', () => {
  it('returns a GeminiProvider for a gemini selection', () => {
    const clients: LlmClients = { gemini: fakeGeminiClient(), openRouter: null };
    const provider = getProvider({ provider: 'gemini', model: 'gemini-3.1-flash-lite' }, 'notes', clients);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('returns an OpenRouterProvider for an openrouter selection when an OpenRouter client is configured', () => {
    const clients: LlmClients = { gemini: fakeGeminiClient(), openRouter: fakeOpenRouterClient() };
    const provider = getProvider({ provider: 'openrouter', model: 'qwen/qwen3.6-flash' }, 'notes', clients);
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it('throws when an openrouter selection is requested but no OpenRouter client is configured', () => {
    const clients: LlmClients = { gemini: fakeGeminiClient(), openRouter: null };
    expect(() => getProvider({ provider: 'openrouter', model: 'qwen/qwen3.6-flash' }, 'notes', clients)).toThrow(
      'OPENROUTER_API_KEY is not configured'
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/llmRegistry.test.ts`
Expected: FAIL — `getProvider`'s current signature takes a `ModelId` and a bare `GeminiClient`, not a `RoleModelSelection`/`LlmClients`.

- [ ] **Step 3: Rewrite `llmRegistry.ts`**

Replace the full contents of `server/src/llmRegistry.ts`:

```ts
import type { GeminiClient } from './gemini.js';
import type { OpenRouterClient } from './openRouterClient.js';
import { GeminiProvider } from './geminiProvider.js';
import { OpenRouterProvider } from './openRouterProvider.js';
import type { LlmProvider, RoleModelSelection } from './llmTypes.js';

export interface LlmClients {
  gemini: GeminiClient;
  openRouter: OpenRouterClient | null;
}

export function getProvider(selection: RoleModelSelection, notes: string, clients: LlmClients): LlmProvider {
  if (selection.provider === 'gemini') {
    return new GeminiProvider(clients.gemini, selection.model, notes);
  }
  if (!clients.openRouter) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }
  return new OpenRouterProvider(clients.openRouter, selection.model, notes);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/llmRegistry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/llmRegistry.ts server/tests/llmRegistry.test.ts
git commit -m "Branch getProvider on RoleModelSelection.provider, adding OpenRouterProvider support"
```

---

### Task 10: Wire `LlmClients` into `wsServer.ts` and `index.ts`

**Files:**
- Modify: `server/src/wsServer.ts:38-50,138-142`
- Modify: `server/src/index.ts`
- Modify: `server/.env.example`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `LlmClients`, `getProvider` (Task 9); `withOpenRouterCostTracking` (Task 6); `withOpenRouterLimiter` (Task 7); `createOpenRouterClient` (Task 1).
- Produces: `WsServerDeps` gains `llmClients: LlmClients` (in addition to the existing `geminiClient: GeminiClient`, which stays — it's still used directly for `createRoleCaches`/`deleteRoleCaches`).

- [ ] **Step 1: Update `WsServerDeps` and the three `getProvider` call sites in `wsServer.ts`**

In `server/src/wsServer.ts`, add an import:

```ts
import type { LlmClients } from './llmRegistry.js';
```

Add a field to the `WsServerDeps` interface, right after `geminiClient: GeminiClient;`:

```ts
  llmClients: LlmClients;
```

Change the three `getProvider(...)` calls (currently at lines 139-141) from passing `deps.geminiClient` to passing `deps.llmClients`:

```ts
            deps.session.providers = {
              transcriptionVerifier: getProvider(modelConfig.transcriptionVerifier, promptConfig.transcriptionVerifier, deps.llmClients),
              translation: getProvider(modelConfig.translation, promptConfig.translation, deps.llmClients),
              translationVerifier: getProvider(modelConfig.translationVerifier, promptConfig.translationVerifier, deps.llmClients),
            };
```

`createRoleCaches`/`deleteRoleCaches` calls, which use `deps.geminiClient` directly, are unchanged.

- [ ] **Step 2: Update the `wsServer.test.ts` fixture**

In `server/tests/wsServer.test.ts`, inside the `attachWsServer({...})` call in `beforeEach` (around line 146), add `llmClients` right after `geminiClient,`:

```ts
    attachWsServer({
      httpServer,
      session,
      geminiClient,
      llmClients: { gemini: geminiClient, openRouter: null },
      deepgramApiKey: 'fake-key',
```

- [ ] **Step 3: Run the wsServer suite to verify it still passes**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: PASS — behavior is unchanged since `openRouter: null` and the default `ModelConfig` never requests an OpenRouter provider.

- [ ] **Step 4: Wire real clients in `index.ts`**

In `server/src/index.ts`, add imports:

```ts
import { createOpenRouterClient } from './openRouterClient.js';
import { withOpenRouterCostTracking } from './openRouterCostTracking.js';
import { withOpenRouterLimiter } from './openRouterLimiter.js';
```

Leave `requiredEnvVars` as `['DEEPGRAM_API_KEY', 'GEMINI_API_KEY']` — `OPENROUTER_API_KEY` stays optional.

After the existing `geminiClient` construction, add:

```ts
const openRouterLimiter = new GeminiCallLimiter();
const openRouterClient = process.env.OPENROUTER_API_KEY
  ? withOpenRouterCostTracking(
      withOpenRouterLimiter(createOpenRouterClient(process.env.OPENROUTER_API_KEY), openRouterLimiter),
      costTracker
    )
  : null;
```

Change the `attachWsServer({...})` call to include `llmClients`, right after `geminiClient,`:

```ts
attachWsServer({
  httpServer,
  session,
  geminiClient,
  llmClients: { gemini: geminiClient, openRouter: openRouterClient },
  deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
  createDeepgramConnection,
  sermonDocStore,
  feedbackStore,
  costTracker,
  modelConfigStore,
  promptConfigStore,
  translationFlagDisplayStore,
});
```

- [ ] **Step 5: Add `OPENROUTER_API_KEY` to `.env.example`**

In `server/.env.example`, add a new line after `GEMINI_API_KEY=`:

```
OPENROUTER_API_KEY=
```

- [ ] **Step 6: Run the full server build and test suite**

Run: `cd server && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/wsServer.ts server/src/index.ts server/.env.example server/tests/wsServer.test.ts
git commit -m "Wire OpenRouter client construction and LlmClients through wsServer and index"
```

---

### Task 11: Known-OpenRouter-models store and admin routes

**Files:**
- Create: `server/src/openRouterModelsStore.ts`
- Test: `server/tests/openRouterModelsStore.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Test: `server/tests/app.test.ts`

**Interfaces:**
- Consumes: nothing new for the store itself.
- Produces: `OpenRouterModelsStore { read(): Promise<string[]>; addModel(model: string): Promise<string[]> }`, `createOpenRouterModelsStore(filePath): OpenRouterModelsStore` — Task 12 (admin UI) fetches `GET/POST /admin/openrouter-models`, which this task adds.

- [ ] **Step 1: Write the failing store tests**

```ts
// server/tests/openRouterModelsStore.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouterModelsStore } from '../src/openRouterModelsStore';

describe('createOpenRouterModelsStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns an empty list when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openrouter-models-test-'));
    const store = createOpenRouterModelsStore(join(tempDir, 'openrouter-models.json'));
    expect(await store.read()).toEqual([]);
  });

  it('adds a new model id and persists it, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openrouter-models-test-'));
    const filePath = join(tempDir, 'nested', 'openrouter-models.json');
    const store = createOpenRouterModelsStore(filePath);
    const updated = await store.addModel('qwen/qwen3.6-flash');
    expect(updated).toEqual(['qwen/qwen3.6-flash']);
    expect(await store.read()).toEqual(['qwen/qwen3.6-flash']);
  });

  it('does not duplicate an already-known model id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openrouter-models-test-'));
    const store = createOpenRouterModelsStore(join(tempDir, 'openrouter-models.json'));
    await store.addModel('qwen/qwen3.6-flash');
    const updated = await store.addModel('qwen/qwen3.6-flash');
    expect(updated).toEqual(['qwen/qwen3.6-flash']);
  });

  it('falls back to an empty list when the file is corrupt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openrouter-models-test-'));
    const filePath = join(tempDir, 'openrouter-models.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const store = createOpenRouterModelsStore(filePath);
    expect(await store.read()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run tests/openRouterModelsStore.test.ts`
Expected: FAIL — `../src/openRouterModelsStore` doesn't exist yet.

- [ ] **Step 3: Write `openRouterModelsStore.ts`**

```ts
// server/src/openRouterModelsStore.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface OpenRouterModelsStore {
  read(): Promise<string[]>;
  addModel(model: string): Promise<string[]>;
}

function validateModelsList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

export function createOpenRouterModelsStore(filePath: string): OpenRouterModelsStore {
  async function readList(): Promise<string[]> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const validated = validateModelsList(JSON.parse(raw));
      return validated ?? [];
    } catch {
      return [];
    }
  }

  async function writeList(models: string[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(models), 'utf-8');
  }

  return {
    read: readList,
    async addModel(model: string): Promise<string[]> {
      const existing = await readList();
      if (existing.includes(model)) return existing;
      const updated = [...existing, model];
      await writeList(updated);
      return updated;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run tests/openRouterModelsStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `app.test.ts` additions**

In `server/tests/app.test.ts`, add an import:

```ts
import { createOpenRouterModelsStore } from '../src/openRouterModelsStore';
```

Add a field to `testDeps()`'s returned object, right after `translationFlagDisplayStore: ...,`:

```ts
    openRouterModelsStore: createOpenRouterModelsStore(
      join(tmpdir(), `openrouter-models-app-test-${Date.now()}-${Math.random()}.json`)
    ),
```

Replace the `newConfig` object inside the existing `'saves a valid config and returns it on a subsequent read'` test (in the `describe('GET/PUT /admin/model-config', ...)` block) so it exercises the new shape end-to-end:

```ts
    const newConfig = {
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'openrouter', model: 'qwen/qwen3.6-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    };
```

Add a new describe block at the end of the file, after the closing `});` of `describe('GET/PUT /admin/model-config', ...)`:

```ts
describe('GET/POST /admin/openrouter-models', () => {
  it('returns 401 without the admin passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/admin/openrouter-models');
    expect(response.status).toBe(401);
  });

  it('returns an empty list on first read', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/openrouter-models')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ models: [] });
  });

  it('adds a model id and returns it on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const postResponse = await request(app)
      .post('/admin/openrouter-models')
      .set('x-admin-passcode', 'test-passcode')
      .send({ model: 'qwen/qwen3.6-flash' });
    expect(postResponse.status).toBe(200);
    expect(postResponse.body).toEqual({ models: ['qwen/qwen3.6-flash'] });

    const getResponse = await request(app).get('/admin/openrouter-models').set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual({ models: ['qwen/qwen3.6-flash'] });
  });

  it('rejects an empty model id with 400', async () => {
    const response = await request(createApp(testDeps()))
      .post('/admin/openrouter-models')
      .set('x-admin-passcode', 'test-passcode')
      .send({ model: '' });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 6: Run to verify the new/changed tests fail**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: FAIL — `AppDeps` has no `openRouterModelsStore` field yet, and the routes don't exist.

- [ ] **Step 7: Add the routes and `AppDeps` field in `app.ts`**

In `server/src/app.ts`, add an import:

```ts
import type { OpenRouterModelsStore } from './openRouterModelsStore.js';
```

Add a field to `AppDeps`, right after `promptConfigStore: PromptConfigStore;`:

```ts
  openRouterModelsStore: OpenRouterModelsStore;
```

Add two routes, right after the existing `app.put('/admin/prompt-config', ...)` block and before `app.get('/admin/translation-flag-display', ...)`:

```ts
  app.get('/admin/openrouter-models', adminAuth, async (_req, res) => {
    res.json({ models: await deps.openRouterModelsStore.read() });
  });

  app.post('/admin/openrouter-models', adminAuth, async (req, res) => {
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    if (model.length === 0) {
      res.status(400).json({ error: 'model is required' });
      return;
    }
    const models = await deps.openRouterModelsStore.addModel(model);
    res.json({ models });
  });
```

- [ ] **Step 8: Run to verify the tests pass**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: PASS.

- [ ] **Step 9: Wire the store into `index.ts`**

In `server/src/index.ts`, add an import:

```ts
import { createOpenRouterModelsStore } from './openRouterModelsStore.js';
```

Add a store instance, right after the existing `promptConfigStore` line:

```ts
const openRouterModelsStore = createOpenRouterModelsStore(
  process.env.OPENROUTER_MODELS_FILE_PATH ?? 'data/openrouter-models.json'
);
```

Add it to the `createApp({...})` call, right after `promptConfigStore,`:

```ts
  openRouterModelsStore,
```

- [ ] **Step 10: Run the full server build and test suite**

Run: `cd server && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS, no type errors.

- [ ] **Step 11: Commit**

```bash
git add server/src/openRouterModelsStore.ts server/tests/openRouterModelsStore.test.ts server/src/app.ts server/src/index.ts server/tests/app.test.ts
git commit -m "Add openRouterModelsStore and GET/POST /admin/openrouter-models"
```

---

### Task 12: Admin UI — provider toggle and add-model control

**Files:**
- Modify: `web/app/admin/page.tsx`

**Interfaces:**
- Consumes: `GET/PUT /admin/model-config` (existing, now returns/accepts `{ provider, model }` per role — Task 3/11), `GET/POST /admin/openrouter-models` (Task 11).
- Produces: no new exports (this is a page component).

- [ ] **Step 1: Update the type definitions at the top of `web/app/admin/page.tsx`**

Replace:

```ts
type ModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';
type Role = 'transcriptionVerifier' | 'translation' | 'translationVerifier';

interface ModelConfig {
  transcriptionVerifier: ModelId;
  translation: ModelId;
  translationVerifier: ModelId;
}
```

with:

```ts
type GeminiModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';
type Provider = 'gemini' | 'openrouter';
type RoleModelSelection = { provider: 'gemini'; model: GeminiModelId } | { provider: 'openrouter'; model: string };
type Role = 'transcriptionVerifier' | 'translation' | 'translationVerifier';

interface ModelConfig {
  transcriptionVerifier: RoleModelSelection;
  translation: RoleModelSelection;
  translationVerifier: RoleModelSelection;
}
```

Replace `const MODEL_IDS: ModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];` with:

```ts
const GEMINI_MODEL_IDS: GeminiModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];
```

- [ ] **Step 2: Add OpenRouter-models state and fetch it in `loadAll`**

Add a new state declaration, right after the `displayConfig`/`displaySaveStatus`/`displayError` block:

```ts
  const [openRouterModels, setOpenRouterModels] = useState<string[]>([]);
  const [newModelInputs, setNewModelInputs] = useState<Record<Role, string>>({
    transcriptionVerifier: '',
    translation: '',
    translationVerifier: '',
  });
```

Inside `loadAll`, replace the `Promise.all([...])` call and the status/response handling that follows it:

```ts
    try {
      const [modelResponse, promptResponse, displayResponse, openRouterModelsResponse] = await Promise.all([
        fetch(`${API_URL}/admin/model-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/prompt-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/translation-flag-display`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/openrouter-models`, { headers: { 'x-admin-passcode': candidatePasscode } }),
      ]);

      if (
        modelResponse.status === 401 ||
        promptResponse.status === 401 ||
        displayResponse.status === 401 ||
        openRouterModelsResponse.status === 401
      ) {
        window.sessionStorage.removeItem('adminPasscode');
        setAuthorized(false);
        setAuthError('Incorrect passcode.');
        return;
      }

      setModelConfig(await modelResponse.json());
      const promptData = await promptResponse.json();
      setNotes(promptData.notes);
      setFixedRules(promptData.fixedRules);
      setDisplayConfig(await displayResponse.json());
      const openRouterModelsData = await openRouterModelsResponse.json();
      setOpenRouterModels(openRouterModelsData.models);

      window.sessionStorage.setItem('adminPasscode', candidatePasscode);
      setPasscode(candidatePasscode);
      setAuthorized(true);
    } catch {
      setAuthError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCheckingAuth(false);
    }
```

- [ ] **Step 3: Add the `addOpenRouterModel` function**

Add this function right after `saveModelConfig`:

```ts
  async function addOpenRouterModel(role: Role) {
    const model = newModelInputs[role].trim();
    if (model.length === 0 || !modelConfig) return;
    try {
      const response = await fetch(`${API_URL}/admin/openrouter-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) return;
      const data = await response.json();
      setOpenRouterModels(data.models);
      setModelConfig({ ...modelConfig, [role]: { provider: 'openrouter', model } });
      setNewModelInputs({ ...newModelInputs, [role]: '' });
      setModelSaveStatus('idle');
    } catch {
      // Adding a model id is a convenience action; a network failure here just
      // leaves the input as-is for the admin to retry, same posture as the
      // existing save actions on this page.
    }
  }
```

- [ ] **Step 4: Replace the Models section JSX**

Replace the entire `<div className="w-full max-w-xl flex flex-col gap-3">` ... `</div>` block under `<h2 className="text-lg font-medium">Models</h2>` with:

```tsx
      <div className="w-full max-w-xl flex flex-col gap-3">
        <h2 className="text-lg font-medium">Models</h2>
        {modelConfig &&
          ROLES.map((role) => {
            const selection = modelConfig[role];
            return (
              <div key={role} className="flex flex-col gap-1 border-b pb-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-medium">{ROLE_LABELS[role]}</label>
                  <select
                    value={selection.provider}
                    onChange={(event) => {
                      const provider = event.target.value as Provider;
                      const nextSelection: RoleModelSelection =
                        provider === 'gemini'
                          ? { provider: 'gemini', model: GEMINI_MODEL_IDS[0] }
                          : { provider: 'openrouter', model: openRouterModels[0] ?? '' };
                      setModelConfig({ ...modelConfig, [role]: nextSelection });
                      setModelSaveStatus('idle');
                    }}
                    className="border rounded p-1 text-sm"
                  >
                    <option value="gemini">Gemini</option>
                    <option value="openrouter">OpenRouter</option>
                  </select>
                </div>
                {selection.provider === 'gemini' ? (
                  <select
                    value={selection.model}
                    onChange={(event) => {
                      setModelConfig({
                        ...modelConfig,
                        [role]: { provider: 'gemini', model: event.target.value as GeminiModelId },
                      });
                      setModelSaveStatus('idle');
                    }}
                    className="border rounded p-1 text-sm"
                  >
                    {GEMINI_MODEL_IDS.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="flex flex-col gap-1">
                    <select
                      value={selection.model}
                      onChange={(event) => {
                        setModelConfig({ ...modelConfig, [role]: { provider: 'openrouter', model: event.target.value } });
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
                )}
              </div>
            );
          })}
        <div className="flex items-center gap-3">
          <button
            onClick={saveModelConfig}
            disabled={modelSaveStatus === 'saving'}
            className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
          >
            Save models
          </button>
          {modelSaveStatus === 'saved' && <p className="text-sm text-green-600">Saved.</p>}
        </div>
        {modelError && <p className="text-sm text-destructive">{modelError}</p>}
      </div>
```

- [ ] **Step 5: Type-check and build the web app**

Run: `cd web && npm run build`
Expected: builds successfully with no type errors.

- [ ] **Step 6: Manual verification**

Start the server (`cd server && npm run dev`) and the web app (`cd web && npm run dev`), open `/admin`, enter the configured passcode, and confirm:
- Each role shows a Gemini/OpenRouter toggle next to its model dropdown.
- Switching a role to OpenRouter shows an empty "No models added yet" dropdown plus a text input and "Add" button.
- Typing a model id (e.g. `qwen/qwen3.6-flash`) and clicking "Add" makes it appear in that role's dropdown, selects it, and reloading the page still shows it as a known option for every role.
- Clicking "Save models" persists the selection; reloading the page shows the same provider/model chosen.

- [ ] **Step 7: Commit**

```bash
git add web/app/admin/page.tsx
git commit -m "Add a provider toggle and OpenRouter model-id picker to the admin models section"
```

---

### Task 13: Final full-suite verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full server test suite and type-check**

Run: `cd server && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS, every test file green, no type errors.

- [ ] **Step 2: Run the web build**

Run: `cd web && npm run build`
Expected: builds successfully.

- [ ] **Step 3: Confirm default behavior is unchanged**

Run: `cd server && npx vitest run tests/wsServer.test.ts tests/sermonCache.test.ts tests/app.test.ts`
Expected: PASS — these exercise the all-Gemini default path end-to-end and must behave exactly as before this plan started.

- [ ] **Step 4: Final commit (only if any of the above required fixes)**

If Steps 1-3 required any fixes, stage and commit them:

```bash
git add -A
git commit -m "Fix issues found in final OpenRouter provider verification pass"
```

If no fixes were needed, this task is complete with no commit.
