# Translation Safety Safeguards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the chance that a meaning-inverting or theologically damaging mistranslation reaches viewers of the live sermon captions, given no human moderator is watching.

**Architecture:** Harden the existing single Gemini translate call with explicit polarity-preservation and Australian-slang-context instructions, then add one independent, batched Gemini "verifier" call per segment/backlog that checks candidate translations for polarity flips or theological misrepresentation. Any translation that fails verification (or that can't be verified because the verifier call itself errors twice) falls back to displaying the plain English line, with the incident logged via `console.warn` for post-service review (captured automatically by the existing pm2 process manager).

**Tech Stack:** TypeScript, Node.js, `@google/genai` (Gemini), `ws`, Vitest.

## Global Constraints

- No human moderator watches translated output live — safeguards must be fully automated end-to-end. (spec: Context)
- At most one additional Gemini round-trip beyond the existing translate call, batched across every item being checked in a single request. (spec: Context, Approach)
- Fail-safe default: an unverified translation (verifier flagged it unsafe, or the verifier call failed twice) is never trusted — it falls back to the plain English line. (spec: Components §3-4)
- Both the translate prompt and the verifier prompt must include Australian slang/idiom/humor context, so idiomatic (non-literal) translations are not flagged as unsafe. (spec: Context, Approach)
- Use the existing model, `gemini-3.1-flash-lite` (the constant already used in `server/src/gemini.ts`), for the verifier call too. (spec: Components §2, existing code)
- Log every fallback via `console.warn` with structured JSON (`event`, `timestamp`, `language`, `english`, `discardedTranslation`, `reason`) — no new logging dependency; pm2 already captures stdout/stderr to disk. (spec: Components §3)

---

### Task 1: Harden the translate prompt with polarity and Australian-slang guidance

**Files:**
- Modify: `server/src/gemini.ts:29-36` (`translateSegment`), `server/src/gemini.ts:48-50` (`translateBacklog`)
- Test: `server/tests/gemini.test.ts`

**Interfaces:**
- Consumes: nothing new — `translateSegment(client, englishText, languageCodes)` and `translateBacklog(client, englishLines, languageCode)` keep their existing signatures.
- Produces: nothing new for other tasks — this task only changes prompt text. Later tasks don't depend on anything from this task's internals.

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks inside the existing `describe('translateSegment', ...)` block in `server/tests/gemini.test.ts` (after the existing tests, before the closing `});`):

```ts
  it('includes Australian slang context and polarity-preservation guidance in the prompt', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, "G'day mate, no worries", ['zh']);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('Preserve polarity and negation exactly');
  });
```

Add this `it` block inside the existing `describe('translateBacklog', ...)` block (after the existing tests, before the closing `});`):

```ts
  it('includes Australian slang context and polarity-preservation guidance in the prompt', async () => {
    const client = fakeClient('{"translations":["你好"]}');
    await translateBacklog(client, ["G'day mate, no worries"], 'zh');

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('Preserve polarity and negation exactly');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/gemini.test.ts`
Expected: 2 new tests FAIL (`expect(call.contents).toContain('Australian slang')` fails — current prompt has no such text). The 4 pre-existing tests still PASS.

- [ ] **Step 3: Harden the prompts**

In `server/src/gemini.ts`, replace the `contents` line inside `translateSegment` (currently line 31):

```ts
    contents: `Translate the following sentence, spoken during a live church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal. Sentence: "${englishText}"`,
```

with:

```ts
    contents: `Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal.

This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she'll be right," "having a go"). Translate for the speaker's intended meaning and tone, not word-for-word — don't flatten idiomatic phrasing into something overly formal, and don't translate slang literally into an unrelated meaning.

Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don't add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.

Sentence: "${englishText}"`,
```

Replace the `contents` line inside `translateBacklog` (currently line 50):

```ts
    contents: `Translate each of these sentences, spoken during a live church sermon, into language code "${languageCode}". Return the translations in the exact same order as the input. Sentences: ${JSON.stringify(englishLines)}`,
```

with:

```ts
    contents: `Translate each of these sentences, spoken during a live Australian church sermon, into language code "${languageCode}". Return the translations in the exact same order as the input.

This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she'll be right," "having a go"). Translate for the speaker's intended meaning and tone, not word-for-word — don't flatten idiomatic phrasing into something overly formal, and don't translate slang literally into an unrelated meaning.

Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don't add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.

Sentences: ${JSON.stringify(englishLines)}`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/gemini.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/gemini.ts server/tests/gemini.test.ts
git commit -m "feat: harden translate prompt with polarity and Australian slang guidance"
```

---

### Task 2: Build the independent translation verifier module

**Files:**
- Create: `server/src/translationVerifier.ts`
- Test: `server/tests/translationVerifier.test.ts`

**Interfaces:**
- Consumes: `GeminiClient` type from `server/src/gemini.ts` (already defined: `{ models: { generateContent(params): Promise<{ text: string | null | undefined }> } }`).
- Produces (used by Task 3 and Task 4):
  - `export interface VerificationItem { id: string; english: string; translated: string; }`
  - `export interface VerificationResult { safe: boolean; reason: string; }`
  - `export async function verifyTranslations(client: GeminiClient, items: VerificationItem[]): Promise<Record<string, VerificationResult>>`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/translationVerifier.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { verifyTranslations } from '../src/translationVerifier';
import type { GeminiClient } from '../src/gemini';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: responseText }),
    },
  };
}

describe('verifyTranslations', () => {
  it('returns safe:true results parsed from the model response', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":"meaning preserved"}}');
    const result = await verifyTranslations(client, [
      { id: 'zh', english: 'Jesus loves you', translated: '耶稣爱你' },
    ]);
    expect(result).toEqual({ zh: { safe: true, reason: 'meaning preserved' } });
  });

  it('returns safe:false results for a flagged translation', async () => {
    const client = fakeClient('{"zh":{"safe":false,"reason":"polarity flip: negates original meaning"}}');
    const result = await verifyTranslations(client, [
      { id: 'zh', english: 'Jesus loves you', translated: '耶稣不爱你' },
    ]);
    expect(result).toEqual({ zh: { safe: false, reason: 'polarity flip: negates original meaning' } });
  });

  it('batches every item into a single generateContent call', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":"ok"},"ko":{"safe":true,"reason":"ok"}}');
    await verifyTranslations(client, [
      { id: 'zh', english: 'Hello', translated: '你好' },
      { id: 'ko', english: 'Hello', translated: '안녕' },
    ]);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('includes Australian slang guidance so idiomatic translations are not penalized', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":"ok"}}');
    await verifyTranslations(client, [{ id: 'zh', english: 'No worries', translated: '没问题' }]);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
  });

  it('skips the API call and returns an empty object when there are no items', async () => {
    const client = fakeClient('{}');
    const result = await verifyTranslations(client, []);
    expect(result).toEqual({});
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/translationVerifier.test.ts`
Expected: FAIL — `../src/translationVerifier` does not exist (module not found).

- [ ] **Step 3: Implement the verifier module**

Create `server/src/translationVerifier.ts`:

```ts
import type { GeminiClient } from './gemini.js';

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
  items: VerificationItem[]
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
    },
  });

  return JSON.parse(response.text ?? '{}');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/translationVerifier.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/translationVerifier.ts server/tests/translationVerifier.test.ts
git commit -m "feat: add independent translation verifier module"
```

---

### Task 3: Integrate the verifier into the live caption flow, with English fallback

**Files:**
- Modify: `server/src/wsServer.ts`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `verifyTranslations`, `VerificationItem`, `VerificationResult` from `server/src/translationVerifier.ts` (Task 2).
- Produces (used by Task 4): a shared `verifyTranslationsWithRetry(client: GeminiClient, items: VerificationItem[]): Promise<Record<string, VerificationResult>>` helper function defined in `wsServer.ts`, retrying once on failure and returning `{}` (meaning "nothing verified") if the second attempt also fails.

- [ ] **Step 1: Write the failing tests**

In `server/tests/wsServer.test.ts`, replace the imports at the top of the file:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachWsServer } from '../src/wsServer';
import { Session } from '../src/session';
import type { GeminiClient } from '../src/gemini';
import type { DeepgramCallbacks } from '../src/deepgram';
```

with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachWsServer } from '../src/wsServer';
import { Session } from '../src/session';
import type { GeminiClient } from '../src/gemini';
import type { DeepgramCallbacks } from '../src/deepgram';

function fakeGeminiClient(overrides: { translate?: string; verify?: string } = {}): GeminiClient {
  const translateText = overrides.translate ?? '{"zh":"你好"}';
  const verifyText = overrides.verify ?? '{"zh":{"safe":true,"reason":"ok"}}';
  return {
    models: {
      generateContent: vi.fn().mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: verifyText });
        }
        return Promise.resolve({ text: translateText });
      }),
    },
  };
}
```

Replace the `geminiClient = { ... }` assignment inside `beforeEach` (currently):

```ts
    geminiClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({ text: '{"zh":"你好"}' }),
      },
    };
```

with:

```ts
    geminiClient = fakeGeminiClient();
```

Add these two new `it` blocks inside the top-level `describe('wsServer', ...)` block, after the existing `'does not fan out a live caption...'` test and before the closing `});` of the describe block:

```ts
  it('falls back to the English line when the verifier flags a translation as unsafe', async () => {
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('safety checker')) {
        return Promise.resolve({ text: '{"zh":{"safe":false,"reason":"polarity flip"}}' });
      }
      return Promise.resolve({ text: '{"zh":"耶稣不爱你"}' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    await waitForMessage(viewerSocket); // backlog: []

    const captionPromise = waitForMessage(viewerSocket);
    capturedCallbacks!.onFinalSegment('Jesus loves you');
    const caption = await captionPromise;

    expect(caption).toEqual({ type: 'caption', english: 'Jesus loves you', translated: 'Jesus loves you' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('translation_fallback'));

    warnSpy.mockRestore();
    captureSocket.close();
    viewerSocket.close();
  });

  it('falls back to English when the verifier call fails after retry', async () => {
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('safety checker')) {
        return Promise.reject(new Error('verifier down'));
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
    capturedCallbacks!.onFinalSegment('Hello everyone');
    const caption = await captionPromise;

    expect(caption).toEqual({ type: 'caption', english: 'Hello everyone', translated: 'Hello everyone' });

    captureSocket.close();
    viewerSocket.close();
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: the 2 new tests FAIL (captions still show the unverified/flagged translation, since `handleFinalSegment` doesn't call a verifier yet). The 4 pre-existing tests still PASS (the `fakeGeminiClient` helper is backward compatible with them).

- [ ] **Step 3: Integrate the verifier into `handleFinalSegment`**

In `server/src/wsServer.ts`, replace the import block at the top of the file:

```ts
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from './session.js';
import { translateSegment, translateBacklog, type GeminiClient } from './gemini.js';
import type { DeepgramConnection, DeepgramConnectionFactory } from './deepgram.js';
```

with:

```ts
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from './session.js';
import { translateSegment, translateBacklog, type GeminiClient } from './gemini.js';
import { verifyTranslations, type VerificationItem, type VerificationResult } from './translationVerifier.js';
import type { DeepgramConnection, DeepgramConnectionFactory } from './deepgram.js';
```

Replace the entire `handleFinalSegment` function with:

```ts
async function handleFinalSegment(
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket
): Promise<void> {
  const line = deps.session.buffer.append(english);
  captureSocket.send(JSON.stringify({ type: 'transcript', english }));

  const activeLanguages = deps.session.getActiveLanguages();
  if (activeLanguages.length === 0) return;

  let translations: Record<string, string>;
  try {
    translations = await translateSegment(deps.geminiClient, english, activeLanguages);
  } catch {
    try {
      translations = await translateSegment(deps.geminiClient, english, activeLanguages);
    } catch (secondError) {
      console.error('Translation failed after retry, skipping segment:', secondError);
      return;
    }
  }

  const verificationItems: VerificationItem[] = activeLanguages
    .filter((language) => Boolean(translations[language]))
    .map((language) => ({ id: language, english, translated: translations[language] }));
  const verifications = await verifyTranslationsWithRetry(deps.geminiClient, verificationItems);

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = safe ? translated : english;

    if (!safe) {
      console.warn(
        JSON.stringify({
          event: 'translation_fallback',
          timestamp: new Date().toISOString(),
          language,
          english,
          discardedTranslation: translated,
          reason: verification?.reason ?? 'verification unavailable',
        })
      );
    }

    const payload = JSON.stringify({ type: 'caption', english: line.english, translated: outgoing });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}

async function verifyTranslationsWithRetry(
  client: GeminiClient,
  items: VerificationItem[]
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};
  try {
    return await verifyTranslations(client, items);
  } catch {
    try {
      return await verifyTranslations(client, items);
    } catch (secondError) {
      console.error('Verification failed after retry, treating all as unverified:', secondError);
      return {};
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "feat: verify live captions and fall back to English on unsafe translations"
```

---

### Task 4: Integrate the verifier into the backlog flow, with English fallback

**Files:**
- Modify: `server/src/wsServer.ts` (`handleViewerConnection`)
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `verifyTranslationsWithRetry` helper defined in Task 3 (same file, no import needed).
- Produces: nothing new for other tasks — this is the last integration point.

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the top-level `describe('wsServer', ...)` block in `server/tests/wsServer.test.ts`, after the two tests added in Task 3:

```ts
  it('falls back to English in the backlog when the verifier flags a line as unsafe', async () => {
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('safety checker')) {
        return Promise.resolve({ text: '{"0":{"safe":false,"reason":"polarity flip"}}' });
      }
      return Promise.resolve({ text: '{"translations":["耶稣不爱你"]}' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    session.buffer.append('Jesus loves you', Date.now());

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    const backlogMessage = await waitForMessage(viewerSocket);

    expect(backlogMessage).toEqual({
      type: 'backlog',
      lines: [{ english: 'Jesus loves you', translated: 'Jesus loves you' }],
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('translation_fallback'));

    warnSpy.mockRestore();
    captureSocket.close();
    viewerSocket.close();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: the new test FAILS (backlog still shows the unverified `'耶稣不爱你'` translation, since the subscribe handler doesn't verify backlog lines yet).

- [ ] **Step 3: Integrate the verifier into `handleViewerConnection`**

In `server/src/wsServer.ts`, replace the body of the `if (message.type === 'subscribe')` block inside `handleViewerConnection` — currently:

```ts
          const translations = await translateBacklog(
            deps.geminiClient,
            backlog.map((line) => line.english),
            language
          );
          const lines = backlog.map((line, index) => ({
            english: line.english,
            translated: translations[index] ?? '',
          }));
          ws.send(JSON.stringify({ type: 'backlog', lines }));
          deps.session.addViewer(ws, language);
```

with:

```ts
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
          const verifications = await verifyTranslationsWithRetry(deps.geminiClient, verificationItems);

          const verifiedLines = lines.map((line, index) => {
            if (line.translated.length === 0) return line;
            const verification = verifications[String(index)];
            if (verification?.safe === true) return line;
            console.warn(
              JSON.stringify({
                event: 'translation_fallback',
                timestamp: new Date().toISOString(),
                language,
                english: line.english,
                discardedTranslation: line.translated,
                reason: verification?.reason ?? 'verification unavailable',
              })
            );
            return { english: line.english, translated: line.english };
          });

          ws.send(JSON.stringify({ type: 'backlog', lines: verifiedLines }));
          deps.session.addViewer(ws, language);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "feat: verify backlog translations and fall back to English on unsafe lines"
```

---

### Task 5: Full validation

**Files:** none (validation only)

**Interfaces:** none

- [ ] **Step 1: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: all test files PASS (no failures), including `gemini.test.ts`, `translationVerifier.test.ts`, `wsServer.test.ts`, and the pre-existing `app.test.ts`, `deepgram.test.ts`, `session.test.ts`, `transcriptBuffer.test.ts`.

- [ ] **Step 2: Run the TypeScript build to confirm no type errors**

Run: `cd server && npm run build`
Expected: exits with code 0, `dist/` is produced with no compiler errors (confirms `VerificationItem`/`VerificationResult` types line up between `translationVerifier.ts` and `wsServer.ts`).

- [ ] **Step 3: Commit if the build step produced any tracked changes**

```bash
git status
```

Expected: working tree clean (the `dist/` output should already be gitignored — if `git status` shows no changes, no commit is needed; if it unexpectedly shows tracked changes, investigate before committing).
