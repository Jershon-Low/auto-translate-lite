import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachWsServer } from '../src/wsServer';
import { Session } from '../src/session';
import type { GeminiClient } from '../src/gemini';
import type { DeepgramCallbacks } from '../src/deepgram';
import { createSermonDocStore } from '../src/sermonDocStore';
import type { SermonDocStore } from '../src/sermonDocStore';
import type { FeedbackStore } from '../src/feedbackStore';
import type { CostTracker } from '../src/costTracker';
import { DEFAULT_MODEL_CONFIG, type ModelConfigStore } from '../src/modelConfigStore';
import { DEFAULT_PROMPT_CONFIG, type PromptConfigStore } from '../src/promptConfigStore';
import {
  DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG,
  type TranslationFlagDisplayStore,
} from '../src/translationFlagDisplayStore';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LOG_FILE_PATH = join(tmpdir(), 'auto-translate-lite-test-events.log');

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

function fakeFeedbackStore(text = ''): FeedbackStore {
  return { read: vi.fn().mockResolvedValue(text), write: vi.fn().mockResolvedValue(undefined) };
}

// Gemini rejects context caches under 1024 tokens (~4.5 chars/token for this
// app's prose, see sermonCache.ts). Fixed rules + notes alone fall well
// short of that, so most of these tests — which are about wiring session
// caches through wsServer, not about the size threshold itself — need a
// stand-in for "a real church uploaded sermon material" to get a cache
// created at all. The threshold behavior itself is covered in
// sermonCache.test.ts.
const CACHE_PADDING = 'Today we talk about faith and hope in difficult times. '.repeat(100);

function fakeCostTracker(): CostTracker & { listeners: Set<(sessionUsd: number, lifetimeUsd: number) => void> } {
  let sessionUsd = 0;
  let lifetimeUsd = 0;
  const listeners = new Set<(sessionUsd: number, lifetimeUsd: number) => void>();
  return {
    listeners,
    recordGeminiUsage: vi.fn(),
    recordDeepgramSeconds: vi.fn((seconds: number) => {
      sessionUsd += seconds * 0.001;
      lifetimeUsd += seconds * 0.001;
      for (const listener of listeners) listener(sessionUsd, lifetimeUsd);
    }),
    resetSession: vi.fn(() => {
      sessionUsd = 0;
    }),
    getSessionCostUsd: vi.fn(() => sessionUsd),
    getLifetimeCostUsd: vi.fn(() => lifetimeUsd),
    onUpdate: vi.fn((listener: (sessionUsd: number, lifetimeUsd: number) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
}

function fakeModelConfigStore(): ModelConfigStore {
  return { read: vi.fn().mockResolvedValue(DEFAULT_MODEL_CONFIG), write: vi.fn().mockResolvedValue(undefined) };
}

function fakePromptConfigStore(): PromptConfigStore {
  return { read: vi.fn().mockResolvedValue(DEFAULT_PROMPT_CONFIG), write: vi.fn().mockResolvedValue(undefined) };
}

function fakeTranslationFlagDisplayStore(): TranslationFlagDisplayStore {
  return {
    read: vi.fn().mockResolvedValue(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG),
    write: vi.fn().mockResolvedValue(undefined),
  };
}

function isTranslateCall(call: any): boolean {
  const contents = call[0].contents as string;
  return !contents.includes('safety checker') && !contents.includes('transcription accuracy checker');
}

// Skips 'caption-pending' notices: an informational heads-up broadcast the
// moment a line is ingested (before translation), which most tests here
// aren't asserting on — they want the next substantive message.
function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    function onMessage(data: Buffer) {
      const message = JSON.parse(data.toString());
      if (message.type === 'caption-pending') {
        ws.once('message', onMessage);
        return;
      }
      resolve(message);
    }
    ws.once('message', onMessage);
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once('open', () => resolve()));
}

describe('wsServer', () => {
  let httpServer: Server;
  let port: number;
  let session: Session;
  let capturedCallbacks: DeepgramCallbacks | null;
  let geminiClient: GeminiClient;
  let sermonDocStore: SermonDocStore;
  let feedbackStore: FeedbackStore;
  let costTracker: ReturnType<typeof fakeCostTracker>;
  let translationFlagDisplayStore: TranslationFlagDisplayStore;
  let deps: Parameters<typeof attachWsServer>[0];

  beforeEach(async () => {
    session = new Session();
    capturedCallbacks = null;
    httpServer = createServer();

    geminiClient = fakeGeminiClient();
    sermonDocStore = createSermonDocStore();
    feedbackStore = fakeFeedbackStore(CACHE_PADDING);
    costTracker = fakeCostTracker();
    translationFlagDisplayStore = fakeTranslationFlagDisplayStore();

    deps = {
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
      deepgramCostFlushIntervalMs: 5000,
    };
    attachWsServer(deps);

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(() => {
    httpServer.close();
  });

  it('broadcasts a translated caption to a subscribed viewer', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

    expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Hello everyone', translated: '你好' });

    captureSocket.close();
    viewerSocket.close();
  });

  it('includes up to the last 7 preceding lines as translation context', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

  it('sends translated backlog to a viewer joining after segments already arrived', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    session.buffer.append('Earlier line', Date.now());
    (geminiClient.models.generateContent as any).mockResolvedValueOnce({
      text: '{"translations":["较早的一行"]}',
    });

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    const backlogMessage = await waitForMessage(viewerSocket);

    expect(backlogMessage).toEqual({
      type: 'backlog',
      lines: [{ id: expect.any(String), english: 'Earlier line', translated: '较早的一行' }],
    });

    captureSocket.close();
    viewerSocket.close();
  });

  it('survives a malformed non-binary frame instead of crashing the connection', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
    await waitForOpen(captureSocket);

    // Malformed JSON must not throw uncaught inside the message handler.
    captureSocket.send('not valid json {{{');

    // The connection should still be usable afterward.
    captureSocket.send(JSON.stringify({ type: 'start' }));
    const status = await waitForMessage(captureSocket);
    expect(status).toEqual({ type: 'status', status: 'recording' });

    captureSocket.close();
  });

  it('does not fan out a live caption to a viewer until its backlog has been sent', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    session.buffer.append('Earlier line', Date.now());

    let resolveBacklog!: (value: { text: string }) => void;
    const pendingBacklog = new Promise<{ text: string }>((resolve) => {
      resolveBacklog = resolve;
    });
    let notifyBacklogStarted!: () => void;
    const backlogStarted = new Promise<void>((resolve) => {
      notifyBacklogStarted = resolve;
    });
    (geminiClient.models.generateContent as any).mockImplementationOnce(() => {
      notifyBacklogStarted();
      return pendingBacklog;
    });

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);

    const messages: any[] = [];
    viewerSocket.on('message', (data) => messages.push(JSON.parse(data.toString())));

    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    // Wait until the subscribe handler has actually started translating the
    // backlog (i.e. it has already taken its buffer snapshot synchronously),
    // so the ordering below is deterministic rather than tick-count dependent.
    await backlogStarted;

    // A new final segment arrives while the backlog translation is still in flight.
    // The viewer must not be registered yet, so it should receive nothing yet.
    capturedCallbacks!.onFinalSegment('Should not jump the queue');
    await new Promise((resolve) => setImmediate(resolve));
    expect(messages).toEqual([]);

    resolveBacklog({ text: '{"translations":["较早的一行"]}' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(messages).toEqual([
      { type: 'backlog', lines: [{ id: expect.any(String), english: 'Earlier line', translated: '较早的一行' }] },
    ]);

    const captionPromise = waitForMessage(viewerSocket);
    capturedCallbacks!.onFinalSegment('Now the viewer is registered');
    const caption = await captionPromise;
    expect(caption).toEqual({
      type: 'caption',
      id: expect.any(String),
      english: 'Now the viewer is registered',
      translated: '你好',
    });

    captureSocket.close();
    viewerSocket.close();
  });

  it('falls back to the English line when the verifier flags a translation as unsafe', async () => {
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('transcription accuracy checker')) {
        return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
      }
      if (params.contents.includes('safety checker')) {
        return Promise.resolve({ text: '{"zh":{"safe":false,"reason":"polarity flip"}}' });
      }
      return Promise.resolve({ text: '{"zh":"耶稣不爱你"}' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

    expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Jesus loves you', translated: 'Jesus loves you' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('translation_fallback'));

    warnSpy.mockRestore();
    captureSocket.close();
    viewerSocket.close();
  });

  it('falls back to English when the verifier call fails after retry', async () => {
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

    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

    expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Hello everyone', translated: 'Hello everyone' });
    expect(verifyCallCount).toBe(2);

    captureSocket.close();
    viewerSocket.close();
  });

  describe('decoupled translation pipeline', () => {
    it("does not block a second segment's ack on the first segment's pending translate call", async () => {
      let resolveFirstTranslate!: (value: { text: string }) => void;
      const firstTranslate = new Promise<{ text: string }>((resolve) => {
        resolveFirstTranslate = resolve;
      });

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
        if (params.contents.includes('Sentence: "Line 1"')) return firstTranslate;
        return Promise.resolve({ text: '{"zh":"你好2"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      // A subscribed viewer is required so activeLanguages is non-empty —
      // translateWithFallback short-circuits without calling Gemini at all
      // when there are zero active languages, which would make firstTranslate
      // irrelevant and defeat the point of this test.
      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const firstAckPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Line 1');
      const firstAck = await firstAckPromise;
      expect(firstAck).toEqual({ type: 'transcript', id: expect.any(String), english: 'Line 1' });

      // Line 1's translate call is still pending (firstTranslate unresolved).
      // A second segment must still get its ack without waiting for it.
      const secondAckPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Line 2');
      const secondAck = await secondAckPromise;
      expect(secondAck).toEqual({ type: 'transcript', id: expect.any(String), english: 'Line 2' });

      resolveFirstTranslate({ text: '{"zh":"你好1"}' });
      captureSocket.close();
      viewerSocket.close();
    });

    it('publishes captions to viewers in original order even when a later line translates first', async () => {
      let resolveFirstTranslate!: (value: { text: string }) => void;
      const firstTranslate = new Promise<{ text: string }>((resolve) => {
        resolveFirstTranslate = resolve;
      });

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
        if (params.contents.includes('Sentence: "Line 1"')) return firstTranslate;
        return Promise.resolve({ text: '{"zh":"你好2"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const viewerMessages: any[] = [];
      viewerSocket.on('message', (data) => viewerMessages.push(JSON.parse(data.toString())));

      capturedCallbacks!.onFinalSegment('Line 1');
      await waitForMessage(captureSocket); // Line 1 ack
      capturedCallbacks!.onFinalSegment('Line 2');
      await waitForMessage(captureSocket); // Line 2 ack

      // Line 2's translate call already resolved. Give its publish work a
      // chance to run, and confirm it does NOT jump ahead of Line 1. Both
      // lines' 'caption-pending' notices arrive immediately on ingest,
      // independent of translate/publish ordering.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(viewerMessages).toEqual([
        { type: 'caption-pending', id: expect.any(String), english: 'Line 1' },
        { type: 'caption-pending', id: expect.any(String), english: 'Line 2' },
      ]);

      resolveFirstTranslate({ text: '{"zh":"你好1"}' });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(viewerMessages).toEqual([
        { type: 'caption-pending', id: expect.any(String), english: 'Line 1' },
        { type: 'caption-pending', id: expect.any(String), english: 'Line 2' },
        { type: 'caption', id: expect.any(String), english: 'Line 1', translated: '你好1' },
        { type: 'caption', id: expect.any(String), english: 'Line 2', translated: '你好2' },
      ]);

      captureSocket.close();
      viewerSocket.close();
    });

    it('prefetches translations for a suppressed line in the background without publishing them', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []
      const viewerMessages: any[] = [];
      viewerSocket.on('message', (data) => viewerMessages.push(JSON.parse(data.toString())));

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const transcript = await transcriptPromise;
      expect(transcript).toMatchObject({ flagged: true });

      // Prefetch runs detached from the ingest queue; give its promise chain
      // a tick to settle, then confirm the buffer entry was filled in.
      // (A 'line-removed' broadcast for the new suppressed line is expected —
      // see the "flagged as unsafe" and "manual mode" tests above — but no
      // 'caption' message should ever reach the still-suppressed viewer.)
      await new Promise((resolve) => setImmediate(resolve));
      const stored = session.buffer.peek(transcript.id);
      expect(stored?.pendingTranslations).toEqual({ zh: '你好' });
      expect(viewerMessages).toEqual([{ type: 'line-removed', id: transcript.id }]);

      captureSocket.close();
      viewerSocket.close();
    });
  });

  it('falls back to English in the backlog when the verifier flags a line as unsafe', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

  it('falls back to English in the backlog when the verifier call fails after retry', async () => {
    let verifyCallCount = 0;
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('safety checker')) {
        verifyCallCount += 1;
        return Promise.reject(new Error('verifier down'));
      }
      return Promise.resolve({ text: '{"translations":["较早的一行"]}' });
    });

    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    session.buffer.append('Earlier line', Date.now());

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    const backlogMessage = await waitForMessage(viewerSocket);

    expect(backlogMessage).toEqual({
      type: 'backlog',
      lines: [{ id: expect.any(String), english: 'Earlier line', translated: 'Earlier line' }],
    });
    expect(verifyCallCount).toBe(2);

    captureSocket.close();
    viewerSocket.close();
  });

  describe('per-role context caching', () => {
    it('creates a cache for every role on start once there is enough sermon material to clear Gemini\'s 1024-token cache minimum', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(geminiClient.caches.create).toHaveBeenCalledTimes(3);
      expect(session.roleCaches.transcriptionVerifier).toEqual({ name: 'cachedContents/test' });
      expect(session.roleCaches.translation).toEqual({ name: 'cachedContents/test' });
      expect(session.roleCaches.translationVerifier).toEqual({ name: 'cachedContents/test' });

      captureSocket.close();
    });

    it('skips cache creation for every role — without ever calling Gemini — when there is no sermon document or feedback text, since fixed rules + notes alone fall well under the 1024-token minimum', async () => {
      (feedbackStore.read as ReturnType<typeof vi.fn>).mockResolvedValue('');

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(geminiClient.caches.create).not.toHaveBeenCalled();
      expect(session.roleCaches).toEqual({ transcriptionVerifier: null, translation: null, translationVerifier: null });

      captureSocket.close();
    });

    it('passes the translation role\'s cache to translation calls', async () => {
      sermonDocStore.set(`This week: the story of Cain and Abel. ${CACHE_PADDING}`);
      (feedbackStore.read as ReturnType<typeof vi.fn>).mockResolvedValue(
        `Cain should translate to 该隐 in Chinese. ${CACHE_PADDING}`
      );

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

    it('keeps the translation cache after a non-cache transient error (e.g. rate limiting)', async () => {
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
          return Promise.reject(new Error('429 Too Many Requests'));
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

      // A rate-limit blip on this one call shouldn't be treated as evidence
      // the cache itself is stale — unlike the 'cachedContent reference
      // expired' cases above, the cache is fine and must survive for the
      // next segment.
      expect(session.roleCaches.translation).toEqual({ name: 'cachedContents/test' });

      const captionPromise2 = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('A later segment');
      await captionPromise2;

      const translateCallsAfter = (geminiClient.models.generateContent as any).mock.calls.filter(isTranslateCall);
      expect(translateCallsAfter[2][0].config.cachedContent).toBe('cachedContents/test');

      captureSocket.close();
      viewerSocket.close();
    });

    it('drops the stale translation-verifier cache reference on verification retry and self-heals subsequent segments', async () => {
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

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

      // Cross-segment self-healing: like translation, the translationVerifier
      // role's cache is cleared after a failed-then-retried verification, so a
      // later segment must not even attempt to use it, while the other two
      // roles' caches are untouched.
      expect(session.roleCaches.translationVerifier).toBeNull();
      expect(session.roleCaches.transcriptionVerifier).toEqual({ name: 'cachedContents/test' });

      const captionPromise2 = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('A later segment');
      await captionPromise2;

      const verifyCallsAfter = (geminiClient.models.generateContent as any).mock.calls.filter((call: any) =>
        call[0].contents.includes('safety checker')
      );
      expect(verifyCallsAfter).toHaveLength(3);
      expect(verifyCallsAfter[2][0].config).not.toHaveProperty('cachedContent');

      captureSocket.close();
      viewerSocket.close();
    });

    it('drops the stale transcription-verifier cache reference on verification retry and self-heals subsequent segments', async () => {
      let transcriptionCheckCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          transcriptionCheckCallCount += 1;
          if (transcriptionCheckCallCount === 1) {
            return Promise.reject(new Error('cachedContent reference expired'));
          }
          return Promise.resolve({ text: '{"safe":true,"reason":""}' });
        }
        if (params.contents.includes('safety checker')) {
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: '' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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
      expect(transcriptionCheckCallCount).toBe(2);

      const transcriptionCheckCalls = (geminiClient.models.generateContent as any).mock.calls.filter((call: any) =>
        call[0].contents.includes('transcription accuracy checker')
      );
      expect(transcriptionCheckCalls).toHaveLength(2);
      expect(transcriptionCheckCalls[0][0].config.cachedContent).toBe('cachedContents/test');
      expect(transcriptionCheckCalls[1][0].config).not.toHaveProperty('cachedContent');

      // Cross-segment self-healing: like translation, the transcriptionVerifier
      // role's cache is cleared after a failed-then-retried check, so a later
      // segment must not even attempt to use it, while the other two roles'
      // caches are untouched.
      expect(session.roleCaches.transcriptionVerifier).toBeNull();
      expect(session.roleCaches.translationVerifier).toEqual({ name: 'cachedContents/test' });

      const captionPromise2 = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('A later segment');
      await captionPromise2;

      const transcriptionCheckCallsAfter = (geminiClient.models.generateContent as any).mock.calls.filter((call: any) =>
        call[0].contents.includes('transcription accuracy checker')
      );
      expect(transcriptionCheckCallsAfter).toHaveLength(3);
      expect(transcriptionCheckCallsAfter[2][0].config).not.toHaveProperty('cachedContent');

      captureSocket.close();
      viewerSocket.close();
    });
  });

  describe('transcription safety check', () => {
    it('notifies every viewer of a line removal, and still reports the flag to the capture socket', async () => {
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

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

      warnSpy.mockRestore();
      captureSocket.close();
      viewerSocket.close();
    });

    it('runs the transcription check even with zero active viewers, storing a flagged line as suppressed', async () => {
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

    it('does not mark a safe line as flagged in the transcript event', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const transcript = await transcriptPromise;

      expect(transcript).toEqual({ type: 'transcript', id: expect.any(String), english: 'Hello everyone' });

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

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const transcript = await transcriptPromise;

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

      captureSocket.close();
    });

    it('gives a viewer joining while a line is suppressed a placeholder at the correct position', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const before = session.buffer.append('Before the flag', Date.now());
      const flagged = session.buffer.append('Mishe*rd line', Date.now(), true);
      const after = session.buffer.append('After the flag', Date.now());

      (geminiClient.models.generateContent as any).mockResolvedValueOnce({
        text: '{"translations":["你好","你好"]}',
      });

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
  });

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

    it("does not block the ingest queue on reinstate's translate call in manual mode", async () => {
      let resolveReinstateTranslate!: (value: { text: string }) => void;
      const heldTranslate = new Promise<{ text: string }>((resolve) => {
        resolveReinstateTranslate = resolve;
      });

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
        if (params.contents.includes('Sentence: "Edited line"')) return heldTranslate;
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      // A subscribed viewer is required so activeLanguages is non-empty —
      // translateWithFallback short-circuits without calling Gemini at all
      // when there are zero active languages, which would make heldTranslate
      // irrelevant and defeat the point of this test.
      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      reviewSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));
      // set-mode has no ack message, so give the real socket I/O a tick to
      // land before triggering onFinalSegment directly (see the same wait
      // used throughout the "manual approval mode" describe block below).
      await new Promise((resolve) => setTimeout(resolve, 20));

      const pendingAckPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Original line');
      const pendingAck = await pendingAckPromise;
      expect(pendingAck).toMatchObject({ type: 'transcript', english: 'Original line', flagged: true, pending: true });

      // Approve with edited text (the operator corrected the transcription
      // before pressing Enter) — this always pays a fresh, uncached translate
      // call, which is the case that used to stall the queue.
      const reinstateAckPromise = waitForMessage(captureSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: pendingAck.id, english: 'Edited line' }));
      const reinstateAck = await reinstateAckPromise;
      expect(reinstateAck).toEqual({ type: 'transcript', id: pendingAck.id, english: 'Edited line' });

      // The reinstate's translate call (heldTranslate) is still pending. The
      // ingest queue must still process a new segment without waiting on it.
      const nextAckPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Next segment');
      const nextAck = await nextAckPromise;
      expect(nextAck).toMatchObject({ english: 'Next segment' });

      resolveReinstateTranslate({ text: '{"zh":"编辑后的行"}' });
      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });

    it('reinstates with unedited text: un-flags the capture line and broadcasts caption-inserted', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const flagged = await flagALine(captureSocket, geminiClient);

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":true,"reason":"ok"}}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: flagged.id, english: flagged.english }));

      const ack = await ackPromise;
      expect(ack).toEqual({ type: 'transcript', id: flagged.id, english: flagged.english });

      const inserted = await insertedPromise;
      expect(inserted).toEqual({ type: 'caption-inserted', id: flagged.id, english: flagged.english, translated: '你好' });

      const recent = session.buffer.getRecent();
      expect(recent.find((line) => line.id === flagged.id)?.suppressed).toBe(false);

      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });

    it('reinstates with edited text: stores the corrected wording, reflected in a later backlog', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const flagged = await flagALine(captureSocket, geminiClient);

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{}' });
        }
        return Promise.resolve({ text: '{"zh":"耶稣确实是神的儿子"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      reviewSocket.send(
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
      reviewSocket.close();
    });

    it('responds with reinstate-error for an unknown id and does not touch the buffer', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      const errorPromise = waitForMessage(reviewSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: 'no-such-id', english: 'text' }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'reinstate-error', id: 'no-such-id', error: 'not found' });
      expect(session.buffer.getRecent()).toHaveLength(0);

      captureSocket.close();
      reviewSocket.close();
    });

    it('responds with reinstate-error for a line that is not currently suppressed', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const visible = session.buffer.append('Already visible', Date.now());

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      const errorPromise = waitForMessage(reviewSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: visible.id, english: 'text' }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'reinstate-error', id: visible.id, error: 'not found' });

      captureSocket.close();
      reviewSocket.close();
    });

    it('responds with reinstate-error for blank edited text and does not touch the buffer', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const flagged = await flagALine(captureSocket, geminiClient);

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      const errorPromise = waitForMessage(reviewSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: flagged.id, english: '   ' }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'reinstate-error', id: flagged.id, error: 'empty text' });
      expect(session.buffer.getRecent().find((line) => line.id === flagged.id)?.suppressed).toBe(true);

      captureSocket.close();
      reviewSocket.close();
    });

    it('uses the line\'s fixed position for translation context, not lines that arrived after it', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) return Promise.resolve({ text: '{}' });
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: flagged.id, english: flagged.english }));
      await ackPromise;

      const translateCall = (geminiClient.models.generateContent as any).mock.calls.find(isTranslateCall);
      expect(translateCall[0].contents).toContain('Earlier context line');
      expect(translateCall[0].contents).not.toContain('Later unrelated line');

      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });
  });

  describe('translation cache (viewer subscribe burst fix)', () => {
    it('caches the live-published translation for each active language', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

      expect(session.translationCache.get('zh', caption.id)?.translated).toBe('你好');

      captureSocket.close();
      viewerSocket.close();
    });

    it('caches the English fallback when the verifier flags a translation as unsafe', async () => {
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":false,"reason":"polarity flip"}}' });
        }
        return Promise.resolve({ text: '{"zh":"耶稣不爱你"}' });
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

      expect(session.translationCache.get('zh', caption.id)?.translated).toBe('Jesus loves you');

      warnSpy.mockRestore();
      captureSocket.close();
      viewerSocket.close();
    });

    it('does not cache anything for a language with no translation at all for that line', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'ko' }));
      await waitForMessage(viewerSocket); // backlog: []

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone'); // fakeGeminiClient's default translate only returns "zh"
      await transcriptPromise;
      await new Promise((resolve) => setImmediate(resolve));

      const recent = session.buffer.getRecent();
      expect(session.translationCache.get('ko', recent[0].id)).toBeUndefined();

      captureSocket.close();
      viewerSocket.close();
    });

    it('serves a second subscriber to an already-active language from cache, without additional Gemini calls', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const firstViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(firstViewer);
      firstViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(firstViewer); // backlog: []

      const captionPromise = waitForMessage(firstViewer);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      await captionPromise;

      const callsBeforeSecondSubscribe = (geminiClient.models.generateContent as any).mock.calls.length;

      const secondViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(secondViewer);
      secondViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlogMessage = await waitForMessage(secondViewer);

      expect(backlogMessage).toEqual({
        type: 'backlog',
        lines: [{ id: expect.any(String), english: 'Hello everyone', translated: '你好' }],
      });
      expect((geminiClient.models.generateContent as any).mock.calls.length).toBe(callsBeforeSecondSubscribe);

      captureSocket.close();
      firstViewer.close();
      secondViewer.close();
    });

    it('coalesces two concurrent first-time subscribes to the same new language into one backlog fill', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      session.buffer.append('Earlier line', Date.now());

      let resolveTranslate!: (value: { text: string }) => void;
      const pendingTranslate = new Promise<{ text: string }>((resolve) => {
        resolveTranslate = resolve;
      });
      let notifyTranslateStarted!: () => void;
      const translateStarted = new Promise<void>((resolve) => {
        notifyTranslateStarted = resolve;
      });
      let translateCallCount = 0;
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          // Mirror fakeGeminiClient's default behavior (see top of this file):
          // mark every requested id safe, so this test isolates coalescing
          // behavior instead of accidentally exercising the unsafe-fallback path.
          const ids = [...params.contents.matchAll(/\[id: "([^"]+)"\]/g)].map((match) => match[1]);
          const result: Record<string, { safe: boolean; reason: string }> = {};
          for (const id of ids) result[id] = { safe: true, reason: 'ok' };
          return Promise.resolve({ text: JSON.stringify(result) });
        }
        translateCallCount += 1;
        notifyTranslateStarted();
        return pendingTranslate;
      });

      const firstViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(firstViewer);
      firstViewer.send(JSON.stringify({ type: 'subscribe', language: 'fr' }));
      await translateStarted;

      const secondViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(secondViewer);
      secondViewer.send(JSON.stringify({ type: 'subscribe', language: 'fr' }));
      await new Promise((resolve) => setImmediate(resolve));

      expect(translateCallCount).toBe(1);

      const firstBacklogPromise = waitForMessage(firstViewer);
      const secondBacklogPromise = waitForMessage(secondViewer);
      resolveTranslate({ text: '{"translations":["Plus tôt"]}' });

      const [firstBacklog, secondBacklog] = await Promise.all([firstBacklogPromise, secondBacklogPromise]);
      expect(firstBacklog).toEqual({
        type: 'backlog',
        lines: [{ id: expect.any(String), english: 'Earlier line', translated: 'Plus tôt' }],
      });
      expect(secondBacklog).toEqual(firstBacklog);
      expect(translateCallCount).toBe(1);

      captureSocket.close();
      firstViewer.close();
      secondViewer.close();
    });

    it('a viewer subscribing after a reinstated correction sees the cached corrected translation, with no extra Gemini calls', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const firstViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(firstViewer);
      firstViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(firstViewer); // backlog: []

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });
      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const flagged = await transcriptPromise;

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":true,"reason":"ok"}}' });
        }
        return Promise.resolve({ text: '{"zh":"耶稣确实是神的儿子"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(firstViewer);
      reviewSocket.send(
        JSON.stringify({ type: 'reinstate', id: flagged.id, english: 'Jesus is indeed the son of God' })
      );
      await ackPromise;
      await insertedPromise;

      expect(session.translationCache.get('zh', flagged.id)?.translated).toBe('耶稣确实是神的儿子');

      const callsBeforeSecondSubscribe = (geminiClient.models.generateContent as any).mock.calls.length;

      const secondViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(secondViewer);
      secondViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlogMessage = await waitForMessage(secondViewer);

      expect(backlogMessage).toEqual({
        type: 'backlog',
        lines: [{ id: flagged.id, english: 'Jesus is indeed the son of God', translated: '耶稣确实是神的儿子' }],
      });
      expect((geminiClient.models.generateContent as any).mock.calls.length).toBe(callsBeforeSecondSubscribe);

      captureSocket.close();
      firstViewer.close();
      secondViewer.close();
      reviewSocket.close();
    });
  });

  describe('unsafe translation display mode', () => {
    it('flag mode: sends the real translation marked flagged with the reason, and a later viewer sees it in backlog too', async () => {
      (translationFlagDisplayStore.read as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'flag' });
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":false,"reason":"polarity flip"}}' });
        }
        return Promise.resolve({ text: '{"zh":"耶稣不爱你"}' });
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const firstViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(firstViewer);
      firstViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(firstViewer); // backlog: []

      const captionPromise = waitForMessage(firstViewer);
      capturedCallbacks!.onFinalSegment('Jesus loves you');
      const caption = await captionPromise;

      expect(caption).toEqual({
        type: 'caption',
        id: expect.any(String),
        english: 'Jesus loves you',
        translated: '耶稣不爱你',
        flagged: true,
        reason: 'polarity flip',
      });
      expect(session.translationCache.get('zh', caption.id)).toEqual({
        translated: '耶稣不爱你',
        flagged: true,
        reason: 'polarity flip',
      });

      const secondViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(secondViewer);
      secondViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlogMessage = await waitForMessage(secondViewer);

      expect(backlogMessage).toEqual({
        type: 'backlog',
        lines: [
          { id: caption.id, english: 'Jesus loves you', translated: '耶稣不爱你', flagged: true, reason: 'polarity flip' },
        ],
      });

      warnSpy.mockRestore();
      captureSocket.close();
      firstViewer.close();
      secondViewer.close();
    });

    it('flag mode: a safe translation is delivered exactly as in hide mode, with no flagged/reason fields', async () => {
      (translationFlagDisplayStore.read as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'flag' });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

      expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Hello everyone', translated: '你好' });
      expect(caption).not.toHaveProperty('flagged');
      expect(session.translationCache.get('zh', caption.id)).toEqual({ translated: '你好', flagged: false });

      captureSocket.close();
      viewerSocket.close();
    });

    it('flag mode: an unsafe backlog-fill translation is cached flagged and delivered with the reason', async () => {
      (translationFlagDisplayStore.read as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'flag' });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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
        lines: [{ id: line.id, english: 'Jesus loves you', translated: '耶稣不爱你', flagged: true, reason: 'polarity flip' }],
      });
      expect(session.translationCache.get('zh', line.id)).toEqual({
        translated: '耶稣不爱你',
        flagged: true,
        reason: 'polarity flip',
      });

      captureSocket.close();
      viewerSocket.close();
    });
  });

  describe('admin-remove', () => {
    it('suppresses a live line, acks the capture socket with a "Removed by admin" reason, and broadcasts line-removed to viewers', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const captionPromise = waitForMessage(viewerSocket);
      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      await captionPromise;
      const transcript = await transcriptPromise;

      const line = session.buffer.getRecent()[0];

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      const ackPromise = waitForMessage(captureSocket);
      const removedPromise = waitForMessage(viewerSocket);
      reviewSocket.send(JSON.stringify({ type: 'admin-remove', id: line.id }));

      const ack = await ackPromise;
      expect(ack).toEqual({
        type: 'transcript',
        id: line.id,
        english: 'Hello everyone',
        flagged: true,
        reason: 'Removed by admin',
      });

      const removed = await removedPromise;
      expect(removed).toEqual({ type: 'line-removed', id: line.id });

      expect(session.buffer.getRecent().find((entry) => entry.id === line.id)?.suppressed).toBe(true);

      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });

    it('responds with admin-remove-error for an unknown id and does not touch the buffer', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      const errorPromise = waitForMessage(reviewSocket);
      reviewSocket.send(JSON.stringify({ type: 'admin-remove', id: 'no-such-id' }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'admin-remove-error', id: 'no-such-id', error: 'not found' });
      expect(session.buffer.getRecent()).toHaveLength(0);

      captureSocket.close();
      reviewSocket.close();
    });

    it('responds with admin-remove-error for a line that is already suppressed', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const flagged = session.buffer.append('Already hidden', Date.now(), true);

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      const errorPromise = waitForMessage(reviewSocket);
      reviewSocket.send(JSON.stringify({ type: 'admin-remove', id: flagged.id }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'admin-remove-error', id: flagged.id, error: 'not found' });

      captureSocket.close();
      reviewSocket.close();
    });

    it('an admin-removed line can subsequently be reinstated with corrected text', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const transcript = await transcriptPromise;

      const removeAckPromise = waitForMessage(captureSocket);
      reviewSocket.send(JSON.stringify({ type: 'admin-remove', id: transcript.id }));
      await removeAckPromise;

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: [{ ...removed placeholder }]

      const reinstateAckPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      reviewSocket.send(
        JSON.stringify({ type: 'reinstate', id: transcript.id, english: 'Hello everyone, corrected' })
      );

      const reinstateAck = await reinstateAckPromise;
      expect(reinstateAck).toEqual({ type: 'transcript', id: transcript.id, english: 'Hello everyone, corrected' });

      const inserted = await insertedPromise;
      expect(inserted).toEqual({
        type: 'caption-inserted',
        id: transcript.id,
        english: 'Hello everyone, corrected',
        translated: '你好',
      });

      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });

    it('does not publish a caption to viewers for a line admin-removed while its translate call was still pending', async () => {
      let resolveTranslate!: (value: { text: string }) => void;
      const pendingTranslate = new Promise<{ text: string }>((resolve) => {
        resolveTranslate = resolve;
      });

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
        return pendingTranslate;
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const viewerMessages: any[] = [];
      viewerSocket.on('message', (data) => viewerMessages.push(JSON.parse(data.toString())));

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const transcript = await transcriptPromise;

      // The line's translate call is still in flight (pendingTranslate is
      // unresolved) when the operator admin-removes it.
      const removeAckPromise = waitForMessage(captureSocket);
      reviewSocket.send(JSON.stringify({ type: 'admin-remove', id: transcript.id }));
      await removeAckPromise;

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(viewerMessages).toEqual([
        { type: 'caption-pending', id: transcript.id, english: 'Hello everyone' },
        { type: 'line-removed', id: transcript.id },
      ]);

      // Now let the deferred translate resolve. The queued publish must be
      // skipped since the line was suppressed in the meantime.
      resolveTranslate({ text: '{"zh":"你好"}' });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(viewerMessages).toEqual([
        { type: 'caption-pending', id: transcript.id, english: 'Hello everyone' },
        { type: 'line-removed', id: transcript.id },
      ]);
      expect(viewerMessages.some((message) => message.type === 'caption')).toBe(false);

      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });
  });

  describe('manual approval mode', () => {
    it('suppresses every safe line as pending when the session is in manual mode', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog
      reviewSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const viewerMessages: any[] = [];
      viewerSocket.on('message', (data) => viewerMessages.push(JSON.parse(data.toString())));

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const transcript = await transcriptPromise;

      expect(transcript).toEqual({
        type: 'transcript',
        id: expect.any(String),
        english: 'Hello everyone',
        flagged: true,
        reason: 'Pending manual approval',
        pending: true,
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(viewerMessages).toEqual([{ type: 'line-removed', id: transcript.id }]);

      const recent = session.buffer.getRecent();
      expect(recent[0]).toMatchObject({ id: transcript.id, suppressed: true });
      expect(recent[0].pendingTranslations).toEqual({ zh: '你好' });

      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });

    it('combines the AI flag reason with the manual-approval reason when both apply', async () => {
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":false,"reason":"likely mis-heard negation"}' });
        }
        return Promise.resolve({ text: '{"zh":"你好"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog
      reviewSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));
      // set-mode has no ack message, so (unlike other capture-socket messages
      // in this file) there's nothing to `waitForMessage` on to know the
      // server has processed it. Give the real socket I/O a tick to land
      // before triggering onFinalSegment directly, mirroring the same
      // real-socket-latency wait used in the "cost tracking" tests below.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const transcript = await transcriptPromise;

      expect(transcript).toEqual({
        type: 'transcript',
        id: expect.any(String),
        english: 'Jesus is not the son of God',
        flagged: true,
        reason: 'Pending manual approval — AI also flagged: likely mis-heard negation',
        pending: true,
      });

      captureSocket.close();
      reviewSocket.close();
    });

    it('switching from manual back to automatic mid-session only affects new lines, leaving already-pending lines suppressed', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog
      reviewSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));
      // See the comment in the previous test: set-mode has no ack, so give
      // the real socket I/O a tick to land before triggering onFinalSegment.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const firstTranscriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('First line');
      const firstTranscript = await firstTranscriptPromise;
      expect(firstTranscript.pending).toBe(true);

      reviewSocket.send(JSON.stringify({ type: 'set-mode', mode: 'automatic' }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const secondTranscriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Second line');
      const secondTranscript = await secondTranscriptPromise;
      expect(secondTranscript).toEqual({ type: 'transcript', id: expect.any(String), english: 'Second line' });

      const recent = session.buffer.getRecent();
      expect(recent.find((line) => line.id === firstTranscript.id)?.suppressed).toBe(true);
      expect(recent.find((line) => line.id === secondTranscript.id)?.suppressed).toBe(false);

      captureSocket.close();
      reviewSocket.close();
    });

    it('approving an unedited manual-mode line reuses the cached translation instead of calling Gemini again', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog
      reviewSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const pending = await transcriptPromise;

      const translateCallsBeforeApprove = (geminiClient.models.generateContent as any).mock.calls.filter(
        isTranslateCall
      ).length;

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: pending.id, english: pending.english }));
      await ackPromise;
      const inserted = await insertedPromise;

      expect(inserted).toEqual({
        type: 'caption-inserted',
        id: pending.id,
        english: 'Hello everyone',
        translated: '你好',
      });

      const translateCallsAfterApprove = (geminiClient.models.generateContent as any).mock.calls.filter(
        isTranslateCall
      ).length;
      expect(translateCallsAfterApprove).toBe(translateCallsBeforeApprove);

      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });

    it('approving translates only languages that became active after the line was held, reusing the rest from cache', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog
      reviewSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));
      // set-mode has no ack message, so give the real socket I/O a tick to
      // land before triggering onFinalSegment directly (see the comment in
      // the "combines the AI flag reason..." test above).
      await new Promise((resolve) => setTimeout(resolve, 20));

      // No viewers yet: the line is held with an empty translation cache.
      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const pending = await transcriptPromise;
      expect(session.buffer.getRecent()[0].pendingTranslations).toEqual({});

      // A viewer joins zh after the line was held but before it's approved.
      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: [] (the line is suppressed, not included)

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: pending.id, english: pending.english }));
      await ackPromise;
      const inserted = await insertedPromise;

      expect(inserted).toEqual({
        type: 'caption-inserted',
        id: pending.id,
        english: 'Hello everyone',
        translated: '你好',
      });

      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });

    it('editing the text before approving discards the cache and re-translates', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket);

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog
      reviewSocket.send(JSON.stringify({ type: 'set-mode', mode: 'manual' }));
      // set-mode has no ack message, so give the real socket I/O a tick to
      // land before triggering onFinalSegment directly (see the comment in
      // the "combines the AI flag reason..." test above).
      await new Promise((resolve) => setTimeout(resolve, 20));
      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const pending = await transcriptPromise;

      // The line was held (suppressed) on arrival, so handleFinalSegment also
      // broadcasts a 'line-removed' message to the already-subscribed viewer.
      // That message and the 'transcript' message above are sent over two
      // separate socket connections, so there's no guarantee both have been
      // delivered by the time `pending` resolves. Give the real socket I/O a
      // tick to land here — with no listener attached, it's harmlessly
      // dropped — so it can't race with and be mistaken for the reinstate's
      // 'caption-inserted' message below.
      await new Promise((resolve) => setTimeout(resolve, 20));

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":true,"reason":"ok"}}' });
        }
        return Promise.resolve({ text: '{"zh":"大家好"}' });
      });

      const ackPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      reviewSocket.send(JSON.stringify({ type: 'reinstate', id: pending.id, english: 'Hello, everyone!' }));
      await ackPromise;
      const inserted = await insertedPromise;

      expect(inserted).toEqual({
        type: 'caption-inserted',
        id: pending.id,
        english: 'Hello, everyone!',
        translated: '大家好',
      });

      captureSocket.close();
      viewerSocket.close();
      reviewSocket.close();
    });
  });

  describe('segment processing order', () => {
    it('processes segments strictly in arrival order even if a later segment finishes its Gemini calls first', async () => {
      let resolveFirst!: (value: { text: string }) => void;
      const firstPending = new Promise<{ text: string }>((resolve) => {
        resolveFirst = resolve;
      });

      // Both segments only go through the transcription-safety check here,
      // since no viewer is subscribed (translateWithFallback short-circuits
      // without calling Gemini when there are no active languages). The first
      // segment's check is held pending while the second segment's resolves
      // immediately, simulating a Gemini latency spike that lets the second
      // segment "win the race" despite arriving after the first.
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('Line: "First segment"')) {
          return firstPending;
        }
        return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
      });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      // Fired back-to-back with no await in between, matching the real
      // fire-and-forget `onFinalSegment` callback wiring.
      capturedCallbacks!.onFinalSegment('First segment');
      capturedCallbacks!.onFinalSegment('Second segment');

      // Give the second segment's (fast) Gemini call a chance to resolve and
      // be processed while the first segment's call is still pending.
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Without serialization, "Second segment" would already be appended
      // here even though "First segment" arrived first and hasn't finished.
      expect(session.buffer.getRecent()).toHaveLength(0);

      resolveFirst({ text: '{"safe":true,"reason":"ok"}' });
      await new Promise((resolve) => setTimeout(resolve, 30));

      const lines = session.buffer.getRecent().map((line) => line.english);
      expect(lines).toEqual(['First segment', 'Second segment']);

      captureSocket.close();
    });
  });

  describe('cost tracking', () => {
    it('resets the session cost tracker and subscribes to updates when a capture session starts', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(costTracker.resetSession).toHaveBeenCalledTimes(1);
      expect(costTracker.onUpdate).toHaveBeenCalledTimes(1);

      captureSocket.close();
    });

    it('sends a cost update to the capture socket whenever the tracker reports new totals', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const costPromise = waitForMessage(captureSocket);
      for (const listener of costTracker.listeners) listener(0.0032, 14.82);
      const cost = await costPromise;

      expect(cost).toEqual({ type: 'cost', sessionUsd: 0.0032, lifetimeUsd: 14.82 });

      captureSocket.close();
    });

    it('periodically flushes elapsed Deepgram time to the cost tracker during an active recording, without waiting for stop', async () => {
      deps.deepgramCostFlushIntervalMs = 20;

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const costPromise = waitForMessage(captureSocket); // first periodic flush's cost update — no 'stop' sent
      const cost = await costPromise;

      expect(cost.type).toBe('cost');
      expect(costTracker.recordDeepgramSeconds).toHaveBeenCalledTimes(1);
      const elapsedSeconds = (costTracker.recordDeepgramSeconds as any).mock.calls[0][0];
      expect(elapsedSeconds).toBeGreaterThan(0);
      expect(elapsedSeconds).toBeLessThan(1);

      captureSocket.close();
    });

    it('stops the periodic Deepgram flush on stop, so no further flush fires after the final one', async () => {
      deps.deepgramCostFlushIntervalMs = 20;

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      captureSocket.send(JSON.stringify({ type: 'stop' }));
      await new Promise((resolve) => setTimeout(resolve, 50)); // status: idle, then final cost update

      const callCountAtStop = (costTracker.recordDeepgramSeconds as any).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 60)); // long enough for 3 more flush ticks if the interval leaked

      expect((costTracker.recordDeepgramSeconds as any).mock.calls.length).toBe(callCountAtStop);

      captureSocket.close();
    });

    it('sends status:idle before the final cost update on stop, and records Deepgram seconds', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      // The 'stop' handler sends the idle status and the final cost update
      // back-to-back in the same synchronous tick, so two sequential
      // `waitForMessage` (`once('message', ...)`) calls race: the `ws` client
      // can emit both 'message' events before the second listener is
      // registered, losing the cost update and hanging the test. Collecting
      // via a persistent listener avoids that race.
      const messages: any[] = [];
      captureSocket.on('message', (data) => messages.push(JSON.parse(data.toString())));

      captureSocket.send(JSON.stringify({ type: 'stop' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages[0]).toEqual({ type: 'status', status: 'idle' });
      expect(messages[1]?.type).toBe('cost');

      expect(costTracker.recordDeepgramSeconds).toHaveBeenCalledTimes(1);
      const elapsedSeconds = (costTracker.recordDeepgramSeconds as any).mock.calls[0][0];
      expect(elapsedSeconds).toBeGreaterThanOrEqual(0);
      expect(elapsedSeconds).toBeLessThan(5);

      captureSocket.close();
    });

    it('stops sending cost updates after stop, even if the tracker fires again', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      // See the note above: collect via a persistent listener instead of two
      // sequential `waitForMessage` calls, since the idle status and final
      // cost update are sent synchronously back-to-back.
      const messages: any[] = [];
      captureSocket.on('message', (data) => messages.push(JSON.parse(data.toString())));

      captureSocket.send(JSON.stringify({ type: 'stop' }));
      await new Promise((resolve) => setTimeout(resolve, 50)); // status: idle, then final cost update

      expect(messages.map((message) => message.type)).toEqual(['status', 'cost']);
      expect(costTracker.listeners.size).toBe(0);

      captureSocket.close();
    });

    it('records Deepgram seconds on an abrupt close without an explicit stop', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      captureSocket.close();
      // The server-side 'close' event fires only after the WebSocket close
      // handshake completes real socket I/O (a few ms even on loopback), so
      // a single `setImmediate` isn't enough to observe it reliably.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(costTracker.recordDeepgramSeconds).toHaveBeenCalledTimes(1);
    });

    it('does not double-record Deepgram seconds when close fires after an explicit stop', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      captureSocket.send(JSON.stringify({ type: 'stop' }));
      await new Promise((resolve) => setTimeout(resolve, 50)); // status: idle, then final cost update
      captureSocket.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(costTracker.recordDeepgramSeconds).toHaveBeenCalledTimes(1);
    });
  });

  describe('review connection', () => {
    it('sends a backlog snapshot with mode and status on connect', async () => {
      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      const backlog = await waitForMessage(reviewSocket);
      expect(backlog).toEqual({ type: 'backlog', lines: [], mode: 'automatic', status: 'idle' });
      reviewSocket.close();
    });

    it("includes a suppressed line's pending/reason in the backlog", async () => {
      session.buffer.append('Visible', Date.now() - 2000);
      session.buffer.append('Held for review', Date.now() - 1000, true, undefined, true, 'Pending manual approval');

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
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
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      const backlog = await waitForMessage(reviewSocket);
      expect(backlog).toMatchObject({ status: 'recording' });

      captureSocket.close();
      reviewSocket.close();
    });

    it('broadcasts a new transcript line to both the capture socket and a connected review socket', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
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

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const flaggedPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Jesus is not the son of God');
      const flagged = await flaggedPromise;

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
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
      const reviewSocketA = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocketA); // backlog
      const reviewSocketB = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
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
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
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

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
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
      const reviewSocketA = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocketA); // backlog
      const reviewSocketB = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
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
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog

      const costPromise = waitForMessage(reviewSocket);
      costTracker.recordDeepgramSeconds(1);
      const cost = await costPromise;
      expect(cost.type).toBe('cost');

      captureSocket.close();
      reviewSocket.close();
    });

    it('removes a review socket from broadcast targets on close', async () => {
      const reviewSocket = new WebSocket(`ws://localhost:${port}/ws/review?passcode=test-passcode`);
      await waitForMessage(reviewSocket); // backlog
      reviewSocket.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(session.getAllReview()).toEqual([]);
    });
  });

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
});
