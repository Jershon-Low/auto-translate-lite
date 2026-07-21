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
import type { LlmClients } from './llmRegistry.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { CostTracker } from './costTracker.js';
import type { ModelConfigStore } from './modelConfigStore.js';
import type { PromptConfigStore } from './promptConfigStore.js';
import type { TranslationFlagDisplayStore } from './translationFlagDisplayStore.js';
import { logEvent } from './logger.js';
import type { LogHub } from './logHub.js';

const PRECEDING_CONTEXT_LINES = 7;

// ws.send() is non-blocking, so a live-tail /ws/logs viewer that can't keep up
// (e.g. a stalled tab) would otherwise let its outgoing send buffer grow
// without bound on every log entry. The on-disk log remains the durable
// record, so once a socket is saturated it simply drops intermediate entries
// rather than accumulating an unbounded backlog.
const MAX_LOGS_SOCKET_BUFFER_BYTES = 1_000_000;

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

interface PreparedLanguageResult {
  language: string;
  translated: string;
  flagged: boolean;
  reason?: string;
}

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
  logHub: LogHub;
  deepgramCostFlushIntervalMs: number;
}

export function attachWsServer(deps: WsServerDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  deps.httpServer.on('upgrade', (request, socket, head) => {
    const { pathname, searchParams } = new URL(request.url ?? '', 'http://localhost');
    if (
      pathname !== '/ws/capture' &&
      pathname !== '/ws/viewer' &&
      pathname !== '/ws/review' &&
      pathname !== '/ws/logs'
    ) {
      socket.destroy();
      return;
    }
    if (pathname === '/ws/capture' || pathname === '/ws/review' || pathname === '/ws/logs') {
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

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, pathname: string) => {
    if (pathname === '/ws/capture') {
      handleCaptureConnection(ws, deps);
    } else if (pathname === '/ws/review') {
      handleReviewConnection(ws, deps);
    } else if (pathname === '/ws/logs') {
      handleLogsConnection(ws, deps);
    } else {
      handleViewerConnection(ws, deps);
    }
  });
}

function createEnqueuePublish(deps: WsServerDeps): EnqueuePublish {
  return function enqueuePublish(
    line: CaptionLine,
    workPromise: Promise<Record<string, string>>,
    viewerMessageType: 'caption' | 'caption-inserted' = 'caption'
  ): void {
    // Translate + verify for this line starts immediately (not gated on the
    // queue below), so a slow line doesn't stall the network work for lines
    // behind it — only the final, already-computed send is kept in order.
    const preparedPromise = workPromise
      .then((translations) => prepareTranslationsForPublish(line, translations, deps))
      .catch((error) => {
        void logEvent('error', {
          event: 'publish_failed',
          english: line.english,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    deps.session.publishQueue = deps.session.publishQueue.then(async () => {
      const results = await preparedPromise;
      sendPrepared(line, results, deps, viewerMessageType);
    });
  };
}

function handleCaptureConnection(ws: WebSocket, deps: WsServerDeps): void {
  let deepgramConnection: DeepgramConnection | null = null;
  let recordingStartedAt: number | null = null;
  let unsubscribeCost: (() => void) | null = null;
  let deepgramCostFlushInterval: ReturnType<typeof setInterval> | null = null;
  // TEMP DIAGNOSTIC (remove after debugging localhost transcription): counts the
  // audio actually forwarded to Deepgram this recording. Tiny bytes/chunk ≈ silence
  // (mic problem); ~3-4 KB/chunk ≈ real audio (problem is downstream, not the mic).
  let audioChunkCount = 0;
  let audioByteCount = 0;

  // Audio can arrive from the browser before the Deepgram live connection has
  // finished opening — the 'start' handler awaits config + Gemini role caches
  // before creating the connection, and the connection itself takes a moment to
  // open. The very first MediaRecorder chunk carries the WebM/EBML init header;
  // if it's dropped, Deepgram can never decode the stream (it reports
  // duration:0 and returns no transcripts). So hold audio until the connection
  // is open, then flush it in order — header first.
  let deepgramReady = false;
  let pendingAudio: Buffer[] = [];
  let pendingAudioBytes = 0;
  const MAX_PENDING_AUDIO_BYTES = 5_000_000;

  function resetAudioBuffering(): void {
    deepgramReady = false;
    pendingAudio = [];
    pendingAudioBytes = 0;
  }

  // Send everything buffered during startup to Deepgram in arrival order (the
  // WebM header chunk first), then clear the buffer.
  function flushPendingAudio(): void {
    for (const chunk of pendingAudio) deepgramConnection?.send(chunk);
    pendingAudio = [];
    pendingAudioBytes = 0;
  }

  deps.session.captureSocket = ws;

  // Deepgram bills by elapsed audio duration, not by discrete calls like the
  // Gemini/OpenRouter usage tracked elsewhere — so "live" cost for it means
  // periodically flushing the elapsed window rather than reacting to events.
  // Rolls recordingStartedAt forward to the flush point so the next flush (or
  // the final one in finalizeDeepgramCost) only covers the remaining window.
  function recordElapsedDeepgramCost(): void {
    if (recordingStartedAt === null) return;
    const now = Date.now();
    const elapsedSeconds = (now - recordingStartedAt) / 1000;
    deps.costTracker.recordDeepgramSeconds(elapsedSeconds);
    recordingStartedAt = now;
  }

  function finalizeDeepgramCost(): void {
    recordElapsedDeepgramCost();
    recordingStartedAt = null;
    if (deepgramCostFlushInterval !== null) {
      clearInterval(deepgramCostFlushInterval);
      deepgramCostFlushInterval = null;
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

            audioChunkCount = 0;
            audioByteCount = 0;
            resetAudioBuffering();
            deepgramConnection = deps.createDeepgramConnection(deps.deepgramApiKey, {
              onOpen: () => {
                deepgramReady = true;
                flushPendingAudio();
              },
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
                const errorPayload = JSON.stringify({ type: 'status', status: 'error' });
                ws.send(errorPayload);
                deps.session.broadcastToReview(errorPayload);
              },
              onClose: () => {
                // Stop forwarding to a closed connection; further audio is held
                // (capped) rather than sent into a dead socket.
                deepgramReady = false;
              },
            });
            recordingStartedAt = Date.now();
            deepgramCostFlushInterval = setInterval(recordElapsedDeepgramCost, deps.deepgramCostFlushIntervalMs);
            const recordingPayload = JSON.stringify({ type: 'status', status: 'recording' });
            ws.send(recordingPayload);
            deps.session.broadcastToReview(recordingPayload);

            deps.costTracker.resetSession();
            unsubscribeCost = deps.costTracker.onUpdate((sessionUsd, lifetimeUsd) => {
              const costPayload = JSON.stringify({ type: 'cost', sessionUsd, lifetimeUsd });
              ws.send(costPayload);
              deps.session.broadcastToReview(costPayload);
            });
          } else if (message.type === 'stop') {
            void logEvent('info', {
              event: 'capture_audio_stats_diag',
              sessionId: deps.session.id,
              audioChunkCount,
              audioByteCount,
              avgBytesPerChunk: audioChunkCount > 0 ? Math.round(audioByteCount / audioChunkCount) : 0,
            });
            deps.session.stop();
            await deleteRoleCaches(deps.geminiClient, deps.session.roleCaches);
            deps.session.roleCaches = { transcriptionVerifier: null, translation: null, translationVerifier: null };
            deepgramConnection?.finish();
            deepgramConnection = null;
            resetAudioBuffering();
            const idlePayload = JSON.stringify({ type: 'status', status: 'idle' });
            ws.send(idlePayload);
            deps.session.broadcastToReview(idlePayload);

            finalizeDeepgramCost();
            unsubscribeCost?.();
            unsubscribeCost = null;
          }
        } else {
          const chunk = data as Buffer;
          audioChunkCount += 1;
          audioByteCount += chunk.length;
          if (deepgramConnection && deepgramReady) {
            deepgramConnection.send(chunk);
          } else if (pendingAudioBytes + chunk.length <= MAX_PENDING_AUDIO_BYTES) {
            // Deepgram not open yet — hold the chunk (esp. the WebM header) so it
            // isn't lost to the startup race; onOpen flushes these in order.
            pendingAudio.push(chunk);
            pendingAudioBytes += chunk.length;
          }
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
    void logEvent('info', {
      event: 'capture_audio_stats_diag',
      sessionId: deps.session.id,
      reason: 'socket_closed',
      audioChunkCount,
      audioByteCount,
      avgBytesPerChunk: audioChunkCount > 0 ? Math.round(audioByteCount / audioChunkCount) : 0,
    });
    if (deps.session.captureSocket === ws) deps.session.captureSocket = null;
    deps.session.stop();
    void deleteRoleCaches(deps.geminiClient, deps.session.roleCaches).then(() => {
      deps.session.roleCaches = { transcriptionVerifier: null, translation: null, translationVerifier: null };
    });
    deepgramConnection?.finish();
    resetAudioBuffering();

    // Unsubscribe before finalizing: the socket is already closed by the time
    // this event fires, so the cost-update listener must not attempt a send.
    unsubscribeCost?.();
    unsubscribeCost = null;
    finalizeDeepgramCost();
  });
}

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

function handleLogsConnection(ws: WebSocket, deps: WsServerDeps): void {
  // Recent context first, then live entries. This is a read-only channel:
  // inbound messages from a logs socket are ignored.
  try {
    ws.send(JSON.stringify({ type: 'history', entries: deps.logHub.getHistory() }));
  } catch {
    // A dead/broken socket must never propagate back into logHub.push and
    // break logging for everyone else; the close handler unsubscribes it.
  }

  const unsubscribe = deps.logHub.subscribe((entry) => {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_LOGS_SOCKET_BUFFER_BYTES) return;
    try {
      ws.send(JSON.stringify({ type: 'log', entry }));
    } catch {
      // A dead/broken socket must never propagate back into logHub.push and
      // break logging for everyone else; the close handler unsubscribes it.
    }
  });

  ws.on('close', () => unsubscribe());
  ws.on('error', () => unsubscribe());
}

function logTranslationFallback(
  language: string,
  english: string,
  discardedTranslation: string,
  reason: string
): void {
  void logEvent('warn', { event: 'translation_fallback', language, english, discardedTranslation, reason });
}

// Runs the network-bound work (translation-verification) for a single line.
// Deliberately not gated on publishQueue: called as soon as this line's own
// translations resolve, so it can run concurrently with other lines' prep
// instead of waiting its turn. Only the (cheap, synchronous) sendPrepared
// step below needs to happen in order.
async function prepareTranslationsForPublish(
  line: CaptionLine,
  translations: Record<string, string>,
  deps: WsServerDeps
): Promise<PreparedLanguageResult[] | null> {
  // The line may have been admin-removed (or otherwise suppressed) after it
  // was handed to enqueuePublish but before its translate work resolved.
  // Skip the publish entirely in that case — the viewer already got (or
  // will get) a line-removed broadcast for it.
  if (line.suppressed) return null;

  const activeLanguages = deps.session.getActiveLanguages();
  if (activeLanguages.length === 0) return [];

  const verificationItems: VerificationItem[] = activeLanguages
    .filter((language) => Boolean(translations[language]))
    .map((language) => ({ id: language, english: line.english, translated: translations[language] }));
  const verifications = await verifyTranslationsWithRetry(deps, verificationItems);
  const flagMode = deps.session.translationFlagDisplayMode === 'flag';

  const results: PreparedLanguageResult[] = [];
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

    results.push({ language, translated: outgoing, flagged, reason: flagged ? reason : undefined });
  }
  return results;
}

// The ordered, synchronous half of publishing: writes the cache and sends to
// viewers currently subscribed to each language. Kept inside publishQueue so
// captions still arrive at viewers in the same order they were spoken.
function sendPrepared(
  line: CaptionLine,
  results: PreparedLanguageResult[] | null,
  deps: WsServerDeps,
  viewerMessageType: 'caption' | 'caption-inserted'
): void {
  if (results === null) return;

  for (const { language, translated, flagged, reason } of results) {
    deps.session.translationCache.set(
      language,
      line.id,
      flagged ? { translated, flagged: true, reason: reason! } : { translated, flagged: false }
    );

    const payload = JSON.stringify({
      type: viewerMessageType,
      id: line.id,
      english: line.english,
      translated,
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

  // Let viewers know Deepgram already produced this line before translation
  // finishes — the view page renders it greyed-out until the real 'caption'
  // (or 'line-removed') arrives, so slow translation is visibly distinct
  // from a stalled transcription feed.
  const pendingPayload = JSON.stringify({ type: 'caption-pending', id: line.id, english: line.english });
  for (const viewerSocket of deps.session.getAllViewers()) {
    viewerSocket.send(pendingPayload);
  }

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
