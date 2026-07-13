import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachWsServer } from '../src/wsServer';
import { Session } from '../src/session';
import type { GeminiClient } from '../src/gemini';
import type { DeepgramCallbacks } from '../src/deepgram';

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

  beforeEach(async () => {
    session = new Session();
    capturedCallbacks = null;
    httpServer = createServer();

    geminiClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({ text: '{"zh":"你好"}' }),
      },
    };

    attachWsServer({
      httpServer,
      session,
      geminiClient,
      deepgramApiKey: 'fake-key',
      createDeepgramConnection: (_apiKey, callbacks) => {
        capturedCallbacks = callbacks;
        return { send: vi.fn(), finish: vi.fn() };
      },
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
});
