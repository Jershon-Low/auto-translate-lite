# Translation Context & Deepgram Segmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Deepgram's over-segmentation of live transcripts (arbitrary chunk boundaries instead of real sentences) and give the live translation path memory of the last few preceding sentences, so translations resolve pronouns and terminology consistently.

**Architecture:** Deepgram's `is_final` transcript chunks are accumulated server-side and only released as a complete "line" on `speech_final`, an `UtteranceEnd` event, or a 5-second safety-net timeout — via a new, SDK-independent `createUtteranceRouter` unit that's fully unit-testable without a real Deepgram connection. Separately, `translateSegment` gains an optional `precedingContext: string[]` parameter, sourced in `wsServer.ts` from the session's existing rolling transcript buffer (last 3 lines before the current one).

**Tech Stack:** Node.js/TypeScript, `@deepgram/sdk` (^3.9.0), `@google/genai` (^0.3.0), Vitest.

## Global Constraints

- Preceding-context window is exactly the last **3** sentences before the current one (fewer at the start of a session).
- Deepgram segmentation safety-net force-flush is **5 seconds** from when an utterance starts accumulating.
- `translateBacklog` and `translationVerifier.ts` are explicitly untouched — out of scope per the spec.
- `onFinalSegment`'s callback contract to `wsServer.ts` does not change (still `(text: string) => void`, still fires with a complete sentence) — no changes needed in the capture-connection handling code in `wsServer.ts`.
- When `precedingContext` is empty, `translateSegment`'s prompt must be byte-for-byte identical to its current (pre-change) output — no behavior change for the first sentences of a session.
- All new logic follows the existing codebase pattern of pure, directly-testable units (see `transcriptBuffer.ts`) rather than logic embedded inline where it can't be unit tested without the real SDK.

---

## File Structure

- **Modify:** `.worktrees/auto-translate-lite/server/src/deepgram.ts` — add `speech_final` to the transcript event type, add a new exported `UtteranceAccumulator` class and `createUtteranceRouter` function, wire them into `createDeepgramConnection`, add `utterance_end_ms` to the connection config.
- **Modify:** `.worktrees/auto-translate-lite/server/tests/deepgram.test.ts` — new tests for `createUtteranceRouter`.
- **Modify:** `.worktrees/auto-translate-lite/server/src/gemini.ts` — add `precedingContext` parameter and a `buildContextBlock` helper to `translateSegment`.
- **Modify:** `.worktrees/auto-translate-lite/server/tests/gemini.test.ts` — new tests for the context block.
- **Modify:** `.worktrees/auto-translate-lite/server/src/wsServer.ts` — source `precedingContext` from `session.buffer` in `handleFinalSegment`.
- **Modify:** `.worktrees/auto-translate-lite/server/tests/wsServer.test.ts` — new test asserting the last-3-lines slice is passed through.

---

### Task 1: Utterance accumulation and routing (deepgram.ts)

**Files:**
- Modify: `.worktrees/auto-translate-lite/server/src/deepgram.ts`
- Test: `.worktrees/auto-translate-lite/server/tests/deepgram.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the existing `DeepgramTranscriptEvent` shape, extended with `speech_final`).
- Produces: `UtteranceAccumulator` class (`addChunk(text: string): void`, `hasPending(): boolean`, `flush(): string`) and `createUtteranceRouter(onFinalSegment: (text: string) => void, options?: { maxWaitMs?: number }): { handleTranscriptEvent(data: DeepgramTranscriptEvent): void; handleUtteranceEnd(): void; flushRemaining(): void }`. Task 2 wires these into `createDeepgramConnection`.

- [ ] **Step 1: Write the failing tests**

Add to `.worktrees/auto-translate-lite/server/tests/deepgram.test.ts` (keep the existing `extractFinalTranscript` describe block above this, unchanged):

```typescript
import { describe, it, expect } from 'vitest';
import { extractFinalTranscript, createUtteranceRouter } from '../src/deepgram';

// ... existing extractFinalTranscript describe block stays as-is ...

describe('createUtteranceRouter', () => {
  it('joins multiple is_final chunks and emits them together when speech_final arrives', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'Hello' }] } });
    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'there friend' }] } });
    router.handleTranscriptEvent({
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'how are you' }] },
    });

    expect(segments).toEqual(['Hello there friend how are you']);
  });

  it('ignores interim (non-final) chunks', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleTranscriptEvent({ is_final: false, channel: { alternatives: [{ transcript: 'Hel' }] } });
    router.handleTranscriptEvent({
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'Hello' }] },
    });

    expect(segments).toEqual(['Hello']);
  });

  it('flushes the accumulated buffer on UtteranceEnd even without speech_final', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'Partial thought' }] } });
    router.handleUtteranceEnd();

    expect(segments).toEqual(['Partial thought']);
  });

  it('force-flushes after maxWaitMs elapses with no natural pause', async () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text), { maxWaitMs: 30 });

    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'Still going' }] } });
    expect(segments).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(segments).toEqual(['Still going']);
  });

  it('flushRemaining emits any buffered text (used when the connection finishes)', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'Trailing words' }] } });
    router.flushRemaining();

    expect(segments).toEqual(['Trailing words']);
  });

  it('does not emit an empty segment when flushed with nothing buffered', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleUtteranceEnd();
    router.flushRemaining();

    expect(segments).toEqual([]);
  });

  it('clears the safety timer after a speech_final flush so it does not fire twice', async () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text), { maxWaitMs: 30 });

    router.handleTranscriptEvent({
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'Complete sentence.' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(segments).toEqual(['Complete sentence.']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ".worktrees/auto-translate-lite/server" && npx vitest run tests/deepgram.test.ts`
Expected: FAIL — `createUtteranceRouter` is not exported from `../src/deepgram`.

- [ ] **Step 3: Implement `UtteranceAccumulator` and `createUtteranceRouter`**

In `.worktrees/auto-translate-lite/server/src/deepgram.ts`, add `speech_final` to the event interface and add the new exports (keep `extractFinalTranscript` exactly as it is today):

```typescript
export interface DeepgramTranscriptEvent {
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

export function extractFinalTranscript(event: DeepgramTranscriptEvent): string | null {
  const transcript = event.channel?.alternatives?.[0]?.transcript ?? '';
  if (event.is_final && transcript.trim().length > 0) {
    return transcript.trim();
  }
  return null;
}

const DEFAULT_MAX_UTTERANCE_WAIT_MS = 5000;

export class UtteranceAccumulator {
  private pieces: string[] = [];

  addChunk(text: string): void {
    this.pieces.push(text);
  }

  hasPending(): boolean {
    return this.pieces.length > 0;
  }

  flush(): string {
    const text = this.pieces.join(' ').trim();
    this.pieces = [];
    return text;
  }
}

export interface UtteranceRouterOptions {
  maxWaitMs?: number;
}

export interface UtteranceRouter {
  handleTranscriptEvent(data: DeepgramTranscriptEvent): void;
  handleUtteranceEnd(): void;
  flushRemaining(): void;
}

export function createUtteranceRouter(
  onFinalSegment: (text: string) => void,
  options: UtteranceRouterOptions = {}
): UtteranceRouter {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_UTTERANCE_WAIT_MS;
  const accumulator = new UtteranceAccumulator();
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSafetyTimer(): void {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  }

  function flush(): void {
    clearSafetyTimer();
    const text = accumulator.flush();
    if (text.length > 0) onFinalSegment(text);
  }

  return {
    handleTranscriptEvent(data: DeepgramTranscriptEvent): void {
      const chunk = extractFinalTranscript(data);
      if (chunk) {
        const isNewUtterance = !accumulator.hasPending();
        accumulator.addChunk(chunk);
        if (isNewUtterance) {
          safetyTimer = setTimeout(flush, maxWaitMs);
        }
      }
      if (data.speech_final) flush();
    },
    handleUtteranceEnd(): void {
      flush();
    },
    flushRemaining(): void {
      flush();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ".worktrees/auto-translate-lite/server" && npx vitest run tests/deepgram.test.ts`
Expected: PASS (all `extractFinalTranscript` tests plus all new `createUtteranceRouter` tests).

- [ ] **Step 5: Commit**

```bash
git add .worktrees/auto-translate-lite/server/src/deepgram.ts .worktrees/auto-translate-lite/server/tests/deepgram.test.ts
git commit -m "feat: accumulate Deepgram chunks into full utterances before flushing"
```

---

### Task 2: Wire the utterance router into the live Deepgram connection

**Files:**
- Modify: `.worktrees/auto-translate-lite/server/src/deepgram.ts`

**Interfaces:**
- Consumes: `createUtteranceRouter` from Task 1.
- Produces: `createDeepgramConnection`'s external behavior — `onFinalSegment` now fires per real utterance instead of per raw `is_final` chunk. Signature and `DeepgramConnection`/`DeepgramCallbacks` interfaces are unchanged, so `wsServer.ts` requires no changes for this task.

- [ ] **Step 1: Update `createDeepgramConnection`**

In `.worktrees/auto-translate-lite/server/src/deepgram.ts`, replace the body of `createDeepgramConnection` (the connection config and event wiring) with:

```typescript
export function createDeepgramConnection(
  apiKey: string,
  callbacks: DeepgramCallbacks
): DeepgramConnection {
  const deepgram = createClient(apiKey);
  const connection = deepgram.listen.live({
    model: 'nova-3',
    language: 'en',
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 1000,
    encoding: 'opus',
    mimetype: 'audio/webm',
    keyterm: ['Planetshakers'],
  });

  const router = createUtteranceRouter(callbacks.onFinalSegment);

  connection.on(LiveTranscriptionEvents.Transcript, (data: DeepgramTranscriptEvent) => {
    router.handleTranscriptEvent(data);
  });
  connection.on(LiveTranscriptionEvents.UtteranceEnd, () => router.handleUtteranceEnd());
  connection.on(LiveTranscriptionEvents.Error, (error: Error) => callbacks.onError(error));
  connection.on(LiveTranscriptionEvents.Close, () => callbacks.onClose());

  return {
    send: (data: Buffer) => connection.send(data as unknown as ArrayBufferLike),
    finish: () => {
      router.flushRemaining();
      connection.finish();
    },
  };
}
```

Note: `utterance_end_ms: 1000` requires `interim_results: true`, which is already set. `LiveTranscriptionEvents.UtteranceEnd` is already exported by the installed `@deepgram/sdk` (`^3.9.0`) — no dependency changes needed.

- [ ] **Step 2: Build and typecheck**

Run: `cd ".worktrees/auto-translate-lite/server" && npx tsc -p tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Run the full test suite**

Run: `cd ".worktrees/auto-translate-lite/server" && npm test`
Expected: PASS — this task has no new automated tests of its own (the real `deepgram.listen.live` client isn't mocked anywhere in this codebase; `wsServer.test.ts` already injects a fake `createDeepgramConnection` factory instead of exercising the real one), so correctness here rests on Task 1's coverage of `createUtteranceRouter` plus the manual verification in Task 5. Confirm no existing test regressed.

- [ ] **Step 4: Commit**

```bash
git add .worktrees/auto-translate-lite/server/src/deepgram.ts
git commit -m "feat: flush Deepgram segments on speech_final/UtteranceEnd instead of every chunk"
```

---

### Task 3: Preceding-sentence context in `translateSegment`

**Files:**
- Modify: `.worktrees/auto-translate-lite/server/src/gemini.ts`
- Test: `.worktrees/auto-translate-lite/server/tests/gemini.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `translateSegment(client: GeminiClient, englishText: string, languageCodes: string[], precedingContext?: string[]): Promise<Record<string, string>>` — the new 4th parameter, used by Task 4 in `wsServer.ts`.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('translateSegment', ...)` block in `.worktrees/auto-translate-lite/server/tests/gemini.test.ts` (alongside the existing three tests):

```typescript
  it('includes preceding context as reference-only lines when provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, 'How are you', ['zh'], ['Hello everyone', 'Welcome to church']);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Hello everyone');
    expect(call.contents).toContain('Welcome to church');
    expect(call.contents).toContain('do not translate these');
  });

  it('produces an unchanged prompt when no preceding context is given', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, 'Hello', ['zh']);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toBe(
      'Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: zh. Keep the tone natural and spoken, not overly formal.\n\n' +
        'This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she\'ll be right," "having a go"). Translate for the speaker\'s intended meaning and tone, not word-for-word — don\'t flatten idiomatic phrasing into something overly formal, and don\'t translate slang literally into an unrelated meaning.\n\n' +
        'Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don\'t add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.\n\n' +
        'Sentence: "Hello"'
    );
  });
```

Add these two tests after the existing three, inside the same `describe` block, before its closing `});`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ".worktrees/auto-translate-lite/server" && npx vitest run tests/gemini.test.ts`
Expected: FAIL — `translateSegment` doesn't accept a 4th argument yet, and the prompt doesn't contain preceding-context text.

- [ ] **Step 3: Implement the context block**

In `.worktrees/auto-translate-lite/server/src/gemini.ts`, add a helper and update `translateSegment`'s signature and template string:

```typescript
function buildContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (do not translate these — they're for reference only, e.g. to resolve pronouns or match terminology):
${numbered}

`;
}

export async function translateSegment(
  client: GeminiClient,
  englishText: string,
  languageCodes: string[],
  precedingContext: string[] = []
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
    },
  });

  return JSON.parse(response.text ?? '{}');
}
```

Leave `translateBacklog` untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ".worktrees/auto-translate-lite/server" && npx vitest run tests/gemini.test.ts`
Expected: PASS — all existing and new tests green.

- [ ] **Step 5: Commit**

```bash
git add .worktrees/auto-translate-lite/server/src/gemini.ts .worktrees/auto-translate-lite/server/tests/gemini.test.ts
git commit -m "feat: let translateSegment take preceding sentences as translation context"
```

---

### Task 4: Source preceding context from the session buffer in `wsServer.ts`

**Files:**
- Modify: `.worktrees/auto-translate-lite/server/src/wsServer.ts`
- Test: `.worktrees/auto-translate-lite/server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `translateSegment(client, englishText, languageCodes, precedingContext)` from Task 3; `session.buffer.getRecent(): CaptionLine[]` (existing, unchanged) where `CaptionLine` is `{ id: string; timestampMs: number; english: string }`.
- Produces: no new exports — this wires existing pieces together inside `handleFinalSegment`.

- [ ] **Step 1: Write the failing test**

Add to the `describe('wsServer', ...)` block in `.worktrees/auto-translate-lite/server/tests/wsServer.test.ts` (after the existing `'broadcasts a translated caption to a subscribed viewer'` test):

```typescript
  it('includes up to the last 3 preceding lines as translation context', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    await waitForMessage(viewerSocket); // backlog: []

    session.buffer.append('First line', Date.now());
    session.buffer.append('Second line', Date.now());
    session.buffer.append('Third line', Date.now());
    session.buffer.append('Fourth line', Date.now());

    const captionPromise = waitForMessage(viewerSocket);
    capturedCallbacks!.onFinalSegment('Fifth line');
    await captionPromise;

    const translateCall = (geminiClient.models.generateContent as any).mock.calls.find(
      (call: any) => !call[0].contents.includes('safety checker')
    );
    expect(translateCall[0].contents).toContain('Second line');
    expect(translateCall[0].contents).toContain('Third line');
    expect(translateCall[0].contents).toContain('Fourth line');
    expect(translateCall[0].contents).not.toContain('First line');

    captureSocket.close();
    viewerSocket.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ".worktrees/auto-translate-lite/server" && npx vitest run tests/wsServer.test.ts`
Expected: FAIL — the translate call's `contents` won't contain "Second line"/"Third line"/"Fourth line" yet, since no context is passed today.

- [ ] **Step 3: Wire the context slice in `handleFinalSegment`**

In `.worktrees/auto-translate-lite/server/src/wsServer.ts`, update `handleFinalSegment`:

```typescript
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

  let translations: Record<string, string>;
  try {
    translations = await translateSegment(deps.geminiClient, english, activeLanguages, precedingContext);
  } catch {
    try {
      translations = await translateSegment(deps.geminiClient, english, activeLanguages, precedingContext);
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
      logTranslationFallback(language, english, translated, verification?.reason ?? 'verification unavailable');
    }

    const payload = JSON.stringify({ type: 'caption', english: line.english, translated: outgoing });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}
```

(`recentLines.slice(-4, -1)` takes the buffer entries immediately before the just-appended current line, capped to at most 3: the current line is always the last element of `recentLines` right after `append`, so `-1` excludes it and `-4` caps the slice to 3 items before it. With fewer than 4 total lines, `slice` naturally returns however many are available — e.g. `[current].slice(-4, -1)` is `[]`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ".worktrees/auto-translate-lite/server" && npx vitest run tests/wsServer.test.ts`
Expected: PASS — all existing and new tests green.

- [ ] **Step 5: Run the full test suite**

Run: `cd ".worktrees/auto-translate-lite/server" && npm test`
Expected: PASS — every test file green.

- [ ] **Step 6: Commit**

```bash
git add .worktrees/auto-translate-lite/server/src/wsServer.ts .worktrees/auto-translate-lite/server/tests/wsServer.test.ts
git commit -m "feat: pass the last 3 preceding sentences as live translation context"
```

---

### Task 5: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck and build the whole server**

Run: `cd ".worktrees/auto-translate-lite/server" && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 2: Run the capture page against a recorded sermon clip (or live mic) with at least one long unbroken sentence (>5s) and a few natural pauses**

Start the server (`npm run dev` in `.worktrees/auto-translate-lite/server`) and the capture/viewer pages per the existing local dev setup. Speak or play a clip that includes:
- a few short, clearly-separated sentences
- one long sentence spoken with no pause longer than a beat (to exercise the 5-second safety net)

- [ ] **Step 3: Confirm segmentation is fixed**

Expected: the capture page's rolling transcript view shows full sentences (not one-word fragments like the "benefit" / "from it." example from the bug report), and the long unbroken sentence still appears within roughly 5 seconds rather than stalling indefinitely.

- [ ] **Step 4: Confirm context doesn't leak into translated output**

Expected: viewer captions show only the current sentence translated — the preceding-context lines fed to Gemini for reference must not appear duplicated or partially translated in the caption feed.

- [ ] **Step 5: No commit for this task** (verification only; nothing to check in).

---

## Self-Review Notes

- **Spec coverage:** Deepgram accumulation + `speech_final`/`UtteranceEnd`/5s-safety-net flush → Tasks 1–2. Preceding-context prompt + wiring from `session.buffer` → Tasks 3–4. `translateBacklog`/`translationVerifier` left untouched → confirmed no task modifies them. Manual verification → Task 5.
- **Placeholder scan:** no TBD/TODO; every step has literal code, exact commands, and expected output.
- **Type consistency:** `UtteranceAccumulator`, `UtteranceRouter`, `UtteranceRouterOptions`, `createUtteranceRouter` names and signatures match between Task 1 (definition) and Task 2 (usage). `translateSegment`'s 4th parameter name (`precedingContext`) matches between Task 3 (definition) and Task 4 (call site). `CaptionLine.english` (from `types.ts`, unchanged) is the field read in Task 4's `.map((recentLine) => recentLine.english)`.
