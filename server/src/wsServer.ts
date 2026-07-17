import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from './session.js';
import type { CaptionLine } from './types.js';
import type { GeminiClient } from './gemini.js';
import type { VerificationItem, VerificationResult } from './translationVerifier.js';
import type { TranscriptionCheckResult } from './transcriptionVerifier.js';
import type { DeepgramConnection, DeepgramConnectionFactory } from './deepgram.js';
import { createRoleCaches, deleteRoleCaches } from './sermonCache.js';
import { getProvider } from './llmRegistry.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { CostTracker } from './costTracker.js';
import type { ModelConfigStore } from './modelConfigStore.js';
import type { PromptConfigStore } from './promptConfigStore.js';
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
  modelConfigStore: ModelConfigStore;
  promptConfigStore: PromptConfigStore;
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

            const sermonText = deps.sermonDocStore.get() ?? '';
            const feedbackText = await deps.feedbackStore.read();
            const modelConfig = await deps.modelConfigStore.read();
            const promptConfig = await deps.promptConfigStore.read();

            deps.session.providers = {
              transcriptionVerifier: getProvider(modelConfig.transcriptionVerifier, promptConfig.transcriptionVerifier, deps.geminiClient),
              translation: getProvider(modelConfig.translation, promptConfig.translation, deps.geminiClient),
              translationVerifier: getProvider(modelConfig.translationVerifier, promptConfig.translationVerifier, deps.geminiClient),
            };
            deps.session.roleCaches = await createRoleCaches(deps.geminiClient, modelConfig, promptConfig, feedbackText, sermonText);

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
            await deleteRoleCaches(deps.geminiClient, deps.session.roleCaches);
            deps.session.roleCaches = { transcriptionVerifier: null, translation: null, translationVerifier: null };
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
  viewerMessageType: 'caption' | 'caption-inserted' = 'caption'
): Promise<void> {
  const activeLanguages = deps.session.getActiveLanguages();
  if (activeLanguages.length === 0) return;

  const verificationItems: VerificationItem[] = activeLanguages
    .filter((language) => Boolean(translations[language]))
    .map((language) => ({ id: language, english: line.english, translated: translations[language] }));
  const verifications = await verifyTranslationsWithRetry(deps, verificationItems);

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = safe ? translated : line.english;
    deps.session.translationCache.set(language, line.id, outgoing);

    if (!safe) {
      logTranslationFallback(language, line.english, translated, verification?.reason || 'verification unavailable');
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

  const existing = deps.session.buffer.peek(id);
  if (existing === null || !existing.suppressed) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  const originalEnglish = existing.english;
  const cachedTranslations = existing.pendingTranslations ?? {};
  const precedingContext = deps.session.buffer.precedingContextFor(id, PRECEDING_CONTEXT_LINES);
  const activeLanguages = deps.session.getActiveLanguages();

  let translations: Record<string, string>;
  if (trimmed === originalEnglish) {
    const cachedLanguages = activeLanguages.filter((language) => cachedTranslations[language] !== undefined);
    const newLanguages = activeLanguages.filter((language) => cachedTranslations[language] === undefined);
    const freshTranslations =
      newLanguages.length > 0 ? await translateWithFallback(deps, trimmed, newLanguages, precedingContext) : {};
    translations = {
      ...Object.fromEntries(cachedLanguages.map((language) => [language, cachedTranslations[language]])),
      ...freshTranslations,
    };
  } else {
    translations = await translateWithFallback(deps, trimmed, activeLanguages, precedingContext);
  }

  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));
  await finishPublishing(line, translations, deps, 'caption-inserted');
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
  const activeLanguages = deps.session.getActiveLanguages();

  const [transcriptionResult, translations] = await Promise.all([
    verifyTranscriptionWithRetry(deps, english, precedingContext),
    translateWithFallback(deps, english, activeLanguages, precedingContext),
  ]);

  const manualHold = deps.session.mode === 'manual';

  if (!transcriptionResult.safe || manualHold) {
    if (!transcriptionResult.safe) {
      void logEvent('warn', { event: 'transcription_flagged', english, reason: transcriptionResult.reason });
    }
    const reason = manualHold
      ? transcriptionResult.safe
        ? 'Pending manual approval'
        : `Pending manual approval — AI also flagged: ${transcriptionResult.reason}`
      : transcriptionResult.reason;
    const line = deps.session.buffer.append(english, Date.now(), true, translations);
    captureSocket.send(
      JSON.stringify({
        type: 'transcript',
        id: line.id,
        english,
        flagged: true,
        reason,
        ...(manualHold ? { pending: true } : {}),
      })
    );
    const removedPayload = JSON.stringify({ type: 'line-removed', id: line.id });
    for (const viewerSocket of deps.session.getAllViewers()) {
      viewerSocket.send(removedPayload);
    }
    return;
  }

  const line = deps.session.buffer.append(english);
  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));
  await finishPublishing(line, translations, deps);
}

async function translateWithFallback(
  deps: WsServerDeps,
  english: string,
  activeLanguages: string[],
  precedingContext: string[]
): Promise<Record<string, string>> {
  if (activeLanguages.length === 0) return {};
  // deps.session.providers is assigned in the 'start' handler before the
  // Deepgram connection is created, and the Deepgram connection is the only
  // source of onFinalSegment calls that drive this function — so providers is
  // always populated by the time this runs. See handleCaptureConnection.
  const provider = deps.session.providers!.translation;
  try {
    return await provider.translate(english, activeLanguages, precedingContext, deps.session.roleCaches.translation);
  } catch {
    deps.session.roleCaches.translation = null;
    try {
      return await provider.translate(english, activeLanguages, precedingContext, null);
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
  deps: WsServerDeps,
  english: string,
  precedingContext: string[]
): Promise<TranscriptionCheckResult> {
  const provider = deps.session.providers!.transcriptionVerifier;
  const cacheRef = deps.session.roleCaches.transcriptionVerifier;
  try {
    return await provider.verifyTranscription(english, precedingContext, cacheRef);
  } catch {
    deps.session.roleCaches.transcriptionVerifier = null;
    try {
      return await provider.verifyTranscription(english, precedingContext, null);
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
  deps: WsServerDeps,
  items: VerificationItem[]
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};
  const provider = deps.session.providers!.translationVerifier;
  const cacheRef = deps.session.roleCaches.translationVerifier;
  try {
    return await provider.verifyTranslations(items, cacheRef);
  } catch {
    deps.session.roleCaches.translationVerifier = null;
    try {
      return await provider.verifyTranslations(items, null);
    } catch (secondError) {
      void logEvent('error', {
        event: 'verification_failed',
        error: secondError instanceof Error ? secondError.message : String(secondError),
      });
      return {};
    }
  }
}

async function ensureBacklogCached(
  deps: WsServerDeps,
  language: string,
  missingEntries: CaptionLine[]
): Promise<void> {
  if (missingEntries.length === 0) return;

  const cache = deps.session.translationCache;
  const fills = deps.session.inFlightFills;

  const existingFill = fills.get(language);
  if (existingFill) {
    await existingFill;
    const stillMissing = missingEntries.filter((line) => cache.get(language, line.id) === undefined);
    if (stillMissing.length === 0) return;
    return ensureBacklogCached(deps, language, stillMissing);
  }

  const fillPromise = (async () => {
    let translations: string[];
    try {
      translations = await deps.session.providers!.translation.translateBacklog(
        missingEntries.map((line) => line.english),
        language,
        deps.session.roleCaches.translation
      );
    } catch (error) {
      void logEvent('error', {
        event: 'backlog_translation_failed',
        language,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const line of missingEntries) {
        cache.set(language, line.id, line.english);
      }
      return;
    }

    const verificationItems: VerificationItem[] = missingEntries
      .map((line, index) => ({ id: line.id, english: line.english, translated: translations[index] ?? '' }))
      .filter((item) => item.translated.length > 0);
    const verifications = await verifyTranslationsWithRetry(deps, verificationItems);

    missingEntries.forEach((line, index) => {
      const translated = translations[index];
      if (!translated) {
        cache.set(language, line.id, line.english);
        return;
      }
      const verification = verifications[line.id];
      if (verification?.safe === true) {
        cache.set(language, line.id, translated);
        return;
      }
      logTranslationFallback(language, line.english, translated, verification?.reason || 'verification unavailable');
      cache.set(language, line.id, line.english);
    });
  })();

  fills.set(language, fillPromise);
  try {
    await fillPromise;
  } finally {
    fills.delete(language);
  }
}

function handleViewerConnection(ws: WebSocket, deps: WsServerDeps): void {
  ws.on('message', (data) => {
    void (async () => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'subscribe') {
          const language = message.language as string;
          const cache = deps.session.translationCache;

          const backlog = deps.session.buffer.getRecent();
          const visibleEntries = backlog.filter((line) => !line.suppressed);
          const missingEntries = visibleEntries.filter((line) => cache.get(language, line.id) === undefined);

          if (missingEntries.length > 0) {
            await ensureBacklogCached(deps, language, missingEntries);
          }

          const lines = backlog.map((line) =>
            line.suppressed
              ? { id: line.id, english: '', translated: '', removed: true }
              : { id: line.id, english: line.english, translated: cache.get(language, line.id) ?? line.english }
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
