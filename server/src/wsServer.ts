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
import { logEvent } from './logger.js';

export interface WsServerDeps {
  httpServer: HttpServer;
  session: Session;
  geminiClient: GeminiClient;
  deepgramApiKey: string;
  createDeepgramConnection: DeepgramConnectionFactory;
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
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
    void (async () => {
      try {
        if (!isBinary) {
          const message = JSON.parse(data.toString());
          if (message.type === 'start') {
            deps.session.start();

            const sermonText = deps.sermonDocStore.get();
            if (sermonText) {
              const feedbackText = await deps.feedbackStore.read();
              deps.session.sermonCache = await createSermonContextCache(
                deps.geminiClient,
                feedbackText,
                sermonText
              );
            }

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
            await deleteSermonContextCache(deps.geminiClient, deps.session.sermonCache);
            deps.session.sermonCache = null;
            deepgramConnection?.finish();
            deepgramConnection = null;
            ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
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
    deps.session.stop();
    void deleteSermonContextCache(deps.geminiClient, deps.session.sermonCache).then(() => {
      deps.session.sermonCache = null;
    });
    deepgramConnection?.finish();
  });
}

function logTranslationFallback(
  language: string,
  english: string,
  discardedTranslation: string,
  reason: string
): void {
  void logEvent('warn', { event: 'translation_fallback', language, english, discardedTranslation, reason });
}

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

async function verifyTranslationsWithRetry(
  client: GeminiClient,
  items: VerificationItem[],
  sermonCache: SermonCacheRef | null
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};
  try {
    return await verifyTranslations(client, items, sermonCache);
  } catch {
    try {
      return await verifyTranslations(client, items, null);
    } catch (secondError) {
      void logEvent('error', {
        event: 'verification_failed',
        error: secondError instanceof Error ? secondError.message : String(secondError),
      });
      return {};
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

          const verificationItems: VerificationItem[] = lines
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => line.translated.length > 0)
            .map(({ line, index }) => ({ id: String(index), english: line.english, translated: line.translated }));
          const verifications = await verifyTranslationsWithRetry(
            deps.geminiClient,
            verificationItems,
            deps.session.sermonCache
          );

          const verifiedLines = lines.map((line, index) => {
            if (line.translated.length === 0) return { english: line.english, translated: line.english };
            const verification = verifications[String(index)];
            if (verification?.safe === true) return line;
            logTranslationFallback(
              language,
              line.english,
              line.translated,
              verification?.reason ?? 'verification unavailable'
            );
            return { english: line.english, translated: line.english };
          });

          ws.send(JSON.stringify({ type: 'backlog', lines: verifiedLines }));
          deps.session.addViewer(ws, language);
        }
      } catch (error) {
        void logEvent('error', {
          event: 'viewer_message_error',
          error: error instanceof Error ? error.message : String(error),
        });
        ws.send(JSON.stringify({ type: 'backlog', lines: [] }));
      }
    })();
  });

  ws.on('close', () => deps.session.removeViewer(ws));
}
