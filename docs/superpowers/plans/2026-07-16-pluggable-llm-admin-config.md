# Pluggable LLM Providers & Admin Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick which Gemini model handles each of the three LLM roles (transcription verification, translation, translation verification) and edit each role's situational prompt notes from a new passcode-gated admin page, while closing a real token-cost gap where static instruction text is resent in full on every call instead of being cached — all without changing today's default behavior or cost.

**Architecture:** An `LlmProvider` interface wraps the existing Gemini call functions (parametrized by model instead of a hardcoded constant); a `getProvider(model, notes, client)` registry resolves one provider per role at session Start, using model/notes persisted in two new JSON-file stores (following the existing `feedbackStore.ts` pattern). The single shared Gemini cache becomes three per-role caches, each combining that role's fixed (non-editable) safety rules with its editable notes and the existing shared sermon/feedback material — closing the gap where fixed instructions were never cached at all. A new passcode-gated `/admin/*` REST surface and `web/app/admin` page let an operator change model/notes per role.

**Tech Stack:** Node/TypeScript/Express/vitest (server), Next.js 16 App Router/React 19/Tailwind (web) — no new runtime dependencies.

## Global Constraints

- Model config defaults to today's actual behavior: all three roles on `gemini-3.1-flash-lite`. Shipping this must not change running cost until an admin explicitly changes a dropdown.
- The safety-critical fixed rules in each role's prompt (polarity/negation preservation, "how to refer to God/Jesus/Holy Spirit", inversion-only-flagging) are hardcoded and never exposed for editing. Only the situational/style "notes" are admin-editable.
- Config changes (model or notes) take effect on the **next** session Start, not hot-reloaded into an already-running session.
- `/admin/*` routes are gated by a single shared passcode (`ADMIN_PASSCODE` env var); missing/unset passcode fails closed (401), never open. No other existing route gains auth.
- No new npm dependencies for the frontend admin page — use plain HTML `<select>`/`<textarea>` with Tailwind utility classes, matching `capture/page.tsx`'s actual convention (not the installed-but-unused shadcn `Button`/`Card`).
- Follow the existing flat `server/src/*.ts` layout — no new subdirectories.

---

### Task 1: Cost tracking becomes model-aware

**Files:**
- Modify: `server/src/costPricing.ts`
- Modify: `server/src/costTracker.ts`
- Modify: `server/src/geminiCostTracking.ts`
- Test: `server/tests/costTracker.test.ts`
- Test: `server/tests/geminiCostTracking.test.ts`

**Interfaces:**
- Produces: `GEMINI_PRICING_USD_PER_MILLION_TOKENS` gains a `'gemini-3.5-flash'` entry. `CostTracker.recordGeminiUsage(usage: GeminiUsage)` where `GeminiUsage` gains a required `model: string` field, and looks up pricing for that specific model instead of a hardcoded string.

This is a prerequisite the original spec didn't call out explicitly: `costTracker.recordGeminiUsage` currently hardcodes `GEMINI_PRICING_USD_PER_MILLION_TOKENS['gemini-3.1-flash-lite']` regardless of which model actually made the call. Once `gemini-3.5-flash` becomes selectable in a later task, every 3.5-Flash call would silently get billed at Flash-Lite's ~6x-cheaper output rate unless this is fixed first.

- [ ] **Step 1: Add the `gemini-3.5-flash` pricing entry**

Edit `server/src/costPricing.ts`:

```ts
// Rates verified against Google's and Deepgram's published pricing as of mid-2026
// (see README.md's "Cost analysis" section, which these values match exactly).
// There is no live pricing API for either provider — update these manually if
// Google or Deepgram change their published rates.

export const GEMINI_PRICING_USD_PER_MILLION_TOKENS = {
  'gemini-3.1-flash-lite': {
    input: 0.25,
    cachedInput: 0.025,
    output: 1.5,
  },
  'gemini-3.5-flash': {
    input: 1.5,
    // Google publishes a 90% cached-input discount across Gemini models; verify
    // this exact figure against live pricing before relying on it for budgeting.
    cachedInput: 0.15,
    output: 9.0,
  },
} as const;

export const DEEPGRAM_PRICING_USD_PER_MINUTE = {
  'nova-3': 0.0077,
} as const;
```

- [ ] **Step 2: Write the failing test for model-aware pricing**

Add to `server/tests/costTracker.test.ts` (after the existing "charges non-cached input..." test, inside the `describe('createCostTracker')` block):

```ts
  it('charges gemini-3.5-flash usage at its own (pricier) rate, not gemini-3.1-flash-lite\'s', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    tracker.recordGeminiUsage({
      model: 'gemini-3.5-flash',
      promptTokens: 1_000_000,
      candidatesTokens: 100_000,
      cachedTokens: 200_000,
    });

    // 800k non-cached @ $1.50/1M = $1.20; 200k cached @ $0.15/1M = $0.03; 100k output @ $9.00/1M = $0.90
    expect(tracker.getSessionCostUsd()).toBeCloseTo(2.13, 6);
  });

  it('defaults to gemini-3.1-flash-lite pricing when model is omitted, for backward compatibility', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    tracker.recordGeminiUsage({ promptTokens: 1_000_000, candidatesTokens: 100_000, cachedTokens: 200_000 });

    expect(tracker.getSessionCostUsd()).toBeCloseTo(0.355, 6);
  });
```

Also update the existing test at the top of the file to include `model`:

```ts
  it('charges non-cached input at the standard rate, cached input at the discounted rate, and candidates at the output rate', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    // 1,000,000 prompt tokens, 200,000 of which came from cache; 100,000 candidate tokens.
    tracker.recordGeminiUsage({
      model: 'gemini-3.1-flash-lite',
      promptTokens: 1_000_000,
      candidatesTokens: 100_000,
      cachedTokens: 200_000,
    });

    // 800k non-cached @ $0.25/1M = $0.20; 200k cached @ $0.025/1M = $0.005; 100k output @ $1.50/1M = $0.15
    expect(tracker.getSessionCostUsd()).toBeCloseTo(0.355, 6);
    expect(tracker.getLifetimeCostUsd()).toBeCloseTo(0.355, 6);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/costTracker.test.ts`
Expected: FAIL — `recordGeminiUsage` doesn't accept/use a `model` field yet, and the new pricing entry doesn't exist.

- [ ] **Step 4: Make `recordGeminiUsage` model-aware**

Edit `server/src/costTracker.ts`:

```ts
export interface GeminiUsage {
  model?: string;
  promptTokens: number;
  candidatesTokens: number;
  cachedTokens: number;
}
```

Replace the `recordGeminiUsage` implementation:

```ts
    recordGeminiUsage(usage: GeminiUsage): void {
      const model = usage.model ?? 'gemini-3.1-flash-lite';
      const pricing = (GEMINI_PRICING_USD_PER_MILLION_TOKENS as Record<string, { input: number; cachedInput: number; output: number } | undefined>)[model];
      if (!pricing) {
        void logEvent('warn', { event: 'unknown_gemini_pricing_model', model });
        return;
      }
      const nonCachedPromptTokens = Math.max(0, usage.promptTokens - usage.cachedTokens);
      const cost =
        (nonCachedPromptTokens / 1_000_000) * pricing.input +
        (usage.cachedTokens / 1_000_000) * pricing.cachedInput +
        (usage.candidatesTokens / 1_000_000) * pricing.output;
      addCost(cost);
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/costTracker.test.ts`
Expected: PASS (all cases, including the new `gemini-3.5-flash` one).

- [ ] **Step 6: Thread `params.model` through `withCostTracking`**

Edit `server/src/geminiCostTracking.ts`:

```ts
import type { GeminiClient } from './gemini.js';
import type { CostTracker } from './costTracker.js';

export function withCostTracking(client: GeminiClient, tracker: CostTracker): GeminiClient {
  return {
    models: {
      async generateContent(params) {
        const response = await client.models.generateContent(params);
        const usage = response.usageMetadata;
        if (usage) {
          tracker.recordGeminiUsage({
            model: params.model,
            promptTokens: usage.promptTokenCount ?? 0,
            candidatesTokens: usage.candidatesTokenCount ?? 0,
            cachedTokens: usage.cachedContentTokenCount ?? 0,
          });
        }
        return response;
      },
    },
    caches: client.caches,
  };
}
```

- [ ] **Step 7: Update `geminiCostTracking.test.ts` to assert the model is passed through**

Edit the two assertions in `server/tests/geminiCostTracking.test.ts` that check `recordGeminiUsage` calls (the tests already pass `model: 'gemini-3.1-flash-lite'` in the `generateContent` call — just add it to the expected `recordGeminiUsage` call):

```ts
    expect(tracker.recordGeminiUsage).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-lite',
      promptTokens: 100,
      candidatesTokens: 20,
      cachedTokens: 10,
    });
```

and

```ts
    expect(tracker.recordGeminiUsage).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-lite',
      promptTokens: 0,
      candidatesTokens: 0,
      cachedTokens: 0,
    });
```

- [ ] **Step 8: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/costPricing.ts server/src/costTracker.ts server/src/geminiCostTracking.ts server/tests/costTracker.test.ts server/tests/geminiCostTracking.test.ts
git commit -m "Make Gemini cost tracking model-aware, add gemini-3.5-flash pricing"
```

---

### Task 2: Extract fixed prompt rules, add `model`/`notes` parameters

**Files:**
- Create: `server/src/llmPrompts.ts`
- Modify: `server/src/gemini.ts`
- Modify: `server/src/transcriptionVerifier.ts`
- Modify: `server/src/translationVerifier.ts`
- Modify: `server/src/wsServer.ts:5-7, 175-182, 196-199, 250-258, 291-301, 336-402, 422-459`
- Test: `server/tests/gemini.test.ts`
- Test: `server/tests/transcriptionVerifier.test.ts`
- Test: `server/tests/translationVerifier.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `translateSegment(client, model, englishText, languageCodes, notes, precedingContext?, cacheRef?)`, `translateBacklog(client, model, englishLines, languageCode, notes, cacheRef?)`, `verifyTranscription(client, model, english, notes, precedingContext?, cacheRef?)`, `verifyTranslations(client, model, items, notes, cacheRef?)` — every later task calls these exact signatures. Exported constants from `llmPrompts.ts`: `TRANSLATION_FIXED_RULES`, `TRANSLATION_DEFAULT_NOTES`, `TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO`, `TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO`, `TRANSCRIPTION_VERIFIER_DEFAULT_NOTES`, `TRANSLATION_VERIFIER_FIXED_RULES_INTRO`, `TRANSLATION_VERIFIER_FIXED_RULES_OUTRO`, `TRANSLATION_VERIFIER_DEFAULT_NOTES`.

This also bakes in the output-token trim (verifier `reason` left empty when `safe: true`) and prepares each function to omit its notes/rules text from `contents` when a cache is supplied (Task 5 makes those rules actually land in a cache) — a cache-aware call must not pay for the same instructions twice.

- [ ] **Step 1: Create `llmPrompts.ts` with the exact current text, split into fixed-rules and default-notes**

```ts
// server/src/llmPrompts.ts
export const TRANSLATION_FIXED_RULES =
  "Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don't add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.";

export const TRANSLATION_DEFAULT_NOTES =
  'This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she\'ll be right," "having a go"). Translate for the speaker\'s intended meaning and tone, not word-for-word — don\'t flatten idiomatic phrasing into something overly formal, and don\'t translate slang literally into an unrelated meaning.';

export const TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO =
  'You are a transcription accuracy checker for live captions at an Australian church sermon. This line was auto-transcribed live from spoken audio by speech-to-text, which occasionally mishears a word — dropping or inserting a "not", mishearing a name, or similar. Decide whether this line, taken at face value, confidently states something false about God, Jesus, the Holy Spirit, or core Christian belief.\n\nDo NOT flag a line just because it is idiomatic, informal, or grammatically rough — this sermon includes Australian slang, jokes, and dry humor (e.g. "no worries," "arvo," "having a go," "she\'ll be right"), and normal spoken imperfection is expected and not a sign of an error.';

export const TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO =
  'Only mark it unsafe if the line, as transcribed, clearly and confidently misrepresents who God, Jesus, or the Holy Spirit is or does — the kind of thing a dropped or inserted "not" would cause. If safe is true, set reason to an empty string; only write a reason when safe is false.';

export const TRANSCRIPTION_VERIFIER_DEFAULT_NOTES =
  'Language Specific Notes:\nBAHASE INDONESIA: Do NOT flag a line just because it uses the word "Allah" — this is the correct word for God in Indonesian, and is not a misrepresentation of Christian belief.  \n\nNaming Notes:\nCIEL is a cafe in Melbourne, do not remove\nPlanetshakers is the church in Melbourne, do not remove';

export const TRANSLATION_VERIFIER_FIXED_RULES_INTRO =
  "You are a safety checker for live captions at an Australian church sermon. For each numbered pair below, decide whether the translation is safe to show: it must preserve the original's meaning and polarity, and must not misrepresent who God, Jesus, or the Holy Spirit is or does.";

export const TRANSLATION_VERIFIER_FIXED_RULES_OUTRO =
  "Only mark a translation unsafe if it inverts a positive statement into a negative one (or vice versa), negates or contradicts the original, reverses who is doing or receiving an action, or misrepresents God/Jesus/the Holy Spirit. If safe is true, set reason to an empty string; only write a reason when safe is false.";

export const TRANSLATION_VERIFIER_DEFAULT_NOTES =
  'Do NOT flag a translation just because it is idiomatic or non-literal — this sermon includes Australian slang, jokes, and dry humor (e.g. "no worries," "arvo," "having a go," "she\'ll be right"), and a natural, non-literal rendering of those is expected and correct.';
```

Note the `BAHASE INDONESIA` spelling (not `BAHASA`) is copied verbatim from the current production prompt — this is preserving today's actual text exactly, not a typo to fix here.

- [ ] **Step 2: Update `gemini.ts` — add `model`/`notes` params, use the cache-aware instruction block**

Replace the full contents of `server/src/gemini.ts`:

```ts
import { GoogleGenAI } from '@google/genai';
import { TRANSLATION_FIXED_RULES } from './llmPrompts.js';

export interface SermonCacheRef {
  name: string;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config: {
        responseMimeType: string;
        responseSchema: Record<string, unknown>;
        cachedContent?: string;
      };
    }): Promise<{ text: string | null | undefined; usageMetadata?: GeminiUsageMetadata }>;
  };
  caches: {
    create(params: {
      model: string;
      config: { systemInstruction: string; ttl: string; displayName?: string };
    }): Promise<{ name?: string }>;
    delete(params: { name: string }): Promise<unknown>;
  };
}

export function createGeminiClient(apiKey: string): GeminiClient {
  return new GoogleGenAI({ apiKey });
}

function buildContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (do not translate these — they're for reference only, e.g. to resolve pronouns or match terminology):
${numbered}

`;
}

export async function translateSegment(
  client: GeminiClient,
  model: string,
  englishText: string,
  languageCodes: string[],
  notes: string,
  precedingContext: string[] = [],
  cacheRef: SermonCacheRef | null = null
): Promise<Record<string, string>> {
  if (languageCodes.length === 0) return {};

  const properties: Record<string, { type: string }> = {};
  for (const code of languageCodes) properties[code] = { type: 'string' };

  const instructionBlock = cacheRef ? '' : `${notes}\n\n${TRANSLATION_FIXED_RULES}\n\n`;

  const response = await client.models.generateContent({
    model,
    contents: `Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal.

${instructionBlock}${buildContextBlock(precedingContext)}Sentence: "${englishText}"`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: languageCodes },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
    },
  });

  return JSON.parse(response.text ?? '{}');
}

export async function translateBacklog(
  client: GeminiClient,
  model: string,
  englishLines: string[],
  languageCode: string,
  notes: string,
  cacheRef: SermonCacheRef | null = null
): Promise<string[]> {
  if (englishLines.length === 0) return [];

  const instructionBlock = cacheRef ? '' : `${notes}\n\n${TRANSLATION_FIXED_RULES}\n\n`;

  const response = await client.models.generateContent({
    model,
    contents: `Translate each of these sentences, spoken during a live Australian church sermon, into language code "${languageCode}". Return the translations in the exact same order as the input.

${instructionBlock}Sentences: ${JSON.stringify(englishLines)}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { translations: { type: 'array', items: { type: 'string' } } },
        required: ['translations'],
      },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
    },
  });

  const parsed = JSON.parse(response.text ?? '{"translations":[]}');
  return parsed.translations ?? [];
}
```

- [ ] **Step 3: Update `gemini.test.ts` for the new signature**

Replace the full contents of `server/tests/gemini.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { translateSegment, translateBacklog, type GeminiClient } from '../src/gemini';
import { TRANSLATION_DEFAULT_NOTES } from '../src/llmPrompts';

const MODEL = 'gemini-3.1-flash-lite';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: responseText }),
    },
    caches: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe('translateSegment', () => {
  it('returns parsed translations for the requested languages', async () => {
    const client = fakeClient('{"zh":"你好","ko":"안녕"}');
    const result = await translateSegment(client, MODEL, 'Hello', ['zh', 'ko'], TRANSLATION_DEFAULT_NOTES);
    expect(result).toEqual({ zh: '你好', ko: '안녕' });
  });

  it('skips the API call and returns an empty object when no languages are active', async () => {
    const client = fakeClient('{}');
    const result = await translateSegment(client, MODEL, 'Hello', [], TRANSLATION_DEFAULT_NOTES);
    expect(result).toEqual({});
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('includes Australian slang context and polarity-preservation guidance in the prompt when uncached', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, "G'day mate, no worries", ['zh'], TRANSLATION_DEFAULT_NOTES);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('Preserve polarity and negation exactly');
  });

  it('includes preceding context as reference-only lines when provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'How are you', ['zh'], TRANSLATION_DEFAULT_NOTES, ['Hello everyone', 'Welcome to church']);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Hello everyone');
    expect(call.contents).toContain('Welcome to church');
    expect(call.contents).toContain('do not translate these');
  });

  it('produces an unchanged prompt when no preceding context is given and no cache is used', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toBe(
      'Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: zh. Keep the tone natural and spoken, not overly formal.\n\n' +
        'This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she\'ll be right," "having a go"). Translate for the speaker\'s intended meaning and tone, not word-for-word — don\'t flatten idiomatic phrasing into something overly formal, and don\'t translate slang literally into an unrelated meaning.\n\n' +
        'Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don\'t add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.\n\n' +
        'Sentence: "Hello"'
    );
  });

  it('includes cachedContent in the request config when a cache ref is provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES, [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('omits cachedContent from the request config when no cache ref is provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });

  it('omits the notes and fixed-rules text from contents when a cache ref is provided, since the cache already carries them', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES, [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('Australian slang');
    expect(call.contents).not.toContain('Preserve polarity and negation exactly');
  });

  it('passes the given model through to generateContent', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, 'gemini-3.5-flash', 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.model).toBe('gemini-3.5-flash');
  });
});

describe('translateBacklog', () => {
  it('returns translations in the same order as the input lines', async () => {
    const client = fakeClient('{"translations":["你好","再见"]}');
    const result = await translateBacklog(client, MODEL, ['Hello', 'Goodbye'], 'zh', TRANSLATION_DEFAULT_NOTES);
    expect(result).toEqual(['你好', '再见']);
  });

  it('skips the API call and returns an empty array for an empty backlog', async () => {
    const client = fakeClient('{"translations":[]}');
    const result = await translateBacklog(client, MODEL, [], 'zh', TRANSLATION_DEFAULT_NOTES);
    expect(result).toEqual([]);
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('includes Australian slang context and polarity-preservation guidance in the prompt when uncached', async () => {
    const client = fakeClient('{"translations":["你好"]}');
    await translateBacklog(client, MODEL, ["G'day mate, no worries"], 'zh', TRANSLATION_DEFAULT_NOTES);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('Preserve polarity and negation exactly');
  });

  it('includes cachedContent in the request config when a cache ref is provided', async () => {
    const client = fakeClient('{"translations":["你好"]}');
    await translateBacklog(client, MODEL, ['Hello'], 'zh', TRANSLATION_DEFAULT_NOTES, { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
    expect(call.contents).not.toContain('Australian slang');
  });
});
```

- [ ] **Step 4: Run `gemini.test.ts`**

Run: `cd server && npx vitest run tests/gemini.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `transcriptionVerifier.ts`**

Replace the full contents of `server/src/transcriptionVerifier.ts`:

```ts
import type { GeminiClient, SermonCacheRef } from './gemini.js';
import { TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO, TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO } from './llmPrompts.js';

export interface TranscriptionCheckResult {
  safe: boolean;
  reason: string;
}

function buildContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (not to be evaluated themselves — only for resolving pronouns or continuing a thought):\n${numbered}\n\n`;
}

export async function verifyTranscription(
  client: GeminiClient,
  model: string,
  english: string,
  notes: string,
  precedingContext: string[] = [],
  cacheRef: SermonCacheRef | null = null
): Promise<TranscriptionCheckResult> {
  const instructionBlock = cacheRef
    ? ''
    : `${TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO}\n\n${notes}\n\n${TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO}\n\n`;

  const response = await client.models.generateContent({
    model,
    contents: `This is a transcription accuracy checker for live captions at an Australian church sermon.

${instructionBlock}${buildContextBlock(precedingContext)}Line: "${english}"

Return whether it is safe and a short reason.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['safe', 'reason'],
      },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
    },
  });

  const parsed: unknown = JSON.parse(response.text ?? '{}');
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
```

This adds one short always-present marker line ("This is a transcription accuracy checker...") outside the cacheable block purely so `wsServer.ts`'s existing fake-client routing convention (matching on the substring `'transcription accuracy checker'` in `contents`) keeps working whether or not a cache is active — the full task explanation still lives in `TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO`, cached when a cache ref exists.

- [ ] **Step 6: Update `translationVerifier.ts`** the same way

Replace the full contents of `server/src/translationVerifier.ts`:

```ts
import type { GeminiClient, SermonCacheRef } from './gemini.js';
import { TRANSLATION_VERIFIER_FIXED_RULES_INTRO, TRANSLATION_VERIFIER_FIXED_RULES_OUTRO } from './llmPrompts.js';

export interface VerificationItem {
  id: string;
  english: string;
  translated: string;
}

export interface VerificationResult {
  safe: boolean;
  reason: string;
}

export async function verifyTranslations(
  client: GeminiClient,
  model: string,
  items: VerificationItem[],
  notes: string,
  cacheRef: SermonCacheRef | null = null
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};

  const properties: Record<string, Record<string, unknown>> = {};
  for (const item of items) {
    properties[item.id] = {
      type: 'object',
      properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['safe', 'reason'],
    };
  }

  const pairs = items
    .map(
      (item, index) =>
        `${index + 1}. [id: "${item.id}"] English: "${item.english}" | Translation: "${item.translated}"`
    )
    .join('\n');

  const instructionBlock = cacheRef
    ? ''
    : `${TRANSLATION_VERIFIER_FIXED_RULES_INTRO}\n\n${notes}\n\n${TRANSLATION_VERIFIER_FIXED_RULES_OUTRO}\n\n`;

  const response = await client.models.generateContent({
    model,
    contents: `This is a safety checker for live captions at an Australian church sermon.

${instructionBlock}Pairs:
${pairs}

Return, for each id, whether it is safe and a short reason.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: items.map((item) => item.id) },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
    },
  });

  const parsed: unknown = JSON.parse(response.text ?? '{}');
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, VerificationResult>) : {};
}
```

- [ ] **Step 7: Update `transcriptionVerifier.test.ts` and `translationVerifier.test.ts`**

Replace the full contents of `server/tests/transcriptionVerifier.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { verifyTranscription } from '../src/transcriptionVerifier';
import type { GeminiClient } from '../src/gemini';
import { TRANSCRIPTION_VERIFIER_DEFAULT_NOTES } from '../src/llmPrompts';

const MODEL = 'gemini-3.1-flash-lite';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: responseText }),
    },
    caches: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe('verifyTranscription', () => {
  it('returns safe:true parsed from the model response', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    const result = await verifyTranscription(client, MODEL, 'Jesus loves you', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    expect(result).toEqual({ safe: true, reason: '' });
  });

  it('returns safe:false for a flagged line', async () => {
    const client = fakeClient(
      '{"safe":false,"reason":"likely mis-heard: negates a core statement about Jesus"}'
    );
    const result = await verifyTranscription(client, MODEL, 'Jesus is not the son of God', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    expect(result).toEqual({
      safe: false,
      reason: 'likely mis-heard: negates a core statement about Jesus',
    });
  });

  it('includes Australian slang guidance and the leave-reason-empty-when-safe instruction when uncached', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, "No worries, she'll be right", TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('set reason to an empty string');
  });

  it('includes preceding context as reference-only lines when provided', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'He rose again', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES, [
      'Jesus died on the cross',
      'Three days later',
    ]);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Jesus died on the cross');
    expect(call.contents).toContain('Three days later');
  });

  it('produces a prompt marker that cannot collide with the translation verifier', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('safety checker');
    expect(call.contents).toContain('transcription accuracy checker');
  });

  it('includes cachedContent in the request config when a cache ref is provided', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES, [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('omits cachedContent, notes, and fixed rules from contents when no cache ref is provided is false — omits them only when a cache ref IS provided', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES, [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('Australian slang');
    expect(call.contents).not.toContain('Naming Notes');
  });

  it('omits cachedContent from the request config when no cache ref is provided', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });

  it('throws when the response is not valid JSON, so the caller can retry/fail-safe', async () => {
    const client = fakeClient('not json');
    await expect(verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES)).rejects.toThrow();
  });

  it('treats a well-formed but incomplete JSON response as unsafe', async () => {
    const client = fakeClient('{"unexpected":"shape"}');
    const result = await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    expect(result).toEqual({ safe: false, reason: 'malformed response' });
  });
});
```

Replace the full contents of `server/tests/translationVerifier.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { verifyTranslations } from '../src/translationVerifier';
import type { GeminiClient } from '../src/gemini';
import { TRANSLATION_VERIFIER_DEFAULT_NOTES } from '../src/llmPrompts';

const MODEL = 'gemini-3.1-flash-lite';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: responseText }),
    },
    caches: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe('verifyTranslations', () => {
  it('returns safe:true results parsed from the model response', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    const result = await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Jesus loves you', translated: '耶稣爱你' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES
    );
    expect(result).toEqual({ zh: { safe: true, reason: '' } });
  });

  it('returns safe:false results for a flagged translation', async () => {
    const client = fakeClient('{"zh":{"safe":false,"reason":"polarity flip: negates original meaning"}}');
    const result = await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Jesus loves you', translated: '耶稣不爱你' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES
    );
    expect(result).toEqual({ zh: { safe: false, reason: 'polarity flip: negates original meaning' } });
  });

  it('batches every item into a single generateContent call', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""},"ko":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [
        { id: 'zh', english: 'Hello', translated: '你好' },
        { id: 'ko', english: 'Hello', translated: '안녕' },
      ],
      TRANSLATION_VERIFIER_DEFAULT_NOTES
    );
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('includes Australian slang guidance and the leave-reason-empty-when-safe instruction when uncached', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'No worries', translated: '没问题' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES
    );
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('set reason to an empty string');
  });

  it('skips the API call and returns an empty object when there are no items', async () => {
    const client = fakeClient('{}');
    const result = await verifyTranslations(client, MODEL, [], TRANSLATION_VERIFIER_DEFAULT_NOTES);
    expect(result).toEqual({});
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('includes cachedContent in the request config when a cache ref is provided', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Hello', translated: '你好' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES,
      { name: 'cachedContents/abc' }
    );
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('omits notes and fixed rules from contents when a cache ref is provided', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Hello', translated: '你好' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES,
      { name: 'cachedContents/abc' }
    );
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('Australian slang');
  });

  it('omits cachedContent from the request config when no cache ref is provided', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(client, MODEL, [{ id: 'zh', english: 'Hello', translated: '你好' }], TRANSLATION_VERIFIER_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });
});
```

- [ ] **Step 8: Run both verifier test files**

Run: `cd server && npx vitest run tests/transcriptionVerifier.test.ts tests/translationVerifier.test.ts`
Expected: PASS.

- [ ] **Step 9: Update `wsServer.ts`'s call sites to pass the new required arguments**

`wsServer.ts` currently calls `translateSegment`, `translateBacklog`, `verifyTranscription`, and `verifyTranslations` directly with the old signatures. Update every call site to pass `'gemini-3.1-flash-lite'` as the model and the matching default-notes constant, so the app keeps compiling and behaving identically — this is a stopgap wiring that Task 6 replaces with the real per-role provider/config lookup.

Edit `server/src/wsServer.ts`, add the import (near the top, alongside the other imports):

```ts
import {
  TRANSLATION_DEFAULT_NOTES,
  TRANSCRIPTION_VERIFIER_DEFAULT_NOTES,
  TRANSLATION_VERIFIER_DEFAULT_NOTES,
} from './llmPrompts.js';
```

Update each of the four wrapper functions' internal calls:

```ts
async function translateWithFallback(
  deps: WsServerDeps,
  english: string,
  activeLanguages: string[],
  precedingContext: string[],
  sermonCache: SermonCacheRef | null
): Promise<Record<string, string>> {
  if (activeLanguages.length === 0) return {};
  try {
    return await translateSegment(deps.geminiClient, 'gemini-3.1-flash-lite', english, activeLanguages, TRANSLATION_DEFAULT_NOTES, precedingContext, sermonCache);
  } catch {
    deps.session.sermonCache = null;
    try {
      return await translateSegment(deps.geminiClient, 'gemini-3.1-flash-lite', english, activeLanguages, TRANSLATION_DEFAULT_NOTES, precedingContext, null);
    } catch (secondError) {
      void logEvent('error', {
        event: 'translation_failed',
        english,
        error: secondError instanceof Error ? secondError.message : String(secondError),
      });
      return {};
    }
  }
}

async function verifyTranscriptionWithRetry(
  client: GeminiClient,
  english: string,
  precedingContext: string[],
  sermonCache: SermonCacheRef | null
): Promise<TranscriptionCheckResult> {
  try {
    return await verifyTranscription(client, 'gemini-3.1-flash-lite', english, TRANSCRIPTION_VERIFIER_DEFAULT_NOTES, precedingContext, sermonCache);
  } catch {
    try {
      return await verifyTranscription(client, 'gemini-3.1-flash-lite', english, TRANSCRIPTION_VERIFIER_DEFAULT_NOTES, precedingContext, null);
    } catch (secondError) {
      void logEvent('error', {
        event: 'transcription_verification_failed',
        english,
        error: secondError instanceof Error ? secondError.message : String(secondError),
      });
      return { safe: false, reason: 'verification unavailable' };
    }
  }
}

async function verifyTranslationsWithRetry(
  client: GeminiClient,
  items: VerificationItem[],
  sermonCache: SermonCacheRef | null
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};
  try {
    return await verifyTranslations(client, 'gemini-3.1-flash-lite', items, TRANSLATION_VERIFIER_DEFAULT_NOTES, sermonCache);
  } catch {
    try {
      return await verifyTranslations(client, 'gemini-3.1-flash-lite', items, TRANSLATION_VERIFIER_DEFAULT_NOTES, null);
    } catch (secondError) {
      void logEvent('error', {
        event: 'verification_failed',
        error: secondError instanceof Error ? secondError.message : String(secondError),
      });
      return {};
    }
  }
}
```

And inside `ensureBacklogCached`, update the `translateBacklog` call:

```ts
      translations = await translateBacklog(
        deps.geminiClient,
        'gemini-3.1-flash-lite',
        missingEntries.map((line) => line.english),
        language,
        TRANSLATION_DEFAULT_NOTES
      );
```

- [ ] **Step 10: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS — `wsServer.test.ts` is unaffected because the fake client's routing still keys off the same `'transcription accuracy checker'` / `'safety checker'` substrings, and default notes/rules produce byte-identical uncached prompts to before.

- [ ] **Step 11: Commit**

```bash
git add server/src/llmPrompts.ts server/src/gemini.ts server/src/transcriptionVerifier.ts server/src/translationVerifier.ts server/src/wsServer.ts server/tests/gemini.test.ts server/tests/transcriptionVerifier.test.ts server/tests/translationVerifier.test.ts
git commit -m "Parametrize model and notes on translate/verify calls, trim verifier reason on safe"
```

---

### Task 3: `LlmProvider` abstraction and registry

**Files:**
- Create: `server/src/llmTypes.ts`
- Create: `server/src/geminiProvider.ts`
- Create: `server/src/llmRegistry.ts`
- Test: `server/tests/geminiProvider.test.ts`
- Test: `server/tests/llmRegistry.test.ts`

**Interfaces:**
- Consumes: `translateSegment`, `translateBacklog`, `verifyTranscription`, `verifyTranslations` from Task 2 (exact signatures above).
- Produces: `ModelId`, `MODEL_IDS`, `LlmProvider`, `RoleProviders` (from `llmTypes.ts`); `GeminiProvider` class (from `geminiProvider.ts`); `getProvider(model, notes, client): LlmProvider` (from `llmRegistry.ts`). Task 6 constructs `RoleProviders` via `getProvider` for each of the three roles.

- [ ] **Step 1: Write `llmTypes.ts`**

```ts
// server/src/llmTypes.ts
import type { SermonCacheRef } from './gemini.js';
import type { TranscriptionCheckResult } from './transcriptionVerifier.js';
import type { VerificationItem, VerificationResult } from './translationVerifier.js';

export type ModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';

export const MODEL_IDS: ModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];

export interface LlmProvider {
  translate(
    englishText: string,
    languageCodes: string[],
    precedingContext: string[],
    cacheRef: SermonCacheRef | null
  ): Promise<Record<string, string>>;
  translateBacklog(englishLines: string[], languageCode: string, cacheRef: SermonCacheRef | null): Promise<string[]>;
  verifyTranscription(
    english: string,
    precedingContext: string[],
    cacheRef: SermonCacheRef | null
  ): Promise<TranscriptionCheckResult>;
  verifyTranslations(
    items: VerificationItem[],
    cacheRef: SermonCacheRef | null
  ): Promise<Record<string, VerificationResult>>;
}

export interface RoleProviders {
  transcriptionVerifier: LlmProvider;
  translation: LlmProvider;
  translationVerifier: LlmProvider;
}
```

- [ ] **Step 2: Write the failing test for `GeminiProvider`**

```ts
// server/tests/geminiProvider.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GeminiProvider } from '../src/geminiProvider';
import type { GeminiClient } from '../src/gemini';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: { generateContent: vi.fn().mockResolvedValue({ text: responseText }) },
    caches: { create: vi.fn(), delete: vi.fn() },
  };
}

describe('GeminiProvider', () => {
  it('translate() delegates to translateSegment with the configured model and notes', async () => {
    const client = fakeClient('{"zh":"你好"}');
    const provider = new GeminiProvider(client, 'gemini-3.5-flash', 'custom notes');
    const result = await provider.translate('Hello', ['zh'], [], null);
    expect(result).toEqual({ zh: '你好' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.model).toBe('gemini-3.5-flash');
    expect(call.contents).toContain('custom notes');
  });

  it('translateBacklog() delegates to translateBacklog with the configured model and notes', async () => {
    const client = fakeClient('{"translations":["你好"]}');
    const provider = new GeminiProvider(client, 'gemini-3.1-flash-lite', 'custom notes');
    const result = await provider.translateBacklog(['Hello'], 'zh', null);
    expect(result).toEqual(['你好']);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('custom notes');
  });

  it('verifyTranscription() delegates to verifyTranscription with the configured model and notes', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    const provider = new GeminiProvider(client, 'gemini-3.1-flash-lite', 'custom transcription notes');
    const result = await provider.verifyTranscription('Hello', [], null);
    expect(result).toEqual({ safe: true, reason: '' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('custom transcription notes');
  });

  it('verifyTranslations() delegates to verifyTranslations with the configured model and notes', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    const provider = new GeminiProvider(client, 'gemini-3.1-flash-lite', 'custom verifier notes');
    const result = await provider.verifyTranslations([{ id: 'zh', english: 'Hi', translated: '你好' }], null);
    expect(result).toEqual({ zh: { safe: true, reason: '' } });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('custom verifier notes');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && npx vitest run tests/geminiProvider.test.ts`
Expected: FAIL — `../src/geminiProvider` doesn't exist yet.

- [ ] **Step 4: Write `geminiProvider.ts`**

```ts
// server/src/geminiProvider.ts
import { translateSegment, translateBacklog, type GeminiClient, type SermonCacheRef } from './gemini.js';
import { verifyTranscription, type TranscriptionCheckResult } from './transcriptionVerifier.js';
import { verifyTranslations, type VerificationItem, type VerificationResult } from './translationVerifier.js';
import type { LlmProvider, ModelId } from './llmTypes.js';

export class GeminiProvider implements LlmProvider {
  constructor(
    private readonly client: GeminiClient,
    private readonly model: ModelId,
    private readonly notes: string
  ) {}

  translate(
    englishText: string,
    languageCodes: string[],
    precedingContext: string[],
    cacheRef: SermonCacheRef | null
  ): Promise<Record<string, string>> {
    return translateSegment(this.client, this.model, englishText, languageCodes, this.notes, precedingContext, cacheRef);
  }

  translateBacklog(englishLines: string[], languageCode: string, cacheRef: SermonCacheRef | null): Promise<string[]> {
    return translateBacklog(this.client, this.model, englishLines, languageCode, this.notes, cacheRef);
  }

  verifyTranscription(
    english: string,
    precedingContext: string[],
    cacheRef: SermonCacheRef | null
  ): Promise<TranscriptionCheckResult> {
    return verifyTranscription(this.client, this.model, english, this.notes, precedingContext, cacheRef);
  }

  verifyTranslations(
    items: VerificationItem[],
    cacheRef: SermonCacheRef | null
  ): Promise<Record<string, VerificationResult>> {
    return verifyTranslations(this.client, this.model, items, this.notes, cacheRef);
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && npx vitest run tests/geminiProvider.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing test for the registry**

```ts
// server/tests/llmRegistry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getProvider } from '../src/llmRegistry';
import { GeminiProvider } from '../src/geminiProvider';
import type { GeminiClient } from '../src/gemini';

function fakeClient(): GeminiClient {
  return {
    models: { generateContent: vi.fn() },
    caches: { create: vi.fn(), delete: vi.fn() },
  };
}

describe('getProvider', () => {
  it('returns a GeminiProvider for gemini-3.1-flash-lite', () => {
    const provider = getProvider('gemini-3.1-flash-lite', 'notes', fakeClient());
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('returns a GeminiProvider for gemini-3.5-flash', () => {
    const provider = getProvider('gemini-3.5-flash', 'notes', fakeClient());
    expect(provider).toBeInstanceOf(GeminiProvider);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `cd server && npx vitest run tests/llmRegistry.test.ts`
Expected: FAIL — `../src/llmRegistry` doesn't exist yet.

- [ ] **Step 8: Write `llmRegistry.ts`**

```ts
// server/src/llmRegistry.ts
import type { GeminiClient } from './gemini.js';
import { GeminiProvider } from './geminiProvider.js';
import type { LlmProvider, ModelId } from './llmTypes.js';

export function getProvider(model: ModelId, notes: string, client: GeminiClient): LlmProvider {
  return new GeminiProvider(client, model, notes);
}
```

- [ ] **Step 9: Run to verify it passes, then run the full suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/src/llmTypes.ts server/src/geminiProvider.ts server/src/llmRegistry.ts server/tests/geminiProvider.test.ts server/tests/llmRegistry.test.ts
git commit -m "Add LlmProvider abstraction and a model-id-keyed provider registry"
```

---

### Task 4: Persisted model and prompt config stores

**Files:**
- Create: `server/src/modelConfigStore.ts`
- Create: `server/src/promptConfigStore.ts`
- Test: `server/tests/modelConfigStore.test.ts`
- Test: `server/tests/promptConfigStore.test.ts`

**Interfaces:**
- Consumes: `ModelId`, `MODEL_IDS` from `llmTypes.ts` (Task 3); `TRANSLATION_DEFAULT_NOTES`, `TRANSCRIPTION_VERIFIER_DEFAULT_NOTES`, `TRANSLATION_VERIFIER_DEFAULT_NOTES` from `llmPrompts.ts` (Task 2).
- Produces: `ModelConfig`, `DEFAULT_MODEL_CONFIG`, `createModelConfigStore(filePath): ModelConfigStore`, `validateModelConfig(value): ModelConfig | null`; `PromptConfig`, `DEFAULT_PROMPT_CONFIG`, `createPromptConfigStore(filePath): PromptConfigStore`, `validatePromptConfig(value): PromptConfig | null`. Tasks 6 and 8 both consume these exact names.

- [ ] **Step 1: Write the failing test for `modelConfigStore`**

```ts
// server/tests/modelConfigStore.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelConfigStore, validateModelConfig, DEFAULT_MODEL_CONFIG } from '../src/modelConfigStore';

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
    const config = {
      transcriptionVerifier: 'gemini-3.1-flash-lite' as const,
      translation: 'gemini-3.5-flash' as const,
      translationVerifier: 'gemini-3.1-flash-lite' as const,
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
});

describe('validateModelConfig', () => {
  it('accepts a config with all three valid model ids', () => {
    const config = {
      transcriptionVerifier: 'gemini-3.1-flash-lite',
      translation: 'gemini-3.5-flash',
      translationVerifier: 'gemini-3.1-flash-lite',
    };
    expect(validateModelConfig(config)).toEqual(config);
  });

  it('rejects a config missing a role', () => {
    expect(validateModelConfig({ transcriptionVerifier: 'gemini-3.1-flash-lite', translation: 'gemini-3.5-flash' })).toBeNull();
  });

  it('rejects a config with an unknown model id', () => {
    expect(
      validateModelConfig({ transcriptionVerifier: 'gpt-5', translation: 'gemini-3.5-flash', translationVerifier: 'gemini-3.1-flash-lite' })
    ).toBeNull();
  });

  it('rejects a non-object value', () => {
    expect(validateModelConfig(null)).toBeNull();
    expect(validateModelConfig('gemini-3.1-flash-lite')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run tests/modelConfigStore.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `modelConfigStore.ts`**

```ts
// server/src/modelConfigStore.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MODEL_IDS, type ModelId } from './llmTypes.js';

export interface ModelConfig {
  transcriptionVerifier: ModelId;
  translation: ModelId;
  translationVerifier: ModelId;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  transcriptionVerifier: 'gemini-3.1-flash-lite',
  translation: 'gemini-3.1-flash-lite',
  translationVerifier: 'gemini-3.1-flash-lite',
};

export interface ModelConfigStore {
  read(): Promise<ModelConfig>;
  write(config: ModelConfig): Promise<void>;
}

export function validateModelConfig(value: unknown): ModelConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const roles: (keyof ModelConfig)[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
  for (const role of roles) {
    if (!MODEL_IDS.includes(candidate[role] as ModelId)) return null;
  }
  return candidate as unknown as ModelConfig;
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

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run tests/modelConfigStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `promptConfigStore`**

```ts
// server/tests/promptConfigStore.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPromptConfigStore, validatePromptConfig, DEFAULT_PROMPT_CONFIG } from '../src/promptConfigStore';
import { TRANSLATION_DEFAULT_NOTES } from '../src/llmPrompts';

describe('createPromptConfigStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the default notes when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'prompt-config-test-'));
    const store = createPromptConfigStore(join(tempDir, 'prompt-config.json'));
    expect(await store.read()).toEqual(DEFAULT_PROMPT_CONFIG);
    expect((await store.read()).translation).toBe(TRANSLATION_DEFAULT_NOTES);
  });

  it('writes then reads back the same notes, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'prompt-config-test-'));
    const filePath = join(tempDir, 'nested', 'prompt-config.json');
    const store = createPromptConfigStore(filePath);
    const config = { transcriptionVerifier: 'custom tv notes', translation: 'custom t notes', translationVerifier: 'custom vv notes' };
    await store.write(config);
    expect(await store.read()).toEqual(config);
  });

  it('falls back to the default notes when the file is corrupt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'prompt-config-test-'));
    const filePath = join(tempDir, 'prompt-config.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const store = createPromptConfigStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_PROMPT_CONFIG);
  });
});

describe('validatePromptConfig', () => {
  it('accepts a config with all three roles as strings', () => {
    const config = { transcriptionVerifier: 'a', translation: 'b', translationVerifier: 'c' };
    expect(validatePromptConfig(config)).toEqual(config);
  });

  it('rejects a config missing a role', () => {
    expect(validatePromptConfig({ transcriptionVerifier: 'a', translation: 'b' })).toBeNull();
  });

  it('rejects a config with a non-string role value', () => {
    expect(validatePromptConfig({ transcriptionVerifier: 1, translation: 'b', translationVerifier: 'c' })).toBeNull();
  });

  it('rejects a non-object value', () => {
    expect(validatePromptConfig(null)).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd server && npx vitest run tests/promptConfigStore.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Write `promptConfigStore.ts`**

```ts
// server/src/promptConfigStore.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  TRANSLATION_DEFAULT_NOTES,
  TRANSCRIPTION_VERIFIER_DEFAULT_NOTES,
  TRANSLATION_VERIFIER_DEFAULT_NOTES,
} from './llmPrompts.js';

export interface PromptConfig {
  transcriptionVerifier: string;
  translation: string;
  translationVerifier: string;
}

export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  transcriptionVerifier: TRANSCRIPTION_VERIFIER_DEFAULT_NOTES,
  translation: TRANSLATION_DEFAULT_NOTES,
  translationVerifier: TRANSLATION_VERIFIER_DEFAULT_NOTES,
};

export interface PromptConfigStore {
  read(): Promise<PromptConfig>;
  write(config: PromptConfig): Promise<void>;
}

export function validatePromptConfig(value: unknown): PromptConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const roles: (keyof PromptConfig)[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
  for (const role of roles) {
    if (typeof candidate[role] !== 'string') return null;
  }
  return candidate as unknown as PromptConfig;
}

export function createPromptConfigStore(filePath: string): PromptConfigStore {
  return {
    async read(): Promise<PromptConfig> {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const validated = validatePromptConfig(JSON.parse(raw));
        return validated ?? DEFAULT_PROMPT_CONFIG;
      } catch {
        return DEFAULT_PROMPT_CONFIG;
      }
    },
    async write(config: PromptConfig): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(config), 'utf-8');
    },
  };
}
```

- [ ] **Step 8: Run to verify it passes, then run the full suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/modelConfigStore.ts server/src/promptConfigStore.ts server/tests/modelConfigStore.test.ts server/tests/promptConfigStore.test.ts
git commit -m "Add persisted per-role model and prompt-notes config stores"
```

---

### Task 5: Per-role Gemini caches

**Files:**
- Modify: `server/src/sermonCache.ts`
- Test: `server/tests/sermonCache.test.ts`

**Interfaces:**
- Consumes: `ModelConfig` (Task 4), `PromptConfig` (Task 4), `TRANSLATION_FIXED_RULES`/`TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO`/`TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO`/`TRANSLATION_VERIFIER_FIXED_RULES_INTRO`/`TRANSLATION_VERIFIER_FIXED_RULES_OUTRO` (Task 2).
- Produces: `RoleCaches` interface `{ transcriptionVerifier: SermonCacheRef | null; translation: SermonCacheRef | null; translationVerifier: SermonCacheRef | null }`, `createRoleCaches(client, modelConfig, promptConfig, feedbackText, sermonText): Promise<RoleCaches>`, `deleteRoleCaches(client, caches): Promise<void>`. Task 6 wires both into `Session`/`wsServer.ts`.

- [ ] **Step 1: Write the failing test for per-role cache assembly**

Replace the full contents of `server/tests/sermonCache.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createRoleCaches, deleteRoleCaches } from '../src/sermonCache';
import type { GeminiClient } from '../src/gemini';
import type { ModelConfig } from '../src/modelConfigStore';
import type { PromptConfig } from '../src/promptConfigStore';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LOG_FILE_PATH = join(tmpdir(), 'auto-translate-lite-test-events.log');

function fakeClientWithCaches(): GeminiClient {
  let counter = 0;
  return {
    models: { generateContent: vi.fn() },
    caches: {
      create: vi.fn().mockImplementation(() => {
        counter += 1;
        return Promise.resolve({ name: `cachedContents/${counter}` });
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const modelConfig: ModelConfig = {
  transcriptionVerifier: 'gemini-3.1-flash-lite',
  translation: 'gemini-3.5-flash',
  translationVerifier: 'gemini-3.1-flash-lite',
};

const promptConfig: PromptConfig = {
  transcriptionVerifier: 'tv notes',
  translation: 't notes',
  translationVerifier: 'vv notes',
};

describe('createRoleCaches', () => {
  it('creates one cache per role, even with no sermon document or feedback text, since fixed rules + notes are always substantial', async () => {
    const client = fakeClientWithCaches();
    const caches = await createRoleCaches(client, modelConfig, promptConfig, '', '');
    expect(client.caches.create).toHaveBeenCalledTimes(3);
    expect(caches.transcriptionVerifier).not.toBeNull();
    expect(caches.translation).not.toBeNull();
    expect(caches.translationVerifier).not.toBeNull();
  });

  it('creates each role\'s cache against that role\'s configured model', async () => {
    const client = fakeClientWithCaches();
    await createRoleCaches(client, modelConfig, promptConfig, '', '');
    const createCalls = (client.caches.create as any).mock.calls.map((call: any) => call[0].model);
    expect(createCalls).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite']);
  });

  it("includes each role's fixed rules and editable notes in its own systemInstruction, not the other roles'", async () => {
    const client = fakeClientWithCaches();
    await createRoleCaches(client, modelConfig, promptConfig, '', '');
    const instructions = (client.caches.create as any).mock.calls.map((call: any) => call[0].config.systemInstruction);
    expect(instructions[0]).toContain('tv notes');
    expect(instructions[0]).not.toContain('t notes and'); // sanity: not leaking translation notes verbatim as a substring collision
    expect(instructions[1]).toContain('t notes');
    expect(instructions[1]).toContain('Preserve polarity and negation exactly');
    expect(instructions[2]).toContain('vv notes');
  });

  it('includes shared feedback and sermon material in every role\'s cache', async () => {
    const client = fakeClientWithCaches();
    await createRoleCaches(client, modelConfig, promptConfig, 'Cain should be 该隐 in Chinese', 'Today we talk about Cain and Abel.');
    const instructions = (client.caches.create as any).mock.calls.map((call: any) => call[0].config.systemInstruction);
    for (const instruction of instructions) {
      expect(instruction).toContain('Known corrections from past sessions');
      expect(instruction).toContain('Cain should be 该隐');
      expect(instruction).toContain("This week's sermon material");
      expect(instruction).toContain('Cain and Abel');
    }
  });

  it('omits the feedback section when feedback text is empty', async () => {
    const client = fakeClientWithCaches();
    await createRoleCaches(client, modelConfig, promptConfig, '', 'Sermon content here.');
    const instructions = (client.caches.create as any).mock.calls.map((call: any) => call[0].config.systemInstruction);
    for (const instruction of instructions) {
      expect(instruction).not.toContain('Known corrections from past sessions');
      expect(instruction).toContain('Sermon content here.');
    }
  });

  it("returns null for a role's cache and logs, without affecting the other roles, when that role's cache creation fails", async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClientWithCaches();
    (client.caches.create as any).mockImplementationOnce(() => Promise.reject(new Error('API down')));
    const caches = await createRoleCaches(client, modelConfig, promptConfig, '', '');
    expect(caches.transcriptionVerifier).toBeNull();
    expect(caches.translation).not.toBeNull();
    expect(caches.translationVerifier).not.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('deleteRoleCaches', () => {
  it('deletes every non-null role cache by name', async () => {
    const client = fakeClientWithCaches();
    await deleteRoleCaches(client, {
      transcriptionVerifier: { name: 'cachedContents/a' },
      translation: { name: 'cachedContents/b' },
      translationVerifier: null,
    });
    expect(client.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/a' });
    expect(client.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/b' });
    expect(client.caches.delete).toHaveBeenCalledTimes(2);
  });

  it('does nothing when all role caches are null', async () => {
    const client = fakeClientWithCaches();
    await deleteRoleCaches(client, { transcriptionVerifier: null, translation: null, translationVerifier: null });
    expect(client.caches.delete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run tests/sermonCache.test.ts`
Expected: FAIL — `createRoleCaches`/`deleteRoleCaches` don't exist yet.

- [ ] **Step 3: Rewrite `sermonCache.ts`**

Replace the full contents of `server/src/sermonCache.ts`:

```ts
import type { GeminiClient, SermonCacheRef } from './gemini.js';
import type { ModelConfig } from './modelConfigStore.js';
import type { PromptConfig } from './promptConfigStore.js';
import {
  TRANSLATION_FIXED_RULES,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_INTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_OUTRO,
} from './llmPrompts.js';
import { logEvent } from './logger.js';

const CACHE_TTL = '7200s';
const MIN_CACHEABLE_CHARS = 200;

export interface RoleCaches {
  transcriptionVerifier: SermonCacheRef | null;
  translation: SermonCacheRef | null;
  translationVerifier: SermonCacheRef | null;
}

function buildSharedContextBlock(feedbackText: string, sermonText: string): string {
  const sections: string[] = [];
  const trimmedFeedback = feedbackText.trim();
  if (trimmedFeedback.length > 0) {
    sections.push(
      `Known corrections from past sessions (avoid repeating these specific mistakes):\n${trimmedFeedback}`
    );
  }
  const trimmedSermon = sermonText.trim();
  if (trimmedSermon.length > 0) {
    sections.push(`This week's sermon material (for reference only, e.g. names, scripture references, terminology):\n${trimmedSermon}`);
  }
  return sections.join('\n\n');
}

async function createOneRoleCache(
  client: GeminiClient,
  model: string,
  fixedAndNotes: string,
  sharedContext: string,
  displayName: string
): Promise<SermonCacheRef | null> {
  const instruction = sharedContext.length > 0 ? `${fixedAndNotes}\n\n${sharedContext}` : fixedAndNotes;
  if (instruction.length < MIN_CACHEABLE_CHARS) return null;

  try {
    const cache = await client.caches.create({
      model,
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

export async function createRoleCaches(
  client: GeminiClient,
  modelConfig: ModelConfig,
  promptConfig: PromptConfig,
  feedbackText: string,
  sermonText: string
): Promise<RoleCaches> {
  const sharedContext = buildSharedContextBlock(feedbackText, sermonText);

  const [transcriptionVerifier, translation, translationVerifier] = await Promise.all([
    createOneRoleCache(
      client,
      modelConfig.transcriptionVerifier,
      `${TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO}\n\n${promptConfig.transcriptionVerifier}\n\n${TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO}`,
      sharedContext,
      'transcription-verifier-context'
    ),
    createOneRoleCache(
      client,
      modelConfig.translation,
      `${promptConfig.translation}\n\n${TRANSLATION_FIXED_RULES}`,
      sharedContext,
      'translation-context'
    ),
    createOneRoleCache(
      client,
      modelConfig.translationVerifier,
      `${TRANSLATION_VERIFIER_FIXED_RULES_INTRO}\n\n${promptConfig.translationVerifier}\n\n${TRANSLATION_VERIFIER_FIXED_RULES_OUTRO}`,
      sharedContext,
      'translation-verifier-context'
    ),
  ]);

  return { transcriptionVerifier, translation, translationVerifier };
}

export async function deleteRoleCaches(client: GeminiClient, caches: RoleCaches): Promise<void> {
  const refs = [caches.transcriptionVerifier, caches.translation, caches.translationVerifier].filter(
    (ref): ref is SermonCacheRef => ref !== null
  );
  await Promise.all(
    refs.map((ref) =>
      client.caches.delete({ name: ref.name }).catch((error) => {
        void logEvent('error', {
          event: 'role_cache_delete_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      })
    )
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run tests/sermonCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: The suite will FAIL at this point — `wsServer.ts` and `session.ts` still reference the old `sermonCache`/`createSermonContextCache`/`buildSermonContextInstruction`/`deleteSermonContextCache` exports that no longer exist. That's expected; Task 6 fixes it. Confirm the *only* failures are in `wsServer.test.ts` and `session.test.ts`, and that `sermonCache.test.ts` itself is green, before moving on.

- [ ] **Step 6: Commit**

```bash
git add server/src/sermonCache.ts server/tests/sermonCache.test.ts
git commit -m "Replace the single shared sermon cache with one cache per LLM role"
```

Note: this commit intentionally leaves `wsServer.test.ts`/`session.test.ts` red — Task 6 is the matching integration task and fixes them in the same development session. Do not consider Task 5 "done" for release purposes until Task 6 lands.

---

### Task 6: Wire Session and wsServer to per-role providers and caches

**Files:**
- Modify: `server/src/session.ts`
- Modify: `server/src/wsServer.ts`
- Test: `server/tests/session.test.ts`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `RoleCaches`, `createRoleCaches`, `deleteRoleCaches` (Task 5); `RoleProviders`, `LlmProvider` (Task 3); `getProvider` (Task 3); `ModelConfigStore`, `PromptConfigStore` (Task 4).
- Produces: `Session.roleCaches: RoleCaches`, `Session.providers: RoleProviders | null`; `WsServerDeps` gains `modelConfigStore: ModelConfigStore` and `promptConfigStore: PromptConfigStore`. Task 8 (index.ts wiring) constructs and passes these two new deps.

This is the task that makes the model/notes config from the admin page (Task 8/9) actually affect what happens in a live session — everything before this point is inert plumbing.

- [ ] **Step 1: Update `session.ts`**

Replace the full contents of `server/src/session.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { TranscriptBuffer } from './transcriptBuffer.js';
import { TranslationCache } from './translationCache.js';
import type { RoleCaches } from './sermonCache.js';
import type { RoleProviders } from './llmTypes.js';

const EMPTY_ROLE_CACHES: RoleCaches = {
  transcriptionVerifier: null,
  translation: null,
  translationVerifier: null,
};

export class Session {
  id: string = randomUUID();
  isActive: boolean = false;
  buffer: TranscriptBuffer = new TranscriptBuffer();
  roleCaches: RoleCaches = { ...EMPTY_ROLE_CACHES };
  providers: RoleProviders | null = null;
  translationCache: TranslationCache = new TranslationCache();
  inFlightFills: Map<string, Promise<void>> = new Map();
  mode: 'automatic' | 'manual' = 'automatic';
  private viewers: Map<WebSocket, string> = new Map();

  start(): void {
    this.id = randomUUID();
    this.isActive = true;
    this.buffer.clear();
    this.roleCaches = { ...EMPTY_ROLE_CACHES };
    this.providers = null;
    this.translationCache = new TranslationCache();
    this.inFlightFills = new Map();
  }

  stop(): void {
    this.isActive = false;
  }

  addViewer(socket: WebSocket, language: string): void {
    this.viewers.set(socket, language);
  }

  removeViewer(socket: WebSocket): void {
    this.viewers.delete(socket);
  }

  switchViewerLanguage(socket: WebSocket, language: string): void {
    this.viewers.set(socket, language);
  }

  getActiveLanguages(): string[] {
    return Array.from(new Set(this.viewers.values()));
  }

  getViewersForLanguage(language: string): WebSocket[] {
    return Array.from(this.viewers.entries())
      .filter(([, viewerLanguage]) => viewerLanguage === language)
      .map(([socket]) => socket);
  }

  getAllViewers(): WebSocket[] {
    return Array.from(this.viewers.keys());
  }
}
```

- [ ] **Step 2: Update `session.test.ts`**

Replace the `'start() clears any previous sermon cache reference'` test in `server/tests/session.test.ts` with:

```ts
  it('start() clears any previous role caches and providers', () => {
    const session = new Session();
    session.roleCaches = {
      transcriptionVerifier: { name: 'cachedContents/old-tv' },
      translation: { name: 'cachedContents/old-t' },
      translationVerifier: { name: 'cachedContents/old-vv' },
    };
    session.start();
    expect(session.roleCaches).toEqual({
      transcriptionVerifier: null,
      translation: null,
      translationVerifier: null,
    });
    expect(session.providers).toBeNull();
  });
```

- [ ] **Step 3: Run `session.test.ts`**

Run: `cd server && npx vitest run tests/session.test.ts`
Expected: PASS.

- [ ] **Step 4: Rewrite `wsServer.ts`**

Replace the full contents of `server/src/wsServer.ts`:

```ts
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from './session.js';
import type { CaptionLine } from './types.js';
import type { GeminiClient } from './gemini.js';
import type { VerificationItem, VerificationResult } from './translationVerifier.js';
import type { TranscriptionCheckResult } from './transcriptionVerifier.js';
import type { DeepgramConnection, DeepgramConnectionFactory } from './deepgram.js';
import { createRoleCaches, deleteRoleCaches } from './sermonCache.js';
import { getProvider } from './llmRegistry.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { CostTracker } from './costTracker.js';
import type { ModelConfigStore } from './modelConfigStore.js';
import type { PromptConfigStore } from './promptConfigStore.js';
import { logEvent } from './logger.js';

const PRECEDING_CONTEXT_LINES = 7;

export interface WsServerDeps {
  httpServer: HttpServer;
  session: Session;
  geminiClient: GeminiClient;
  deepgramApiKey: string;
  createDeepgramConnection: DeepgramConnectionFactory;
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
  costTracker: CostTracker;
  modelConfigStore: ModelConfigStore;
  promptConfigStore: PromptConfigStore;
}

export function attachWsServer(deps: WsServerDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  deps.httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '', 'http://localhost');
    if (pathname === '/ws/capture' || pathname === '/ws/viewer') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, pathname);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, pathname: string) => {
    if (pathname === '/ws/capture') {
      handleCaptureConnection(ws, deps);
    } else {
      handleViewerConnection(ws, deps);
    }
  });
}

function handleCaptureConnection(ws: WebSocket, deps: WsServerDeps): void {
  let deepgramConnection: DeepgramConnection | null = null;
  let processingQueue: Promise<void> = Promise.resolve();
  let recordingStartedAt: number | null = null;
  let unsubscribeCost: (() => void) | null = null;

  function finalizeDeepgramCost(): void {
    if (recordingStartedAt !== null) {
      const elapsedSeconds = (Date.now() - recordingStartedAt) / 1000;
      deps.costTracker.recordDeepgramSeconds(elapsedSeconds);
      recordingStartedAt = null;
    }
  }

  ws.on('message', (data, isBinary) => {
    void (async () => {
      try {
        if (!isBinary) {
          const message = JSON.parse(data.toString());
          if (message.type === 'start') {
            deps.session.start();

            const sermonText = deps.sermonDocStore.get() ?? '';
            const feedbackText = await deps.feedbackStore.read();
            const modelConfig = await deps.modelConfigStore.read();
            const promptConfig = await deps.promptConfigStore.read();

            deps.session.providers = {
              transcriptionVerifier: getProvider(modelConfig.transcriptionVerifier, promptConfig.transcriptionVerifier, deps.geminiClient),
              translation: getProvider(modelConfig.translation, promptConfig.translation, deps.geminiClient),
              translationVerifier: getProvider(modelConfig.translationVerifier, promptConfig.translationVerifier, deps.geminiClient),
            };
            deps.session.roleCaches = await createRoleCaches(deps.geminiClient, modelConfig, promptConfig, feedbackText, sermonText);

            void logEvent('info', {
              event: 'session_context_cache',
              sessionId: deps.session.id,
              cacheNames: {
                transcriptionVerifier: deps.session.roleCaches.transcriptionVerifier?.name ?? null,
                translation: deps.session.roleCaches.translation?.name ?? null,
                translationVerifier: deps.session.roleCaches.translationVerifier?.name ?? null,
              },
            });

            deepgramConnection = deps.createDeepgramConnection(deps.deepgramApiKey, {
              onFinalSegment: (text) => {
                processingQueue = processingQueue
                  .then(() => handleFinalSegment(text, deps, ws))
                  .catch((error) => {
                    void logEvent('error', {
                      event: 'segment_processing_failed',
                      english: text,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  });
              },
              onError: () => {
                ws.send(JSON.stringify({ type: 'status', status: 'error' }));
              },
              onClose: () => {},
            });
            recordingStartedAt = Date.now();
            ws.send(JSON.stringify({ type: 'status', status: 'recording' }));

            deps.costTracker.resetSession();
            unsubscribeCost = deps.costTracker.onUpdate((sessionUsd, lifetimeUsd) => {
              ws.send(JSON.stringify({ type: 'cost', sessionUsd, lifetimeUsd }));
            });
          } else if (message.type === 'stop') {
            deps.session.stop();
            await deleteRoleCaches(deps.geminiClient, deps.session.roleCaches);
            deps.session.roleCaches = { transcriptionVerifier: null, translation: null, translationVerifier: null };
            deepgramConnection?.finish();
            deepgramConnection = null;
            ws.send(JSON.stringify({ type: 'status', status: 'idle' }));

            finalizeDeepgramCost();
            unsubscribeCost?.();
            unsubscribeCost = null;
          } else if (message.type === 'reinstate') {
            processingQueue = processingQueue
              .then(() => handleReinstate(message.id, message.english, deps, ws))
              .catch((error) => {
                void logEvent('error', {
                  event: 'reinstate_processing_failed',
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          } else if (message.type === 'admin-remove') {
            processingQueue = processingQueue
              .then(() => handleAdminRemove(message.id, deps, ws))
              .catch((error) => {
                void logEvent('error', {
                  event: 'admin_remove_processing_failed',
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          } else if (message.type === 'set-mode') {
            deps.session.mode = message.mode === 'manual' ? 'manual' : 'automatic';
          }
        } else if (deepgramConnection) {
          deepgramConnection.send(data as Buffer);
        }
      } catch (error) {
        void logEvent('error', {
          event: 'capture_message_error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  ws.on('close', () => {
    deps.session.stop();
    void deleteRoleCaches(deps.geminiClient, deps.session.roleCaches).then(() => {
      deps.session.roleCaches = { transcriptionVerifier: null, translation: null, translationVerifier: null };
    });
    deepgramConnection?.finish();

    // Unsubscribe before finalizing: the socket is already closed by the time
    // this event fires, so the cost-update listener must not attempt a send.
    unsubscribeCost?.();
    unsubscribeCost = null;
    finalizeDeepgramCost();
  });
}

function logTranslationFallback(
  language: string,
  english: string,
  discardedTranslation: string,
  reason: string
): void {
  void logEvent('warn', { event: 'translation_fallback', language, english, discardedTranslation, reason });
}

async function finishPublishing(
  line: CaptionLine,
  translations: Record<string, string>,
  deps: WsServerDeps,
  captureSocket: WebSocket,
  viewerMessageType: 'caption' | 'caption-inserted' = 'caption'
): Promise<void> {
  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));

  const activeLanguages = deps.session.getActiveLanguages();
  if (activeLanguages.length === 0) return;

  const verificationItems: VerificationItem[] = activeLanguages
    .filter((language) => Boolean(translations[language]))
    .map((language) => ({ id: language, english: line.english, translated: translations[language] }));
  const verifications = await verifyTranslationsWithRetry(deps, verificationItems);

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = safe ? translated : line.english;
    deps.session.translationCache.set(language, line.id, outgoing);

    if (!safe) {
      logTranslationFallback(language, line.english, translated, verification?.reason || 'verification unavailable');
    }

    const payload = JSON.stringify({ type: viewerMessageType, id: line.id, english: line.english, translated: outgoing });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}

async function handleReinstate(
  id: string,
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket
): Promise<void> {
  const trimmed = english.trim();
  if (trimmed.length === 0) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'empty text' }));
    return;
  }

  const existing = deps.session.buffer.peek(id);
  if (existing === null || !existing.suppressed) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  const originalEnglish = existing.english;
  const cachedTranslations = existing.pendingTranslations ?? {};
  const precedingContext = deps.session.buffer.precedingContextFor(id, PRECEDING_CONTEXT_LINES);
  const activeLanguages = deps.session.getActiveLanguages();

  let translations: Record<string, string>;
  if (trimmed === originalEnglish) {
    const cachedLanguages = activeLanguages.filter((language) => cachedTranslations[language] !== undefined);
    const newLanguages = activeLanguages.filter((language) => cachedTranslations[language] === undefined);
    const freshTranslations =
      newLanguages.length > 0 ? await translateWithFallback(deps, trimmed, newLanguages, precedingContext) : {};
    translations = {
      ...Object.fromEntries(cachedLanguages.map((language) => [language, cachedTranslations[language]])),
      ...freshTranslations,
    };
  } else {
    translations = await translateWithFallback(deps, trimmed, activeLanguages, precedingContext);
  }

  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  await finishPublishing(line, translations, deps, captureSocket, 'caption-inserted');
}

async function handleAdminRemove(id: string, deps: WsServerDeps, captureSocket: WebSocket): Promise<void> {
  const line = deps.session.buffer.suppress(id);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'admin-remove-error', id, error: 'not found' }));
    return;
  }

  captureSocket.send(
    JSON.stringify({ type: 'transcript', id: line.id, english: line.english, flagged: true, reason: 'Removed by admin' })
  );
  const removedPayload = JSON.stringify({ type: 'line-removed', id: line.id });
  for (const viewerSocket of deps.session.getAllViewers()) {
    viewerSocket.send(removedPayload);
  }
}

async function handleFinalSegment(
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket
): Promise<void> {
  const recentLines = deps.session.buffer.getRecent();
  const precedingContext = recentLines
    .filter((recentLine) => !recentLine.suppressed)
    .slice(-PRECEDING_CONTEXT_LINES)
    .map((recentLine) => recentLine.english);
  const activeLanguages = deps.session.getActiveLanguages();

  const [transcriptionResult, translations] = await Promise.all([
    verifyTranscriptionWithRetry(deps, english, precedingContext),
    translateWithFallback(deps, english, activeLanguages, precedingContext),
  ]);

  const manualHold = deps.session.mode === 'manual';

  if (!transcriptionResult.safe || manualHold) {
    if (!transcriptionResult.safe) {
      void logEvent('warn', { event: 'transcription_flagged', english, reason: transcriptionResult.reason });
    }
    const reason = manualHold
      ? transcriptionResult.safe
        ? 'Pending manual approval'
        : `Pending manual approval — AI also flagged: ${transcriptionResult.reason}`
      : transcriptionResult.reason;
    const line = deps.session.buffer.append(english, Date.now(), true, translations);
    captureSocket.send(
      JSON.stringify({
        type: 'transcript',
        id: line.id,
        english,
        flagged: true,
        reason,
        ...(manualHold ? { pending: true } : {}),
      })
    );
    const removedPayload = JSON.stringify({ type: 'line-removed', id: line.id });
    for (const viewerSocket of deps.session.getAllViewers()) {
      viewerSocket.send(removedPayload);
    }
    return;
  }

  const line = deps.session.buffer.append(english);
  await finishPublishing(line, translations, deps, captureSocket);
}

async function translateWithFallback(
  deps: WsServerDeps,
  english: string,
  activeLanguages: string[],
  precedingContext: string[]
): Promise<Record<string, string>> {
  if (activeLanguages.length === 0) return {};
  // deps.session.providers is populated synchronously in the 'start' handler
  // before the Deepgram connection (the only source of onFinalSegment calls,
  // which is what drives this function) is created — see handleCaptureConnection.
  const provider = deps.session.providers!.translation;
  try {
    return await provider.translate(english, activeLanguages, precedingContext, deps.session.roleCaches.translation);
  } catch {
    deps.session.roleCaches.translation = null;
    try {
      return await provider.translate(english, activeLanguages, precedingContext, null);
    } catch (secondError) {
      void logEvent('error', {
        event: 'translation_failed',
        english,
        error: secondError instanceof Error ? secondError.message : String(secondError),
      });
      return {};
    }
  }
}

async function verifyTranscriptionWithRetry(
  deps: WsServerDeps,
  english: string,
  precedingContext: string[]
): Promise<TranscriptionCheckResult> {
  const provider = deps.session.providers!.transcriptionVerifier;
  const cacheRef = deps.session.roleCaches.transcriptionVerifier;
  try {
    return await provider.verifyTranscription(english, precedingContext, cacheRef);
  } catch {
    try {
      return await provider.verifyTranscription(english, precedingContext, null);
    } catch (secondError) {
      void logEvent('error', {
        event: 'transcription_verification_failed',
        english,
        error: secondError instanceof Error ? secondError.message : String(secondError),
      });
      return { safe: false, reason: 'verification unavailable' };
    }
  }
}

async function verifyTranslationsWithRetry(
  deps: WsServerDeps,
  items: VerificationItem[]
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};
  const provider = deps.session.providers!.translationVerifier;
  const cacheRef = deps.session.roleCaches.translationVerifier;
  try {
    return await provider.verifyTranslations(items, cacheRef);
  } catch {
    try {
      return await provider.verifyTranslations(items, null);
    } catch (secondError) {
      void logEvent('error', {
        event: 'verification_failed',
        error: secondError instanceof Error ? secondError.message : String(secondError),
      });
      return {};
    }
  }
}

async function ensureBacklogCached(
  deps: WsServerDeps,
  language: string,
  missingEntries: CaptionLine[]
): Promise<void> {
  if (missingEntries.length === 0) return;

  const cache = deps.session.translationCache;
  const fills = deps.session.inFlightFills;

  const existingFill = fills.get(language);
  if (existingFill) {
    await existingFill;
    const stillMissing = missingEntries.filter((line) => cache.get(language, line.id) === undefined);
    if (stillMissing.length === 0) return;
    return ensureBacklogCached(deps, language, stillMissing);
  }

  const fillPromise = (async () => {
    let translations: string[];
    try {
      translations = await deps.session.providers!.translation.translateBacklog(
        missingEntries.map((line) => line.english),
        language,
        deps.session.roleCaches.translation
      );
    } catch (error) {
      void logEvent('error', {
        event: 'backlog_translation_failed',
        language,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const line of missingEntries) {
        cache.set(language, line.id, line.english);
      }
      return;
    }

    const verificationItems: VerificationItem[] = missingEntries
      .map((line, index) => ({ id: line.id, english: line.english, translated: translations[index] ?? '' }))
      .filter((item) => item.translated.length > 0);
    const verifications = await verifyTranslationsWithRetry(deps, verificationItems);

    missingEntries.forEach((line, index) => {
      const translated = translations[index];
      if (!translated) {
        cache.set(language, line.id, line.english);
        return;
      }
      const verification = verifications[line.id];
      if (verification?.safe === true) {
        cache.set(language, line.id, translated);
        return;
      }
      logTranslationFallback(language, line.english, translated, verification?.reason ?? 'verification unavailable');
      cache.set(language, line.id, line.english);
    });
  })();

  fills.set(language, fillPromise);
  try {
    await fillPromise;
  } finally {
    fills.delete(language);
  }
}

function handleViewerConnection(ws: WebSocket, deps: WsServerDeps): void {
  ws.on('message', (data) => {
    void (async () => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'subscribe') {
          const language = message.language as string;
          const cache = deps.session.translationCache;

          const backlog = deps.session.buffer.getRecent();
          const visibleEntries = backlog.filter((line) => !line.suppressed);
          const missingEntries = visibleEntries.filter((line) => cache.get(language, line.id) === undefined);

          if (missingEntries.length > 0) {
            await ensureBacklogCached(deps, language, missingEntries);
          }

          const lines = backlog.map((line) =>
            line.suppressed
              ? { id: line.id, english: '', translated: '', removed: true }
              : { id: line.id, english: line.english, translated: cache.get(language, line.id) ?? line.english }
          );

          ws.send(JSON.stringify({ type: 'backlog', lines }));
          deps.session.addViewer(ws, language);
        }
      } catch (error) {
        void logEvent('error', {
          event: 'viewer_message_error',
          error: error instanceof Error ? error.message : String(error),
        });
        ws.send(JSON.stringify({ type: 'backlog', lines: [] }));
      }
    })();
  });

  ws.on('close', () => deps.session.removeViewer(ws));
}
```

- [ ] **Step 5: Update `wsServer.test.ts`'s test setup to provide the two new deps**

Add these two imports to the top of `server/tests/wsServer.test.ts`, alongside the existing imports:

```ts
import { DEFAULT_MODEL_CONFIG, type ModelConfigStore } from '../src/modelConfigStore';
import { DEFAULT_PROMPT_CONFIG, type PromptConfigStore } from '../src/promptConfigStore';
```

Add these two fake factory functions after the existing `fakeCostTracker` function:

```ts
function fakeModelConfigStore(): ModelConfigStore {
  return { read: vi.fn().mockResolvedValue(DEFAULT_MODEL_CONFIG), write: vi.fn().mockResolvedValue(undefined) };
}

function fakePromptConfigStore(): PromptConfigStore {
  return { read: vi.fn().mockResolvedValue(DEFAULT_PROMPT_CONFIG), write: vi.fn().mockResolvedValue(undefined) };
}
```

In the `beforeEach` block, add the two new deps to the `attachWsServer(...)` call:

```ts
    attachWsServer({
      httpServer,
      session,
      geminiClient,
      deepgramApiKey: 'fake-key',
      createDeepgramConnection: (_apiKey, callbacks) => {
        capturedCallbacks = callbacks;
        return { send: vi.fn(), finish: vi.fn() };
      },
      sermonDocStore,
      feedbackStore,
      costTracker,
      modelConfigStore: fakeModelConfigStore(),
      promptConfigStore: fakePromptConfigStore(),
    });
```

- [ ] **Step 6: Replace the `'sermon context caching'` describe block**

Replace the entire `describe('sermon context caching', ...)` block (originally lines 428-631) in `server/tests/wsServer.test.ts` with:

```ts
  describe('per-role context caching', () => {
    it('creates a cache for every role on start, even with no sermon document uploaded, since fixed rules + notes are always cacheable', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(geminiClient.caches.create).toHaveBeenCalledTimes(3);
      expect(session.roleCaches.transcriptionVerifier).toEqual({ name: 'cachedContents/test' });
      expect(session.roleCaches.translation).toEqual({ name: 'cachedContents/test' });
      expect(session.roleCaches.translationVerifier).toEqual({ name: 'cachedContents/test' });

      captureSocket.close();
    });

    it('passes the translation role\'s cache to translation calls', async () => {
      sermonDocStore.set('This week: the story of Cain and Abel.');
      (feedbackStore.read as ReturnType<typeof vi.fn>).mockResolvedValue(
        'Cain should translate to 该隐 in Chinese'
      );

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const captionPromise = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('Cain killed Abel');
      await captionPromise;

      const translateCall = (geminiClient.models.generateContent as any).mock.calls.find(isTranslateCall);
      expect(translateCall[0].config.cachedContent).toBe('cachedContents/test');

      captureSocket.close();
      viewerSocket.close();
    });

    it('deletes every role\'s cache on stop', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);

      captureSocket.send(JSON.stringify({ type: 'stop' }));
      await waitForMessage(captureSocket); // status: idle

      expect(geminiClient.caches.delete).toHaveBeenCalledTimes(3);
      expect(session.roleCaches).toEqual({ transcriptionVerifier: null, translation: null, translationVerifier: null });

      captureSocket.close();
    });

    it('rebuilds all three caches on a second start (reconnect)', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);

      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording
      expect(geminiClient.caches.create).toHaveBeenCalledTimes(3);

      // Simulate a client auto-reconnect: it re-sends 'start' on the same
      // logical flow without a new document upload.
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(geminiClient.caches.create).toHaveBeenCalledTimes(6);

      captureSocket.close();
    });

    it('drops the stale translation cache reference on translation retry and self-heals subsequent segments', async () => {
      let translateCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":""}' });
        }
        if (params.contents.includes('safety checker')) {
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: '' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        translateCallCount += 1;
        if (translateCallCount === 1) {
          return Promise.reject(new Error('cachedContent reference expired'));
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(session.roleCaches.translation).toEqual({ name: 'cachedContents/test' });

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const captionPromise = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('Cain killed Abel');
      const caption = await captionPromise;

      expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Cain killed Abel', translated: '你好' });

      const translateCalls = (geminiClient.models.generateContent as any).mock.calls.filter(isTranslateCall);
      expect(translateCalls).toHaveLength(2);
      expect(translateCalls[0][0].config.cachedContent).toBe('cachedContents/test');
      expect(translateCalls[1][0].config).not.toHaveProperty('cachedContent');

      // Cross-segment self-healing: only the translation role's cache was
      // cleared, so a later segment must not even attempt to use it, while
      // the other two roles' caches are untouched.
      expect(session.roleCaches.translation).toBeNull();
      expect(session.roleCaches.transcriptionVerifier).toEqual({ name: 'cachedContents/test' });

      const captionPromise2 = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('A later segment');
      await captionPromise2;

      const translateCallsAfter = (geminiClient.models.generateContent as any).mock.calls.filter(isTranslateCall);
      expect(translateCallsAfter).toHaveLength(3);
      expect(translateCallsAfter[2][0].config).not.toHaveProperty('cachedContent');

      captureSocket.close();
      viewerSocket.close();
    });

    it('retries a failed verification without persisting the null cache reference back onto the session', async () => {
      let verifyCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":""}' });
        }
        if (params.contents.includes('safety checker')) {
          verifyCallCount += 1;
          if (verifyCallCount === 1) {
            return Promise.reject(new Error('cachedContent reference expired'));
          }
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: '' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const captionPromise = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('Cain killed Abel');
      const caption = await captionPromise;

      expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Cain killed Abel', translated: '你好' });
      expect(verifyCallCount).toBe(2);

      const verifyCalls = (geminiClient.models.generateContent as any).mock.calls.filter((call: any) =>
        call[0].contents.includes('safety checker')
      );
      expect(verifyCalls).toHaveLength(2);
      expect(verifyCalls[0][0].config.cachedContent).toBe('cachedContents/test');
      expect(verifyCalls[1][0].config).not.toHaveProperty('cachedContent');
      // Unlike translation, a failed verification retry does not persist the
      // null cache reference back onto the session (matches pre-existing behavior).
      expect(session.roleCaches.translationVerifier).toEqual({ name: 'cachedContents/test' });

      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 7: Update the two `reason` literals elsewhere in the file to match the trimmed-on-safe convention**

Every other test in this file that mocks a `safe:true` verifier/checker response with `"reason":"ok"` still works unchanged — the trimmed-reason behavior is a prompt instruction to Gemini, not a parsing constraint, so `verifyTranslations`/`verifyTranscription` still parse whatever `reason` string the (fake) model returns. No further changes needed there.

- [ ] **Step 8: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/session.ts server/src/wsServer.ts server/tests/session.test.ts server/tests/wsServer.test.ts
git commit -m "Wire Session and wsServer to per-role LLM providers and caches"
```

---

### Task 7: Admin passcode middleware

**Files:**
- Create: `server/src/adminAuth.ts`
- Test: `server/tests/adminAuth.test.ts`

**Interfaces:**
- Produces: `createAdminAuth(passcode: string | undefined): RequestHandler` (Express middleware). Task 8 mounts it in front of the four `/admin/*` routes.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/adminAuth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createAdminAuth } from '../src/adminAuth';

function fakeReqRes(header: string | undefined) {
  const req = { header: vi.fn().mockReturnValue(header) } as any;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe('createAdminAuth', () => {
  it('calls next() when the header matches the configured passcode', () => {
    const middleware = createAdminAuth('secret123');
    const { req, res, next } = fakeReqRes('secret123');
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('responds 401 when the header is missing', () => {
    const middleware = createAdminAuth('secret123');
    const { req, res, next } = fakeReqRes(undefined);
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when the header does not match', () => {
    const middleware = createAdminAuth('secret123');
    const { req, res, next } = fakeReqRes('wrong');
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed (401) when no passcode is configured at all, even if a header is sent', () => {
    const middleware = createAdminAuth(undefined);
    const { req, res, next } = fakeReqRes('anything');
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run tests/adminAuth.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `adminAuth.ts`**

```ts
// server/src/adminAuth.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export function createAdminAuth(passcode: string | undefined): RequestHandler {
  return function adminAuth(req: Request, res: Response, next: NextFunction): void {
    const provided = req.header('x-admin-passcode');
    if (!passcode || provided !== passcode) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run tests/adminAuth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/adminAuth.ts server/tests/adminAuth.test.ts
git commit -m "Add passcode-gated admin auth middleware"
```

---

### Task 8: Admin REST routes and server wiring

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Test: `server/tests/app.test.ts`

**Interfaces:**
- Consumes: `createAdminAuth` (Task 7); `ModelConfigStore`, `validateModelConfig`, `createModelConfigStore` (Task 4); `PromptConfigStore`, `validatePromptConfig`, `createPromptConfigStore` (Task 4); `TRANSLATION_FIXED_RULES`, `TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO`/`_OUTRO`, `TRANSLATION_VERIFIER_FIXED_RULES_INTRO`/`_OUTRO` (Task 2).
- Produces: `GET/PUT /admin/model-config`, `GET/PUT /admin/prompt-config`, gated by `x-admin-passcode`. Task 9 (frontend) calls these exact routes.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/app.test.ts`, after the imports (add new imports) and before the closing of the file:

```ts
import { createModelConfigStore, DEFAULT_MODEL_CONFIG } from '../src/modelConfigStore';
import { createPromptConfigStore, DEFAULT_PROMPT_CONFIG } from '../src/promptConfigStore';
```

Update `testDeps()` to include the two new stores and a passcode:

```ts
function testDeps() {
  return {
    sermonDocStore: createSermonDocStore(),
    feedbackStore: createFeedbackStore(join(tmpdir(), `feedback-app-test-${Date.now()}-${Math.random()}.txt`)),
    viewerFeedbackStore: createViewerFeedbackStore(
      join(tmpdir(), `viewer-feedback-app-test-${Date.now()}-${Math.random()}.json`)
    ),
    session: new Session(),
    modelConfigStore: createModelConfigStore(join(tmpdir(), `model-config-app-test-${Date.now()}-${Math.random()}.json`)),
    promptConfigStore: createPromptConfigStore(join(tmpdir(), `prompt-config-app-test-${Date.now()}-${Math.random()}.json`)),
    adminPasscode: 'test-passcode',
  };
}
```

Add these new test blocks at the end of the file:

```ts
describe('GET/PUT /admin/model-config', () => {
  it('returns 401 without the admin passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/admin/model-config');
    expect(response.status).toBe(401);
  });

  it('returns the default config on first read', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/model-config')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('saves a valid config and returns it on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const newConfig = {
      transcriptionVerifier: 'gemini-3.1-flash-lite',
      translation: 'gemini-3.5-flash',
      translationVerifier: 'gemini-3.1-flash-lite',
    };

    const putResponse = await request(app)
      .put('/admin/model-config')
      .set('x-admin-passcode', 'test-passcode')
      .send(newConfig);
    expect(putResponse.status).toBe(200);

    const getResponse = await request(app).get('/admin/model-config').set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual(newConfig);
  });

  it('rejects an invalid model id with 400 and does not persist it', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const putResponse = await request(app)
      .put('/admin/model-config')
      .set('x-admin-passcode', 'test-passcode')
      .send({ transcriptionVerifier: 'gpt-5', translation: 'gemini-3.5-flash', translationVerifier: 'gemini-3.1-flash-lite' });
    expect(putResponse.status).toBe(400);

    const getResponse = await request(app).get('/admin/model-config').set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual(DEFAULT_MODEL_CONFIG);
  });
});

describe('GET/PUT /admin/prompt-config', () => {
  it('returns 401 without the admin passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/admin/prompt-config');
    expect(response.status).toBe(401);
  });

  it('returns the default notes and the fixed rules for reference on first read', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/prompt-config')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body.notes).toEqual(DEFAULT_PROMPT_CONFIG);
    expect(typeof response.body.fixedRules.transcriptionVerifier).toBe('string');
    expect(typeof response.body.fixedRules.translation).toBe('string');
    expect(typeof response.body.fixedRules.translationVerifier).toBe('string');
  });

  it('saves valid notes and returns them on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const newNotes = { transcriptionVerifier: 'a', translation: 'b', translationVerifier: 'c' };

    const putResponse = await request(app)
      .put('/admin/prompt-config')
      .set('x-admin-passcode', 'test-passcode')
      .send(newNotes);
    expect(putResponse.status).toBe(200);

    const getResponse = await request(app).get('/admin/prompt-config').set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body.notes).toEqual(newNotes);
  });

  it('rejects a payload missing a role with 400', async () => {
    const response = await request(createApp(testDeps()))
      .put('/admin/prompt-config')
      .set('x-admin-passcode', 'test-passcode')
      .send({ transcriptionVerifier: 'a', translation: 'b' });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: FAIL — `AppDeps` doesn't accept the new fields yet and the routes don't exist.

- [ ] **Step 3: Update `app.ts`**

Replace the full contents of `server/src/app.ts`:

```ts
import express, { type Express } from 'express';
import cors from 'cors';
import multer from 'multer';
import { extractDocumentText } from './docExtraction.js';
import { toCsv } from './csv.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { ViewerFeedbackStore } from './viewerFeedbackStore.js';
import type { Session } from './session.js';
import { createAdminAuth } from './adminAuth.js';
import { validateModelConfig, type ModelConfigStore } from './modelConfigStore.js';
import { validatePromptConfig, type PromptConfigStore } from './promptConfigStore.js';
import {
  TRANSLATION_FIXED_RULES,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_INTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_OUTRO,
} from './llmPrompts.js';

export interface AppDeps {
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
  viewerFeedbackStore: ViewerFeedbackStore;
  session: Session;
  modelConfigStore: ModelConfigStore;
  promptConfigStore: PromptConfigStore;
  adminPasscode: string | undefined;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json());

  const adminAuth = createAdminAuth(deps.adminPasscode);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/sermon-doc', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const text = await extractDocumentText(req.file.buffer, req.file.mimetype);
      if (text.length === 0) {
        res.status(400).json({ error: 'Could not extract any text from this document' });
        return;
      }
      deps.sermonDocStore.set(text);
      res.json({ ok: true, characterCount: text.length });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to process document' });
    }
  });

  app.get('/feedback', async (_req, res) => {
    const text = await deps.feedbackStore.read();
    res.json({ text });
  });

  app.put('/feedback', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    await deps.feedbackStore.write(text);
    res.json({ ok: true });
  });

  app.post('/viewer-feedback', (req, res) => {
    const { language, lineIndex, english, translated, comment } = req.body ?? {};
    if (
      typeof language !== 'string' ||
      typeof lineIndex !== 'number' ||
      typeof english !== 'string' ||
      typeof translated !== 'string'
    ) {
      res.status(400).json({ error: 'language, lineIndex, english, and translated are required' });
      return;
    }
    deps.viewerFeedbackStore.add({
      sessionId: deps.session.id,
      language,
      lineIndex,
      english,
      translated,
      comment: typeof comment === 'string' ? comment : '',
    });
    res.json({ ok: true });
  });

  app.get('/viewer-feedback', (_req, res) => {
    res.json({ items: deps.viewerFeedbackStore.list() });
  });

  const VIEWER_FEEDBACK_CSV_HEADER = ['Timestamp', 'Language', 'English', 'Translated', 'Comment', 'Session ID'];

  app.post('/viewer-feedback/:id/download', (req, res) => {
    const item = deps.viewerFeedbackStore.get(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Feedback item not found' });
      return;
    }
    deps.viewerFeedbackStore.markDownloaded([item.id]);
    const csv = toCsv(VIEWER_FEEDBACK_CSV_HEADER, [
      [item.timestamp, item.language, item.english, item.translated, item.comment, item.sessionId],
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-${item.id}.csv"`);
    res.send(csv);
  });

  app.post('/viewer-feedback/download-all', (_req, res) => {
    const undownloaded = deps.viewerFeedbackStore.getUndownloaded();
    deps.viewerFeedbackStore.markDownloaded(undownloaded.map((item) => item.id));
    const csv = toCsv(
      VIEWER_FEEDBACK_CSV_HEADER,
      undownloaded.map((item) => [item.timestamp, item.language, item.english, item.translated, item.comment, item.sessionId])
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-all-${Date.now()}.csv"`);
    res.send(csv);
  });

  app.get('/admin/model-config', adminAuth, async (_req, res) => {
    res.json(await deps.modelConfigStore.read());
  });

  app.put('/admin/model-config', adminAuth, async (req, res) => {
    const config = validateModelConfig(req.body);
    if (!config) {
      res.status(400).json({ error: 'Invalid model config: all three roles must be set to a supported model id' });
      return;
    }
    await deps.modelConfigStore.write(config);
    res.json({ ok: true });
  });

  app.get('/admin/prompt-config', adminAuth, async (_req, res) => {
    res.json({
      notes: await deps.promptConfigStore.read(),
      fixedRules: {
        transcriptionVerifier: `${TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO}\n\n${TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO}`,
        translation: TRANSLATION_FIXED_RULES,
        translationVerifier: `${TRANSLATION_VERIFIER_FIXED_RULES_INTRO}\n\n${TRANSLATION_VERIFIER_FIXED_RULES_OUTRO}`,
      },
    });
  });

  app.put('/admin/prompt-config', adminAuth, async (req, res) => {
    const config = validatePromptConfig(req.body);
    if (!config) {
      res.status(400).json({ error: 'Invalid prompt config: all three roles must be set to a string' });
      return;
    }
    await deps.promptConfigStore.write(config);
    res.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 4: Run `app.test.ts`**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the new stores and passcode into `index.ts`**

Replace the full contents of `server/src/index.ts`:

```ts
import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachWsServer } from './wsServer.js';
import { Session } from './session.js';
import { createGeminiClient } from './gemini.js';
import { createDeepgramConnection } from './deepgram.js';
import { createSermonDocStore } from './sermonDocStore.js';
import { createFeedbackStore } from './feedbackStore.js';
import { createViewerFeedbackStore } from './viewerFeedbackStore.js';
import { createCostTracker } from './costTracker.js';
import { createModelConfigStore } from './modelConfigStore.js';
import { createPromptConfigStore } from './promptConfigStore.js';
import { withCostTracking } from './geminiCostTracking.js';
import { withGeminiLimiter } from './geminiRateLimiting.js';
import { GeminiCallLimiter } from './geminiLimiter.js';

const requiredEnvVars = ['DEEPGRAM_API_KEY', 'GEMINI_API_KEY'] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const session = new Session();
const costTracker = createCostTracker(process.env.COST_FILE_PATH ?? 'data/cost.json');
const geminiLimiter = new GeminiCallLimiter();
const geminiClient = withCostTracking(
  withGeminiLimiter(createGeminiClient(process.env.GEMINI_API_KEY!), geminiLimiter),
  costTracker
);
const sermonDocStore = createSermonDocStore();
const feedbackStore = createFeedbackStore(process.env.FEEDBACK_FILE_PATH ?? 'data/feedback.txt');
const viewerFeedbackStore = createViewerFeedbackStore(
  process.env.VIEWER_FEEDBACK_FILE_PATH ?? 'data/viewer-feedback.json'
);
const modelConfigStore = createModelConfigStore(process.env.MODEL_CONFIG_FILE_PATH ?? 'data/model-config.json');
const promptConfigStore = createPromptConfigStore(process.env.PROMPT_CONFIG_FILE_PATH ?? 'data/prompt-config.json');

const app = createApp({
  sermonDocStore,
  feedbackStore,
  viewerFeedbackStore,
  session,
  modelConfigStore,
  promptConfigStore,
  adminPasscode: process.env.ADMIN_PASSCODE,
});
const httpServer = createServer(app);

attachWsServer({
  httpServer,
  session,
  geminiClient,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
  createDeepgramConnection,
  sermonDocStore,
  feedbackStore,
  costTracker,
  modelConfigStore,
  promptConfigStore,
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

Note `ADMIN_PASSCODE` is deliberately **not** added to `requiredEnvVars` — an unset passcode fails closed (401 on every `/admin/*` request) rather than crashing the whole server at boot, so existing deployments that haven't set it yet keep running exactly as before, just without admin-page access.

- [ ] **Step 6: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/tests/app.test.ts
git commit -m "Add passcode-gated /admin/model-config and /admin/prompt-config routes"
```

---

### Task 9: Admin frontend page

**Files:**
- Create: `web/app/admin/page.tsx`

**Interfaces:**
- Consumes: `GET/PUT /admin/model-config`, `GET/PUT /admin/prompt-config` (Task 8), via `x-admin-passcode` header.

No frontend test framework exists in this repo (`web/` has zero `*.test.*` files) — verification for this task is manual only, matching the rest of `web/`.

- [ ] **Step 1: Write `web/app/admin/page.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type ModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';
type Role = 'transcriptionVerifier' | 'translation' | 'translationVerifier';

interface ModelConfig {
  transcriptionVerifier: ModelId;
  translation: ModelId;
  translationVerifier: ModelId;
}

interface PromptConfig {
  transcriptionVerifier: string;
  translation: string;
  translationVerifier: string;
}

const ROLE_LABELS: Record<Role, string> = {
  transcriptionVerifier: 'Transcription verifier',
  translation: 'Translation',
  translationVerifier: 'Translation verifier',
};

const ROLES: Role[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
const MODEL_IDS: ModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];

export default function AdminPage() {
  const [passcode, setPasscode] = useState('');
  const [enteredPasscode, setEnteredPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);

  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const [modelSaveStatus, setModelSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [modelError, setModelError] = useState<string | null>(null);

  const [notes, setNotes] = useState<PromptConfig | null>(null);
  const [fixedRules, setFixedRules] = useState<PromptConfig | null>(null);
  const [notesSaveStatus, setNotesSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [notesError, setNotesError] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.sessionStorage.getItem('adminPasscode');
    if (stored) {
      setPasscode(stored);
      void loadAll(stored);
    }
  }, []);

  async function loadAll(candidatePasscode: string) {
    setCheckingAuth(true);
    setAuthError(null);
    try {
      const [modelResponse, promptResponse] = await Promise.all([
        fetch(`${API_URL}/admin/model-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/prompt-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
      ]);

      if (modelResponse.status === 401 || promptResponse.status === 401) {
        window.sessionStorage.removeItem('adminPasscode');
        setAuthorized(false);
        setAuthError('Incorrect passcode.');
        return;
      }

      setModelConfig(await modelResponse.json());
      const promptData = await promptResponse.json();
      setNotes(promptData.notes);
      setFixedRules(promptData.fixedRules);

      window.sessionStorage.setItem('adminPasscode', candidatePasscode);
      setPasscode(candidatePasscode);
      setAuthorized(true);
    } catch {
      setAuthError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCheckingAuth(false);
    }
  }

  function submitPasscode() {
    void loadAll(enteredPasscode);
  }

  async function saveModelConfig() {
    if (!modelConfig) return;
    setModelSaveStatus('saving');
    setModelError(null);
    try {
      const response = await fetch(`${API_URL}/admin/model-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(modelConfig),
      });
      if (!response.ok) {
        setModelError(`Save failed (status ${response.status}).`);
        setModelSaveStatus('idle');
        return;
      }
      setModelSaveStatus('saved');
    } catch {
      setModelError('Save failed. Check your connection and try again.');
      setModelSaveStatus('idle');
    }
  }

  async function saveNotes() {
    if (!notes) return;
    setNotesSaveStatus('saving');
    setNotesError(null);
    try {
      const response = await fetch(`${API_URL}/admin/prompt-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(notes),
      });
      if (!response.ok) {
        setNotesError(`Save failed (status ${response.status}).`);
        setNotesSaveStatus('idle');
        return;
      }
      setNotesSaveStatus('saved');
    } catch {
      setNotesError('Save failed. Check your connection and try again.');
      setNotesSaveStatus('idle');
    }
  }

  if (!authorized) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
        <h1 className="text-xl font-semibold">Admin</h1>
        <input
          type="password"
          value={enteredPasscode}
          onChange={(event) => setEnteredPasscode(event.target.value)}
          placeholder="Passcode"
          className="border rounded p-2 text-sm w-64"
          disabled={checkingAuth}
        />
        <button
          onClick={submitPasscode}
          disabled={checkingAuth || enteredPasscode.length === 0}
          className="bg-primary text-primary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          {checkingAuth ? 'Checking…' : 'Enter'}
        </button>
        {authError && <p className="text-sm text-destructive">{authError}</p>}
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col items-center gap-8 p-6">
      <h1 className="text-xl font-semibold">Admin</h1>

      <div className="w-full max-w-xl flex flex-col gap-3">
        <h2 className="text-lg font-medium">Models</h2>
        {modelConfig &&
          ROLES.map((role) => (
            <div key={role} className="flex items-center justify-between gap-2">
              <label className="text-sm font-medium">{ROLE_LABELS[role]}</label>
              <select
                value={modelConfig[role]}
                onChange={(event) => {
                  setModelConfig({ ...modelConfig, [role]: event.target.value as ModelId });
                  setModelSaveStatus('idle');
                }}
                className="border rounded p-1 text-sm"
              >
                {MODEL_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          ))}
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

      <div className="w-full max-w-xl flex flex-col gap-6">
        <h2 className="text-lg font-medium">Prompt notes</h2>
        {notes &&
          fixedRules &&
          ROLES.map((role) => (
            <div key={role} className="flex flex-col gap-2">
              <label className="text-sm font-medium">{ROLE_LABELS[role]}</label>
              <p className="text-xs text-muted-foreground border rounded p-2 bg-accent/20 whitespace-pre-wrap">
                {fixedRules[role]}
              </p>
              <textarea
                value={notes[role]}
                onChange={(event) => {
                  setNotes({ ...notes, [role]: event.target.value });
                  setNotesSaveStatus('idle');
                }}
                rows={4}
                className="w-full border rounded p-2 text-sm"
              />
            </div>
          ))}
        <div className="flex items-center gap-3">
          <button
            onClick={saveNotes}
            disabled={notesSaveStatus === 'saving'}
            className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
          >
            Save notes
          </button>
          {notesSaveStatus === 'saved' && <p className="text-sm text-green-600">Saved.</p>}
        </div>
        {notesError && <p className="text-sm text-destructive">{notesError}</p>}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Manually verify in the browser**

1. Set `ADMIN_PASSCODE=test123` in `server/.env` (or the shell running it) and restart the server.
2. Run: `cd server && npm run dev` (leave running)
3. Run: `cd web && npm run dev` (leave running)
4. Open `http://localhost:3000/admin`. Confirm the passcode gate appears.
5. Enter a wrong passcode — confirm "Incorrect passcode." appears and no config loads.
6. Enter `test123` — confirm both sections load: 3 model dropdowns (all defaulting to `gemini-3.1-flash-lite`) and 3 notes textareas pre-filled with today's actual default notes text, each with its fixed rules shown as read-only text above the textarea.
7. Change the "Translation" dropdown to `gemini-3.5-flash`, click "Save models" — confirm "Saved." appears.
8. Reload the page, re-enter the passcode — confirm the translation dropdown still shows `gemini-3.5-flash` (persisted).
9. Edit one of the notes textareas, click "Save notes" — confirm "Saved.", then reload and confirm the edit persisted.
10. Confirm `server/data/model-config.json` and `server/data/prompt-config.json` now exist on disk with the saved values.

- [ ] **Step 3: Commit**

```bash
git add web/app/admin/page.tsx
git commit -m "Add passcode-gated admin page for per-role model selection and prompt notes"
```

---

## Final Verification

- [ ] Run `cd server && npx vitest run` — full suite green.
- [ ] Run `cd server && npx tsc -p tsconfig.json --noEmit` — no type errors.
- [ ] Manually run a capture session end-to-end (per `run`/`verify` skill conventions) with the default config, confirming captions/translations still work and `server/data/cost.json` accumulates a sane amount.
- [ ] Manually exercise the admin page per Task 9 Step 2, then start a new capture session and confirm the changed model/notes are actually used (check the request payload to Gemini, or just confirm no regressions in translation output).
