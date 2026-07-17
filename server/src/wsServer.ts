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
import type { TranslationFlagDisplayStore } from './translationFlagDisplayStore.js';
import { logEvent } from './logger.js';

const PRECEDING_CONTEXT_LINES = 7;

// Only a failure that actually implicates the cached-content reference (e.g.
// an expired/deleted cache) should drop a role's cache for the rest of the
// session. Any other failure — a rate limit, a network blip, a malformed
// response — is transient and unrelated to the cache's validity; treating it
// as a cache failure would needlessly force every subsequent call for that
// role onto the slower, uncached (full-instructions-every-time) path.
function isCacheRelatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cache/i.test(message);
}

type EnqueuePublish = (
  line: CaptionLine,
  workPromise: Promise<Record<string, string>>,
  viewerMessageType?: 'caption' | 'caption-inserted'
) => void;

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
  translationFlagDisplayStore: TranslationFlagDisplayStore;
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
  let ingestQueue: Promise<void> = Promise.resolve();
  let publishQueue: Promise<void> = Promise.resolve();
  let recordingStartedAt: number | null = null;
  let unsubscribeCost: (() => void) | null = null;

  function finalizeDeepgramCost(): void {
    if (recordingStartedAt !== null) {
      const elapsedSeconds = (Date.now() - recordingStartedAt) / 1000;
      deps.costTracker.recordDeepgramSeconds(elapsedSeconds);
      recordingStartedAt = null;
    }
  }

  // Fires the translate call immediately (so multiple lines' calls can run
  // concurrently, bounded by GeminiCallLimiter), but only lets its result
  // reach viewers once every earlier-queued line has already been published —
  // so captions stay in original order even though the network calls overlap.
  function enqueuePublish(
    line: CaptionLine,
    workPromise: Promise<Record<string, string>>,
    viewerMessageType: 'caption' | 'caption-inserted' = 'caption'
  ): void {
    publishQueue = publishQueue
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
              transcriptionVerifier: getProvider(modelConfig.transcriptionVerifier, promptConfig.transcriptionVerifier, deps.geminiClient),
              translation: getProvider(modelConfig.translation, promptConfig.translation, deps.geminiClient),
              translationVerifier: getProvider(modelConfig.translationVerifier, promptConfig.translationVerifier, deps.geminiClient),
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
                ingestQueue = ingestQueue
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
            ingestQueue = ingestQueue
              .then(() => handleReinstateFast(message.id, message.english, deps, ws, enqueuePublish))
              .catch((error) => {
                void logEvent('error', {
                  event: 'reinstate_processing_failed',
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          } else if (message.type === 'admin-remove') {
            ingestQueue = ingestQueue
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
  // The line may have been admin-removed (or otherwise suppressed) after it
  // was handed to enqueuePublish but before its translate work resolved.
  // Skip the publish entirely in that case — the viewer already got (or
  // will get) a line-removed broadcast for it.
  if (line.suppressed) return;

  const activeLanguages = deps.session.getActiveLanguages();
  if (activeLanguages.length === 0) return;

  const verificationItems: VerificationItem[] = activeLanguages
    .filter((language) => Boolean(translations[language]))
    .map((language) => ({ id: language, english: line.english, translated: translations[language] }));
  const verifications = await verifyTranslationsWithRetry(deps, verificationItems);
  const flagMode = deps.session.translationFlagDisplayMode === 'flag';

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = flagMode || safe ? translated : line.english;
    const flagged = flagMode && !safe;
    const reason = verification?.reason || 'verification unavailable';

    if (!safe) {
      logTranslationFallback(language, line.english, translated, reason);
    }

    deps.session.translationCache.set(
      language,
      line.id,
      flagged ? { translated: outgoing, flagged: true, reason } : { translated: outgoing, flagged: false }
    );

    const payload = JSON.stringify({
      type: viewerMessageType,
      id: line.id,
      english: line.english,
      translated: outgoing,
      ...(flagged ? { flagged: true, reason } : {}),
    });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}

function buildReinstateTranslation(
  deps: WsServerDeps,
  trimmed: string,
  originalEnglish: string,
  cachedTranslations: Record<string, string>,
  precedingContext: string[],
  activeLanguages: string[]
): Promise<Record<string, string>> {
  if (trimmed !== originalEnglish) {
    return translateWithFallback(deps, trimmed, activeLanguages, precedingContext);
  }
  const cachedLanguages = activeLanguages.filter((language) => cachedTranslations[language] !== undefined);
  const newLanguages = activeLanguages.filter((language) => cachedTranslations[language] === undefined);
  const cachedEntries = Object.fromEntries(cachedLanguages.map((language) => [language, cachedTranslations[language]]));
  if (newLanguages.length === 0) return Promise.resolve(cachedEntries);
  return translateWithFallback(deps, trimmed, newLanguages, precedingContext).then((fresh) => ({
    ...cachedEntries,
    ...fresh,
  }));
}

async function handleReinstateFast(
  id: string,
  english: string,
  deps: WsServerDeps,
  captureSocket: WebSocket,
  enqueuePublish: EnqueuePublish
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

  const line = deps.session.buffer.reinstate(id, trimmed);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'reinstate-error', id, error: 'not found' }));
    return;
  }

  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));

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

  const line = deps.session.buffer.append(english, Date.now(), suppressed);

  if (suppressed) {
    if (!transcriptionResult.safe) {
      void logEvent('warn', { event: 'transcription_flagged', english, reason: transcriptionResult.reason });
    }
    const reason = manualHold
      ? transcriptionResult.safe
        ? 'Pending manual approval'
        : `Pending manual approval — AI also flagged: ${transcriptionResult.reason}`
      : transcriptionResult.reason;
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
    schedulePrefetch(line, precedingContext);
    return;
  }

  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));
  const activeLanguages = deps.session.getActiveLanguages();
  const workPromise = translateWithFallback(deps, english, activeLanguages, precedingContext);
  enqueuePublish(line, workPromise);
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
  } catch (error) {
    if (isCacheRelatedError(error)) deps.session.roleCaches.translation = null;
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
  } catch (error) {
    if (isCacheRelatedError(error)) deps.session.roleCaches.transcriptionVerifier = null;
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
  } catch (error) {
    if (isCacheRelatedError(error)) deps.session.roleCaches.translationVerifier = null;
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
        cache.set(language, line.id, { translated: line.english, flagged: false });
      }
      return;
    }

    const verificationItems: VerificationItem[] = missingEntries
      .map((line, index) => ({ id: line.id, english: line.english, translated: translations[index] ?? '' }))
      .filter((item) => item.translated.length > 0);
    const verifications = await verifyTranslationsWithRetry(deps, verificationItems);

    const flagMode = deps.session.translationFlagDisplayMode === 'flag';
    missingEntries.forEach((line, index) => {
      const translated = translations[index];
      if (!translated) {
        cache.set(language, line.id, { translated: line.english, flagged: false });
        return;
      }
      const verification = verifications[line.id];
      if (verification?.safe === true) {
        cache.set(language, line.id, { translated, flagged: false });
        return;
      }
      const reason = verification?.reason || 'verification unavailable';
      logTranslationFallback(language, line.english, translated, reason);
      if (flagMode) {
        cache.set(language, line.id, { translated, flagged: true, reason });
      } else {
        cache.set(language, line.id, { translated: line.english, flagged: false });
      }
    });
  })();

  fills.set(language, fillPromise);
  try {
    await fillPromise;
  } finally {
    fills.delete(language);
  }
}

function buildBacklogLine(
  line: CaptionLine,
  cache: Session['translationCache'],
  language: string
): Record<string, unknown> {
  if (line.suppressed) return { id: line.id, english: '', translated: '', removed: true };
  const cached = cache.get(language, line.id);
  return {
    id: line.id,
    english: line.english,
    translated: cached?.translated ?? line.english,
    ...(cached?.flagged ? { flagged: true, reason: cached.reason } : {}),
  };
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

          const lines = backlog.map((line) => buildBacklogLine(line, cache, language));

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
