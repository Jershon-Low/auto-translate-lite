import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from './session.js';
import { translateSegment, translateBacklog, type GeminiClient } from './gemini.js';
import type { DeepgramConnection, DeepgramConnectionFactory } from './deepgram.js';

export interface WsServerDeps {
  httpServer: HttpServer;
  session: Session;
  geminiClient: GeminiClient;
  deepgramApiKey: string;
  createDeepgramConnection: DeepgramConnectionFactory;
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
    try {
      if (!isBinary) {
        const message = JSON.parse(data.toString());
        if (message.type === 'start') {
          deps.session.start();
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
  });

  ws.on('close', () => {
    deps.session.stop();
    deepgramConnection?.finish();
  });
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

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;
    const payload = JSON.stringify({ type: 'caption', english: line.english, translated });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
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
          ws.send(JSON.stringify({ type: 'backlog', lines }));
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
