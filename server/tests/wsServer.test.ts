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

function fakeGeminiClient(overrides: { translate?: string; verify?: string } = {}): GeminiClient {
  const translateText = overrides.translate ?? '{"zh":"你好"}';
  return {
    models: {
      generateContent: vi.fn().mockImplementation((params: { contents: string }) => {
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

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
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

  it('broadcasts a translated caption to a subscribed viewer', async () => {
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

    expect(caption).toEqual({ type: 'caption', english: 'Hello everyone', translated: '你好' });

    captureSocket.close();
    viewerSocket.close();
  });

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

  it('sends translated backlog to a viewer joining after segments already arrived', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
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
      lines: [{ english: 'Earlier line', translated: '较早的一行' }],
    });

    captureSocket.close();
    viewerSocket.close();
  });

  it('survives a malformed non-binary frame instead of crashing the connection', async () => {
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
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
    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
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
      { type: 'backlog', lines: [{ english: 'Earlier line', translated: '较早的一行' }] },
    ]);

    const captionPromise = waitForMessage(viewerSocket);
    capturedCallbacks!.onFinalSegment('Now the viewer is registered');
    const caption = await captionPromise;
    expect(caption).toEqual({
      type: 'caption',
      english: 'Now the viewer is registered',
      translated: '你好',
    });

    captureSocket.close();
    viewerSocket.close();
  });

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
    let verifyCallCount = 0;
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('safety checker')) {
        verifyCallCount += 1;
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
    expect(verifyCallCount).toBe(2);

    captureSocket.close();
    viewerSocket.close();
  });

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

  it('falls back to English in the backlog when the verifier call fails after retry', async () => {
    let verifyCallCount = 0;
    (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
      if (params.contents.includes('safety checker')) {
        verifyCallCount += 1;
        return Promise.reject(new Error('verifier down'));
      }
      return Promise.resolve({ text: '{"translations":["较早的一行"]}' });
    });

    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
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
      lines: [{ english: 'Earlier line', translated: 'Earlier line' }],
    });
    expect(verifyCallCount).toBe(2);

    captureSocket.close();
    viewerSocket.close();
  });

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
      expect(sermonDocStore.get()).not.toBeNull();

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
      sermonDocStore.set(
        'This week: the story of Cain and Abel. Genesis chapter four covers jealousy, ' +
          "the first murder, and God's response to Cain after he kills his brother out in the field."
      );

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

    it('rebuilds the cache on a second start (reconnect) since the sermon doc is no longer consumed', async () => {
      sermonDocStore.set(
        'This week: the story of Cain and Abel. Genesis chapter four covers jealousy, ' +
          "the first murder, and God's response to Cain after he kills his brother out in the field."
      );

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);

      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording
      expect(geminiClient.caches.create).toHaveBeenCalledTimes(1);
      expect(sermonDocStore.get()).not.toBeNull();

      // Simulate a client auto-reconnect: it re-sends 'start' on the same
      // logical flow without a new document upload.
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(geminiClient.caches.create).toHaveBeenCalledTimes(2);
      expect(session.sermonCache).toEqual({ name: 'cachedContents/test' });

      captureSocket.close();
    });

    it('drops the stale cache reference on translation retry and self-heals subsequent segments', async () => {
      sermonDocStore.set(
        'This week: the story of Cain and Abel. Genesis chapter four covers jealousy, ' +
          "the first murder, and God's response to Cain after he kills his brother out in the field."
      );

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

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      expect(session.sermonCache).toEqual({ name: 'cachedContents/test' });

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const captionPromise = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('Cain killed Abel');
      const caption = await captionPromise;

      expect(caption).toEqual({ type: 'caption', english: 'Cain killed Abel', translated: '你好' });

      const translateCalls = (geminiClient.models.generateContent as any).mock.calls.filter(
        (call: any) => !call[0].contents.includes('safety checker')
      );
      expect(translateCalls).toHaveLength(2);
      expect(translateCalls[0][0].config.cachedContent).toBe('cachedContents/test');
      expect(translateCalls[1][0].config).not.toHaveProperty('cachedContent');

      // Cross-segment self-healing: the session's cache reference was cleared,
      // so a later segment must not even attempt to use it.
      expect(session.sermonCache).toBeNull();

      const captionPromise2 = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('A later segment');
      await captionPromise2;

      const translateCallsAfter = (geminiClient.models.generateContent as any).mock.calls.filter(
        (call: any) => !call[0].contents.includes('safety checker')
      );
      expect(translateCallsAfter).toHaveLength(3);
      expect(translateCallsAfter[2][0].config).not.toHaveProperty('cachedContent');

      captureSocket.close();
      viewerSocket.close();
    });

    it('drops the stale cache reference on verification retry', async () => {
      sermonDocStore.set(
        'This week: the story of Cain and Abel. Genesis chapter four covers jealousy, ' +
          "the first murder, and God's response to Cain after he kills his brother out in the field."
      );

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

      expect(caption).toEqual({ type: 'caption', english: 'Cain killed Abel', translated: '你好' });
      expect(verifyCallCount).toBe(2);

      const verifyCalls = (geminiClient.models.generateContent as any).mock.calls.filter((call: any) =>
        call[0].contents.includes('safety checker')
      );
      expect(verifyCalls).toHaveLength(2);
      expect(verifyCalls[0][0].config.cachedContent).toBe('cachedContents/test');
      expect(verifyCalls[1][0].config).not.toHaveProperty('cachedContent');

      captureSocket.close();
      viewerSocket.close();
    });
  });
});
