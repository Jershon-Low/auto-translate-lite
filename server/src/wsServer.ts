import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from './session.js';
import type { CaptionLine } from './types.js';
import { translateSegment, translateBacklog, type GeminiClient, type SermonCacheRef } from './gemini.js';
import { verifyTranslations, type VerificationItem, type VerificationResult } from './translationVerifier.js';
import { verifyTranscription, type TranscriptionCheckResult } from './transcriptionVerifier.js';
import type { DeepgramConnection, DeepgramConnectionFactory } from './deepgram.js';
import { createSermonContextCache, deleteSermonContextCache } from './sermonCache.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { CostTracker } from './costTracker.js';
import { logEvent } from './logger.js';

const PRECEDING_CONTEXT_LINES = 7;

export interface WsServerDeps {
  httpServer: HttpServer;
  session: Session;
  geminiClient: GeminiClient;
  deepgramApiKey: string;
  createDeepgramConnection: DeepgramConnectionFactory;
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
  costTracker: CostTracker;
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
  let processingQueue: Promise<void> = Promise.resolve();
  let recordingStartedAt: number | null = null;
  let unsubscribeCost: (() => void) | null = null;

  function finalizeDeepgramCost(): void {
    if (recordingStartedAt !== null) {
      const elapsedSeconds = (Date.now() - recordingStartedAt) / 1000;
      deps.costTracker.recordDeepgramSeconds(elapsedSeconds);
      recordingStartedAt = null;
    }
  }

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
                processingQueue = processingQueue
                  .then(() => handleFinalSegment(text, deps, ws))
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
            await deleteSermonContextCache(deps.geminiClient, deps.session.sermonCache);
            deps.session.sermonCache = null;
            deepgramConnection?.finish();
            deepgramConnection = null;
            ws.send(JSON.stringify({ type: 'status', status: 'idle' }));

            finalizeDeepgramCost();
            unsubscribeCost?.();
            unsubscribeCost = null;
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
          } else if (message.type === 'admin-remove') {
            processingQueue = processingQueue
              .then(() => handleAdminRemove(message.id, deps, ws))
              .catch((error) => {
                void logEvent('error', {
                  event: 'admin_remove_processing_failed',
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
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

    // Unsubscribe before finalizing: the socket is already closed by the time
    // this event fires, so the cost-update listener must not attempt a send.
    unsubscribeCost?.();
    unsubscribeCost = null;
    finalizeDeepgramCost();
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
    deps.session.translationCache.set(language, line.id, outgoing);

    if (!safe) {
      logTranslationFallback(language, line.english, translated, verification?.reason ?? 'verification unavailable');
    }

    const payload = JSON.stringify({ type: viewerMessageType, id: line.id, english: line.english, translated: outgoing });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}

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

async function handleAdminRemove(id: string, deps: WsServerDeps, captureSocket: WebSocket): Promise<void> {
  const line = deps.session.buffer.suppress(id);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'admin-remove-error', id, error: 'not found' }));
    return;
  }

  captureSocket.send(
    JSON.stringify({ type: 'transcript', id: line.id, english: line.english, flagged: true, reason: 'Removed by admin' })
  );
  const removedPayload = JSON.stringify({ type: 'line-removed', id: line.id });
  for (const viewerSocket of deps.session.getAllViewers()) {
    viewerSocket.send(removedPayload);
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
