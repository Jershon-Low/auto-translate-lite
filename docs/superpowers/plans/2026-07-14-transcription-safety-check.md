# Transcription Safety Check (Christianity Misrepresentation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, independent Gemini call that checks the raw English transcript line itself (before translation) for confident misrepresentation of God/Jesus/the Holy Spirit/core Christian belief — catching speech-to-text mishearing errors that the existing translation-vs-English verifier can't, since it only ever compares a translation to an English source it assumes is correct.

**Architecture:** A new `transcriptionVerifier.ts` module (mirroring the existing `translationVerifier.ts`) exposes `verifyTranscription`, a single-line check returning `{ safe, reason }`. In `wsServer.ts`'s `handleFinalSegment`, this check runs in parallel with translation for every finalized segment — regardless of whether any viewer is connected, so a flagged line can never leak into a later backlog. A flagged line is appended to the transcript buffer, broadcast to no viewer, and reported (marked `flagged: true`) only to the AV operator's own capture-page feed. A safe line proceeds through the existing translate → verify → broadcast pipeline unchanged.

**Tech Stack:** Node.js/TypeScript server (`@google/genai`, `ws`), Vitest for server tests; Next.js/React capture page (no automated frontend test infra in this repo — manual verification only, consistent with prior plans in this codebase).

## Global Constraints

- Model matches the existing translation/verification calls: `gemini-3.1-flash-lite`.
- The new prompt's identifying marker phrase is **"transcription accuracy checker"** — it must never contain the substring `"safety checker"`, because `wsServer.test.ts`'s `fakeGeminiClient` helper routes mocked responses by checking `contents.includes('safety checker')` to detect a translation-verification call; a collision would make the fake client answer the new call with the wrong mock response.
- Preceding-context window: last 3 prior transcript lines — matches `translateSegment`'s existing window exactly (see Task 2 for the equivalent-refactor note on how it's computed).
- The transcription check runs on **every** finalized segment, regardless of `activeLanguages.length` — this is the one Gemini call in the pipeline that is *not* viewer-gated (see the design spec's "Cost Impact" section).
- Retry pattern: try with the session's sermon cache, retry once without it, and if that also fails, treat the line as **unsafe** (fail-safe, not fail-open) — same philosophy as `verifyTranslationsWithRetry`.
- A flagged line: never appended to `Session.buffer` (so it can never appear in any future viewer's backlog), never broadcast to any viewer socket. The capture socket still receives `{ type: 'transcript', english, flagged: true, reason }` for it.
- New structured log events, via the existing `logEvent` helper: `transcription_flagged` (level `warn`, fields `english`, `reason`) and `transcription_verification_failed` (level `error`, fields `english`, `error`) — same shape as the existing `translation_fallback`/`verification_failed` events.

---

### Task 1: `transcriptionVerifier.ts` module

**Files:**
- Create: `server/src/transcriptionVerifier.ts`
- Create: `server/tests/transcriptionVerifier.test.ts`

**Interfaces:**
- Produces: `TranscriptionCheckResult { safe: boolean; reason: string }` and `verifyTranscription(client: GeminiClient, english: string, precedingContext?: string[], sermonCache?: SermonCacheRef | null): Promise<TranscriptionCheckResult>`, both exported from `server/src/transcriptionVerifier.ts`, consumed by Task 2 (`wsServer.ts`).
- Consumes: `GeminiClient`, `SermonCacheRef` from `server/src/gemini.ts` (already exist — no changes needed there).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/transcriptionVerifier.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { verifyTranscription } from '../src/transcriptionVerifier';
import type { GeminiClient } from '../src/gemini';

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
    const client = fakeClient('{"safe":true,"reason":"plausible statement"}');
    const result = await verifyTranscription(client, 'Jesus loves you');
    expect(result).toEqual({ safe: true, reason: 'plausible statement' });
  });

  it('returns safe:false for a flagged line', async () => {
    const client = fakeClient(
      '{"safe":false,"reason":"likely mis-heard: negates a core statement about Jesus"}'
    );
    const result = await verifyTranscription(client, 'Jesus is not the son of God');
    expect(result).toEqual({
      safe: false,
      reason: 'likely mis-heard: negates a core statement about Jesus',
    });
  });

  it('includes Australian slang guidance so idiomatic lines are not penalized', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, "No worries, she'll be right");
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
  });

  it('includes preceding context as reference-only lines when provided', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, 'He rose again', [
      'Jesus died on the cross',
      'Three days later',
    ]);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Jesus died on the cross');
    expect(call.contents).toContain('Three days later');
  });

  it('produces a prompt marker that cannot collide with the translation verifier', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, 'Hello');
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('safety checker');
    expect(call.contents).toContain('transcription accuracy checker');
  });

  it('includes cachedContent in the request config when a sermon cache is provided', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, 'Hello', [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('omits cachedContent from the request config when no sermon cache is provided', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, 'Hello');
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });

  it('throws when the response is not valid JSON, so the caller can retry/fail-safe', async () => {
    const client = fakeClient('not json');
    await expect(verifyTranscription(client, 'Hello')).rejects.toThrow();
  });

  it('treats a well-formed but incomplete JSON response as unsafe', async () => {
    const client = fakeClient('{"unexpected":"shape"}');
    const result = await verifyTranscription(client, 'Hello');
    expect(result).toEqual({ safe: false, reason: 'malformed response' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/transcriptionVerifier.test.ts`
Expected: FAIL — `Cannot find module '../src/transcriptionVerifier'`

- [ ] **Step 3: Create `transcriptionVerifier.ts`**

Create `server/src/transcriptionVerifier.ts`:

```ts
import type { GeminiClient, SermonCacheRef } from './gemini.js';

export interface TranscriptionCheckResult {
  safe: boolean;
  reason: string;
}

const MODEL = 'gemini-3.1-flash-lite';

function buildContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (not to be evaluated themselves — only for resolving pronouns or continuing a thought):\n${numbered}\n\n`;
}

export async function verifyTranscription(
  client: GeminiClient,
  english: string,
  precedingContext: string[] = [],
  sermonCache: SermonCacheRef | null = null
): Promise<TranscriptionCheckResult> {
  const response = await client.models.generateContent({
    model: MODEL,
    contents: `You are a transcription accuracy checker for live captions at an Australian church sermon. This line was auto-transcribed live from spoken audio by speech-to-text, which occasionally mishears a word — dropping or inserting a "not", mishearing a name, or similar. Decide whether this line, taken at face value, confidently states something false about God, Jesus, the Holy Spirit, or core Christian belief.

Do NOT flag a line just because it is idiomatic, informal, or grammatically rough — this sermon includes Australian slang, jokes, and dry humor (e.g. "no worries," "arvo," "having a go," "she'll be right"), and normal spoken imperfection is expected and not a sign of an error.

Only mark it unsafe if the line, as transcribed, clearly and confidently misrepresents who God, Jesus, or the Holy Spirit is or does — the kind of thing a dropped or inserted "not" would cause.

${buildContextBlock(precedingContext)}Line: "${english}"

Return whether it is safe and a short reason.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['safe', 'reason'],
      },
      ...(sermonCache ? { cachedContent: sermonCache.name } : {}),
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/transcriptionVerifier.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/transcriptionVerifier.ts server/tests/transcriptionVerifier.test.ts
git commit -m "feat: add transcriptionVerifier for STT-mishearing safety checks"
```

---

### Task 2: `wsServer.ts` integration

**Files:**
- Modify: `server/src/wsServer.ts`
- Modify: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `verifyTranscription`, `TranscriptionCheckResult` from Task 1 (`server/src/transcriptionVerifier.ts`).
- Produces: no new exports — `handleFinalSegment`'s externally-observable behavior changes (documented below); `WsServerDeps` is unchanged.

This task touches the shared `fakeGeminiClient` test helper, which several existing tests depend on to distinguish "translate" calls from "verify" calls by checking whether `contents` includes `'safety checker'`. Since the new transcription check's calls also won't include that phrase, several existing tests must be updated in the same commit as the production code change, or they'll silently start asserting on the wrong mock call. This task's steps are ordered to make those updates explicit before wiring the new call in.

- [ ] **Step 1: Update `fakeGeminiClient` to route transcription-check calls**

In `server/tests/wsServer.test.ts`, replace the `fakeGeminiClient` function with:

```ts
function fakeGeminiClient(
  overrides: { translate?: string; verify?: string; transcriptionCheck?: string } = {}
): GeminiClient {
  const translateText = overrides.translate ?? '{"zh":"你好"}';
  return {
    models: {
      generateContent: vi.fn().mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: overrides.transcriptionCheck ?? '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          if (overrides.verify) {
            return Promise.resolve({ text: overrides.verify });
          }
          // Default: mark every requested id as safe, regardless of whether the
          // caller used language-keyed ids (live captions) or index-keyed ids
          // (backlog lines).
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

Add this helper directly below `fakeFeedbackStore`:

```ts
function isTranslateCall(call: any): boolean {
  const contents = call[0].contents as string;
  return !contents.includes('safety checker') && !contents.includes('transcription accuracy checker');
}
```

- [ ] **Step 2: Fix existing tests that filter mock calls by `'safety checker'` alone**

Three tests currently locate "the translate call(s)" with `.find`/`.filter((call) => !call[0].contents.includes('safety checker'))`. Now that transcription-check calls also lack that phrase, this predicate would match the wrong call. Replace it with `isTranslateCall` in each of the following:

In the test `'includes up to the last 3 preceding lines as translation context'`, replace:

```ts
    const translateCall = (geminiClient.models.generateContent as any).mock.calls.find(
      (call: any) => !call[0].contents.includes('safety checker')
    );
```

with:

```ts
    const translateCall = (geminiClient.models.generateContent as any).mock.calls.find(isTranslateCall);
```

In the test `'creates a cache on start when a sermon document is pending, and passes it to translation calls'` (inside `describe('sermon context caching', ...)`), make the identical replacement.

In the test `'drops the stale cache reference on translation retry and self-heals subsequent segments'`, replace both occurrences:

```ts
      const translateCalls = (geminiClient.models.generateContent as any).mock.calls.filter(
        (call: any) => !call[0].contents.includes('safety checker')
      );
```

and

```ts
      const translateCallsAfter = (geminiClient.models.generateContent as any).mock.calls.filter(
        (call: any) => !call[0].contents.includes('safety checker')
      );
```

with `.filter(isTranslateCall)` in both places.

- [ ] **Step 3: Fix existing tests with bespoke `mockImplementation` overrides**

Four tests replace `generateContent`'s mock implementation entirely with a custom two-branch function (`'safety checker'` vs. else-is-translate). Each needs a third branch added *before* the `'safety checker'` check, so transcription-check calls resolve to a safe default instead of falling through to the translate branch (which would return unrelated JSON, fail transcription-check's response-shape validation, and cause every segment in these tests to be wrongly suppressed).

In the test `'falls back to the English line when the verifier flags a translation as unsafe'`, replace:

```ts
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('safety checker')) {
        return Promise.resolve({ text: '{"zh":{"safe":false,"reason":"polarity flip"}}' });
      }
      return Promise.resolve({ text: '{"zh":"耶稣不爱你"}' });
    });
```

with:

```ts
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('transcription accuracy checker')) {
        return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
      }
      if (params.contents.includes('safety checker')) {
        return Promise.resolve({ text: '{"zh":{"safe":false,"reason":"polarity flip"}}' });
      }
      return Promise.resolve({ text: '{"zh":"耶稣不爱你"}' });
    });
```

In the test `'falls back to English when the verifier call fails after retry'`, replace:

```ts
    let verifyCallCount = 0;
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('safety checker')) {
        verifyCallCount += 1;
        return Promise.reject(new Error('verifier down'));
      }
      return Promise.resolve({ text: '{"zh":"你好"}' });
    });
```

with:

```ts
    let verifyCallCount = 0;
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('transcription accuracy checker')) {
        return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
      }
      if (params.contents.includes('safety checker')) {
        verifyCallCount += 1;
        return Promise.reject(new Error('verifier down'));
      }
      return Promise.resolve({ text: '{"zh":"你好"}' });
    });
```

In the test `'drops the stale cache reference on translation retry and self-heals subsequent segments'`, replace:

```ts
      let translateCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        translateCallCount += 1;
        if (translateCallCount === 1) {
          return Promise.reject(new Error('cachedContent reference expired'));
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });
```

with:

```ts
      let translateCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        translateCallCount += 1;
        if (translateCallCount === 1) {
          return Promise.reject(new Error('cachedContent reference expired'));
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });
```

In the test `'drops the stale cache reference on verification retry'`, replace:

```ts
      let verifyCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          verifyCallCount += 1;
          if (verifyCallCount === 1) {
            return Promise.reject(new Error('cachedContent reference expired'));
          }
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });
```

with:

```ts
      let verifyCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          verifyCallCount += 1;
          if (verifyCallCount === 1) {
            return Promise.reject(new Error('cachedContent reference expired'));
          }
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });
```

- [ ] **Step 4: Write the new failing tests for transcription-check behavior**

Add a new `describe` block at the end of `server/tests/wsServer.test.ts`, just before the final closing `});` of `describe('wsServer', ...)` (i.e. after the `describe('sermon context caching', ...)` block):

```ts
  describe('transcription safety check', () => {
    it('suppresses a flagged transcription from every viewer but still reports it to the capture socket', async () => {
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":true,"reason":"ok"}}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
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

      const viewerMessages: any[] = [];
      viewerSocket.on('message', (data) => viewerMessages.push(JSON.parse(data.toString())));

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const transcript = await transcriptPromise;

      expect(transcript).toEqual({
        type: 'transcript',
        english: 'Jesus is not the son of God',
        flagged: true,
        reason: 'likely mis-heard negation',
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('transcription_flagged'));

      await new Promise((resolve) => setImmediate(resolve));
      expect(viewerMessages).toEqual([]);
      expect(session.buffer.getRecent()).toHaveLength(0);

      warnSpy.mockRestore();
      captureSocket.close();
      viewerSocket.close();
    });

    it('runs the transcription check even with zero active viewers, keeping a flagged line out of the buffer', async () => {
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      await transcriptPromise;

      expect(session.buffer.getRecent()).toHaveLength(0);
      expect((geminiClient.models.generateContent as any).mock.calls).toHaveLength(1);

      captureSocket.close();
    });

    it('does not mark a safe line as flagged in the transcript event', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const transcript = await transcriptPromise;

      expect(transcript).toEqual({ type: 'transcript', english: 'Hello everyone' });

      captureSocket.close();
    });

    it('suppresses the line when the transcription check fails after retry', async () => {
      let transcriptionCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          transcriptionCallCount += 1;
          return Promise.reject(new Error('checker down'));
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const transcript = await transcriptPromise;

      expect(transcript).toEqual({
        type: 'transcript',
        english: 'Hello everyone',
        flagged: true,
        reason: 'verification unavailable',
      });
      expect(transcriptionCallCount).toBe(2);
      expect(session.buffer.getRecent()).toHaveLength(0);

      captureSocket.close();
    });
  });
```

- [ ] **Step 5: Run tests to verify the new ones fail and note which existing ones are still fine**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: The 4 new tests in `describe('transcription safety check', ...)` FAIL (transcription check isn't wired into `handleFinalSegment` yet, so lines are never suppressed and the `transcript` event never carries `flagged`/`reason`). Tests updated in Steps 1–3 should already pass against the current (pre-Step-6) production code, since those steps only changed how existing behavior is *observed*, not the behavior itself.

- [ ] **Step 6: Update `wsServer.ts`**

Add the import, alongside the existing ones near the top of `server/src/wsServer.ts`:

```ts
import { verifyTranscription, type TranscriptionCheckResult } from './transcriptionVerifier.js';
```

(Insert it directly below the existing `import { verifyTranslations, ... } from './translationVerifier.js';` line.)

Replace the `handleFinalSegment` function (and the code between it and `verifyTranslationsWithRetry`, if any) with:

```ts
async function handleFinalSegment(
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket
): Promise<void> {
  const recentLines = deps.session.buffer.getRecent();
  const precedingContext = recentLines.slice(-3).map((recentLine) => recentLine.english);
  const sermonCache = deps.session.sermonCache;
  const activeLanguages = deps.session.getActiveLanguages();

  const [transcriptionResult, translations] = await Promise.all([
    verifyTranscriptionWithRetry(deps.geminiClient, english, precedingContext, sermonCache),
    translateWithFallback(deps, english, activeLanguages, precedingContext, sermonCache),
  ]);

  if (!transcriptionResult.safe) {
    void logEvent('warn', { event: 'transcription_flagged', english, reason: transcriptionResult.reason });
    captureSocket.send(
      JSON.stringify({ type: 'transcript', english, flagged: true, reason: transcriptionResult.reason })
    );
    return;
  }

  const line = deps.session.buffer.append(english);
  captureSocket.send(JSON.stringify({ type: 'transcript', english }));

  if (activeLanguages.length === 0) return;

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

async function translateWithFallback(
  deps: WsServerDeps,
  english: string,
  activeLanguages: string[],
  precedingContext: string[],
  sermonCache: SermonCacheRef | null
): Promise<Record<string, string>> {
  if (activeLanguages.length === 0) return {};
  try {
    return await translateSegment(deps.geminiClient, english, activeLanguages, precedingContext, sermonCache);
  } catch {
    deps.session.sermonCache = null;
    try {
      return await translateSegment(deps.geminiClient, english, activeLanguages, precedingContext, null);
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
    return await verifyTranscription(client, english, precedingContext, sermonCache);
  } catch {
    try {
      return await verifyTranscription(client, english, precedingContext, null);
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
```

Leave `verifyTranslationsWithRetry`, `handleCaptureConnection`, `handleViewerConnection`, `logTranslationFallback`, `attachWsServer`, and `WsServerDeps` exactly as they are today.

> **Note on the `precedingContext` computation:** today's code computes it *after* `buffer.append(english)`, via `recentLines.slice(-4, -1)` (dropping the just-appended current line, then taking the 3 before it). The version above computes it *before* appending — since appending must now be conditional on the transcription check passing — via `recentLines.slice(-3)` (the buffer doesn't yet contain the current line, so this needs no drop-last step). Both produce the identical 3-line window; this is a reordering, not a behavior change, and is exercised by the existing `'includes up to the last 3 preceding lines as translation context'` test.

- [ ] **Step 7: Run tests to verify everything passes**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: PASS (all tests, including the 4 new ones and every pre-existing test)

- [ ] **Step 8: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS (all suites — `transcriptionVerifier.test.ts`, `wsServer.test.ts`, and every other existing suite, none of which this task touches)

- [ ] **Step 9: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "feat: run a transcription safety check before every translated/broadcast segment"
```

---

### Task 3: Capture page shows flagged transcript lines to the operator

**Files:**
- Modify: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: the `{ type: 'transcript', english, flagged?: boolean, reason?: string }` WebSocket message shape produced by Task 2.
- Produces: no exports — this is a leaf UI component.

- [ ] **Step 1: Update transcript line state and rendering**

In `web/app/capture/page.tsx`, replace this line:

```tsx
  const [transcriptLines, setTranscriptLines] = useState<string[]>([]);
```

with:

```tsx
  const [transcriptLines, setTranscriptLines] = useState<{ text: string; flagged: boolean }[]>([]);
```

Replace the `onmessage` handler's `transcript` branch:

```tsx
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => [...previous.slice(-49), message.english]);
      }
```

with:

```tsx
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => [
          ...previous.slice(-49),
          { text: message.english, flagged: Boolean(message.flagged) },
        ]);
      }
```

Replace the transcript rendering block:

```tsx
      <div className="w-full max-w-xl h-64 overflow-y-auto border rounded p-3 text-sm space-y-1">
        {transcriptLines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
```

with:

```tsx
      <div className="w-full max-w-xl h-64 overflow-y-auto border rounded p-3 text-sm space-y-1">
        {transcriptLines.map((line, index) => (
          <p key={index} className={line.flagged ? 'text-destructive line-through' : undefined}>
            {line.text}
          </p>
        ))}
      </div>
```

- [ ] **Step 2: Manual verification**

This repo has no automated frontend test infrastructure (consistent with the prior sermon-context-caching plan's approach to `web/`). Verify manually:

Run: `cd web && npm run dev` (and `cd server && npm run dev` in a second terminal)
1. Open `http://localhost:3000/capture`, click Start, speak a sentence into the mic.
2. Confirm the sentence appears in the transcript box as plain (non-struck-through) text — this exercises the unflagged rendering path.
3. Triggering the flagged/struck-through path requires a real STT mishearing or a deliberately misleading test utterance reaching a live Gemini call, which isn't practical to force on demand — that path is already covered by the automated `wsServer.test.ts` cases from Task 2. This manual step only needs to confirm there's no visual regression for the normal case.

- [ ] **Step 3: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "feat: show flagged transcript lines to the AV operator on the capture page"
```

---

### Task 4: README updates

**Files:**
- Modify: `README.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Add the new safety feature to the "Safety features" list**

In `README.md`, find this bullet (in the `## Safety features` section):

```markdown
- **Theological/polarity safety checker** ([`translationVerifier.ts`](server/src/translationVerifier.ts)) — every translation is checked by a second Gemini call before it reaches a viewer. It flags translations that invert positive↔negative meaning, negate or contradict the original, reverse who's doing/receiving an action, or misrepresent God/Jesus/the Holy Spirit.
```

Insert this new bullet directly after it:

```markdown
- **Transcription accuracy check** ([`transcriptionVerifier.ts`](server/src/transcriptionVerifier.ts)) — before translation, a separate Gemini call checks the raw English transcript line itself (independent of any translation) for confident misrepresentation of God, Jesus, the Holy Spirit, or core Christian belief — the kind of thing a speech-to-text mishearing (a dropped or inserted "not", a misheard name) can produce even when the preacher's actual words were correct. It runs on every sentence for the whole session, not just while a viewer is watching, so a flagged line can never surface later in anyone's backlog either.
```

- [ ] **Step 2: Clarify the fallback-behavior difference between the two checks**

Find this bullet:

```markdown
- **Fail-safe fallback, not fail-open** — if a translation is flagged unsafe (or the safety check itself fails), the viewer sees the **English original** instead of a suspect translation. The system never ships a translation it couldn't verify.
```

Replace it with:

```markdown
- **Fail-safe fallback, not fail-open** — if a translation is flagged unsafe (or the safety check itself fails), the viewer sees the **English original** instead of a suspect translation. The system never ships a translation it couldn't verify. A flagged *transcript* line has no safe fallback to show — it *is* the source — so it's suppressed entirely from every viewer, live and backlog. The AV operator's own capture-page feed still shows it, marked as flagged, for operational awareness; it just never reaches the congregation.
```

- [ ] **Step 3: Add a caveat to the cost analysis**

Find the end of the `## Cost analysis` section — the italicized paragraph starting `*(Pricing verified against Deepgram's and Google's published rates...`. Insert a new italicized paragraph directly after it, before the `## Cost vs. commercial competitors` heading:

```markdown
*(This table doesn't yet include the separate transcription accuracy check described under "Safety features" — unlike the translation and verification calls above, it runs on every sentence of the session regardless of whether a viewer is connected, so its marginal cost doesn't scale with active-language count the way this table assumes. Real-world impact depends on how much of a service runs with zero viewers connected — e.g. pre-service, or during a hymn before anyone's tuned in — so it's better re-derived from the "log every call" audit trail once deployed than estimated blind here.)*
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the transcription accuracy check and its cost caveat"
```
