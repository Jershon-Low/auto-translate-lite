# Capture / Review Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the operator experience into two independent pages — `/capture` (mic-only, one computer) and a new `/review` (transcription checking, viewer feedback, feedback notes — any number of computers/people concurrently) — backed by a new `/ws/review` WebSocket endpoint, and gate both pages behind the existing admin passcode.

**Architecture:** `Session` gains session-scoped state (`captureSocket`, a `reviewSockets` set, and the `ingestQueue`/`publishQueue` promise chains that used to live as local variables inside the capture connection handler) so that commands arriving on a brand-new `/ws/review` connection can be sequenced and broadcast exactly like the existing `/ws/capture` commands were. `CaptionLine` gains `pending`/`reason` fields so a reviewer joining mid-session (or reconnecting) can be handed a faithful backlog instead of starting blind. Both new operator surfaces (WS query param for sockets, `x-admin-passcode` header for REST) reuse the existing `adminAuth` middleware and passcode.

**Tech Stack:** TypeScript, Express, `ws`, Vitest + Supertest (server); Next.js, React, shadcn/ui, Tailwind (web). No new dependencies.

## Global Constraints

- No functional change to the translation/verification/Deepgram pipeline — only who can see/control it and from where.
- No new persistence beyond the two new `CaptionLine` fields (`pending`, `reason`).
- `POST /viewer-feedback` (used by the public `/view` page to submit a flag) stays unauthenticated — only the review-only routes (`/feedback`, `GET /viewer-feedback`, the two download routes, `/sermon-doc`) get `adminAuth`.
- `/ws/viewer` (congregant viewers) is not passcode-gated — only `/ws/capture` and `/ws/review`.
- No new frontend test harness exists (`web/package.json` has no Jest/RTL) — frontend tasks verify via `cd web && npm run build` (type-checks) plus a manual check in the dev server, matching the existing `2026-07-18-web-ux-redesign.md` plan's convention.
- Server tests run via `cd server && npm test` (Vitest).

---

### Task 1: `CaptionLine` and `TranscriptBuffer` gain `pending`/`reason`

**Files:**
- Modify: `server/src/types.ts`
- Modify: `server/src/transcriptBuffer.ts`
- Test: `server/tests/transcriptBuffer.test.ts`

**Interfaces:**
- Produces: `CaptionLine.pending?: boolean`, `CaptionLine.reason?: string`; `TranscriptBuffer.append(english, timestampMs?, suppressed?, pendingTranslations?, pending?, reason?): CaptionLine`; `reinstate` now clears `pending`/`reason`; `suppress` now sets `reason: 'Removed by admin'`.

- [x] **Step 1: Write the failing tests**

Add to `server/tests/transcriptBuffer.test.ts`, right after the existing `'append() leaves pendingTranslations undefined when not provided'` test:

```ts
  it('append() stores pending and reason when provided', () => {
    const buffer = new TranscriptBuffer();
    const line = buffer.append('Hidden', 1000, true, undefined, true, 'Pending manual approval');
    expect(line.pending).toBe(true);
    expect(line.reason).toBe('Pending manual approval');
  });
```

Inside the `describe('reinstate', ...)` block, after its last test:

```ts
    it('clears pending and reason on reinstate', () => {
      const buffer = new TranscriptBuffer();
      const flagged = buffer.append('Mishe*rd', 1000, true, undefined, true, 'Pending manual approval');
      const result = buffer.reinstate(flagged.id, 'Corrected', 2000);
      expect(result!.pending).toBeUndefined();
      expect(result!.reason).toBeUndefined();
    });
```

Inside the `describe('suppress', ...)` block, after its last test:

```ts
    it('sets reason to "Removed by admin"', () => {
      const buffer = new TranscriptBuffer();
      const visible = buffer.append('Visible line', 1000);
      const result = buffer.suppress(visible.id, 2000);
      expect(result!.reason).toBe('Removed by admin');
    });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/transcriptBuffer.test.ts`
Expected: FAIL — `line.pending`/`line.reason` are `undefined` where a value is expected, or `result!.reason` isn't set, because the fields don't exist yet.

- [x] **Step 3: Add the fields to `CaptionLine`**

In `server/src/types.ts`, replace the whole file with:

```ts
export interface CaptionLine {
  id: string;
  timestampMs: number;
  english: string;
  suppressed: boolean;
  pendingTranslations?: Record<string, string>;
  pending?: boolean;
  reason?: string;
}
```

- [x] **Step 4: Update `TranscriptBuffer`**

In `server/src/transcriptBuffer.ts`, replace the `append` method:

```ts
  append(
    english: string,
    timestampMs: number = Date.now(),
    suppressed: boolean = false,
    pendingTranslations?: Record<string, string>,
    pending?: boolean,
    reason?: string
  ): CaptionLine {
    const line: CaptionLine = {
      id: randomUUID(),
      timestampMs,
      english,
      suppressed,
      pendingTranslations,
      pending,
      reason,
    };
    this.lines.push(line);
    this.trim(timestampMs);
    return line;
  }
```

Replace `reinstate`:

```ts
  reinstate(id: string, english: string, nowMs: number = Date.now()): CaptionLine | null {
    this.trim(nowMs);
    const line = this.lines.find((candidate) => candidate.id === id && candidate.suppressed);
    if (!line) return null;
    line.english = english;
    line.suppressed = false;
    line.pending = undefined;
    line.reason = undefined;
    return line;
  }
```

Replace `suppress`:

```ts
  suppress(id: string, nowMs: number = Date.now()): CaptionLine | null {
    this.trim(nowMs);
    const line = this.lines.find((candidate) => candidate.id === id && !candidate.suppressed);
    if (!line) return null;
    line.suppressed = true;
    line.reason = 'Removed by admin';
    return line;
  }
```

- [x] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/transcriptBuffer.test.ts`
Expected: PASS (all tests in the file, including the three new ones).

- [x] **Step 6: Commit**

```bash
git add server/src/types.ts server/src/transcriptBuffer.ts server/tests/transcriptBuffer.test.ts
git commit -m "Store pending/reason on CaptionLine so suppressed state survives a reconnect"
```

---

### Task 2: `Session` gains review-socket tracking, a capture-socket reference, and session-scoped queues

**Files:**
- Modify: `server/src/session.ts`
- Test: `server/tests/session.test.ts`

**Interfaces:**
- Consumes: nothing new (pure additions to `Session`).
- Produces: `Session.captureSocket: WebSocket | null`, `Session.ingestQueue: Promise<void>`, `Session.publishQueue: Promise<void>`, `Session.addReview(socket)`, `Session.removeReview(socket)`, `Session.getAllReview(): WebSocket[]`, `Session.broadcastToReview(payload: string): void`. `start()` now also resets `ingestQueue`/`publishQueue` to fresh resolved promises.

- [x] **Step 1: Write the failing tests**

In `server/tests/session.test.ts`, change the import line to pull in the `WebSocket` value (not just the type) and `vi`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Session } from '../src/session';
```

Replace the `fakeSocket` helper's return type usage stays the same (`{} as WebSocket` still works with a value import). Add these tests at the end of the `describe('Session', ...)` block, before the closing `});`:

```ts

  it('defaults captureSocket to null', () => {
    const session = new Session();
    expect(session.captureSocket).toBeNull();
  });

  it('reviewSockets: adds, lists, and removes review connections', () => {
    const session = new Session();
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    session.addReview(socketA);
    session.addReview(socketB);
    expect(session.getAllReview()).toEqual([socketA, socketB]);
    session.removeReview(socketA);
    expect(session.getAllReview()).toEqual([socketB]);
  });

  it('broadcastToReview sends only to sockets whose readyState is OPEN', () => {
    const session = new Session();
    const open = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
    const closed = { readyState: WebSocket.CLOSED, send: vi.fn() } as unknown as WebSocket;
    session.addReview(open);
    session.addReview(closed);
    session.broadcastToReview('hello');
    expect(open.send).toHaveBeenCalledWith('hello');
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('start() resets ingestQueue and publishQueue to fresh resolved promises', () => {
    const session = new Session();
    const originalIngest = session.ingestQueue;
    const originalPublish = session.publishQueue;
    session.start();
    expect(session.ingestQueue).not.toBe(originalIngest);
    expect(session.publishQueue).not.toBe(originalPublish);
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/session.test.ts`
Expected: FAIL — `session.captureSocket`, `session.addReview`, etc. don't exist yet (TypeScript compile error surfaced as a test failure).

- [x] **Step 3: Implement the `Session` changes**

Replace `server/src/session.ts` in full:

```ts
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { TranscriptBuffer } from './transcriptBuffer.js';
import { TranslationCache } from './translationCache.js';
import type { RoleCaches } from './sermonCache.js';
import type { RoleProviders } from './llmTypes.js';
import type { TranslationFlagDisplayMode } from './translationFlagDisplayStore.js';

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
  translationFlagDisplayMode: TranslationFlagDisplayMode = 'hide';
  captureSocket: WebSocket | null = null;
  ingestQueue: Promise<void> = Promise.resolve();
  publishQueue: Promise<void> = Promise.resolve();
  private viewers: Map<WebSocket, string> = new Map();
  private reviewSockets: Set<WebSocket> = new Set();

  start(): void {
    this.id = randomUUID();
    this.isActive = true;
    this.buffer.clear();
    this.roleCaches = { ...EMPTY_ROLE_CACHES };
    this.providers = null;
    this.translationCache = new TranslationCache();
    this.inFlightFills = new Map();
    this.translationFlagDisplayMode = 'hide';
    this.ingestQueue = Promise.resolve();
    this.publishQueue = Promise.resolve();
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

  addReview(socket: WebSocket): void {
    this.reviewSockets.add(socket);
  }

  removeReview(socket: WebSocket): void {
    this.reviewSockets.delete(socket);
  }

  getAllReview(): WebSocket[] {
    return Array.from(this.reviewSockets);
  }

  broadcastToReview(payload: string): void {
    for (const socket of this.reviewSockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }
}
```

(Note: the import switches from `import type { WebSocket } from 'ws'` to a real value import, since `WebSocket.OPEN` is a static constant, not a type.)

- [x] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/session.test.ts`
Expected: PASS (all tests, old and new).

- [x] **Step 5: Commit**

```bash
git add server/src/session.ts server/tests/session.test.ts
git commit -m "Add review-socket tracking and session-scoped queues to Session"
```

---

### Task 3: Rewire `wsServer.ts` to use the session-scoped queues and capture-socket reference (pure refactor)

This task moves `ingestQueue`/`publishQueue` from local variables inside `handleCaptureConnection` onto `deps.session`, and records the active capture socket on `deps.session.captureSocket`. It does **not** change any observable behavior yet — `reinstate`/`admin-remove`/`set-mode` still arrive over `/ws/capture` exactly as before. This isolates the risky part of the refactor (queue relocation) from the new endpoint (Task 4), so the entire existing `wsServer.test.ts` suite is the regression test for this task.

**Files:**
- Modify: `server/src/wsServer.ts`

**Interfaces:**
- Consumes: `Session.captureSocket`, `Session.ingestQueue`, `Session.publishQueue` (Task 2).
- Produces: a `createEnqueuePublish(deps): EnqueuePublish` factory, replacing the old per-connection `enqueuePublish` closure — used by both the capture handler (this task) and the review handler (Task 4).

- [x] **Step 1: Confirm the current suite passes before touching anything**

Run: `cd server && npm test`
Expected: PASS (baseline).

- [x] **Step 2: Replace `handleCaptureConnection` and add `createEnqueuePublish`**

In `server/src/wsServer.ts`, replace the entire `handleCaptureConnection` function (and the `enqueuePublish`/`EnqueuePublish` wiring it contains) with:

```ts
function createEnqueuePublish(deps: WsServerDeps): EnqueuePublish {
  return function enqueuePublish(
    line: CaptionLine,
    workPromise: Promise<Record<string, string>>,
    viewerMessageType: 'caption' | 'caption-inserted' = 'caption'
  ): void {
    deps.session.publishQueue = deps.session.publishQueue
      .then(async () => {
        const translations = await workPromise;
        await finishPublishing(line, translations, deps, viewerMessageType);
      })
      .catch((error) => {
        void logEvent('error', {
          event: 'publish_failed',
          english: line.english,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
}

function handleCaptureConnection(ws: WebSocket, deps: WsServerDeps): void {
  let deepgramConnection: DeepgramConnection | null = null;
  let recordingStartedAt: number | null = null;
  let unsubscribeCost: (() => void) | null = null;

  deps.session.captureSocket = ws;

  function finalizeDeepgramCost(): void {
    if (recordingStartedAt !== null) {
      const elapsedSeconds = (Date.now() - recordingStartedAt) / 1000;
      deps.costTracker.recordDeepgramSeconds(elapsedSeconds);
      recordingStartedAt = null;
    }
  }

  // For lines not yet visible to viewers (AI-flagged or manual-hold): warms
  // pendingTranslations in the background so an operator's later Approve can
  // often skip re-translating, without blocking the ingest queue or being
  // ordered against any other line's publish.
  function schedulePrefetch(line: CaptionLine, precedingContext: string[]): void {
    const activeLanguages = deps.session.getActiveLanguages();
    void translateWithFallback(deps, line.english, activeLanguages, precedingContext).then((translations) => {
      line.pendingTranslations = translations;
    });
  }

  const enqueuePublish = createEnqueuePublish(deps);

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
            const translationFlagDisplayConfig = await deps.translationFlagDisplayStore.read();

            deps.session.providers = {
              transcriptionVerifier: getProvider(modelConfig.transcriptionVerifier, promptConfig.transcriptionVerifier, deps.llmClients),
              translation: getProvider(modelConfig.translation, promptConfig.translation, deps.llmClients),
              translationVerifier: getProvider(modelConfig.translationVerifier, promptConfig.translationVerifier, deps.llmClients),
            };
            deps.session.roleCaches = await createRoleCaches(deps.geminiClient, modelConfig, promptConfig, feedbackText, sermonText);
            deps.session.translationFlagDisplayMode = translationFlagDisplayConfig.mode;

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
                deps.session.ingestQueue = deps.session.ingestQueue
                  .then(() => handleFinalSegmentFast(text, deps, ws, enqueuePublish, schedulePrefetch))
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
            deps.session.ingestQueue = deps.session.ingestQueue
              .then(() => handleReinstateFast(message.id, message.english, deps, ws, enqueuePublish))
              .catch((error) => {
                void logEvent('error', {
                  event: 'reinstate_processing_failed',
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          } else if (message.type === 'admin-remove') {
            deps.session.ingestQueue = deps.session.ingestQueue
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
    if (deps.session.captureSocket === ws) deps.session.captureSocket = null;
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
```

This is a mechanical relocation: `reinstate`/`admin-remove`/`set-mode` are still handled inline in the capture message handler (unchanged behavior) — they move to `/ws/review` in Task 4.

- [x] **Step 3: Run the full server suite to confirm no regression**

Run: `cd server && npm test`
Expected: PASS — identical results to Step 1's baseline (this task changed no observable behavior).

- [x] **Step 4: Commit**

```bash
git add server/src/wsServer.ts
git commit -m "Move capture connection's ingest/publish queues onto Session"
```

---

### Task 4: Add the `/ws/review` endpoint — backlog snapshot, command handoff, and live broadcast

This is the core behavioral change: reviewer connections get a full backlog on connect, `reinstate`/`admin-remove`/`set-mode` move from `/ws/capture` to `/ws/review`, mode changes broadcast to every reviewer, and `transcript`/`status`/`cost` updates fan out to both the capture socket and every review socket.

**Files:**
- Modify: `server/src/wsServer.ts`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `Session.captureSocket`, `Session.addReview`/`removeReview`/`getAllReview`/`broadcastToReview`, `Session.ingestQueue` (Task 2/3), `CaptionLine.pending`/`reason` (Task 1).
- Produces: `/ws/review` WS endpoint accepting `{ type: 'reinstate', id, english }`, `{ type: 'admin-remove', id }`, `{ type: 'set-mode', mode }`; emitting `{ type: 'backlog', lines, mode, status }` on connect, plus `transcript`/`status`/`cost`/`mode`/`reinstate-error`/`admin-remove-error`.

- [x] **Step 1: Write the failing tests**

Add a new top-level `describe` block to `server/tests/wsServer.test.ts`, just before the final closing `});` of the outer `describe('wsServer', ...)` block:

```ts

  describe('review connection', () => {
    it('sends a backlog snapshot with mode and status on connect', async () => {
      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review`);
      const backlog = await waitForMessage(reviewSocket);
      expect(backlog).toEqual({ type: 'backlog', lines: [], mode: 'automatic', status: 'idle' });
      reviewSocket.close();
    });

    it("includes a suppressed line's pending/reason in the backlog", async () => {
      session.buffer.append('Visible', 1000);
      session.buffer.append('Held for review', 2000, true, undefined, true, 'Pending manual approval');

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review`);
      const backlog = await waitForMessage(reviewSocket);
      expect(backlog).toEqual({
        type: 'backlog',
        lines: [
          { id: expect.any(String), english: 'Visible' },
          {
            id: expect.any(String),
            english: 'Held for review',
            flagged: true,
            reason: 'Pending manual approval',
            pending: true,
          },
        ],
        mode: 'automatic',
        status: 'idle',
      });
      reviewSocket.close();
    });

    it('reports status: recording in the backlog once capture has started', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review`);
      const backlog = await waitForMessage(reviewSocket);
      expect(backlog).toMatchObject({ status: 'recording' });

      captureSocket.close();
      reviewSocket.close();
    });

    it('broadcasts a new transcript line to both the capture socket and a connected review socket', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForMessage(reviewSocket); // backlog

      const captureAckPromise = waitForMessage(captureSocket);
      const reviewAckPromise = waitForMessage(reviewSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const [captureAck, reviewAck] = await Promise.all([captureAckPromise, reviewAckPromise]);

      expect(captureAck).toEqual({ type: 'transcript', id: expect.any(String), english: 'Hello everyone' });
      expect(reviewAck).toEqual(captureAck);

      captureSocket.close();
      reviewSocket.close();
    });

    it('accepts reinstate from a review socket and broadcasts the result to the capture socket', async () => {
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

      const flaggedPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const flagged = await flaggedPromise;

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForMessage(reviewSocket); // backlog

      const captureReinstatePromise = waitForMessage(captureSocket);
      const reviewReinstatePromise = waitForMessage(reviewSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: flagged.id, english: flagged.english }));
      const [captureReinstate, reviewReinstate] = await Promise.all([captureReinstatePromise, reviewReinstatePromise]);

      expect(captureReinstate).toEqual({ type: 'transcript', id: flagged.id, english: flagged.english });
      expect(reviewReinstate).toEqual(captureReinstate);

      captureSocket.close();
      reviewSocket.close();
    });

    it('sends reinstate-error back only to the requesting review socket', async () => {
      const reviewSocketA = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForMessage(reviewSocketA); // backlog
      const reviewSocketB = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForMessage(reviewSocketB); // backlog

      const errorPromise = waitForMessage(reviewSocketA);
      const bMessages: any[] = [];
      reviewSocketB.on('message', (data) => bMessages.push(JSON.parse(data.toString())));

      reviewSocketA.send(JSON.stringify({ type: 'reinstate', id: 'does-not-exist', english: 'text' }));
      const error = await errorPromise;
      expect(error).toEqual({ type: 'reinstate-error', id: 'does-not-exist', error: 'not found' });

      await new Promise((resolve) => setImmediate(resolve));
      expect(bMessages).toEqual([]);

      reviewSocketA.close();
      reviewSocketB.close();
    });

    it('accepts admin-remove from a review socket and broadcasts to viewers and the capture socket', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const ackPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const ack = await ackPromise;

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForMessage(reviewSocket); // backlog

      const captureRemovePromise = waitForMessage(captureSocket);
      const reviewRemovePromise = waitForMessage(reviewSocket);
      const viewerRemovePromise = waitForMessage(viewerSocket);
      reviewSocket.send(JSON.stringify({ type: 'admin-remove', id: ack.id }));
      const [captureRemove, reviewRemove, viewerRemove] = await Promise.all([
        captureRemovePromise,
        reviewRemovePromise,
        viewerRemovePromise,
      ]);

      expect(captureRemove).toEqual({
        type: 'transcript',
        id: ack.id,
        english: 'Hello everyone',
        flagged: true,
        reason: 'Removed by admin',
      });
      expect(reviewRemove).toEqual(captureRemove);
      expect(viewerRemove).toEqual({ type: 'line-removed', id: ack.id });

      captureSocket.close();
      reviewSocket.close();
      viewerSocket.close();
    });

    it('broadcasts a mode change from one review socket to every other review socket', async () => {
      const reviewSocketA = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForMessage(reviewSocketA); // backlog
      const reviewSocketB = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForMessage(reviewSocketB); // backlog

      const modePromiseA = waitForMessage(reviewSocketA);
      const modePromiseB = waitForMessage(reviewSocketB);
      reviewSocketA.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));
      const [modeA, modeB] = await Promise.all([modePromiseA, modePromiseB]);

      expect(modeA).toEqual({ type: 'mode', mode: 'manual' });
      expect(modeB).toEqual(modeA);
      expect(session.mode).toBe('manual');

      reviewSocketA.close();
      reviewSocketB.close();
    });

    it('broadcasts cost updates to review sockets', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForMessage(reviewSocket); // backlog

      const costPromise = waitForMessage(reviewSocket);
      costTracker.recordDeepgramSeconds(1);
      const cost = await costPromise;
      expect(cost.type).toBe('cost');

      captureSocket.close();
      reviewSocket.close();
    });

    it('removes a review socket from broadcast targets on close', async () => {
      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForMessage(reviewSocket); // backlog
      reviewSocket.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(session.getAllReview()).toEqual([]);
    });
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/wsServer.test.ts -t "review connection"`
Expected: FAIL — `/ws/review` doesn't exist yet, so these connections never receive a `backlog` message (timeout) or the server destroys the socket as an unknown path.

- [x] **Step 3: Add the `/ws/review` endpoint and move commands off `/ws/capture`**

In `server/src/wsServer.ts`, replace the `attachWsServer` upgrade/connection wiring:

```ts
export function attachWsServer(deps: WsServerDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  deps.httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '', 'http://localhost');
    if (pathname === '/ws/capture' || pathname === '/ws/viewer' || pathname === '/ws/review') {
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
    } else if (pathname === '/ws/review') {
      handleReviewConnection(ws, deps);
    } else {
      handleViewerConnection(ws, deps);
    }
  });
}
```

Remove the `reinstate`/`admin-remove`/`set-mode` branches from `handleCaptureConnection`'s message handler (leave `start`/`stop`/binary-audio untouched) — the `else if` chain becomes just:

```ts
          if (message.type === 'start') {
            // ...unchanged...
          } else if (message.type === 'stop') {
            // ...unchanged...
          }
```

Add the new `handleReviewConnection` function right after `handleCaptureConnection`:

```ts
function buildReviewBacklogLine(line: CaptionLine): Record<string, unknown> {
  if (!line.suppressed) return { id: line.id, english: line.english };
  return {
    id: line.id,
    english: line.english,
    flagged: true,
    reason: line.reason,
    ...(line.pending ? { pending: true } : {}),
  };
}

function handleReviewConnection(ws: WebSocket, deps: WsServerDeps): void {
  const enqueuePublish = createEnqueuePublish(deps);

  ws.send(
    JSON.stringify({
      type: 'backlog',
      lines: deps.session.buffer.getRecent().map(buildReviewBacklogLine),
      mode: deps.session.mode,
      status: deps.session.isActive ? 'recording' : 'idle',
    })
  );
  deps.session.addReview(ws);

  ws.on('message', (data) => {
    void (async () => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'reinstate') {
          deps.session.ingestQueue = deps.session.ingestQueue
            .then(() => handleReinstateFast(message.id, message.english, deps, ws, enqueuePublish))
            .catch((error) => {
              void logEvent('error', {
                event: 'reinstate_processing_failed',
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        } else if (message.type === 'admin-remove') {
          deps.session.ingestQueue = deps.session.ingestQueue
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
          deps.session.broadcastToReview(JSON.stringify({ type: 'mode', mode: deps.session.mode }));
        }
      } catch (error) {
        void logEvent('error', {
          event: 'review_message_error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  ws.on('close', () => deps.session.removeReview(ws));
}
```

Now update the functions that send single-recipient updates so they also broadcast to review sockets. Replace `handleReinstateFast`'s signature and body (the `captureSocket` parameter becomes `requestingSocket`, used only for error replies; success sends go to `deps.session.captureSocket` + `broadcastToReview`):

```ts
async function handleReinstateFast(
  id: string,
  english: string,
  deps: WsServerDeps,
  requestingSocket: WebSocket,
  enqueuePublish: EnqueuePublish
): Promise<void> {
  const trimmed = english.trim();
  if (trimmed.length === 0) {
    requestingSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'empty text' }));
    return;
  }

  const existing = deps.session.buffer.peek(id);
  if (existing === null || !existing.suppressed) {
    requestingSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  const originalEnglish = existing.english;
  const cachedTranslations = existing.pendingTranslations ?? {};
  const precedingContext = deps.session.buffer.precedingContextFor(id, PRECEDING_CONTEXT_LINES);
  const activeLanguages = deps.session.getActiveLanguages();

  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    requestingSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  const payload = JSON.stringify({ type: 'transcript', id: line.id, english: line.english });
  deps.session.captureSocket?.send(payload);
  deps.session.broadcastToReview(payload);

  const workPromise = buildReinstateTranslation(
    deps,
    trimmed,
    originalEnglish,
    cachedTranslations,
    precedingContext,
    activeLanguages
  );
  enqueuePublish(line, workPromise, 'caption-inserted');
}
```

Replace `handleAdminRemove`:

```ts
async function handleAdminRemove(id: string, deps: WsServerDeps, requestingSocket: WebSocket): Promise<void> {
  const line = deps.session.buffer.suppress(id);
  if (line === null) {
    requestingSocket.send(JSON.stringify({ type: 'admin-remove-error', id, error: 'not found' }));
    return;
  }

  const payload = JSON.stringify({
    type: 'transcript',
    id: line.id,
    english: line.english,
    flagged: true,
    reason: 'Removed by admin',
  });
  deps.session.captureSocket?.send(payload);
  deps.session.broadcastToReview(payload);

  const removedPayload = JSON.stringify({ type: 'line-removed', id: line.id });
  for (const viewerSocket of deps.session.getAllViewers()) {
    viewerSocket.send(removedPayload);
  }
}
```

Replace `handleFinalSegmentFast` so it broadcasts its `transcript` message to review sockets too, and stores `pending`/`reason` on the buffered line (Task 1's fields) so a later-joining reviewer's backlog is accurate:

```ts
async function handleFinalSegmentFast(
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket,
  enqueuePublish: EnqueuePublish,
  schedulePrefetch: (line: CaptionLine, precedingContext: string[]) => void
): Promise<void> {
  const recentLines = deps.session.buffer.getRecent();
  const precedingContext = recentLines
    .filter((recentLine) => !recentLine.suppressed)
    .slice(-PRECEDING_CONTEXT_LINES)
    .map((recentLine) => recentLine.english);

  const transcriptionResult = await verifyTranscriptionWithRetry(deps, english, precedingContext);
  const manualHold = deps.session.mode === 'manual';
  const suppressed = manualHold || !transcriptionResult.safe;

  if (suppressed) {
    if (!transcriptionResult.safe) {
      void logEvent('warn', { event: 'transcription_flagged', english, reason: transcriptionResult.reason });
    }
    const reason = manualHold
      ? transcriptionResult.safe
        ? 'Pending manual approval'
        : `Pending manual approval — AI also flagged: ${transcriptionResult.reason}`
      : transcriptionResult.reason;
    const line = deps.session.buffer.append(english, Date.now(), true, undefined, manualHold ? true : undefined, reason);

    const payload = JSON.stringify({
      type: 'transcript',
      id: line.id,
      english,
      flagged: true,
      reason,
      ...(manualHold ? { pending: true } : {}),
    });
    captureSocket.send(payload);
    deps.session.broadcastToReview(payload);

    const removedPayload = JSON.stringify({ type: 'line-removed', id: line.id });
    for (const viewerSocket of deps.session.getAllViewers()) {
      viewerSocket.send(removedPayload);
    }
    schedulePrefetch(line, precedingContext);
    return;
  }

  const line = deps.session.buffer.append(english, Date.now(), false);
  const payload = JSON.stringify({ type: 'transcript', id: line.id, english: line.english });
  captureSocket.send(payload);
  deps.session.broadcastToReview(payload);

  const activeLanguages = deps.session.getActiveLanguages();
  const workPromise = translateWithFallback(deps, english, activeLanguages, precedingContext);
  enqueuePublish(line, workPromise);
}
```

Finally, broadcast `status` and `cost` to review sockets from `handleCaptureConnection` (Task 3's version). In the `'start'` branch, replace:

```ts
            recordingStartedAt = Date.now();
            ws.send(JSON.stringify({ type: 'status', status: 'recording' }));

            deps.costTracker.resetSession();
            unsubscribeCost = deps.costTracker.onUpdate((sessionUsd, lifetimeUsd) => {
              ws.send(JSON.stringify({ type: 'cost', sessionUsd, lifetimeUsd }));
            });
```

with:

```ts
            recordingStartedAt = Date.now();
            const recordingPayload = JSON.stringify({ type: 'status', status: 'recording' });
            ws.send(recordingPayload);
            deps.session.broadcastToReview(recordingPayload);

            deps.costTracker.resetSession();
            unsubscribeCost = deps.costTracker.onUpdate((sessionUsd, lifetimeUsd) => {
              const costPayload = JSON.stringify({ type: 'cost', sessionUsd, lifetimeUsd });
              ws.send(costPayload);
              deps.session.broadcastToReview(costPayload);
            });
```

In the `'stop'` branch, replace `ws.send(JSON.stringify({ type: 'status', status: 'idle' }));` with:

```ts
            const idlePayload = JSON.stringify({ type: 'status', status: 'idle' });
            ws.send(idlePayload);
            deps.session.broadcastToReview(idlePayload);
```

And in the Deepgram `onError` callback, replace `ws.send(JSON.stringify({ type: 'status', status: 'error' }));` with:

```ts
              onError: () => {
                const errorPayload = JSON.stringify({ type: 'status', status: 'error' });
                ws.send(errorPayload);
                deps.session.broadcastToReview(errorPayload);
              },
```

- [x] **Step 4: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS — all pre-existing tests plus the new `review connection` describe block.

- [x] **Step 5: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "Add /ws/review endpoint: backlog snapshot, command handoff, live broadcast"
```

---

### Task 5: Passcode-gate `/capture`, `/review`, and their REST/WS surfaces

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/wsServer.ts`
- Modify: `server/src/index.ts`
- Test: `server/tests/app.test.ts`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Produces: `WsServerDeps.adminPasscode: string | undefined`; `/ws/capture` and `/ws/review` upgrades require a matching `?passcode=` query param; `GET/PUT /feedback`, `GET /viewer-feedback`, `POST /viewer-feedback/:id/download`, `POST /viewer-feedback/download-all`, `POST /sermon-doc` now require `x-admin-passcode`. `POST /viewer-feedback` (public flag submission) stays open.

- [x] **Step 1: Write the failing REST tests**

In `server/tests/app.test.ts`, add (near the top, after the imports) a variant of `testDeps` that omits the passcode isn't needed — `testDeps()` already sets `adminPasscode: 'test-passcode'`. Add these tests inside (or right after) the existing `describe('GET/PUT /feedback', ...)` block:

```ts

  it('returns 401 without the passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/feedback');
    expect(response.status).toBe(401);
  });

  it('succeeds with the correct passcode header', async () => {
    const response = await request(createApp(testDeps()))
      .get('/feedback')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
  });
```

Add a new `describe` block after the existing `POST /viewer-feedback` tests:

```ts

describe('gated review routes', () => {
  it('POST /viewer-feedback stays open (used by the public /view page)', async () => {
    const response = await request(createApp(testDeps()))
      .post('/viewer-feedback')
      .send({ language: 'es', lineIndex: 0, english: 'Hi', translated: 'Hola' });
    expect(response.status).toBe(200);
  });

  it('GET /viewer-feedback requires the passcode', async () => {
    const response = await request(createApp(testDeps())).get('/viewer-feedback');
    expect(response.status).toBe(401);
  });

  it('GET /viewer-feedback succeeds with the passcode', async () => {
    const response = await request(createApp(testDeps()))
      .get('/viewer-feedback')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
  });

  it('POST /sermon-doc requires the passcode', async () => {
    const response = await request(createApp(testDeps()))
      .post('/sermon-doc')
      .attach('file', Buffer.from('fake pdf bytes'), { filename: 'sermon.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(401);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: FAIL — the newly-gated routes currently return 200 without a passcode.

- [x] **Step 3: Apply `adminAuth` to the review-only REST routes**

In `server/src/app.ts`, change the `/sermon-doc`, `/feedback`, and `/viewer-feedback` route declarations (leave `POST /viewer-feedback` alone):

```ts
  app.post('/sermon-doc', adminAuth, upload.single('file'), async (req, res) => {
```

```ts
  app.get('/feedback', adminAuth, async (_req, res) => {
```

```ts
  app.put('/feedback', adminAuth, async (req, res) => {
```

```ts
  app.get('/viewer-feedback', adminAuth, (_req, res) => {
```

```ts
  app.post('/viewer-feedback/:id/download', adminAuth, (req, res) => {
```

```ts
  app.post('/viewer-feedback/download-all', adminAuth, (_req, res) => {
```

`app.post('/viewer-feedback', ...)` (no `.../:id/...`, no `/download-all`) is left exactly as-is — it stays unauthenticated.

- [x] **Step 4: Run the REST tests to verify they pass**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: PASS.

- [x] **Step 5: Write the failing WS passcode tests**

Add to `server/tests/wsServer.test.ts`, inside `describe('wsServer', ...)`. First, update the `attachWsServer` call in `beforeEach` to pass `adminPasscode: 'test-passcode'`:

```ts
    attachWsServer({
      httpServer,
      session,
      geminiClient,
      llmClients: { gemini: geminiClient, openRouter: null },
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
      translationFlagDisplayStore,
      adminPasscode: 'test-passcode',
    });
```

Then add a new describe block for the passcode check, right after the `review connection` block added in Task 4:

```ts

  describe('capture/review passcode gate', () => {
    function waitForCloseOrError(ws: WebSocket): Promise<void> {
      return new Promise((resolve) => {
        ws.once('close', () => resolve());
        ws.once('error', () => resolve());
      });
    }

    it('destroys a /ws/capture upgrade with no passcode', async () => {
      const socket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForCloseOrError(socket);
    });

    it('destroys a /ws/capture upgrade with the wrong passcode', async () => {
      const socket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=wrong`);
      await waitForCloseOrError(socket);
    });

    it('destroys a /ws/review upgrade with no passcode', async () => {
      const socket = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForCloseOrError(socket);
    });

    it('does not require a passcode for /ws/viewer', async () => {
      const socket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(socket);
      socket.close();
    });
  });
```

- [x] **Step 6: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/wsServer.test.ts -t "passcode gate"`
Expected: FAIL — `/ws/capture` and `/ws/review` currently accept any connection regardless of query params, so the sockets open instead of closing/erroring.

Note this will also make every *other* existing test in the file fail once the passcode check is added in Step 7, since none of them include `?passcode=test-passcode` yet — that's expected and fixed in Step 8.

- [x] **Step 7: Add the passcode check to the WS upgrade handler**

Add `adminPasscode: string | undefined;` to the `WsServerDeps` interface in `server/src/wsServer.ts`:

```ts
export interface WsServerDeps {
  httpServer: HttpServer;
  session: Session;
  geminiClient: GeminiClient;
  llmClients: LlmClients;
  deepgramApiKey: string;
  createDeepgramConnection: DeepgramConnectionFactory;
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
  costTracker: CostTracker;
  modelConfigStore: ModelConfigStore;
  promptConfigStore: PromptConfigStore;
  translationFlagDisplayStore: TranslationFlagDisplayStore;
  adminPasscode: string | undefined;
}
```

Replace the `upgrade` handler in `attachWsServer`:

```ts
  deps.httpServer.on('upgrade', (request, socket, head) => {
    const { pathname, searchParams } = new URL(request.url ?? '', 'http://localhost');
    if (pathname !== '/ws/capture' && pathname !== '/ws/viewer' && pathname !== '/ws/review') {
      socket.destroy();
      return;
    }
    if (pathname === '/ws/capture' || pathname === '/ws/review') {
      const providedPasscode = searchParams.get('passcode');
      if (!deps.adminPasscode || providedPasscode !== deps.adminPasscode) {
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, pathname);
    });
  });
```

- [x] **Step 8: Append `?passcode=test-passcode` to every existing `/ws/capture` and `/ws/review` test connection**

Run these two commands to mechanically update every existing test connection in the file (there are ~60 `/ws/capture` occurrences and the handful of `/ws/review` ones added in Task 4; `/ws/viewer` occurrences must NOT be touched):

```bash
cd server
sed -i 's|ws://localhost:${port}/ws/capture`|ws://localhost:${port}/ws/capture?passcode=test-passcode`|g' tests/wsServer.test.ts
sed -i 's|ws://localhost:${port}/ws/review`|ws://localhost:${port}/ws/review?passcode=test-passcode`|g' tests/wsServer.test.ts
```

This will also rewrite the two `capture/review passcode gate` tests that deliberately connect *without* the correct passcode (`no passcode`, `wrong passcode`) — after the sed runs, re-check those three specific lines and revert them by hand so they still test the failure paths:

```ts
    it('destroys a /ws/capture upgrade with no passcode', async () => {
      const socket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForCloseOrError(socket);
    });

    it('destroys a /ws/capture upgrade with the wrong passcode', async () => {
      const socket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=wrong`);
      await waitForCloseOrError(socket);
    });

    it('destroys a /ws/review upgrade with no passcode', async () => {
      const socket = new WebSocket(`ws://localhost:${port}/ws/review`);
      await waitForCloseOrError(socket);
    });
```

Verify the sed left `/ws/viewer` connections untouched:

Run: `cd server && grep -c "ws/viewer\`" tests/wsServer.test.ts`
Expected: `42` (unchanged from before this task).

- [x] **Step 9: Wire `adminPasscode` through `index.ts`**

In `server/src/index.ts`, add `adminPasscode: process.env.ADMIN_PASSCODE,` to the `attachWsServer({...})` call:

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
  adminPasscode: process.env.ADMIN_PASSCODE,
});
```

- [x] **Step 10: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS — every test in `wsServer.test.ts` and `app.test.ts`, including the new passcode-gate tests.

- [x] **Step 11: Commit**

```bash
git add server/src/app.ts server/src/wsServer.ts server/src/index.ts server/tests/app.test.ts server/tests/wsServer.test.ts
git commit -m "Passcode-gate capture/review REST routes and WebSocket upgrades"
```

---

### Task 6: Rebuild `/capture` as a mic-only, passcode-gated page

**Files:**
- Modify: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: `/ws/capture?passcode=...` (`status`, `transcript` messages in; `start`/`stop`/audio-binary out), `GET /feedback` with `x-admin-passcode` header (used only as a passcode-check probe, matching the admin page's own pattern).

- [x] **Step 1: Replace the page**

Replace `web/app/capture/page.tsx` in full:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Lock } from 'lucide-react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type CaptureStatus = 'idle' | 'recording' | 'reconnecting' | 'error';

type TranscriptLine = {
  id: string;
  text: string;
  flagged: boolean;
};

function StatusBadge({ status }: { status: CaptureStatus }) {
  if (status === 'recording') {
    return (
      <Badge className="gap-1.5">
        <span className="size-2 animate-pulse rounded-full bg-primary-foreground" />
        Recording
      </Badge>
    );
  }
  if (status === 'reconnecting') {
    return <Badge variant="secondary">Reconnecting…</Badge>;
  }
  if (status === 'error') {
    return <Badge variant="destructive">Error</Badge>;
  }
  return <Badge variant="secondary">Idle</Badge>;
}

export default function CapturePage() {
  const [passcode, setPasscode] = useState('');
  const [enteredPasscode, setEnteredPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);

  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const manuallyStoppedRef = useRef(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);

  useEffect(() => {
    const stored = window.sessionStorage.getItem('adminPasscode');
    if (stored) {
      setPasscode(stored);
      setAuthorized(true);
    }
  }, []);

  async function submitPasscode() {
    setCheckingAuth(true);
    setAuthError(null);
    try {
      const response = await fetch(`${API_URL}/feedback`, {
        headers: { 'x-admin-passcode': enteredPasscode },
      });
      if (response.status === 401) {
        setAuthError('Incorrect passcode.');
        return;
      }
      window.sessionStorage.setItem('adminPasscode', enteredPasscode);
      setPasscode(enteredPasscode);
      setAuthorized(true);
    } catch {
      setAuthError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCheckingAuth(false);
    }
  }

  useEffect(() => {
    const container = transcriptRef.current;
    if (container && isFollowing) container.scrollTop = container.scrollHeight;
  }, [transcriptLines, isFollowing]);

  function onTranscriptScroll() {
    const container = transcriptRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setIsFollowing(distanceFromBottom < 24);
  }

  function jumpToLatest() {
    const container = transcriptRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    setIsFollowing(true);
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
    const socket = new WebSocket(`${WS_URL}/ws/capture?passcode=${encodeURIComponent(passcode)}`);
    socketRef.current = socket;

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
          };
          if (index === -1) return [...previous.slice(-49), updated];
          const next = [...previous];
          next[index] = updated;
          return next;
        });
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
    setTranscriptLines([]);
    setIsFollowing(true);
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
  }

  if (!authorized) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Capture access</CardTitle>
            <CardDescription>Enter the passcode to continue.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="relative">
              <Lock className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                value={enteredPasscode}
                onChange={(event) => setEnteredPasscode(event.target.value)}
                placeholder="Passcode"
                className="pl-8"
                disabled={checkingAuth}
              />
            </div>
            <Button onClick={submitPasscode} disabled={checkingAuth || enteredPasscode.length === 0}>
              {checkingAuth ? 'Checking…' : 'Enter'}
            </Button>
            {authError && (
              <Alert variant="destructive">
                <AlertDescription>{authError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-3 border-b bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Sermon Capture</h1>
            <StatusBadge status={status} />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={start} disabled={status === 'recording' || status === 'reconnecting'}>
              Start
            </Button>
            <Button variant="secondary" onClick={stop} disabled={status === 'idle'}>
              Stop
            </Button>
          </div>
        </div>
        {errorMessage && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="relative flex-1 p-4">
        {!isFollowing && (
          <Button onClick={jumpToLatest} size="sm" className="absolute right-6 top-6 z-10 shadow">
            Jump to latest
          </Button>
        )}
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className="h-full w-full overflow-y-auto rounded-md border p-3 text-sm space-y-2"
        >
          {transcriptLines.map((line) => (
            <p key={line.id} className={line.flagged ? 'text-destructive line-through' : undefined}>
              {line.text}
            </p>
          ))}
        </div>
      </div>
    </main>
  );
}
```

- [x] **Step 2: Build to verify**

Run: `cd web && npm run build`
Expected: builds and type-checks with no errors.

- [ ] **Step 3: Manual check**

Run `npm run dev` (web) plus the server per `README.md`. Open `http://localhost:3000/capture`. Confirm: the passcode card appears first and rejects a wrong passcode with an inline error; entering the correct passcode unlocks the page and persists across a refresh (same tab); Start/Stop and the status badge (Idle/Recording/Reconnecting/Error) work; the read-only transcript fills in as segments arrive and flagged lines show struck-through with no Remove/Reinstate controls; there is no cost line, sermon-doc upload, mode toggle, or tabs on this page.

- [x] **Step 4: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "Reduce capture page to mic-only controls behind a passcode gate"
```

---

### Task 7: Build `/review` — Live tab

**Files:**
- Create: `web/app/review/page.tsx`

**Interfaces:**
- Consumes: `/ws/review?passcode=...` (`backlog`, `status`, `mode`, `transcript`, `cost`, `reinstate-error`, `admin-remove-error` in; `reinstate`/`admin-remove`/`set-mode` out).
- Produces: the `/review` route, sharing the `adminPasscode` `sessionStorage` key with `/admin` and `/capture`.

- [x] **Step 1: Create the page with the Live tab only (Feedback notes/Viewer feedback tabs are placeholders here, filled in by Task 8)**

Create `web/app/review/page.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Lock } from 'lucide-react';
import { useStoredValue } from '@/lib/useStoredValue';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type SessionStatus = 'idle' | 'recording' | 'reconnecting' | 'error';

type TranscriptLine = {
  id: string;
  text: string;
  flagged: boolean;
  reason?: string;
  pending?: boolean;
  dismissed?: boolean;
  reinstateState?: 'editing' | 'pending' | 'error';
  editedText?: string;
  reinstateError?: string;
  removeState?: 'pending' | 'error';
  removeError?: string;
};

function StatusBadge({ status }: { status: SessionStatus }) {
  if (status === 'recording') {
    return (
      <Badge className="gap-1.5">
        <span className="size-2 animate-pulse rounded-full bg-primary-foreground" />
        Recording
      </Badge>
    );
  }
  if (status === 'reconnecting') {
    return <Badge variant="secondary">Reconnecting…</Badge>;
  }
  if (status === 'error') {
    return <Badge variant="destructive">Error</Badge>;
  }
  return <Badge variant="secondary">Idle</Badge>;
}

export default function ReviewPage() {
  const [passcode, setPasscode] = useState('');
  const [enteredPasscode, setEnteredPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);

  const [status, setStatus] = useState<SessionStatus>('idle');
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [sessionCostUsd, setSessionCostUsd] = useState(0);
  const [lifetimeCostUsd, setLifetimeCostUsd] = useState(0);
  const [hasUploadedDoc, setHasUploadedDoc] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);

  const [mode, setModeState] = useState<'automatic' | 'manual'>('automatic');

  function setMode(newMode: 'automatic' | 'manual') {
    setModeState(newMode);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'set-mode', mode: newMode }));
    }
  }

  const pendingQueue = transcriptLines.filter((line) => line.pending && !line.dismissed);

  const storedApproveKey = useStoredValue('captureApproveKey');
  const storedRejectKey = useStoredValue('captureRejectKey');
  const [approveKeyOverride, setApproveKeyOverride] = useState<string | null>(null);
  const [rejectKeyOverride, setRejectKeyOverride] = useState<string | null>(null);
  const approveKey = approveKeyOverride ?? storedApproveKey ?? 'Enter';
  const rejectKey = rejectKeyOverride ?? storedRejectKey ?? ' ';
  const [rebindingAction, setRebindingAction] = useState<'approve' | 'reject' | null>(null);
  const [rebindError, setRebindError] = useState<string | null>(null);

  function displayKey(key: string): string {
    return key === ' ' ? 'Space' : key;
  }

  useEffect(() => {
    const stored = window.sessionStorage.getItem('adminPasscode');
    if (stored) {
      setPasscode(stored);
      setAuthorized(true);
    }
  }, []);

  async function submitPasscode() {
    setCheckingAuth(true);
    setAuthError(null);
    try {
      const response = await fetch(`${API_URL}/feedback`, {
        headers: { 'x-admin-passcode': enteredPasscode },
      });
      if (response.status === 401) {
        setAuthError('Incorrect passcode.');
        return;
      }
      window.sessionStorage.setItem('adminPasscode', enteredPasscode);
      setPasscode(enteredPasscode);
      setAuthorized(true);
    } catch {
      setAuthError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCheckingAuth(false);
    }
  }

  useEffect(() => {
    if (!rebindingAction) return;
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      const key = event.key;
      const otherKey = rebindingAction === 'approve' ? rejectKey : approveKey;
      if (key === otherKey) {
        setRebindError("Approve and Reject can't share a key.");
        return;
      }
      if (rebindingAction === 'approve') {
        setApproveKeyOverride(key);
        window.localStorage.setItem('captureApproveKey', key);
      } else {
        setRejectKeyOverride(key);
        window.localStorage.setItem('captureRejectKey', key);
      }
      setRebindError(null);
      setRebindingAction(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rebindingAction, approveKey, rejectKey]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (mode !== 'manual') return;
      if (rebindingAction) return;
      const target = event.target as HTMLElement | null;
      const isEditable = Boolean(
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      );
      if (isEditable) return;
      const oldest = pendingQueue[0];
      if (!oldest) return;
      if (event.key === approveKey) {
        event.preventDefault();
        sendReinstate(oldest.id);
      } else if (event.key === rejectKey) {
        event.preventDefault();
        rejectLine(oldest.id);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingQueue, approveKey, rejectKey, rebindingAction, mode]);

  useEffect(() => {
    if (!authorized) return;
    connectSocket();
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      socketRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized]);

  useEffect(() => {
    const container = transcriptRef.current;
    if (container && isFollowing) container.scrollTop = container.scrollHeight;
  }, [transcriptLines, isFollowing]);

  function onTranscriptScroll() {
    const container = transcriptRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setIsFollowing(distanceFromBottom < 24);
  }

  function jumpToLatest() {
    const container = transcriptRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    setIsFollowing(true);
  }

  async function uploadSermonDoc(file: File) {
    setIsUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_URL}/sermon-doc`, {
        method: 'POST',
        headers: { 'x-admin-passcode': passcode },
        body: formData,
      });
      if (!response.ok) {
        let message = `Upload failed (status ${response.status})`;
        try {
          const data = await response.json();
          message = data.error ?? message;
        } catch {
          // Non-JSON error body; fall back to the status-code-based message.
        }
        setUploadError(message);
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

  function connectSocket() {
    const socket = new WebSocket(`${WS_URL}/ws/review?passcode=${encodeURIComponent(passcode)}`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'backlog') {
        setStatus(message.status);
        setModeState(message.mode);
        setTranscriptLines(
          (message.lines as Array<{ id: string; english: string; flagged?: boolean; reason?: string; pending?: boolean }>).map(
            (line) => ({
              id: line.id,
              text: line.english,
              flagged: Boolean(line.flagged),
              reason: line.reason,
              pending: Boolean(line.pending),
            })
          )
        );
      } else if (message.type === 'status') {
        setStatus(message.status);
      } else if (message.type === 'mode') {
        setModeState(message.mode);
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => {
          const index = previous.findIndex((line) => line.id === message.id);
          const updated: TranscriptLine = {
            id: message.id,
            text: message.english,
            flagged: Boolean(message.flagged),
            reason: message.reason,
            pending: Boolean(message.pending),
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
      } else if (message.type === 'admin-remove-error') {
        setTranscriptLines((previous) =>
          previous.map((line) =>
            line.id === message.id ? { ...line, removeState: 'error', removeError: message.error } : line
          )
        );
      } else if (message.type === 'cost') {
        setSessionCostUsd(message.sessionUsd);
        setLifetimeCostUsd(message.lifetimeUsd);
      }
    };

    socket.onclose = () => {
      reconnectTimeoutRef.current = setTimeout(connectSocket, 2000);
    };
  }

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
    if (status !== 'recording') return;
    const line = transcriptLines.find((entry) => entry.id === id);
    if (!line) return;
    const editedText = (line.editedText ?? line.text).trim();
    if (editedText.length === 0) return;
    if (!line.pending) {
      const confirmed = window.confirm(`Flagged: "${line.reason ?? 'no reason given'}". Send this line to viewers?`);
      if (!confirmed) return;
    }
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, reinstateState: 'pending' } : entry))
    );
    socketRef.current?.send(JSON.stringify({ type: 'reinstate', id, english: editedText }));
  }

  function sendAdminRemove(id: string) {
    if (status !== 'recording') return;
    const confirmed = window.confirm('Remove this line? It can be reinstated afterward.');
    if (!confirmed) return;
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, removeState: 'pending' } : entry))
    );
    socketRef.current?.send(JSON.stringify({ type: 'admin-remove', id }));
  }

  function rejectLine(id: string) {
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, dismissed: true } : entry))
    );
  }

  if (!authorized) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Review access</CardTitle>
            <CardDescription>Enter the passcode to continue.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="relative">
              <Lock className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                value={enteredPasscode}
                onChange={(event) => setEnteredPasscode(event.target.value)}
                placeholder="Passcode"
                className="pl-8"
                disabled={checkingAuth}
              />
            </div>
            <Button onClick={submitPasscode} disabled={checkingAuth || enteredPasscode.length === 0}>
              {checkingAuth ? 'Checking…' : 'Enter'}
            </Button>
            {authError && (
              <Alert variant="destructive">
                <AlertDescription>{authError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-3 border-b bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Sermon Review</h1>
            <StatusBadge status={status} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span>
            Session: ${sessionCostUsd.toFixed(4)} · Lifetime: ${lifetimeCostUsd.toFixed(2)}
          </span>
          <div className="flex items-center gap-2">
            <label htmlFor="sermon-doc" className="flex items-center font-medium text-foreground bg-muted px-3 h-8 rounded-md text-sm text-center">
              Sermon document (optional, PDF or Word)
            </label>
            <input
              id="sermon-doc"
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx"
              onChange={onFileSelected}
              disabled={isUploading}
              className="text-xs"
            />
            {isUploading && <span>Uploading…</span>}
            {hasUploadedDoc && !isUploading && <span className="text-green-500">Document loaded.</span>}
            {uploadError && <span className="text-destructive">{uploadError}</span>}
          </div>
        </div>
      </div>

      <Tabs defaultValue="live" className="flex-1 p-4">
        <TabsList>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="notes">Feedback notes</TabsTrigger>
          <TabsTrigger value="viewer-feedback">Viewer feedback</TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              value={[mode]}
              onValueChange={(values) => {
                const newMode = values[0];
                if (newMode) setMode(newMode as 'automatic' | 'manual');
              }}
            >
              <ToggleGroupItem value="automatic">Automatic</ToggleGroupItem>
              <ToggleGroupItem value="manual">Manual</ToggleGroupItem>
            </ToggleGroup>
            {mode === 'manual' && (
              <span className="text-sm text-muted-foreground">{pendingQueue.length} pending</span>
            )}
            {mode === 'manual' && (
              <Popover>
                <PopoverTrigger render={<Button variant="ghost" size="sm">Shortcuts</Button>} />
                <PopoverContent className="w-72">
                  <div className="flex flex-col gap-2 text-sm">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setRebindError(null);
                        setRebindingAction('approve');
                      }}
                    >
                      Approve: {rebindingAction === 'approve' ? 'press a key…' : displayKey(approveKey)}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setRebindError(null);
                        setRebindingAction('reject');
                      }}
                    >
                      Reject: {rebindingAction === 'reject' ? 'press a key…' : displayKey(rejectKey)}
                    </Button>
                    {rebindError && <p className="text-xs text-destructive">{rebindError}</p>}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>

          {mode === 'manual' && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Pending approval ({pendingQueue.length})</p>
              {pendingQueue.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing waiting.</p>
              ) : (
                <ScrollArea className="h-64 rounded-md border">
                  <div className="divide-y">
                    {pendingQueue.map((line, index) => (
                      <div key={line.id} className={`p-2 flex flex-col gap-1 ${index === 0 ? 'bg-accent/30' : ''}`}>
                        <p className="text-sm">{line.text}</p>
                        {line.reason && <p className="text-xs text-muted-foreground">{line.reason}</p>}
                        {line.reinstateState === 'editing' && status === 'recording' ? (
                          <div className="flex flex-col gap-1">
                            <Textarea
                              value={line.editedText ?? line.text}
                              onChange={(event) => updateEditedText(line.id, event.target.value)}
                              rows={2}
                              className="text-xs"
                            />
                            <div className="flex items-center gap-2">
                              <Button
                                size="xs"
                                onClick={() => sendReinstate(line.id)}
                                disabled={(line.editedText ?? line.text).trim().length === 0}
                              >
                                Send
                              </Button>
                              <Button size="xs" variant="ghost" onClick={() => cancelEditing(line.id)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Button
                              size="xs"
                              onClick={() => sendReinstate(line.id)}
                              disabled={status !== 'recording' || line.reinstateState === 'pending'}
                            >
                              {index === 0 ? `Approve (${displayKey(approveKey)})` : 'Approve'}
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => beginEditing(line.id, line.text)}
                              disabled={status !== 'recording' || line.reinstateState === 'pending'}
                            >
                              Edit
                            </Button>
                            <Button size="xs" variant="destructive" onClick={() => rejectLine(line.id)}>
                              {index === 0 ? `Reject (${displayKey(rejectKey)})` : 'Reject'}
                            </Button>
                          </div>
                        )}
                        {line.reinstateState === 'error' && (
                          <p className="text-xs text-destructive">
                            Couldn&apos;t approve ({line.reinstateError}) — try again.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          )}

          <div className="relative">
            {!isFollowing && (
              <Button onClick={jumpToLatest} size="sm" className="absolute bottom-2 right-2 z-10 shadow">
                Jump to latest
              </Button>
            )}
            <div
              ref={transcriptRef}
              onScroll={onTranscriptScroll}
              className="h-64 w-full overflow-y-auto rounded-md border p-3 text-sm space-y-2"
            >
              {transcriptLines.map((line) => (
                <div key={line.id} className="group">
                  <div className="flex items-start justify-between gap-2 hover:bg-accent/30 rounded-md">
                    <p className={line.flagged ? 'text-destructive line-through' : undefined}>{line.text}</p>
                    {!line.flagged && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => sendAdminRemove(line.id)}
                        disabled={status !== 'recording' || line.removeState === 'pending'}
                        className="text-destructive opacity-0 group-hover:opacity-100"
                      >
                        {line.removeState === 'pending' ? 'Removing…' : 'Remove'}
                      </Button>
                    )}
                  </div>
                  {line.flagged && line.reinstateState !== 'editing' && (
                    <div className="flex items-center gap-2 text-xs">
                      {line.reason && <span className="text-muted-foreground">Flagged: {line.reason}</span>}
                      <Button
                        variant="link"
                        size="xs"
                        onClick={() => beginEditing(line.id, line.text)}
                        disabled={status !== 'recording' || line.reinstateState === 'pending'}
                      >
                        {line.reinstateState === 'pending' ? 'Reinstating…' : 'Reinstate'}
                      </Button>
                    </div>
                  )}
                  {line.flagged && line.reinstateState === 'editing' && status === 'recording' && (
                    <div className="mt-1 flex flex-col gap-1">
                      <Textarea
                        value={line.editedText ?? line.text}
                        onChange={(event) => updateEditedText(line.id, event.target.value)}
                        rows={2}
                        className="text-xs"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="xs"
                          onClick={() => sendReinstate(line.id)}
                          disabled={(line.editedText ?? line.text).trim().length === 0}
                        >
                          Send
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => cancelEditing(line.id)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {line.reinstateState === 'error' && (
                    <p className="text-xs text-destructive">
                      Couldn&apos;t reinstate ({line.reinstateError}) — try again.
                    </p>
                  )}
                  {line.removeState === 'error' && (
                    <p className="text-xs text-destructive">Couldn&apos;t remove ({line.removeError}) — try again.</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="notes" className="flex max-w-2xl flex-col gap-2">
          <p className="text-sm text-muted-foreground">Filled in by the next task.</p>
        </TabsContent>

        <TabsContent value="viewer-feedback" className="flex max-w-2xl flex-col gap-2">
          <p className="text-sm text-muted-foreground">Filled in by the next task.</p>
        </TabsContent>
      </Tabs>
    </main>
  );
}
```

- [x] **Step 2: Build to verify**

Run: `cd web && npm run build`
Expected: builds and type-checks with no errors.

- [ ] **Step 3: Manual check**

Run `npm run dev` (web) plus the server. With `/capture` open and recording in one tab, open `http://localhost:3000/review` in a second tab (and a third, to check multi-reviewer behavior). Confirm: the passcode gate works and shares the `adminPasscode` session-storage key with `/capture`/`/admin`; the status badge reflects the capture tab's recording state; toggling Automatic/Manual mode in one review tab updates the badge/queue in the other; approving a pending line in one tab makes it disappear from the queue in the other; the shortcut keys and rebinding popover work; the sermon-doc upload control and cost line are present and functional.

- [x] **Step 4: Commit**

```bash
git add web/app/review/page.tsx
git commit -m "Add review page: passcode gate, live transcript checking, mode/queue/shortcuts"
```

---

### Task 8: Review page — Feedback notes and Viewer feedback tabs

**Files:**
- Modify: `web/app/review/page.tsx`

**Interfaces:**
- Consumes: `GET/PUT /feedback`, `GET /viewer-feedback`, `POST /viewer-feedback/:id/download`, `POST /viewer-feedback/download-all` — all with `x-admin-passcode: passcode` header.

- [x] **Step 1: Add the feedback-notes and viewer-feedback state, effects, and handlers**

In `web/app/review/page.tsx`, add these imports:

```tsx
import { toast } from 'sonner';
```

Add these two state declarations near the other `useState` calls (after `uploadError`):

```tsx
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSaveStatus, setFeedbackSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [viewerFeedback, setViewerFeedback] = useState<ViewerFeedbackItem[]>([]);
```

Add the `ViewerFeedbackItem` type near `TranscriptLine`:

```tsx
interface ViewerFeedbackItem {
  id: string;
  sessionId: string;
  timestamp: string;
  language: string;
  lineIndex: number;
  english: string;
  translated: string;
  comment: string;
  downloaded: boolean;
}
```

Add `undownloadedFeedbackCount` next to `pendingQueue`:

```tsx
  const undownloadedFeedbackCount = viewerFeedback.filter((item) => !item.downloaded).length;
```

Add these two effects right after the `connectSocket` effect (the one keyed on `[authorized]`):

```tsx
  useEffect(() => {
    if (!authorized) return;
    fetch(`${API_URL}/feedback`, { headers: { 'x-admin-passcode': passcode } })
      .then((response) => response.json())
      .then((data) => setFeedbackText(data.text ?? ''))
      .catch(() => setFeedbackText(''));
  }, [authorized, passcode]);

  useEffect(() => {
    if (!authorized) return;
    void fetchViewerFeedback();
  }, [authorized, passcode]);
```

Add these handler functions right after `uploadSermonDoc`/`onFileSelected`:

```tsx
  async function fetchViewerFeedback() {
    try {
      const response = await fetch(`${API_URL}/viewer-feedback`, { headers: { 'x-admin-passcode': passcode } });
      const data = await response.json();
      setViewerFeedback(Array.isArray(data.items) ? data.items : []);
    } catch {
      setViewerFeedback([]);
    }
  }

  async function saveFeedback() {
    if (feedbackText.trim().length === 0) {
      const confirmed = window.confirm('Clear all feedback notes?');
      if (!confirmed) return;
    }
    setFeedbackSaveStatus('saving');
    try {
      const response = await fetch(`${API_URL}/feedback`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify({ text: feedbackText }),
      });
      if (!response.ok) {
        toast.error(`Save failed (status ${response.status}). Check your connection and try again.`);
        setFeedbackSaveStatus('idle');
        return;
      }
      setFeedbackSaveStatus('saved');
      toast.success('Feedback notes saved.');
    } catch {
      toast.error('Save failed. Check your connection and try again.');
      setFeedbackSaveStatus('idle');
    }
  }

  async function downloadFeedbackCsv(url: string) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'x-admin-passcode': passcode } });
      if (!response.ok) {
        toast.error(`Download failed (status ${response.status}). Check your connection and try again.`);
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : 'feedback.csv';
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
      await fetchViewerFeedback();
    } catch {
      toast.error('Download failed. Check your connection and try again.');
    }
  }

  function downloadFeedbackItem(id: string) {
    void downloadFeedbackCsv(`${API_URL}/viewer-feedback/${id}/download`);
  }

  function downloadAllUndownloadedFeedback() {
    void downloadFeedbackCsv(`${API_URL}/viewer-feedback/download-all`);
  }
```

Replace the `Viewer feedback` `TabsTrigger` (to show the undownloaded-count badge):

```tsx
          <TabsTrigger value="viewer-feedback">
            Viewer feedback
            {undownloadedFeedbackCount > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {undownloadedFeedbackCount}
              </Badge>
            )}
          </TabsTrigger>
```

Replace the two placeholder `TabsContent` blocks at the end of the file:

```tsx
        <TabsContent value="notes" className="flex max-w-2xl flex-col gap-2">
          <label className="text-sm font-medium">Feedback notes (optional)</label>
          <Textarea
            value={feedbackText}
            onChange={(event) => {
              setFeedbackText(event.target.value);
              setFeedbackSaveStatus('idle');
            }}
            rows={10}
            placeholder="Notes about past translation accuracy issues, e.g. names that were missed…"
          />
          <div>
            <Button variant="secondary" onClick={saveFeedback} disabled={feedbackSaveStatus === 'saving'}>
              Save feedback notes
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="viewer-feedback" className="flex max-w-2xl flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium">Viewer feedback</label>
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadAllUndownloadedFeedback}
              disabled={undownloadedFeedbackCount === 0}
            >
              Download all undownloaded ({undownloadedFeedbackCount} new)
            </Button>
          </div>
          {viewerFeedback.length === 0 ? (
            <p className="text-sm text-muted-foreground">No feedback yet.</p>
          ) : (
            <ScrollArea className="h-80 rounded-md border">
              <div className="divide-y">
                {viewerFeedback.map((item) => (
                  <div key={item.id} className="p-2 flex flex-col gap-1 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {new Date(item.timestamp).toLocaleString()} · {item.language}
                        {item.downloaded ? ' · downloaded' : ' · new'}
                      </span>
                      <Button variant="link" size="xs" onClick={() => downloadFeedbackItem(item.id)}>
                        Download
                      </Button>
                    </div>
                    <p className="text-muted-foreground">{item.english}</p>
                    <p>{item.translated}</p>
                    {item.comment && <p className="italic">&quot;{item.comment}&quot;</p>}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </TabsContent>
```

- [x] **Step 2: Build to verify**

Run: `cd web && npm run build`
Expected: builds and type-checks with no errors.

- [ ] **Step 3: Manual check**

With the server and `/review` running: type into Feedback notes and Save — confirm a success toast and that the text reloads correctly after a page refresh. Have `/view` (the public viewer page) submit a flagged-line comment, then confirm it shows up in `/review`'s Viewer feedback tab with the unread-count badge on the tab trigger, and that per-item download and "download all undownloaded" both work and clear the badge.

- [x] **Step 4: Commit**

```bash
git add web/app/review/page.tsx
git commit -m "Add Feedback notes and Viewer feedback tabs to the review page"
```

---

### Task 9: End-to-end verification

**Files:** none (verification only).

- [x] **Step 1: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS, all suites.

- [x] **Step 2: Run the web build and lint**

Run: `cd web && npm run build && npm run lint`
Expected: both succeed with no errors.

- [ ] **Step 3: Multi-computer-equivalent manual pass**

With the server running and reachable at `NEXT_PUBLIC_WS_URL` (localhost is fine for this check — the point being verified is protocol correctness, not physical machines), open three browser windows: `/capture`, `/review` (window A), `/review` (window B). All three should share the passcode once entered in any one of them (same browser session storage).

- Start capture in `/capture`. Confirm both review windows show "Recording" and the same transcript lines arrive in all three.
- Switch to Manual mode from review window A; confirm review window B's mode toggle and pending queue appear immediately.
- Approve a pending line from window A; confirm it disappears from window B's queue at the same time, and the capture tab's read-only transcript updates too.
- Refresh review window B mid-session; confirm the pending queue, full transcript, current mode, and status badge all reappear correctly (not blank) from the backlog snapshot.
- Remove/reinstate a line and confirm the capture tab and both review tabs stay in sync.
- Upload a sermon doc and save feedback notes from review window A; confirm success toasts and that a refresh of window B shows the saved notes.
- Stop capture; confirm both review windows' status badges drop to Idle and the cost line stops updating.

- [ ] **Step 4: Confirm no stray console errors**

Check the browser console in all three windows for uncaught errors during the above pass (WebSocket reconnect/close handling in particular).

No commit for this task — it's a verification pass. If any issue surfaces, fix it as part of whichever earlier task owns the broken code, and re-run the relevant task's tests before continuing.
