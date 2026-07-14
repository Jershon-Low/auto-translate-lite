# Widen Preceding Context Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen the shared preceding-context window used by both the transcription safety check and translation from 3 lines to 7 lines, so a multi-sentence rhetorical point isn't flagged as a mis-heard negation when the checker only sees the tail end of it.

**Architecture:** One named constant replaces a bare magic number in `handleFinalSegment`; no other production code changes, since `transcriptionVerifier.ts` and `gemini.ts` already render however many context lines they're given.

**Tech Stack:** Node.js/TypeScript server (`server/`), Vitest for tests.

## Global Constraints

- New window size: exactly 7 lines (was 3), applied identically to both `verifyTranscription` and `translateSegment` — they share one computed `precedingContext` array today and continue to do so.
- The line count must be a named constant (`PRECEDING_CONTEXT_LINES`), not a bare number, since it's asserted directly by a test.
- No change to `translateBacklog`, the transcript buffer's 10-minute retention window, or any prompt wording in `transcriptionVerifier.ts`/`gemini.ts`.

---

### Task 1: Widen the context window

**Files:**
- Modify: `server/src/wsServer.ts`
- Modify: `server/tests/wsServer.test.ts`

**Interfaces:** None — no exported signatures change. `handleFinalSegment`'s externally observable behavior changes only in how many preceding lines appear in the `contents` string sent to Gemini.

- [ ] **Step 1: Update the existing test to expect a 7-line window**

In `server/tests/wsServer.test.ts`, replace the test `'includes up to the last 3 preceding lines as translation context'` (currently pushes 4 buffer lines and checks the last 3 are included):

```ts
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

    const translateCall = (geminiClient.models.generateContent as any).mock.calls.find(isTranslateCall);
    expect(translateCall[0].contents).toContain('Second line');
    expect(translateCall[0].contents).toContain('Third line');
    expect(translateCall[0].contents).toContain('Fourth line');
    expect(translateCall[0].contents).not.toContain('First line');

    captureSocket.close();
    viewerSocket.close();
  });
```

with:

```ts
  it('includes up to the last 7 preceding lines as translation context', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    await waitForMessage(viewerSocket); // backlog: []

    session.buffer.append('Line 1', Date.now());
    session.buffer.append('Line 2', Date.now());
    session.buffer.append('Line 3', Date.now());
    session.buffer.append('Line 4', Date.now());
    session.buffer.append('Line 5', Date.now());
    session.buffer.append('Line 6', Date.now());
    session.buffer.append('Line 7', Date.now());
    session.buffer.append('Line 8', Date.now());

    const captionPromise = waitForMessage(viewerSocket);
    capturedCallbacks!.onFinalSegment('Line 9');
    await captionPromise;

    const translateCall = (geminiClient.models.generateContent as any).mock.calls.find(isTranslateCall);
    expect(translateCall[0].contents).toContain('Line 2');
    expect(translateCall[0].contents).toContain('Line 3');
    expect(translateCall[0].contents).toContain('Line 4');
    expect(translateCall[0].contents).toContain('Line 5');
    expect(translateCall[0].contents).toContain('Line 6');
    expect(translateCall[0].contents).toContain('Line 7');
    expect(translateCall[0].contents).toContain('Line 8');
    expect(translateCall[0].contents).not.toContain('Line 1');

    captureSocket.close();
    viewerSocket.close();
  });
```

(This pushes 8 buffer lines and triggers a 9th segment, so the 7-line window covers Line 2 through Line 8, dropping Line 1 — exercising the same "drops the oldest line beyond the window" shape as the original 3-line test, just at the new size.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/wsServer.test.ts -t "includes up to the last 7 preceding lines"`
Expected: FAIL — `expect(received).toContain(expected)` fails on `'Line 5'`/`'Line 6'`/`'Line 7'`/`'Line 8'` (only the last 3 lines are currently included, so the window is still `Line 6`/`Line 7`/`Line 8` at most... actually with the *current* 3-line window, only `Line 6`, `Line 7`, `Line 8` would be present — so the failure is specifically on the `toContain('Line 2')`, `toContain('Line 3')`, `toContain('Line 4')`, and `toContain('Line 5')` assertions, since those lines aren't in the window yet).

- [ ] **Step 3: Add the named constant and widen the window**

In `server/src/wsServer.ts`, add this constant directly after the existing imports, before `export interface WsServerDeps`:

```ts
const PRECEDING_CONTEXT_LINES = 7;
```

Then find this line inside `handleFinalSegment`:

```ts
  const precedingContext = recentLines.slice(-3).map((recentLine) => recentLine.english);
```

and replace it with:

```ts
  const precedingContext = recentLines.slice(-PRECEDING_CONTEXT_LINES).map((recentLine) => recentLine.english);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/wsServer.test.ts -t "includes up to the last 7 preceding lines"`
Expected: PASS

- [ ] **Step 5: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS (all suites — this change only affects the one updated test; every other test that exercises `handleFinalSegment` uses 3 or fewer buffered lines before triggering a segment, so a wider window doesn't change what they observe)

- [ ] **Step 6: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "feat: widen preceding-context window from 3 to 7 lines"
```
