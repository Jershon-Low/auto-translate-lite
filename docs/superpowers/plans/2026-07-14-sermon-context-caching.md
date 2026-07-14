# Sermon & Feedback Context via Explicit Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give live translation and safety verification access to this week's sermon document and an accumulated feedback-notes file, via one Gemini explicit context cache per session, so the marginal cost of that context stays ~90% cheaper than inlining it on every call.

**Architecture:** A required PDF/Word upload on the capture page is extracted to plain text server-side and held in a single-slot in-memory store. A separate, optional, standing feedback-notes file is editable in-browser from the same page. When the volunteer clicks Start, the server combines feedback text + sermon text into one Gemini `cachedContent` (TTL 2 hours) and stores the reference on the session; `translateSegment` and `verifyTranslations` both pass it through via `config.cachedContent` when present. Stop deletes the cache. Everything falls back to today's uncached behavior when no document is uploaded or cache creation fails.

**Tech Stack:** Node.js/TypeScript server (Express, `ws`, `@google/genai`), `pdf-parse` + `mammoth` for text extraction, `multer` for multipart upload; Next.js/React capture page (no new frontend test infra — this repo has none for `web/`, manual verification only).

## Global Constraints

- Model for cache creation matches the existing translation/verification model: `gemini-3.1-flash-lite`.
- Cache TTL: `'7200s'` (2 hours) — comfortably past a typical service, no proactive refresh.
- Extracted sermon doc text is capped at 30,000 characters (`MAX_CHARS` in `docExtraction.ts`).
- Cache is skipped (falls back to uncached) when the combined instruction text is under 200 characters (`MIN_CACHEABLE_CHARS` in `sermonCache.ts`) — a cheap proxy for Gemini's real per-model minimum-token threshold, backed by a try/catch fallback for any other cache-creation failure.
- **Deviation from the design spec, decided during planning:** the cache holds **only** feedback notes + sermon document text, not the Australian-idiom/polarity/theology instruction text already in `gemini.ts`/`translationVerifier.ts`. Those two prompts have different exact wording (one instructs translation, one instructs verification) — literally deduplicating them risked changing tested, working prompt text for a small token saving. The sermon doc + feedback notes are the dominant token cost anyway, so this keeps ~95%+ of the cost-saving story from the spec while leaving the existing, exactly-tested prompt strings untouched.
- `translateBacklog` is explicitly **not** wired to the cache (matches the existing project decision that batch translation already gets context for free) — only `translateSegment` and `verifyTranslations`.
- No new authentication is added anywhere in this plan (explicitly deferred per user direction) — the capture page and its new `/sermon-doc`, `/feedback` endpoints inherit the app's existing no-auth trust model.
- Feedback file default path: `data/feedback.txt` relative to the server process's working directory, overridable via `FEEDBACK_FILE_PATH` env var.

---

### Task 1: `GeminiClient` cache API + `sermonCache` module

**Files:**
- Modify: `server/src/gemini.ts` (add `SermonCacheRef` interface, extend `GeminiClient` with `caches`)
- Create: `server/src/sermonCache.ts`
- Create: `server/tests/sermonCache.test.ts`
- Modify: `server/tests/gemini.test.ts` (update `fakeClient` helper)
- Modify: `server/tests/translationVerifier.test.ts` (update `fakeClient` helper)
- Modify: `server/tests/wsServer.test.ts` (update `fakeGeminiClient` helper)

**Interfaces:**
- Produces: `SermonCacheRef { name: string }`, exported from `server/src/gemini.ts`.
- Produces: `buildSermonContextInstruction(feedbackText: string, sermonText: string): string`, `createSermonContextCache(client: GeminiClient, feedbackText: string, sermonText: string): Promise<SermonCacheRef | null>`, `deleteSermonContextCache(client: GeminiClient, cacheRef: SermonCacheRef | null): Promise<void>`, all exported from `server/src/sermonCache.ts`.
- Consumes: nothing from earlier tasks (this is the first task).

- [ ] **Step 1: Write the failing tests for `sermonCache.ts`**

Create `server/tests/sermonCache.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  buildSermonContextInstruction,
  createSermonContextCache,
  deleteSermonContextCache,
} from '../src/sermonCache';
import type { GeminiClient } from '../src/gemini';

function fakeClientWithCaches(
  overrides: { createResult?: { name?: string }; createError?: Error } = {}
): GeminiClient {
  return {
    models: { generateContent: vi.fn() },
    caches: {
      create: vi.fn().mockImplementation(() => {
        if (overrides.createError) return Promise.reject(overrides.createError);
        return Promise.resolve(overrides.createResult ?? { name: 'cachedContents/abc123' });
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('buildSermonContextInstruction', () => {
  it('labels and includes both feedback and sermon sections when both are present', () => {
    const instruction = buildSermonContextInstruction(
      'Cain should be 该隐 in Chinese',
      'Today we talk about Cain and Abel.'
    );
    expect(instruction).toContain('Known corrections from past sessions');
    expect(instruction).toContain('Cain should be 该隐');
    expect(instruction).toContain("This week's sermon material");
    expect(instruction).toContain('Cain and Abel');
  });

  it('omits the feedback section when feedback text is empty', () => {
    const instruction = buildSermonContextInstruction('', 'Sermon content here.');
    expect(instruction).not.toContain('Known corrections from past sessions');
    expect(instruction).toContain('Sermon content here.');
  });
});

describe('createSermonContextCache', () => {
  it('creates a cache and returns its name when content is long enough', async () => {
    const client = fakeClientWithCaches({ createResult: { name: 'cachedContents/xyz' } });
    const ref = await createSermonContextCache(client, '', 'A'.repeat(500));
    expect(ref).toEqual({ name: 'cachedContents/xyz' });
    expect(client.caches.create).toHaveBeenCalledTimes(1);
  });

  it('returns null without calling the API when combined content is too short to cache', async () => {
    const client = fakeClientWithCaches();
    const ref = await createSermonContextCache(client, '', 'short');
    expect(ref).toBeNull();
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('returns null and logs when cache creation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClientWithCaches({ createError: new Error('API down') });
    const ref = await createSermonContextCache(client, '', 'A'.repeat(500));
    expect(ref).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('deleteSermonContextCache', () => {
  it('deletes the cache by name when a ref is provided', async () => {
    const client = fakeClientWithCaches();
    await deleteSermonContextCache(client, { name: 'cachedContents/xyz' });
    expect(client.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/xyz' });
  });

  it('does nothing when the ref is null', async () => {
    const client = fakeClientWithCaches();
    await deleteSermonContextCache(client, null);
    expect(client.caches.delete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/sermonCache.test.ts`
Expected: FAIL — `Cannot find module '../src/sermonCache'`

- [ ] **Step 3: Extend `GeminiClient` in `gemini.ts`**

In `server/src/gemini.ts`, replace the top of the file (the `import` line through the end of `createGeminiClient`) with:

```ts
import { GoogleGenAI } from '@google/genai';

export interface SermonCacheRef {
  name: string;
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
    }): Promise<{ text: string | null | undefined }>;
  };
  caches: {
    create(params: {
      model: string;
      config: { systemInstruction: string; ttl: string; displayName?: string };
    }): Promise<{ name?: string }>;
    delete(params: { name: string }): Promise<void>;
  };
}

export function createGeminiClient(apiKey: string): GeminiClient {
  return new GoogleGenAI({ apiKey });
}
```

Leave the rest of `gemini.ts` (`buildContextBlock`, `translateSegment`, `translateBacklog`) unchanged for this step.

- [ ] **Step 4: Create `sermonCache.ts`**

Create `server/src/sermonCache.ts`:

```ts
import type { GeminiClient, SermonCacheRef } from './gemini.js';

const MODEL = 'gemini-3.1-flash-lite';
const CACHE_TTL = '7200s';
const MIN_CACHEABLE_CHARS = 200;

export function buildSermonContextInstruction(feedbackText: string, sermonText: string): string {
  const sections: string[] = [];
  const trimmedFeedback = feedbackText.trim();
  if (trimmedFeedback.length > 0) {
    sections.push(
      `Known corrections from past sessions (avoid repeating these specific mistakes):\n${trimmedFeedback}`
    );
  }
  sections.push(
    `This week's sermon material (for reference only, e.g. names, scripture references, terminology):\n${sermonText.trim()}`
  );
  return sections.join('\n\n');
}

export async function createSermonContextCache(
  client: GeminiClient,
  feedbackText: string,
  sermonText: string
): Promise<SermonCacheRef | null> {
  const instruction = buildSermonContextInstruction(feedbackText, sermonText);
  if (instruction.length < MIN_CACHEABLE_CHARS) return null;

  try {
    const cache = await client.caches.create({
      model: MODEL,
      config: { systemInstruction: instruction, ttl: CACHE_TTL, displayName: 'sermon-context' },
    });
    return cache.name ? { name: cache.name } : null;
  } catch (error) {
    console.error('Failed to create sermon context cache, continuing without it:', error);
    return null;
  }
}

export async function deleteSermonContextCache(
  client: GeminiClient,
  cacheRef: SermonCacheRef | null
): Promise<void> {
  if (!cacheRef) return;
  try {
    await client.caches.delete({ name: cacheRef.name });
  } catch (error) {
    console.error('Failed to delete sermon context cache:', error);
  }
}
```

- [ ] **Step 5: Update existing `fakeClient`/`fakeGeminiClient` helpers to satisfy the widened interface**

In `server/tests/gemini.test.ts`, replace the `fakeClient` helper with:

```ts
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
```

In `server/tests/translationVerifier.test.ts`, replace the `fakeClient` helper with the identical block above.

In `server/tests/wsServer.test.ts`, add a `caches` field to the object returned by `fakeGeminiClient`:

```ts
function fakeGeminiClient(overrides: { translate?: string; verify?: string } = {}): GeminiClient {
  const translateText = overrides.translate ?? '{"zh":"你好"}';
  return {
    models: {
      generateContent: vi.fn().mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          if (overrides.verify) {
            return Promise.resolve({ text: overrides.verify });
          }
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) {
            result[id] = { safe: true, reason: 'ok' };
          }
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        return Promise.resolve({ text: translateText });
      }),
    },
    caches: {
      create: vi.fn().mockResolvedValue({ name: 'cachedContents/test' }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/sermonCache.test.ts tests/gemini.test.ts tests/translationVerifier.test.ts tests/wsServer.test.ts`
Expected: PASS (all suites)

- [ ] **Step 7: Commit**

```bash
git add server/src/gemini.ts server/src/sermonCache.ts server/tests/sermonCache.test.ts server/tests/gemini.test.ts server/tests/translationVerifier.test.ts server/tests/wsServer.test.ts
git commit -m "feat: add Gemini explicit cache API and sermonCache module"
```

---

### Task 2: `translateSegment` gains an optional sermon cache

**Files:**
- Modify: `server/src/gemini.ts:28-55` (the `translateSegment` function)
- Modify: `server/tests/gemini.test.ts`

**Interfaces:**
- Consumes: `SermonCacheRef` from Task 1 (`server/src/gemini.ts`).
- Produces: `translateSegment(client, englishText, languageCodes, precedingContext?, sermonCache?)` — the new 5th parameter, `sermonCache: SermonCacheRef | null = null`, consumed by Task 7 (`wsServer.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/gemini.test.ts`, inside the `describe('translateSegment', ...)` block:

```ts
  it('includes cachedContent in the request config when a sermon cache is provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, 'Hello', ['zh'], [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('omits cachedContent from the request config when no sermon cache is provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, 'Hello', ['zh']);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/gemini.test.ts`
Expected: FAIL — `call.config.cachedContent` is `undefined` in the first new test (expected `'cachedContents/abc'`)

- [ ] **Step 3: Update `translateSegment`**

In `server/src/gemini.ts`, replace the `translateSegment` function with:

```ts
export async function translateSegment(
  client: GeminiClient,
  englishText: string,
  languageCodes: string[],
  precedingContext: string[] = [],
  sermonCache: SermonCacheRef | null = null
): Promise<Record<string, string>> {
  if (languageCodes.length === 0) return {};

  const properties: Record<string, { type: string }> = {};
  for (const code of languageCodes) properties[code] = { type: 'string' };

  const response = await client.models.generateContent({
    model: MODEL,
    contents: `Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal.

This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she'll be right," "having a go"). Translate for the speaker's intended meaning and tone, not word-for-word — don't flatten idiomatic phrasing into something overly formal, and don't translate slang literally into an unrelated meaning.

Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don't add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.

${buildContextBlock(precedingContext)}Sentence: "${englishText}"`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: languageCodes },
      ...(sermonCache ? { cachedContent: sermonCache.name } : {}),
    },
  });

  return JSON.parse(response.text ?? '{}');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/gemini.test.ts`
Expected: PASS (all tests in this file, including the pre-existing ones — the byte-for-byte "unchanged prompt" test must still pass since `contents` wasn't touched)

- [ ] **Step 5: Commit**

```bash
git add server/src/gemini.ts server/tests/gemini.test.ts
git commit -m "feat: let translateSegment reference a sermon context cache"
```

---

### Task 3: `verifyTranslations` gains an optional sermon cache

**Files:**
- Modify: `server/src/translationVerifier.ts`
- Modify: `server/tests/translationVerifier.test.ts`

**Interfaces:**
- Consumes: `SermonCacheRef` from Task 1 (`server/src/gemini.ts`).
- Produces: `verifyTranslations(client, items, sermonCache?)` — the new 3rd parameter, `sermonCache: SermonCacheRef | null = null`, consumed by Task 7 (`wsServer.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/translationVerifier.test.ts`, inside the `describe('verifyTranslations', ...)` block:

```ts
  it('includes cachedContent in the request config when a sermon cache is provided', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":"ok"}}');
    await verifyTranslations(
      client,
      [{ id: 'zh', english: 'Hello', translated: '你好' }],
      { name: 'cachedContents/abc' }
    );
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('omits cachedContent from the request config when no sermon cache is provided', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":"ok"}}');
    await verifyTranslations(client, [{ id: 'zh', english: 'Hello', translated: '你好' }]);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/translationVerifier.test.ts`
Expected: FAIL — `call.config.cachedContent` is `undefined` in the first new test

- [ ] **Step 3: Update `verifyTranslations`**

In `server/src/translationVerifier.ts`, replace the whole file with:

```ts
import type { GeminiClient, SermonCacheRef } from './gemini.js';

export interface VerificationItem {
  id: string;
  english: string;
  translated: string;
}

export interface VerificationResult {
  safe: boolean;
  reason: string;
}

const MODEL = 'gemini-3.1-flash-lite';

export async function verifyTranslations(
  client: GeminiClient,
  items: VerificationItem[],
  sermonCache: SermonCacheRef | null = null
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

  const response = await client.models.generateContent({
    model: MODEL,
    contents: `You are a safety checker for live captions at an Australian church sermon. For each numbered pair below, decide whether the translation is safe to show: it must preserve the original's meaning and polarity, and must not misrepresent who God, Jesus, or the Holy Spirit is or does.

Do NOT flag a translation just because it is idiomatic or non-literal — this sermon includes Australian slang, jokes, and dry humor (e.g. "no worries," "arvo," "having a go," "she'll be right"), and a natural, non-literal rendering of those is expected and correct.

Only mark a translation unsafe if it inverts a positive statement into a negative one (or vice versa), negates or contradicts the original, reverses who is doing or receiving an action, or misrepresents God/Jesus/the Holy Spirit.

Pairs:
${pairs}

Return, for each id, whether it is safe and a short reason.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: items.map((item) => item.id) },
      ...(sermonCache ? { cachedContent: sermonCache.name } : {}),
    },
  });

  const parsed: unknown = JSON.parse(response.text ?? '{}');
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, VerificationResult>) : {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/translationVerifier.test.ts`
Expected: PASS (all tests, including pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add server/src/translationVerifier.ts server/tests/translationVerifier.test.ts
git commit -m "feat: let verifyTranslations reference a sermon context cache"
```

---

### Task 4: Sermon document text extraction

**Files:**
- Create: `server/src/docExtraction.ts`
- Create: `server/tests/docExtraction.test.ts`
- Modify: `server/package.json` (add `pdf-parse`, `mammoth`, `@types/pdf-parse`)

**Interfaces:**
- Produces: `extractDocumentText(buffer: Buffer, mimetype: string): Promise<string>`, exported from `server/src/docExtraction.ts`, consumed by Task 6 (`app.ts`).
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Install dependencies**

Run: `cd server && npm install pdf-parse mammoth && npm install -D @types/pdf-parse`
Expected: `package.json`'s `dependencies` gains `pdf-parse` and `mammoth`; `devDependencies` gains `@types/pdf-parse`.

- [ ] **Step 2: Write the failing tests**

Create `server/tests/docExtraction.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('pdf-parse', () => ({
  default: vi.fn().mockResolvedValue({ text: '  Extracted PDF text  ' }),
}));
vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn().mockResolvedValue({ value: '  Extracted docx text  ' }) },
}));

import pdfParse from 'pdf-parse';
import { extractDocumentText } from '../src/docExtraction';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('extractDocumentText', () => {
  it('extracts and trims text from a PDF', async () => {
    const result = await extractDocumentText(Buffer.from('fake'), 'application/pdf');
    expect(result).toBe('Extracted PDF text');
  });

  it('extracts and trims text from a docx', async () => {
    const result = await extractDocumentText(Buffer.from('fake'), DOCX_MIME);
    expect(result).toBe('Extracted docx text');
  });

  it('throws for an unsupported mimetype', async () => {
    await expect(extractDocumentText(Buffer.from('fake'), 'text/plain')).rejects.toThrow(
      'Unsupported document type: text/plain'
    );
  });

  it('truncates text longer than 30,000 characters', async () => {
    (pdfParse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: 'A'.repeat(40000) });
    const result = await extractDocumentText(Buffer.from('fake'), 'application/pdf');
    expect(result).toHaveLength(30000);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/docExtraction.test.ts`
Expected: FAIL — `Cannot find module '../src/docExtraction'`

- [ ] **Step 4: Create `docExtraction.ts`**

Create `server/src/docExtraction.ts`:

```ts
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const MAX_CHARS = 30000;
const PDF_MIME_TYPE = 'application/pdf';
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function extractDocumentText(buffer: Buffer, mimetype: string): Promise<string> {
  let text: string;
  if (mimetype === PDF_MIME_TYPE) {
    const result = await pdfParse(buffer);
    text = result.text;
  } else if (mimetype === DOCX_MIME_TYPE) {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else {
    throw new Error(`Unsupported document type: ${mimetype}`);
  }

  const trimmed = text.trim();
  return trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/docExtraction.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/docExtraction.ts server/tests/docExtraction.test.ts
git commit -m "feat: add PDF/docx sermon document text extraction"
```

---

### Task 5: Feedback notes file store

**Files:**
- Create: `server/src/feedbackStore.ts`
- Create: `server/tests/feedbackStore.test.ts`
- Modify: `server/.gitignore` (add `data/`)

**Interfaces:**
- Produces: `FeedbackStore { read(): Promise<string>; write(text: string): Promise<void>; }` interface and `createFeedbackStore(filePath: string): FeedbackStore` factory, both exported from `server/src/feedbackStore.ts`, consumed by Task 6 (`app.ts`) and Task 7 (`wsServer.ts`/`index.ts`).
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/feedbackStore.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeedbackStore } from '../src/feedbackStore';

describe('createFeedbackStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns an empty string when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'feedback-test-'));
    const store = createFeedbackStore(join(tempDir, 'feedback.txt'));
    expect(await store.read()).toBe('');
  });

  it('writes then reads back the same content, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'feedback-test-'));
    const filePath = join(tempDir, 'nested', 'feedback.txt');
    const store = createFeedbackStore(filePath);
    await store.write('Cain should be 该隐 in Chinese');
    expect(await store.read()).toBe('Cain should be 该隐 in Chinese');
  });

  it('overwrites previous content on a second write', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'feedback-test-'));
    const store = createFeedbackStore(join(tempDir, 'feedback.txt'));
    await store.write('first version');
    await store.write('second version');
    expect(await store.read()).toBe('second version');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/feedbackStore.test.ts`
Expected: FAIL — `Cannot find module '../src/feedbackStore'`

- [ ] **Step 3: Create `feedbackStore.ts`**

Create `server/src/feedbackStore.ts`:

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FeedbackStore {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

export function createFeedbackStore(filePath: string): FeedbackStore {
  return {
    async read(): Promise<string> {
      try {
        return await readFile(filePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    },
    async write(text: string): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, text, 'utf-8');
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/feedbackStore.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Ignore the runtime data directory**

In `server/.gitignore`, add a line:

```
data/
```

So the file becomes:

```
node_modules/
dist/
.env
data/
```

- [ ] **Step 6: Commit**

```bash
git add server/src/feedbackStore.ts server/tests/feedbackStore.test.ts server/.gitignore
git commit -m "feat: add feedback notes file store"
```

---

### Task 6: Sermon doc store + HTTP routes

**Files:**
- Create: `server/src/sermonDocStore.ts`
- Modify: `server/src/app.ts`
- Modify: `server/tests/app.test.ts`
- Modify: `server/package.json` (add `multer`, `@types/multer`)

**Interfaces:**
- Produces: `SermonDocStore { set(text: string): void; get(): string | null; clear(): void; }` interface and `createSermonDocStore(): SermonDocStore` factory, exported from `server/src/sermonDocStore.ts`, consumed by Task 7 (`wsServer.ts`/`index.ts`).
- Produces: `createApp(deps: AppDeps): Express` where `AppDeps = { sermonDocStore: SermonDocStore; feedbackStore: FeedbackStore }` — signature change from today's zero-arg `createApp()`.
- Consumes: `extractDocumentText` from Task 4, `FeedbackStore`/`createFeedbackStore` from Task 5.

- [ ] **Step 1: Install multer**

Run: `cd server && npm install multer && npm install -D @types/multer`

- [ ] **Step 2: Create `sermonDocStore.ts`**

Create `server/src/sermonDocStore.ts`:

```ts
export interface SermonDocStore {
  set(text: string): void;
  get(): string | null;
  clear(): void;
}

export function createSermonDocStore(): SermonDocStore {
  let text: string | null = null;
  return {
    set: (value: string) => {
      text = value;
    },
    get: () => text,
    clear: () => {
      text = null;
    },
  };
}
```

- [ ] **Step 3: Write the failing tests for the new routes**

Replace `server/tests/app.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { createSermonDocStore } from '../src/sermonDocStore';
import { createFeedbackStore } from '../src/feedbackStore';

vi.mock('../src/docExtraction', () => ({
  extractDocumentText: vi.fn().mockResolvedValue('Extracted sermon text'),
}));

import { extractDocumentText } from '../src/docExtraction';

function testDeps() {
  return {
    sermonDocStore: createSermonDocStore(),
    feedbackStore: createFeedbackStore(join(tmpdir(), `feedback-app-test-${Date.now()}-${Math.random()}.txt`)),
  };
}

describe('GET /health', () => {
  it('returns status ok', async () => {
    const response = await request(createApp(testDeps())).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('POST /sermon-doc', () => {
  it('extracts text and stores it in the sermon doc store', async () => {
    const deps = testDeps();
    const response = await request(createApp(deps))
      .post('/sermon-doc')
      .attach('file', Buffer.from('fake pdf bytes'), { filename: 'sermon.pdf', contentType: 'application/pdf' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, characterCount: 'Extracted sermon text'.length });
    expect(deps.sermonDocStore.get()).toBe('Extracted sermon text');
  });

  it('returns 400 when no file is attached', async () => {
    const response = await request(createApp(testDeps())).post('/sermon-doc');
    expect(response.status).toBe(400);
  });

  it('returns 400 when extraction yields no text', async () => {
    (extractDocumentText as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');
    const response = await request(createApp(testDeps()))
      .post('/sermon-doc')
      .attach('file', Buffer.from('fake'), { filename: 'sermon.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(400);
  });

  it('returns 400 with the error message when extraction throws', async () => {
    (extractDocumentText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Unsupported document type: text/plain')
    );
    const response = await request(createApp(testDeps()))
      .post('/sermon-doc')
      .attach('file', Buffer.from('fake'), { filename: 'sermon.txt', contentType: 'text/plain' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Unsupported document type: text/plain' });
  });
});

describe('GET/PUT /feedback', () => {
  it('returns an empty string when nothing has been saved yet', async () => {
    const response = await request(createApp(testDeps())).get('/feedback');
    expect(response.body).toEqual({ text: '' });
  });

  it('saves feedback text and returns it on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const putResponse = await request(app).put('/feedback').send({ text: 'Cain -> 该隐' });
    expect(putResponse.status).toBe(200);

    const getResponse = await request(app).get('/feedback');
    expect(getResponse.body).toEqual({ text: 'Cain -> 该隐' });
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: FAIL — `createApp` currently takes no arguments and has no `/sermon-doc` or `/feedback` routes (compile error or 404s)

- [ ] **Step 5: Update `app.ts`**

Replace `server/src/app.ts` with:

```ts
import express, { type Express } from 'express';
import multer from 'multer';
import { extractDocumentText } from './docExtraction.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';

export interface AppDeps {
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

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

  return app;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json server/src/app.ts server/src/sermonDocStore.ts server/tests/app.test.ts
git commit -m "feat: add sermon document upload and feedback notes HTTP routes"
```

---

### Task 7: Session + wsServer wiring

**Files:**
- Modify: `server/src/session.ts`
- Modify: `server/src/wsServer.ts`
- Modify: `server/src/index.ts`
- Modify: `server/tests/session.test.ts`
- Modify: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `SermonCacheRef` (Task 1), `translateSegment`/`verifyTranslations` with the `sermonCache` param (Tasks 2–3), `createSermonContextCache`/`deleteSermonContextCache` (Task 1), `SermonDocStore` (Task 6), `FeedbackStore` (Task 5).
- Produces: `Session.sermonCache: SermonCacheRef | null` field; `WsServerDeps` gains `sermonDocStore: SermonDocStore` and `feedbackStore: FeedbackStore`.

- [ ] **Step 1: Write the failing test for `Session`**

Add to `server/tests/session.test.ts`, inside the `describe('Session', ...)` block:

```ts
  it('start() clears any previous sermon cache reference', () => {
    const session = new Session();
    session.sermonCache = { name: 'cachedContents/old' };
    session.start();
    expect(session.sermonCache).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/session.test.ts`
Expected: FAIL — `Property 'sermonCache' does not exist on type 'Session'`

- [ ] **Step 3: Update `Session`**

Replace `server/src/session.ts` with:

```ts
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { TranscriptBuffer } from './transcriptBuffer.js';
import type { SermonCacheRef } from './gemini.js';

export class Session {
  id: string = randomUUID();
  isActive: boolean = false;
  buffer: TranscriptBuffer = new TranscriptBuffer();
  sermonCache: SermonCacheRef | null = null;
  private viewers: Map<WebSocket, string> = new Map();

  start(): void {
    this.id = randomUUID();
    this.isActive = true;
    this.buffer.clear();
    this.sermonCache = null;
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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/session.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit the Session change**

```bash
git add server/src/session.ts server/tests/session.test.ts
git commit -m "feat: give Session a sermonCache field, cleared on start"
```

- [ ] **Step 6: Write the failing tests for wsServer cache wiring**

In `server/tests/wsServer.test.ts`, add these imports at the top (alongside the existing ones):

```ts
import { createSermonDocStore } from '../src/sermonDocStore';
import type { SermonDocStore } from '../src/sermonDocStore';
import type { FeedbackStore } from '../src/feedbackStore';
```

Add this helper near `fakeGeminiClient`:

```ts
function fakeFeedbackStore(text = ''): FeedbackStore {
  return { read: vi.fn().mockResolvedValue(text), write: vi.fn().mockResolvedValue(undefined) };
}
```

Update the `fakeGeminiClient` helper to include a `caches` field (this may already be done if Task 1 was applied to this file — verify it looks like this):

```ts
function fakeGeminiClient(overrides: { translate?: string; verify?: string } = {}): GeminiClient {
  const translateText = overrides.translate ?? '{"zh":"你好"}';
  return {
    models: {
      generateContent: vi.fn().mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          if (overrides.verify) {
            return Promise.resolve({ text: overrides.verify });
          }
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) {
            result[id] = { safe: true, reason: 'ok' };
          }
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        return Promise.resolve({ text: translateText });
      }),
    },
    caches: {
      create: vi.fn().mockResolvedValue({ name: 'cachedContents/test' }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
}
```

Update the `describe('wsServer', ...)` block's variable declarations and `beforeEach` to:

```ts
describe('wsServer', () => {
  let httpServer: Server;
  let port: number;
  let session: Session;
  let capturedCallbacks: DeepgramCallbacks | null;
  let geminiClient: GeminiClient;
  let sermonDocStore: SermonDocStore;
  let feedbackStore: FeedbackStore;

  beforeEach(async () => {
    session = new Session();
    capturedCallbacks = null;
    httpServer = createServer();

    geminiClient = fakeGeminiClient();
    sermonDocStore = createSermonDocStore();
    feedbackStore = fakeFeedbackStore();

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
    });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(() => {
    httpServer.close();
  });
```

(This only changes the `beforeEach`/`afterEach` and the variable declarations directly above them — every existing `it(...)` block below stays exactly as it is today.)

Add a new `describe` block at the end of the file, just before the final closing `});` of `describe('wsServer', ...)`:

```ts
  describe('sermon context caching', () => {
    it('creates a cache on start when a sermon document is pending, and passes it to translation calls', async () => {
      sermonDocStore.set('This week: the story of Cain and Abel.');
      (feedbackStore.read as ReturnType<typeof vi.fn>).mockResolvedValue(
        'Cain should translate to 该隐 in Chinese'
      );

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(geminiClient.caches.create).toHaveBeenCalledTimes(1);
      expect(session.sermonCache).toEqual({ name: 'cachedContents/test' });
      expect(sermonDocStore.get()).toBeNull();

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const captionPromise = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('Cain killed Abel');
      await captionPromise;

      const translateCall = (geminiClient.models.generateContent as any).mock.calls.find(
        (call: any) => !call[0].contents.includes('safety checker')
      );
      expect(translateCall[0].config.cachedContent).toBe('cachedContents/test');

      captureSocket.close();
      viewerSocket.close();
    });

    it('does not create a cache when no sermon document was uploaded', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);

      expect(geminiClient.caches.create).not.toHaveBeenCalled();
      expect(session.sermonCache).toBeNull();

      captureSocket.close();
    });

    it('deletes the cache on stop', async () => {
      sermonDocStore.set('This week: the story of Cain and Abel.');

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);

      captureSocket.send(JSON.stringify({ type: 'stop' }));
      await waitForMessage(captureSocket); // status: idle

      expect(geminiClient.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/test' });
      expect(session.sermonCache).toBeNull();

      captureSocket.close();
    });
  });
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: FAIL — `attachWsServer` doesn't accept `sermonDocStore`/`feedbackStore` yet (compile error), and the new `describe('sermon context caching', ...)` tests fail

- [ ] **Step 8: Update `wsServer.ts`**

Replace `server/src/wsServer.ts` with:

```ts
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from './session.js';
import { translateSegment, translateBacklog, type GeminiClient, type SermonCacheRef } from './gemini.js';
import { verifyTranslations, type VerificationItem, type VerificationResult } from './translationVerifier.js';
import type { DeepgramConnection, DeepgramConnectionFactory } from './deepgram.js';
import { createSermonContextCache, deleteSermonContextCache } from './sermonCache.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';

export interface WsServerDeps {
  httpServer: HttpServer;
  session: Session;
  geminiClient: GeminiClient;
  deepgramApiKey: string;
  createDeepgramConnection: DeepgramConnectionFactory;
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
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

  ws.on('message', (data, isBinary) => {
    void (async () => {
      try {
        if (!isBinary) {
          const message = JSON.parse(data.toString());
          if (message.type === 'start') {
            deps.session.start();

            const sermonText = deps.sermonDocStore.get();
            if (sermonText) {
              const feedbackText = await deps.feedbackStore.read();
              deps.session.sermonCache = await createSermonContextCache(
                deps.geminiClient,
                feedbackText,
                sermonText
              );
              deps.sermonDocStore.clear();
            }

            deepgramConnection = deps.createDeepgramConnection(deps.deepgramApiKey, {
              onFinalSegment: (text) => {
                void handleFinalSegment(text, deps, ws);
              },
              onError: () => {
                ws.send(JSON.stringify({ type: 'status', status: 'error' }));
              },
              onClose: () => {},
            });
            ws.send(JSON.stringify({ type: 'status', status: 'recording' }));
          } else if (message.type === 'stop') {
            deps.session.stop();
            await deleteSermonContextCache(deps.geminiClient, deps.session.sermonCache);
            deps.session.sermonCache = null;
            deepgramConnection?.finish();
            deepgramConnection = null;
            ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
          }
        } else if (deepgramConnection) {
          deepgramConnection.send(data as Buffer);
        }
      } catch (error) {
        console.error('Error handling capture message:', error);
      }
    })();
  });

  ws.on('close', () => {
    deps.session.stop();
    void deleteSermonContextCache(deps.geminiClient, deps.session.sermonCache).then(() => {
      deps.session.sermonCache = null;
    });
    deepgramConnection?.finish();
  });
}

function logTranslationFallback(
  language: string,
  english: string,
  discardedTranslation: string,
  reason: string
): void {
  console.warn(
    JSON.stringify({
      event: 'translation_fallback',
      timestamp: new Date().toISOString(),
      language,
      english,
      discardedTranslation,
      reason,
    })
  );
}

async function handleFinalSegment(
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket
): Promise<void> {
  const line = deps.session.buffer.append(english);
  captureSocket.send(JSON.stringify({ type: 'transcript', english }));

  const activeLanguages = deps.session.getActiveLanguages();
  if (activeLanguages.length === 0) return;

  const recentLines = deps.session.buffer.getRecent();
  const precedingContext = recentLines.slice(-4, -1).map((recentLine) => recentLine.english);
  const sermonCache = deps.session.sermonCache;

  let translations: Record<string, string>;
  try {
    translations = await translateSegment(deps.geminiClient, english, activeLanguages, precedingContext, sermonCache);
  } catch {
    try {
      translations = await translateSegment(
        deps.geminiClient,
        english,
        activeLanguages,
        precedingContext,
        sermonCache
      );
    } catch (secondError) {
      console.error('Translation failed after retry, skipping segment:', secondError);
      return;
    }
  }

  const verificationItems: VerificationItem[] = activeLanguages
    .filter((language) => Boolean(translations[language]))
    .map((language) => ({ id: language, english, translated: translations[language] }));
  const verifications = await verifyTranslationsWithRetry(deps.geminiClient, verificationItems, sermonCache);

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = safe ? translated : english;

    if (!safe) {
      logTranslationFallback(language, english, translated, verification?.reason ?? 'verification unavailable');
    }

    const payload = JSON.stringify({ type: 'caption', english: line.english, translated: outgoing });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
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
    return await verifyTranslations(client, items, sermonCache);
  } catch {
    try {
      return await verifyTranslations(client, items, sermonCache);
    } catch (secondError) {
      console.error('Verification failed after retry, treating all as unverified:', secondError);
      return {};
    }
  }
}

function handleViewerConnection(ws: WebSocket, deps: WsServerDeps): void {
  ws.on('message', (data) => {
    void (async () => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'subscribe') {
          const language = message.language as string;

          const backlog = deps.session.buffer.getRecent();
          if (backlog.length === 0) {
            ws.send(JSON.stringify({ type: 'backlog', lines: [] }));
            deps.session.addViewer(ws, language);
            return;
          }

          const translations = await translateBacklog(
            deps.geminiClient,
            backlog.map((line) => line.english),
            language
          );
          const lines = backlog.map((line, index) => ({
            english: line.english,
            translated: translations[index] ?? '',
          }));

          const verificationItems: VerificationItem[] = lines
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => line.translated.length > 0)
            .map(({ line, index }) => ({ id: String(index), english: line.english, translated: line.translated }));
          const verifications = await verifyTranslationsWithRetry(
            deps.geminiClient,
            verificationItems,
            deps.session.sermonCache
          );

          const verifiedLines = lines.map((line, index) => {
            if (line.translated.length === 0) return { english: line.english, translated: line.english };
            const verification = verifications[String(index)];
            if (verification?.safe === true) return line;
            logTranslationFallback(
              language,
              line.english,
              line.translated,
              verification?.reason ?? 'verification unavailable'
            );
            return { english: line.english, translated: line.english };
          });

          ws.send(JSON.stringify({ type: 'backlog', lines: verifiedLines }));
          deps.session.addViewer(ws, language);
        }
      } catch (error) {
        console.error('Error handling viewer message:', error);
        ws.send(JSON.stringify({ type: 'backlog', lines: [] }));
      }
    })();
  });

  ws.on('close', () => deps.session.removeViewer(ws));
}
```

- [ ] **Step 9: Update `index.ts`**

Replace `server/src/index.ts` with:

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

const requiredEnvVars = ['DEEPGRAM_API_KEY', 'GEMINI_API_KEY'] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const session = new Session();
const geminiClient = createGeminiClient(process.env.GEMINI_API_KEY!);
const sermonDocStore = createSermonDocStore();
const feedbackStore = createFeedbackStore(process.env.FEEDBACK_FILE_PATH ?? 'data/feedback.txt');

const app = createApp({ sermonDocStore, feedbackStore });
const httpServer = createServer(app);

attachWsServer({
  httpServer,
  session,
  geminiClient,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
  createDeepgramConnection,
  sermonDocStore,
  feedbackStore,
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

- [ ] **Step 10: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS (every test file, including the untouched pre-existing `wsServer.test.ts` cases)

- [ ] **Step 11: Type-check and build**

Run: `cd server && npm run build`
Expected: compiles with no TypeScript errors

- [ ] **Step 12: Add `FEEDBACK_FILE_PATH` to the env example**

In `server/.env.example`, add a line so the file reads:

```
DEEPGRAM_API_KEY=
GEMINI_API_KEY=
PORT=3001
FEEDBACK_FILE_PATH=data/feedback.txt
```

- [ ] **Step 13: Commit**

```bash
git add server/src/session.ts server/src/wsServer.ts server/src/index.ts server/tests/session.test.ts server/tests/wsServer.test.ts server/.env.example
git commit -m "feat: wire sermon context cache lifecycle into session start/stop"
```

---

### Task 8: Capture page UI — required sermon upload + feedback editor

**Files:**
- Modify: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: `POST /sermon-doc`, `GET /feedback`, `PUT /feedback` from Task 6.
- No exported interfaces — this is the final, UI-facing task.

There is no test runner configured in `web/` (no Jest/Vitest/Testing Library in `web/package.json`), so this task is verified manually per the steps below rather than with automated tests — consistent with how the existing capture page has no test file today.

- [ ] **Step 1: Replace the capture page**

Replace `web/app/capture/page.tsx` with:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type CaptureStatus = 'idle' | 'recording' | 'reconnecting' | 'error';

export default function CapturePage() {
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [transcriptLines, setTranscriptLines] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasUploadedDoc, setHasUploadedDoc] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSaveStatus, setFeedbackSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const manuallyStoppedRef = useRef(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/feedback`)
      .then((response) => response.json())
      .then((data) => setFeedbackText(data.text ?? ''))
      .catch(() => setFeedbackText(''));
  }, []);

  async function uploadSermonDoc(file: File) {
    setIsUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_URL}/sermon-doc`, { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) {
        setUploadError(data.error ?? 'Upload failed');
        setHasUploadedDoc(false);
        return;
      }
      setHasUploadedDoc(true);
    } catch {
      setUploadError('Upload failed. Check your connection and try again.');
      setHasUploadedDoc(false);
    } finally {
      setIsUploading(false);
    }
  }

  function onFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void uploadSermonDoc(file);
  }

  async function saveFeedback() {
    if (feedbackText.trim().length === 0) {
      const confirmed = window.confirm('Clear all feedback notes?');
      if (!confirmed) return;
    }
    setFeedbackSaveStatus('saving');
    try {
      await fetch(`${API_URL}/feedback`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: feedbackText }),
      });
      setFeedbackSaveStatus('saved');
    } catch {
      setFeedbackSaveStatus('idle');
    }
  }

  async function ensureRecorderStreaming(socket: WebSocket) {
    if (!streamRef.current) {
      try {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? `Microphone access failed: ${error.message}`
            : "Microphone access failed. Check your browser's microphone permission for this site."
        );
        manuallyStoppedRef.current = true;
        socket.send(JSON.stringify({ type: 'stop' }));
        socket.close();
        setStatus('error');
        return;
      }
    }
    const recorder = new MediaRecorder(streamRef.current, { mimeType: 'audio/webm;codecs=opus' });
    recorderRef.current = recorder;

    recorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(await event.data.arrayBuffer());
      }
    };

    recorder.start(250);
  }

  function connectSocket() {
    const socket = new WebSocket(`${WS_URL}/ws/capture`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'status') {
        setStatus(message.status);
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => [...previous.slice(-49), message.english]);
      }
    };

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'start' }));
      void ensureRecorderStreaming(socket);
    };

    socket.onclose = () => {
      if (manuallyStoppedRef.current) {
        setStatus((current) => (current === 'error' ? current : 'idle'));
        return;
      }
      setStatus('reconnecting');
      reconnectTimeoutRef.current = setTimeout(connectSocket, 2000);
    };
  }

  function start() {
    manuallyStoppedRef.current = false;
    setErrorMessage(null);
    connectSocket();
  }

  function stop() {
    manuallyStoppedRef.current = true;
    clearTimeout(reconnectTimeoutRef.current);
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    socketRef.current?.send(JSON.stringify({ type: 'stop' }));
    socketRef.current?.close();
    setHasUploadedDoc(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <main className="min-h-screen flex flex-col items-center gap-6 p-6">
      <h1 className="text-xl font-semibold">Sermon Capture</h1>

      <div className="w-full max-w-xl flex flex-col gap-2">
        <label className="text-sm font-medium">Sermon document (required, PDF or Word)</label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx"
          onChange={onFileSelected}
          disabled={status === 'recording' || status === 'reconnecting' || isUploading}
        />
        {isUploading && <p className="text-sm text-muted-foreground">Uploading…</p>}
        {hasUploadedDoc && !isUploading && <p className="text-sm text-green-600">Document loaded.</p>}
        {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
      </div>

      <div className="flex gap-4">
        <button
          onClick={start}
          disabled={status === 'recording' || status === 'reconnecting' || !hasUploadedDoc}
          className="bg-primary text-primary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          Start
        </button>
        <button
          onClick={stop}
          disabled={status === 'idle'}
          className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          Stop
        </button>
      </div>
      <p className="text-sm text-muted-foreground">Status: {status}</p>
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
      <div className="w-full max-w-xl h-64 overflow-y-auto border rounded p-3 text-sm space-y-1">
        {transcriptLines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>

      <div className="w-full max-w-xl flex flex-col gap-2">
        <label className="text-sm font-medium">Feedback notes (optional)</label>
        <textarea
          value={feedbackText}
          onChange={(event) => {
            setFeedbackText(event.target.value);
            setFeedbackSaveStatus('idle');
          }}
          rows={6}
          className="w-full border rounded p-2 text-sm"
          placeholder="Notes about past translation accuracy issues, e.g. names that were missed…"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={saveFeedback}
            disabled={feedbackSaveStatus === 'saving'}
            className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
          >
            Save feedback notes
          </button>
          {feedbackSaveStatus === 'saved' && <p className="text-sm text-green-600">Saved.</p>}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Manual verification**

1. Start the server: `cd server && npm run dev` (ensure `.env` has real `DEEPGRAM_API_KEY`/`GEMINI_API_KEY`).
2. Start the web app: `cd web && npm run dev`.
3. Open `http://localhost:3000/capture`.
4. Confirm the **Start** button is disabled before any upload.
5. Upload a small `.pdf` or `.docx` file with a few sentences of text. Confirm "Document loaded." appears and **Start** becomes enabled.
6. Confirm the feedback textarea loads (empty on first run), type a note, click **Save feedback notes**, reload the page, and confirm the note persists.
7. Click **Start**, confirm status moves to `recording` and speaking produces live transcript lines as before.
8. Click **Stop**, confirm the sermon-doc upload state resets (Start is disabled again, file input cleared) and a fresh upload is required before the next Start.
9. Open `http://localhost:3000`, pick a language, and confirm captions still arrive as before — this exercises the cache being referenced from `translateSegment`/`verifyTranslations` without changing the viewer-facing behavior.

- [ ] **Step 3: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "feat: require sermon document upload and add feedback notes editor to capture page"
```

---

## Self-Review Notes

- **Spec coverage:** upload/extraction (Task 4, 6), required-upload gating (Task 8), feedback standing file + in-browser editor (Task 5, 6, 8), cache assembly/lifecycle tied to Start/Stop (Task 1, 7), the per-call-vs-cached split for languages/schema/precedingContext/sentence (Tasks 2–3 leave those untouched, only add `cachedContent`), cost analysis (informed the Global Constraints deviation note, no separate task needed — it's a design justification, not code), error handling for extraction failure/cache-creation failure/stale cache (Tasks 1, 6 try/catch + fallback-to-null patterns), testing (unit tests in every server task, manual e2e in Task 8).
- **Deviation flagged explicitly:** the cache holds feedback+sermon text only, not the idiom/theology instructions — called out in Global Constraints so it's not a silent gap against the spec.
- **Type consistency check:** `SermonCacheRef` defined once in `gemini.ts` (Task 1), imported everywhere else (`sermonCache.ts`, `translationVerifier.ts`, `session.ts`, `wsServer.ts`) — no redefinition. `SermonDocStore`/`FeedbackStore` defined once each (Tasks 5–6), consumed identically in `app.ts`, `wsServer.ts`, `index.ts`. `sermonCache: SermonCacheRef | null = null` parameter name and position (5th for `translateSegment`, 3rd for `verifyTranslations`) stays consistent from Tasks 2–3 through Task 7's call sites.
