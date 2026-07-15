# Reinstate a Flagged Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the capture-page operator recover a transcript line that Gemini's transcription-misrepresentation check suppressed — optionally correcting the wording — and have it appear for every viewer at the exact position it was originally spoken.

**Architecture:** The server's `TranscriptBuffer` currently drops flagged lines entirely; this plan makes it retain them as `suppressed: true` placeholders in their original chronological position, so a later "reinstate" action can flip that same entry in place (preserving id and position) instead of appending a new one at the end. Every WebSocket message that references a line (`transcript`, `caption`, `line-removed`, backlog entries) gains a stable `id` so both the capture page and viewer clients can update a specific line instead of only ever appending.

**Tech Stack:** TypeScript, `ws` (WebSocket server), Vitest (server tests), Next.js/React (capture + viewer pages, manually verified in-browser — no frontend test runner in this repo).

## Global Constraints

- Gemini failures fail safe, never fail open (retry once, then suppress/fallback) — matches existing `verifyTranscriptionWithRetry`/`verifyTranslationsWithRetry` pattern; the new reinstate path follows the same convention.
- No new REST endpoints — this feature is entirely WebSocket messages over the existing `/ws/capture` and `/ws/viewer` connections.
- Destructive/consequential client actions use the native `window.confirm()` pattern already established by "Clear all feedback notes?" on the capture page — no custom modal component.
- Server test commands run from the `server/` directory: `npm test` (= `vitest run`), or `npx vitest run tests/<file>.test.ts` for a single file.

---

### Task 1: `TranscriptBuffer` — suppressed lines, reinstate, positional context

**Files:**
- Modify: `server/src/types.ts`
- Modify: `server/src/transcriptBuffer.ts`
- Modify: `server/tests/transcriptBuffer.test.ts`

**Interfaces:**
- Produces: `CaptionLine { id: string; timestampMs: number; english: string; suppressed: boolean }`
- Produces: `TranscriptBuffer.append(english: string, timestampMs?: number, suppressed?: boolean): CaptionLine` — `timestampMs` defaults to `Date.now()`, `suppressed` defaults to `false`. This ordering means every existing call site (`buffer.append('Hello', 1000)`, `buffer.append(english)`) keeps compiling unchanged.
- Produces: `TranscriptBuffer.reinstate(id: string, english: string, nowMs?: number): CaptionLine | null` — mutates the matching suppressed entry in place (same id, same position) and returns it; returns `null` if no entry with that id exists, is already unsuppressed, or was trimmed out of the 10-minute window.
- Produces: `TranscriptBuffer.precedingContextFor(id: string, maxLines: number, nowMs?: number): string[]` — the up-to-`maxLines` non-suppressed lines immediately before the given id's position, oldest first.

- [ ] **Step 1: Write the failing tests**

Append these to `server/tests/transcriptBuffer.test.ts` (inside the existing `describe('TranscriptBuffer', ...)` block, after the current three `it(...)` blocks):

```ts
  it('append() defaults suppressed to false', () => {
    const buffer = new TranscriptBuffer();
    const line = buffer.append('Hello', 1000);
    expect(line.suppressed).toBe(false);
  });

  it('append() stores an explicit suppressed flag', () => {
    const buffer = new TranscriptBuffer();
    const line = buffer.append('Hidden', 1000, true);
    expect(line.suppressed).toBe(true);
    expect(buffer.getRecent(1000)).toHaveLength(1);
  });

  describe('reinstate', () => {
    it('flips suppressed to false and updates the text, preserving id and position', () => {
      const buffer = new TranscriptBuffer();
      buffer.append('Before', 1000);
      const flagged = buffer.append('Mishe*rd', 2000, true);
      buffer.append('After', 3000);

      const result = buffer.reinstate(flagged.id, 'Corrected text', 4000);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(flagged.id);
      expect(result!.english).toBe('Corrected text');
      expect(result!.suppressed).toBe(false);

      const recent = buffer.getRecent(4000);
      expect(recent.map((line) => line.english)).toEqual(['Before', 'Corrected text', 'After']);
    });

    it('returns null for an unknown id', () => {
      const buffer = new TranscriptBuffer();
      expect(buffer.reinstate('does-not-exist', 'text', 1000)).toBeNull();
    });

    it('returns null for a line that is not currently suppressed', () => {
      const buffer = new TranscriptBuffer();
      const line = buffer.append('Already visible', 1000, false);
      expect(buffer.reinstate(line.id, 'text', 2000)).toBeNull();
    });

    it('returns null once the line has been trimmed out of the 10-minute window', () => {
      const buffer = new TranscriptBuffer();
      const flagged = buffer.append('Old and flagged', 0, true);
      const elevenMinutesLater = 11 * 60 * 1000;
      expect(buffer.reinstate(flagged.id, 'text', elevenMinutesLater)).toBeNull();
    });
  });

  describe('precedingContextFor', () => {
    it('returns the non-suppressed lines before the given id, oldest first', () => {
      const buffer = new TranscriptBuffer();
      buffer.append('Line 1', 1000);
      buffer.append('Line 2', 2000);
      const flagged = buffer.append('Flagged', 3000, true);
      buffer.append('Line 3', 4000);

      expect(buffer.precedingContextFor(flagged.id, 7, 4000)).toEqual(['Line 1', 'Line 2']);
    });

    it('caps the result at maxLines, keeping the most recent', () => {
      const buffer = new TranscriptBuffer();
      for (let i = 1; i <= 9; i += 1) buffer.append(`Line ${i}`, i * 1000);
      const target = buffer.append('Target', 10000);

      expect(buffer.precedingContextFor(target.id, 7, 10000)).toEqual([
        'Line 3', 'Line 4', 'Line 5', 'Line 6', 'Line 7', 'Line 8', 'Line 9',
      ]);
    });

    it('returns an empty array for an unknown id', () => {
      const buffer = new TranscriptBuffer();
      buffer.append('Line 1', 1000);
      expect(buffer.precedingContextFor('unknown', 7, 1000)).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `npx vitest run tests/transcriptBuffer.test.ts`
Expected: FAIL — `suppressed` is `undefined`, `reinstate`/`precedingContextFor` are not functions.

- [ ] **Step 3: Implement**

Replace the full contents of `server/src/types.ts`:

```ts
export interface CaptionLine {
  id: string;
  timestampMs: number;
  english: string;
  suppressed: boolean;
}
```

Replace the full contents of `server/src/transcriptBuffer.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { CaptionLine } from './types.js';

const BUFFER_WINDOW_MS = 10 * 60 * 1000;

export class TranscriptBuffer {
  private lines: CaptionLine[] = [];

  append(english: string, timestampMs: number = Date.now(), suppressed: boolean = false): CaptionLine {
    const line: CaptionLine = { id: randomUUID(), timestampMs, english, suppressed };
    this.lines.push(line);
    this.trim(timestampMs);
    return line;
  }

  getRecent(nowMs: number = Date.now()): CaptionLine[] {
    this.trim(nowMs);
    return [...this.lines];
  }

  reinstate(id: string, english: string, nowMs: number = Date.now()): CaptionLine | null {
    this.trim(nowMs);
    const line = this.lines.find((candidate) => candidate.id === id && candidate.suppressed);
    if (!line) return null;
    line.english = english;
    line.suppressed = false;
    return line;
  }

  precedingContextFor(id: string, maxLines: number, nowMs: number = Date.now()): string[] {
    this.trim(nowMs);
    const index = this.lines.findIndex((line) => line.id === id);
    if (index === -1) return [];
    return this.lines
      .slice(0, index)
      .filter((line) => !line.suppressed)
      .slice(-maxLines)
      .map((line) => line.english);
  }

  clear(): void {
    this.lines = [];
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - BUFFER_WINDOW_MS;
    this.lines = this.lines.filter((line) => line.timestampMs >= cutoff);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcriptBuffer.test.ts`
Expected: PASS (all tests, including the pre-existing three).

- [ ] **Step 5: Typecheck the whole server package**

Run: `npx tsc -p tsconfig.json --noEmit` (from `server/`)
Expected: no errors. (`session.test.ts` and `wsServer.test.ts` still compile because their `buffer.append(text, timestamp)` calls match the unchanged 2-argument position.)

- [ ] **Step 6: Commit**

```bash
git add server/src/types.ts server/src/transcriptBuffer.ts server/tests/transcriptBuffer.test.ts
git commit -m "$(cat <<'EOF'
Add suppressed-line storage and reinstate support to TranscriptBuffer

Flagged lines will need to keep their position in the buffer so a
later reinstate can splice them back in place; this lays the
buffer-level groundwork before wiring it into wsServer.
EOF
)"
```

---

### Task 2: Server flagging path — store suppressed lines, thread `id` through every message, fix the backlog builder

**Files:**
- Modify: `server/src/wsServer.ts:1-13` (imports), `:154-208` (`handleFinalSegment`), `:278-340` (`handleViewerConnection`)
- Modify: `server/tests/wsServer.test.ts` (multiple assertions, listed below)

**Interfaces:**
- Consumes: `TranscriptBuffer.append(english, timestampMs?, suppressed?)`, `.getRecent()` from Task 1.
- Produces: `finishPublishing(line: CaptionLine, translations: Record<string, string>, deps: WsServerDeps, captureSocket: WebSocket): Promise<void>` — sends the capture `transcript` ack and broadcasts `caption` to each active language's viewers. Task 3 will extend this with a message-type parameter.
- Every `transcript`, `caption`, `line-removed` message, and every backlog line, now carries `id: string` matching the buffer entry's id.

**Why this task can't stop halfway:** once flagged lines start living in the buffer, the backlog builder *must* also change in the same commit — otherwise a new viewer's subscribe would translate and ship suppressed (flagged, theologically-sensitive) text straight to them. Both changes land together.

- [ ] **Step 1: Update the import**

In `server/src/wsServer.ts`, the import block currently reads (lines 1-13):

```ts
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from './session.js';
import { translateSegment, translateBacklog, type GeminiClient, type SermonCacheRef } from './gemini.js';
import { verifyTranslations, type VerificationItem, type VerificationResult } from './translationVerifier.js';
import { verifyTranscription, type TranscriptionCheckResult } from './transcriptionVerifier.js';
import type { DeepgramConnection, DeepgramConnectionFactory } from './deepgram.js';
import { createSermonContextCache, deleteSermonContextCache } from './sermonCache.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { CostTracker } from './costTracker.js';
import { logEvent } from './logger.js';
```

Add one line after the `Session` import:

```ts
import type { Session } from './session.js';
import type { CaptionLine } from './types.js';
```

- [ ] **Step 2: Replace `handleFinalSegment` and add `finishPublishing`**

Replace the existing `handleFinalSegment` function (currently lines 154-208, from `async function handleFinalSegment(` through its closing `}` right before `async function translateWithFallback`) with:

```ts
async function finishPublishing(
  line: CaptionLine,
  translations: Record<string, string>,
  deps: WsServerDeps,
  captureSocket: WebSocket
): Promise<void> {
  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));

  const activeLanguages = deps.session.getActiveLanguages();
  if (activeLanguages.length === 0) return;

  const verificationItems: VerificationItem[] = activeLanguages
    .filter((language) => Boolean(translations[language]))
    .map((language) => ({ id: language, english: line.english, translated: translations[language] }));
  const verifications = await verifyTranslationsWithRetry(deps.geminiClient, verificationItems, deps.session.sermonCache);

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = safe ? translated : line.english;

    if (!safe) {
      logTranslationFallback(language, line.english, translated, verification?.reason ?? 'verification unavailable');
    }

    const payload = JSON.stringify({ type: 'caption', id: line.id, english: line.english, translated: outgoing });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
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
  const sermonCache = deps.session.sermonCache;
  const activeLanguages = deps.session.getActiveLanguages();

  const [transcriptionResult, translations] = await Promise.all([
    verifyTranscriptionWithRetry(deps.geminiClient, english, precedingContext, sermonCache),
    translateWithFallback(deps, english, activeLanguages, precedingContext, sermonCache),
  ]);

  if (!transcriptionResult.safe) {
    void logEvent('warn', { event: 'transcription_flagged', english, reason: transcriptionResult.reason });
    const line = deps.session.buffer.append(english, Date.now(), true);
    captureSocket.send(
      JSON.stringify({ type: 'transcript', id: line.id, english, flagged: true, reason: transcriptionResult.reason })
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
```

Note `precedingContext` now filters out suppressed lines before taking the last `PRECEDING_CONTEXT_LINES` — without this filter, a just-flagged line's text could leak into the *next* line's transcription/translation context, defeating the point of suppressing it.

- [ ] **Step 3: Rewrite the viewer backlog builder**

In `handleViewerConnection` (currently lines 278-340), replace the body of the `if (message.type === 'subscribe')` block — from `const language = message.language as string;` through `deps.session.addViewer(ws, language);` just before the closing of that `if` — with:

```ts
          const language = message.language as string;

          const backlog = deps.session.buffer.getRecent();
          if (backlog.length === 0) {
            ws.send(JSON.stringify({ type: 'backlog', lines: [] }));
            deps.session.addViewer(ws, language);
            return;
          }

          const visibleEntries = backlog.filter((line) => !line.suppressed);
          const translations = await translateBacklog(
            deps.geminiClient,
            visibleEntries.map((line) => line.english),
            language
          );
          const visibleLines = visibleEntries.map((line, index) => ({
            id: line.id,
            english: line.english,
            translated: translations[index] ?? '',
          }));

          const verificationItems: VerificationItem[] = visibleLines
            .filter((line) => line.translated.length > 0)
            .map((line) => ({ id: line.id, english: line.english, translated: line.translated }));
          const verifications = await verifyTranslationsWithRetry(
            deps.geminiClient,
            verificationItems,
            deps.session.sermonCache
          );

          const verifiedById = new Map(
            visibleLines.map((line) => {
              if (line.translated.length === 0) {
                return [line.id, { id: line.id, english: line.english, translated: line.english }] as const;
              }
              const verification = verifications[line.id];
              if (verification?.safe === true) return [line.id, line] as const;
              logTranslationFallback(
                language,
                line.english,
                line.translated,
                verification?.reason ?? 'verification unavailable'
              );
              return [line.id, { id: line.id, english: line.english, translated: line.english }] as const;
            })
          );

          const lines = backlog.map((line) =>
            line.suppressed
              ? { id: line.id, english: '', translated: '', removed: true }
              : verifiedById.get(line.id)!
          );

          ws.send(JSON.stringify({ type: 'backlog', lines }));
          deps.session.addViewer(ws, language);
```

- [ ] **Step 4: Update existing test assertions in `server/tests/wsServer.test.ts`**

Every assertion below needs `id: expect.any(String)` added (the tests otherwise pass a specific id from a captured value where noted). Apply these exact replacements:

1. Line 151 — broadcasts a translated caption:
   ```ts
   expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Hello everyone', translated: '你好' });
   ```

2. Lines 211-214 — backlog to a late-joining viewer:
   ```ts
   expect(backlogMessage).toEqual({
     type: 'backlog',
     lines: [{ id: expect.any(String), english: 'Earlier line', translated: '较早的一行' }],
   });
   ```

3. Line 277-279 — queued-backlog-before-caption test's backlog assertion:
   ```ts
   expect(messages).toEqual([
     { type: 'backlog', lines: [{ id: expect.any(String), english: 'Earlier line', translated: '较早的一行' }] },
   ]);
   ```

4. Lines 284-288 — same test's caption assertion:
   ```ts
   expect(caption).toEqual({
     type: 'caption',
     id: expect.any(String),
     english: 'Now the viewer is registered',
     translated: '你好',
   });
   ```

5. Line 320 — verifier-flags-translation fallback caption:
   ```ts
   expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Jesus loves you', translated: 'Jesus loves you' });
   ```

6. Line 355 — verifier-call-fails fallback caption:
   ```ts
   expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Hello everyone', translated: 'Hello everyone' });
   ```

7. Lines 362-392 — `'falls back to English in the backlog when the verifier flags a line as unsafe'`: the mock hardcodes the verification response key as `"0"` (a positional index). Verification items are now keyed by the buffer entry's real `id`, so this test must capture that id first. Replace the entire test body with:

   ```ts
   it('falls back to English in the backlog when the verifier flags a line as unsafe', async () => {
     const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

     const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
     await waitForOpen(captureSocket);
     captureSocket.send(JSON.stringify({ type: 'start' }));
     await waitForMessage(captureSocket); // status: recording

     const line = session.buffer.append('Jesus loves you', Date.now());

     (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
       if (params.contents.includes('safety checker')) {
         return Promise.resolve({ text: JSON.stringify({ [line.id]: { safe: false, reason: 'polarity flip' } }) });
       }
       return Promise.resolve({ text: '{"translations":["耶稣不爱你"]}' });
     });

     const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
     await waitForOpen(viewerSocket);
     viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
     const backlogMessage = await waitForMessage(viewerSocket);

     expect(backlogMessage).toEqual({
       type: 'backlog',
       lines: [{ id: line.id, english: 'Jesus loves you', translated: 'Jesus loves you' }],
     });
     expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('translation_fallback'));

     warnSpy.mockRestore();
     captureSocket.close();
     viewerSocket.close();
   });
   ```

8. Lines 416-419 — verifier-call-fails-after-retry backlog:
   ```ts
   expect(backlogMessage).toEqual({
     type: 'backlog',
     lines: [{ id: expect.any(String), english: 'Earlier line', translated: 'Earlier line' }],
   });
   ```

9. Line 555 and line 616 (sermon-context-caching describe block, two occurrences of the same shape) — add `id: expect.any(String)`:
   ```ts
   expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Cain killed Abel', translated: '你好' });
   ```

10. Lines 661-666 — `'notifies every viewer of a line removal...'`. Replace:
    ```ts
    expect(transcript).toEqual({
      type: 'transcript',
      english: 'Jesus is not the son of God',
      flagged: true,
      reason: 'likely mis-heard negation',
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('transcription_flagged'));

    await new Promise((resolve) => setImmediate(resolve));
    expect(viewerMessages).toEqual([{ type: 'line-removed' }]);
    expect(session.buffer.getRecent()).toHaveLength(0);
    ```
    with:
    ```ts
    expect(transcript).toEqual({
      type: 'transcript',
      id: expect.any(String),
      english: 'Jesus is not the son of God',
      flagged: true,
      reason: 'likely mis-heard negation',
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('transcription_flagged'));

    await new Promise((resolve) => setImmediate(resolve));
    expect(viewerMessages).toEqual([{ type: 'line-removed', id: transcript.id }]);
    expect(session.buffer.getRecent()).toHaveLength(1);
    expect(session.buffer.getRecent()[0]).toMatchObject({
      id: transcript.id,
      english: 'Jesus is not the son of God',
      suppressed: true,
    });
    ```

11. The test titled `'runs the transcription check even with zero active viewers, keeping a flagged line out of the buffer'` (lines 678-699) — rename and update, since the line is now *kept* (suppressed) rather than dropped. Replace the whole test with:
    ```ts
    it('runs the transcription check even with zero active viewers, storing a flagged line as suppressed', async () => {
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

      const recent = session.buffer.getRecent();
      expect(recent).toHaveLength(1);
      expect(recent[0].suppressed).toBe(true);
      expect((geminiClient.models.generateContent as any).mock.calls).toHaveLength(1);

      captureSocket.close();
    });
    ```

12. Line 711 — `'does not mark a safe line as flagged in the transcript event'`:
    ```ts
    expect(transcript).toEqual({ type: 'transcript', id: expect.any(String), english: 'Hello everyone' });
    ```

13. Lines 735-742 — `'suppresses the line when the transcription check fails after retry'`. Replace:
    ```ts
    expect(transcript).toEqual({
      type: 'transcript',
      english: 'Hello everyone',
      flagged: true,
      reason: 'verification unavailable',
    });
    expect(transcriptionCallCount).toBe(2);
    expect(session.buffer.getRecent()).toHaveLength(0);
    ```
    with:
    ```ts
    expect(transcript).toEqual({
      type: 'transcript',
      id: expect.any(String),
      english: 'Hello everyone',
      flagged: true,
      reason: 'verification unavailable',
    });
    expect(transcriptionCallCount).toBe(2);
    const recent = session.buffer.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].suppressed).toBe(true);
    ```

- [ ] **Step 5: Add a new test for backlog placeholder positioning**

Add this test inside the `describe('transcription safety check', ...)` block in `server/tests/wsServer.test.ts`:

```ts
    it('gives a viewer joining while a line is suppressed a placeholder at the correct position', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const before = session.buffer.append('Before the flag', Date.now());
      const flagged = session.buffer.append('Mishe*rd line', Date.now(), true);
      const after = session.buffer.append('After the flag', Date.now());

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlogMessage = await waitForMessage(viewerSocket);

      expect(backlogMessage).toEqual({
        type: 'backlog',
        lines: [
          { id: before.id, english: 'Before the flag', translated: '你好' },
          { id: flagged.id, english: '', translated: '', removed: true },
          { id: after.id, english: 'After the flag', translated: '你好' },
        ],
      });

      captureSocket.close();
      viewerSocket.close();
    });
```

- [ ] **Step 6: Run the full server test suite**

Run: `npx vitest run tests/wsServer.test.ts`
Expected: all tests pass.

Run: `npm test` (from `server/`)
Expected: all tests pass across the whole suite.

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "$(cat <<'EOF'
Keep flagged transcript lines in the buffer as suppressed placeholders

Flagged lines now reserve their position in the transcript buffer
instead of being dropped, and every capture/viewer message carries a
stable line id. The backlog builder skips translating suppressed
entries and emits a removed placeholder in their place, so any
viewer's transcript is positionally consistent regardless of when
they joined relative to a flag.
EOF
)"
```

---

### Task 3: Server reinstate handler

**Files:**
- Modify: `server/src/wsServer.ts` (`handleCaptureConnection`'s message switch, `finishPublishing`, new `handleReinstate`)
- Modify: `server/tests/wsServer.test.ts` (new `describe('reinstate', ...)` block)

**Interfaces:**
- Consumes: `TranscriptBuffer.reinstate`, `.precedingContextFor` (Task 1); `finishPublishing` (Task 2, extended here).
- Capture → server: `{ type: 'reinstate', id: string, english: string }`.
- Server → capture: `{ type: 'reinstate-error', id: string, error: string }` on failure; a normal `transcript` message (from `finishPublishing`) on success.
- Server → viewers: `{ type: 'caption-inserted', id: string, english: string, translated: string }`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe('reinstate', ...)` block in `server/tests/wsServer.test.ts`, as a sibling of `describe('transcription safety check', ...)`:

```ts
  describe('reinstate', () => {
    async function flagALine(
      captureSocket: WebSocket,
      geminiClient: GeminiClient,
      reason = 'likely mis-heard negation'
    ): Promise<{ id: string; english: string }> {
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: `{"safe":false,"reason":"${reason}"}` });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });
      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const transcript = await transcriptPromise;
      return { id: transcript.id, english: transcript.english };
    }

    it('reinstates with unedited text: un-flags the capture line and broadcasts caption-inserted', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const flagged = await flagALine(captureSocket, geminiClient);

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":true,"reason":"ok"}}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      captureSocket.send(JSON.stringify({ type: 'reinstate', id: flagged.id, english: flagged.english }));

      const ack = await ackPromise;
      expect(ack).toEqual({ type: 'transcript', id: flagged.id, english: flagged.english });

      const inserted = await insertedPromise;
      expect(inserted).toEqual({ type: 'caption-inserted', id: flagged.id, english: flagged.english, translated: '你好' });

      const recent = session.buffer.getRecent();
      expect(recent.find((line) => line.id === flagged.id)?.suppressed).toBe(false);

      captureSocket.close();
      viewerSocket.close();
    });

    it('reinstates with edited text: stores the corrected wording, reflected in a later backlog', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const flagged = await flagALine(captureSocket, geminiClient);

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{}' });
        }
        return Promise.resolve({ text: '{"zh":"耶稣确实是神的儿子"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      captureSocket.send(
        JSON.stringify({ type: 'reinstate', id: flagged.id, english: 'Jesus is indeed the son of God' })
      );
      const ack = await ackPromise;
      expect(ack).toEqual({ type: 'transcript', id: flagged.id, english: 'Jesus is indeed the son of God' });

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlogMessage = await waitForMessage(viewerSocket);

      expect(backlogMessage).toEqual({
        type: 'backlog',
        lines: [{ id: flagged.id, english: 'Jesus is indeed the son of God', translated: 'Jesus is indeed the son of God' }],
      });

      captureSocket.close();
      viewerSocket.close();
    });

    it('responds with reinstate-error for an unknown id and does not touch the buffer', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const errorPromise = waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'reinstate', id: 'no-such-id', english: 'text' }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'reinstate-error', id: 'no-such-id', error: 'not found' });
      expect(session.buffer.getRecent()).toHaveLength(0);

      captureSocket.close();
    });

    it('responds with reinstate-error for a line that is not currently suppressed', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const visible = session.buffer.append('Already visible', Date.now());

      const errorPromise = waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'reinstate', id: visible.id, english: 'text' }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'reinstate-error', id: visible.id, error: 'not found' });

      captureSocket.close();
    });

    it('responds with reinstate-error for blank edited text and does not touch the buffer', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const flagged = await flagALine(captureSocket, geminiClient);

      const errorPromise = waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'reinstate', id: flagged.id, english: '   ' }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'reinstate-error', id: flagged.id, error: 'empty text' });
      expect(session.buffer.getRecent().find((line) => line.id === flagged.id)?.suppressed).toBe(true);

      captureSocket.close();
    });

    it('uses the line\'s fixed position for translation context, not lines that arrived after it', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      // A subscribed viewer is required so translateWithFallback actually
      // calls Gemini during reinstate (activeLanguages.length > 0) — with no
      // viewers it would short-circuit to {} without any translate call.
      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      session.buffer.append('Earlier context line', Date.now());
      const flagged = await flagALine(captureSocket, geminiClient);
      session.buffer.append('Later unrelated line', Date.now());

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) return Promise.resolve({ text: '{}' });
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'reinstate', id: flagged.id, english: flagged.english }));
      await ackPromise;

      const translateCall = (geminiClient.models.generateContent as any).mock.calls.find(isTranslateCall);
      expect(translateCall[0].contents).toContain('Earlier context line');
      expect(translateCall[0].contents).not.toContain('Later unrelated line');

      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/wsServer.test.ts -t reinstate`
Expected: FAIL — no `reinstate` message type is handled yet, so these hang/timeout or receive no message. (If a test times out rather than failing cleanly, that's expected at this stage — proceed to implementation.)

- [ ] **Step 3: Extend `finishPublishing` with a message-type parameter**

In `server/src/wsServer.ts`, change the `finishPublishing` signature and its one internal reference, so it can emit either `caption` (the live path) or `caption-inserted` (the reinstate path):

```ts
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
  const verifications = await verifyTranslationsWithRetry(deps.geminiClient, verificationItems, deps.session.sermonCache);

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = safe ? translated : line.english;

    if (!safe) {
      logTranslationFallback(language, line.english, translated, verification?.reason ?? 'verification unavailable');
    }

    const payload = JSON.stringify({ type: viewerMessageType, id: line.id, english: line.english, translated: outgoing });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}
```

(The call site in `handleFinalSegment` — `await finishPublishing(line, translations, deps, captureSocket);` — needs no change; it still gets the `'caption'` default.)

- [ ] **Step 4: Add `handleReinstate`**

Add this function directly after `finishPublishing`:

```ts
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

  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  const precedingContext = deps.session.buffer.precedingContextFor(line.id, PRECEDING_CONTEXT_LINES);
  const activeLanguages = deps.session.getActiveLanguages();
  const translations = await translateWithFallback(
    deps,
    line.english,
    activeLanguages,
    precedingContext,
    deps.session.sermonCache
  );

  await finishPublishing(line, translations, deps, captureSocket, 'caption-inserted');
}
```

Note: the transcription-misrepresentation check (`verifyTranscriptionWithRetry`) is deliberately not called here — that's the whole point of a manual operator override. The translation-safety check (inside `finishPublishing` → `verifyTranslationsWithRetry`) still runs.

- [ ] **Step 5: Wire `reinstate` into the capture message handler**

In `handleCaptureConnection`, inside the `ws.on('message', ...)` handler's `if (!isBinary)` branch, the current structure is:

```ts
          if (message.type === 'start') {
            ...
          } else if (message.type === 'stop') {
            ...
          }
```

Add a third branch:

```ts
          if (message.type === 'start') {
            ...
          } else if (message.type === 'stop') {
            ...
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
          }
```

(Leave the existing `start`/`stop` bodies untouched — only add the new `else if` branch alongside them.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/wsServer.test.ts`
Expected: all tests pass, including the new `reinstate` describe block.

Run: `npm test` (from `server/`)
Expected: full suite passes.

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "$(cat <<'EOF'
Add server-side reinstate handling for flagged transcript lines

A capture-page operator can now send { type: 'reinstate', id, english }
to flip a suppressed buffer entry back to visible in place (same id,
same position), skipping only the transcription-misrepresentation
check — the translation-safety check still runs. Viewers receive a
caption-inserted message that replaces their removed placeholder.
EOF
)"
```

---

### Task 4: Viewer client — `id`-aware state and in-place caption updates

**Files:**
- Modify: `web/lib/useViewerSocket.ts`
- Modify: `web/app/view/page.tsx:90-103`

**Interfaces:**
- Produces: `CaptionLine { id: string; english: string; translated: string; removed?: boolean }` (client-side).
- Consumes server messages: `backlog` (lines already carry `id`), `caption` (carries `id`), `line-removed` (carries `id`), `caption-inserted` (new — `{ id, english, translated }`).

No automated frontend test suite exists in this repo (`web/` has no Vitest/Jest config for app code) — this task is verified manually in the browser per Step 4 below, following this repo's standing convention for UI changes.

- [ ] **Step 1: Replace `web/lib/useViewerSocket.ts`**

Full replacement:

```ts
'use client';

import { useEffect, useRef, useState } from 'react';

export interface CaptionLine {
  id: string;
  english: string;
  translated: string;
  removed?: boolean;
}

export type ViewerStatus = 'connecting' | 'reconnecting' | 'live';

export function useViewerSocket(language: string, wsUrl: string) {
  const [status, setStatus] = useState<ViewerStatus>('connecting');
  const [lines, setLines] = useState<CaptionLine[]>([]);

  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let socket: WebSocket;

    function connect() {
      socket = new WebSocket(wsUrl);
      setStatus('connecting');

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'subscribe', language }));
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'backlog') {
          setLines(message.lines);
          setStatus('live');
        } else if (message.type === 'caption') {
          setLines((previous) => [
            ...previous,
            { id: message.id, english: message.english, translated: message.translated },
          ]);
          setStatus('live');
        } else if (message.type === 'line-removed') {
          setLines((previous) => [...previous, { id: message.id, english: '', translated: '', removed: true }]);
          setStatus('live');
        } else if (message.type === 'caption-inserted') {
          setLines((previous) => {
            const index = previous.findIndex((line) => line.id === message.id);
            const inserted = { id: message.id, english: message.english, translated: message.translated };
            if (index === -1) return [...previous, inserted];
            const next = [...previous];
            next[index] = inserted;
            return next;
          });
          setStatus('live');
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setStatus('reconnecting');
        reconnectTimeout = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimeout);
      socket?.close();
    };
  }, [language, wsUrl]);

  return { status, lines };
}
```

- [ ] **Step 2: Update the list key in `web/app/view/page.tsx`**

Current (lines 90-103):

```tsx
        {lines.map((line, index) =>
          line.removed ? (
            <div key={index} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex-1 border-t border-dashed" />
              <span>Line removed</span>
              <span className="flex-1 border-t border-dashed" />
            </div>
          ) : (
            <div key={index}>
              <p className="text-sm text-muted-foreground">{line.english}</p>
              <p className="text-xl">{line.translated}</p>
            </div>
          )
        )}
```

Replace with (only the two `key` attributes change; the `index` map parameter is no longer needed):

```tsx
        {lines.map((line) =>
          line.removed ? (
            <div key={line.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex-1 border-t border-dashed" />
              <span>Line removed</span>
              <span className="flex-1 border-t border-dashed" />
            </div>
          ) : (
            <div key={line.id}>
              <p className="text-sm text-muted-foreground">{line.english}</p>
              <p className="text-xl">{line.translated}</p>
            </div>
          )
        )}
```

- [ ] **Step 3: Typecheck the web package**

Run (from `web/`): `npx tsc --noEmit`
Expected: no errors. (`exportTranscriptPdf.ts` imports `CaptionLine` from this file and only reads `english`/`translated`/`removed`, so it's unaffected by the added `id` field.)

- [ ] **Step 4: Manually verify in the browser**

1. Start the server (`npm run dev` in `server/`) and the web app (`npm run dev` in `web/`).
2. Open the capture page, click Start, and manually trigger a segment that will be flagged (e.g. temporarily point `transcriptionVerifier`'s prompt at a test phrase, or use the existing manual-testing approach documented in the transcription-safety-check spec).
3. Open `/view?lang=zh` in a second tab *before* the flag, and a third `/view?lang=zh` tab *between* the flag and any reinstate action.
4. Confirm both viewer tabs show a "Line removed" placeholder at the correct point in the transcript.
5. (Full end-to-end reinstate verification happens in Task 5, once the capture-page UI exists to trigger it.)

- [ ] **Step 5: Commit**

```bash
git add web/lib/useViewerSocket.ts web/app/view/page.tsx
git commit -m "$(cat <<'EOF'
Make the viewer client id-aware and handle in-place caption updates

CaptionLine now carries a stable id from the server, and a new
caption-inserted message replaces an existing line (e.g. a removed
placeholder) in place instead of only ever appending — needed so a
reinstated line lands back at its original position.
EOF
)"
```

---

### Task 5: Capture-page UI — Reinstate button, inline edit, confirmation

**Files:**
- Modify: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: capture WebSocket messages `transcript` (now carries `id`, optionally `flagged`/`reason`) and new `reinstate-error` (`{ id, error }`).
- Produces: capture WebSocket message `{ type: 'reinstate', id, english }`.

No automated frontend test suite exists for this file — verified manually in the browser per Step 3.

- [ ] **Step 1: Update state, `start()`, and the socket message handler**

In `web/app/capture/page.tsx`, add a new module-level type next to the existing `type CaptureStatus = ...` declaration (line 8):

```ts
type CaptureStatus = 'idle' | 'recording' | 'reconnecting' | 'error';

type TranscriptLine = {
  id: string;
  text: string;
  flagged: boolean;
  reason?: string;
  reinstateState?: 'editing' | 'pending' | 'error';
  editedText?: string;
  reinstateError?: string;
};
```

Then replace the `transcriptLines` state declaration (currently `const [transcriptLines, setTranscriptLines] = useState<{ text: string; flagged: boolean }[]>([]);`, inside the component body) with:

```ts
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
```

Replace the `connectSocket` function's `socket.onmessage` handler (currently the block starting `socket.onmessage = (event) => {` through its closing `};`) with:

```ts
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'status') {
        setStatus(message.status);
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => {
          const index = previous.findIndex((line) => line.id === message.id);
          const updated: TranscriptLine = {
            id: message.id,
            text: message.english,
            flagged: Boolean(message.flagged),
            reason: message.reason,
          };
          if (index === -1) return [...previous.slice(-49), updated];
          const next = [...previous];
          next[index] = updated;
          return next;
        });
      } else if (message.type === 'reinstate-error') {
        setTranscriptLines((previous) =>
          previous.map((line) =>
            line.id === message.id ? { ...line, reinstateState: 'error', reinstateError: message.error } : line
          )
        );
      } else if (message.type === 'cost') {
        setSessionCostUsd(message.sessionUsd);
        setLifetimeCostUsd(message.lifetimeUsd);
      }
    };
```

Replace the `start()` function:

```ts
  function start() {
    manuallyStoppedRef.current = false;
    setErrorMessage(null);
    setSessionCostUsd(0);
    setTranscriptLines([]);
    connectSocket();
  }
```

- [ ] **Step 2: Add the reinstate action handlers**

Add these functions after `stop()` (before the `return (` of the component):

```ts
  function beginEditing(id: string, currentText: string) {
    setTranscriptLines((previous) =>
      previous.map((line) =>
        line.id === id ? { ...line, reinstateState: 'editing', editedText: currentText, reinstateError: undefined } : line
      )
    );
  }

  function cancelEditing(id: string) {
    setTranscriptLines((previous) =>
      previous.map((line) => (line.id === id ? { ...line, reinstateState: undefined, editedText: undefined } : line))
    );
  }

  function updateEditedText(id: string, text: string) {
    setTranscriptLines((previous) => previous.map((line) => (line.id === id ? { ...line, editedText: text } : line)));
  }

  function sendReinstate(id: string) {
    const line = transcriptLines.find((entry) => entry.id === id);
    if (!line) return;
    const editedText = (line.editedText ?? line.text).trim();
    if (editedText.length === 0) return;
    const confirmed = window.confirm(`Flagged: "${line.reason ?? 'no reason given'}". Send this line to viewers?`);
    if (!confirmed) return;
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, reinstateState: 'pending' } : entry))
    );
    socketRef.current?.send(JSON.stringify({ type: 'reinstate', id, english: editedText }));
  }
```

- [ ] **Step 3: Replace the transcript list JSX**

Current (inside the `return (`):

```tsx
      <div ref={transcriptRef} className="w-full max-w-xl h-64 overflow-y-auto border rounded p-3 text-sm space-y-1">
        {transcriptLines.map((line, index) => (
          <p key={index} className={line.flagged ? 'text-destructive line-through' : undefined}>
            {line.text}
          </p>
        ))}
      </div>
```

Replace with:

```tsx
      <div ref={transcriptRef} className="w-full max-w-xl h-64 overflow-y-auto border rounded p-3 text-sm space-y-2">
        {transcriptLines.map((line) => (
          <div key={line.id}>
            <p className={line.flagged ? 'text-destructive line-through' : undefined}>{line.text}</p>
            {line.flagged && line.reinstateState !== 'editing' && (
              <div className="flex items-center gap-2 text-xs">
                {line.reason && <span className="text-muted-foreground">Flagged: {line.reason}</span>}
                <button
                  onClick={() => beginEditing(line.id, line.text)}
                  disabled={status !== 'recording' || line.reinstateState === 'pending'}
                  className="underline disabled:opacity-50 disabled:no-underline"
                >
                  {line.reinstateState === 'pending' ? 'Reinstating…' : 'Reinstate'}
                </button>
              </div>
            )}
            {line.flagged && line.reinstateState === 'editing' && (
              <div className="flex flex-col gap-1 mt-1">
                <textarea
                  value={line.editedText ?? line.text}
                  onChange={(event) => updateEditedText(line.id, event.target.value)}
                  rows={2}
                  className="w-full border rounded p-1 text-xs"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => sendReinstate(line.id)}
                    disabled={(line.editedText ?? line.text).trim().length === 0}
                    className="bg-primary text-primary-foreground px-2 py-1 rounded text-xs disabled:opacity-50"
                  >
                    Send
                  </button>
                  <button onClick={() => cancelEditing(line.id)} className="text-xs underline">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {line.reinstateState === 'error' && (
              <p className="text-xs text-destructive">Couldn&apos;t reinstate ({line.reinstateError}) — try again.</p>
            )}
          </div>
        ))}
      </div>
```

- [ ] **Step 4: Typecheck**

Run (from `web/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manually verify in the browser**

1. Start both dev servers. Open the capture page and the `/view?lang=zh` page in separate tabs.
2. Click Start on the capture page.
3. Trigger a flagged line (per the manual-testing note in Task 4, Step 4) and confirm on the capture page: the line shows struck-through, the flag reason is visible, and a "Reinstate" button appears.
4. Click "Reinstate": confirm the inline edit box appears pre-filled with the original text.
5. Edit the text to a corrected version, click "Send": confirm a `window.confirm` dialog appears showing the flag reason; confirm it.
6. After confirming: verify the capture-page row settles into normal (non-flagged) styling with the corrected text, and the `/view?lang=zh` tab's placeholder is replaced in place (not appended at the end) with the corrected translation.
7. Open a *fourth* `/view?lang=zh` tab now (after reinstating) and confirm its backlog shows the corrected line directly, with no placeholder.
8. Trigger a second flagged line and click "Reinstate" → "Cancel": confirm the row returns to its normal flagged display with no message sent (check the Network/WS tab).
9. Confirm the Reinstate button/edit box are hidden or disabled when `status !== 'recording'` (e.g. after clicking Stop).

- [ ] **Step 6: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "$(cat <<'EOF'
Add reinstate action to the capture page for flagged transcriptions

Flagged lines show their flag reason and a Reinstate button, which
opens an editable text box (pre-filled, correctable) and sends the
line back to the server after a confirm() showing the flag reason.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** buffer/type changes → Task 1; suppression-path + backlog-builder fix (must land together) → Task 2; reinstate handler + translation-safety-still-applies + skip-transcription-check → Task 3; viewer in-place update → Task 4; capture-page UI (reason display, edit box, confirm, error handling, `status === 'recording'` gating, reset on `start()`) → Task 5. All spec sections have a corresponding task.
- **Placeholder scan:** no TBD/TODO; every step has complete code.
- **Type consistency:** `CaptionLine` (server) defined in Task 1 and reused unchanged in Tasks 2-3; `finishPublishing`'s signature is introduced in Task 2 and explicitly extended (not silently redefined) in Task 3; client-side `CaptionLine` (Task 4) and `TranscriptLine` (Task 5) are distinct types in different files, named accordingly to avoid confusion with the server type of the same underlying concept.
