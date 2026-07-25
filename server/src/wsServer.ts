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
import type { LlmProvider } from './llmTypes.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { CostTracker } from './costTracker.js';
import type { ModelConfigStore } from './modelConfigStore.js';
import type { PromptConfigStore } from './promptConfigStore.js';
import type { TranslationFlagDisplayStore } from './translationFlagDisplayStore.js';
import { logEvent } from './logger.js';
import type { LogHub } from './logHub.js';
import { selectBacklogEntriesToTranslate } from './viewerBacklog.js';

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

// The 'stop' message handler and the socket 'close' handler can both fire for
// the same session (e.g. a client sends 'stop' then immediately closes).
// Swapping session.roleCaches out for the empty value synchronously, before
// deletion starts, makes this atomic: whichever handler runs first claims the
// refs, and the other sees the already-cleared value and deletes nothing.
function clearAndDeleteRoleCaches(deps: WsServerDeps): Promise<void> {
  const caches = deps.session.roleCaches;
  deps.session.roleCaches = { transcriptionVerifier: null, translation: null, translationVerifier: null };
  return deleteRoleCaches(deps.geminiClient, caches);
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
  backlogLlmClients: LlmClients;
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
  viewerBacklogTranslateLimit: number;
  maxPublishLagMs: number;
  maxCorrectionLagMs: number;
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

interface Publisher {
  enqueuePublish: EnqueuePublish;
  publishEnglish: (line: CaptionLine, viewerMessageType?: 'caption' | 'caption-inserted') => void;
}

const DEADLINE_REACHED = Symbol('deadline-reached');

// What raceAgainstDeadline decided, not just what it produced. `shedAt` is the
// moment the deadline fired (and therefore the clock the correction window is
// measured from), or null when the translation won the race and no correction
// is owed.
interface DeadlineOutcome {
  results: PreparedLanguageResult[] | null;
  shedAt: number | null;
}

// Publish the line's already-verified English text for every active language.
// Mirrors prepareTranslationsForPublish's guards so a line suppressed
// (admin-removed) mid-flight is still never published. English is always safe:
// the line has already passed the transcription safety check.
function englishFallbackResults(line: CaptionLine, deps: WsServerDeps): PreparedLanguageResult[] | null {
  if (line.suppressed) return null;
  return deps.session
    .getActiveLanguages()
    .map((language) => ({ language, translated: line.english, flagged: false }));
}

// Resolve to the verified translation results if they arrive before the
// staleness deadline; otherwise resolve to the English fallback and let the
// (now-stale) translation be discarded. Bounds how far behind a caption can
// fall to ~maxPublishLagMs.
async function raceAgainstDeadline(
  preparedPromise: Promise<PreparedLanguageResult[] | null>,
  deadlineMs: number,
  line: CaptionLine,
  deps: WsServerDeps
): Promise<DeadlineOutcome> {
  // Attach a handler immediately so a rejection is never left unhandled,
  // regardless of which branch below runs (the early-return path never
  // otherwise touches preparedPromise).
  void preparedPromise.catch(() => {});

  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    void logEvent('warn', { event: 'caption_lag_shed', reason: 'publish_deadline', english: line.english });
    return { results: englishFallbackResults(line, deps), shedAt: Date.now() };
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof DEADLINE_REACHED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_REACHED), remaining);
  });
  try {
    const outcome = await Promise.race([preparedPromise, timeout]);
    if (outcome === DEADLINE_REACHED) {
      void logEvent('warn', { event: 'caption_lag_shed', reason: 'publish_deadline', english: line.english });
      return { results: englishFallbackResults(line, deps), shedAt: Date.now() };
    }
    return { results: outcome, shedAt: null };
  } finally {
    clearTimeout(timer!);
  }
}

// Edge-triggered so a long congested stretch produces one "engaged" log and one
// "disengaged" log, not one per line. Publish-path lag: how far behind the
// oldest un-published line is.
function reportLag(deps: WsServerDeps, lagMs: number): void {
  const behind = lagMs >= deps.maxPublishLagMs;
  if (behind && !deps.session.isBehind) {
    deps.session.isBehind = true;
    void logEvent('warn', { event: 'caption_backpressure_engaged', lagMs: Math.round(lagMs) });
  } else if (!behind && deps.session.isBehind) {
    deps.session.isBehind = false;
    void logEvent('info', { event: 'caption_backpressure_disengaged', lagMs: Math.round(lagMs) });
  }
}

// Ingest-path lag: how long a segment waited in the (un-sheddable) ingest queue
// before processing began. Measured only — surfaces a slow transcription
// verifier that back-pressure cannot fix.
// Note: this only runs at the top of handleFinalSegmentFast, so the "cleared"
// edge is next-segment-triggered, not proactive — if ingest wait spikes and
// speech then stops entirely, ingest_lag_cleared won't log until a new segment
// arrives. Harmless (no user-visible effect) and inherent to measuring lag
// per-segment; unlike the publish path, there's no idle/drain callback to hook.
function reportIngestLag(deps: WsServerDeps, ingestWaitMs: number): void {
  const high = ingestWaitMs >= deps.maxPublishLagMs;
  if (high && !deps.session.ingestLagHigh) {
    deps.session.ingestLagHigh = true;
    void logEvent('warn', { event: 'ingest_lag_high', ingestWaitMs: Math.round(ingestWaitMs) });
  } else if (!high && deps.session.ingestLagHigh) {
    deps.session.ingestLagHigh = false;
    void logEvent('info', { event: 'ingest_lag_cleared', ingestWaitMs: Math.round(ingestWaitMs) });
  }
}

function createEnqueuePublish(deps: WsServerDeps): Publisher {
  // Shared tail: record the line in the lag tracker, then append one ordered
  // link to publishQueue that sends the pre-computed results in order and
  // dequeues afterward. Capturing `tracker` here (not re-reading it inside the
  // async link) keeps enqueue and dequeue on the same instance even if the
  // session restarts mid-flight.
  function enqueueOrderedSend(
    line: CaptionLine,
    enqueuedAt: number,
    outcomePromise: Promise<DeadlineOutcome>,
    viewerMessageType: 'caption' | 'caption-inserted'
  ): Promise<void> {
    const tracker = deps.session.liveLag;
    tracker.enqueue(enqueuedAt);
    const sendPromise = deps.session.publishQueue.then(async () => {
      let outcome: DeadlineOutcome;
      try {
        outcome = await outcomePromise;
      } catch (error) {
        void logEvent('error', {
          event: 'publish_failed',
          english: line.english,
          error: error instanceof Error ? error.message : String(error),
        });
        outcome = { results: null, shedAt: null };
      } finally {
        tracker.dequeue();
      }
      // Tell the viewer a correction may follow only when one is actually owed:
      // the line was shed at the deadline AND corrections are enabled.
      const awaitingCorrection = outcome.shedAt !== null && deps.maxCorrectionLagMs > 0;
      sendPrepared(line, outcome.results, deps, viewerMessageType, awaitingCorrection);
      reportLag(deps, deps.session.liveLag.lagMs(Date.now()));
    });
    deps.session.publishQueue = sendPromise;
    return sendPromise;
  }

  const enqueuePublish: EnqueuePublish = (line, workPromise, viewerMessageType = 'caption') => {
    const enqueuedAt = Date.now();
    // Translate + verify still starts immediately (not gated on the queue), as before.
    const preparedPromise = workPromise.then((translations) =>
      prepareTranslationsForPublish(line, translations, deps)
    );
    const outcomePromise = raceAgainstDeadline(preparedPromise, enqueuedAt + deps.maxPublishLagMs, line, deps);
    const sendPromise = enqueueOrderedSend(line, enqueuedAt, outcomePromise, viewerMessageType);

    if (deps.maxCorrectionLagMs > 0) {
      // .catch is required, not optional: outcomePromise rejects when
      // preparedPromise rejects before the deadline, and this is a second
      // subscription to it — without the catch that rejection is unhandled on
      // this branch even though enqueueOrderedSend handles its own.
      void outcomePromise
        .then((outcome) => {
          if (outcome.shedAt === null) return;
          scheduleCorrection(deps, line, preparedPromise, outcome.shedAt, sendPromise);
        })
        .catch(() => {});
    }
  };

  const publishEnglish = (line: CaptionLine, viewerMessageType: 'caption' | 'caption-inserted' = 'caption'): void => {
    enqueueOrderedSend(
      line,
      Date.now(),
      Promise.resolve({ results: englishFallbackResults(line, deps), shedAt: null }),
      viewerMessageType
    );
  };

  return { enqueuePublish, publishEnglish };
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

  const { enqueuePublish, publishEnglish } = createEnqueuePublish(deps);

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

            // The two translation roles are built identically for the live and
            // backlog lanes — only the client bundle (and thus the OpenRouter
            // budget) differs — so share one builder.
            const buildTranslationProviders = (clients: LlmClients) => ({
              translation: getProvider(modelConfig.translation, promptConfig.translation, clients),
              translationVerifier: getProvider(modelConfig.translationVerifier, promptConfig.translationVerifier, clients),
            });
            deps.session.providers = {
              transcriptionVerifier: getProvider(modelConfig.transcriptionVerifier, promptConfig.transcriptionVerifier, deps.llmClients),
              ...buildTranslationProviders(deps.llmClients),
            };
            deps.session.backlogProviders = buildTranslationProviders(deps.backlogLlmClients);
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
                const receivedAt = Date.now();
                deps.session.ingestQueue = deps.session.ingestQueue
                  .then(() => handleFinalSegmentFast(text, deps, ws, enqueuePublish, publishEnglish, schedulePrefetch, receivedAt))
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
            await clearAndDeleteRoleCaches(deps);
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
    void clearAndDeleteRoleCaches(deps);
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
  const { enqueuePublish } = createEnqueuePublish(deps);

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
  viewerMessageType: 'caption' | 'caption-inserted',
  awaitingCorrection = false
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
      ...(awaitingCorrection ? { awaitingCorrection: true } : {}),
    });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}

// Writes the retained per-language translations into the cache, independent
// of whether the correction window is still open — a viewer who joins,
// reconnects, or switches language later should get the real translation from
// their backlog even after the live window has lapsed. Shared by
// sendCorrection's on-time path and scheduleCorrection's timed-out-but-
// eventually-arrived path below.
function cacheCorrectedTranslations(deps: WsServerDeps, line: CaptionLine, results: PreparedLanguageResult[]): void {
  for (const result of results) {
    deps.session.translationCache.set(
      result.language,
      line.id,
      result.flagged
        ? { translated: result.translated, flagged: true, reason: result.reason! }
        : { translated: result.translated, flagged: false }
    );
  }
}

// Delivers the single terminal message a deadline-shed line is owed. The cache
// is written regardless of the correction window — a viewer who joins,
// reconnects, or switches language later should get the real translation from
// their backlog — while the window governs only whether text is rewritten on a
// screen someone is currently reading. A message with no `translated` means
// "settle": clear the waiting state, leave the text alone.
function sendCorrection(
  deps: WsServerDeps,
  line: CaptionLine,
  results: PreparedLanguageResult[] | null,
  withinWindow: boolean
): void {
  // With no results (the translation ultimately failed, or hadn't arrived by
  // the time the correction window closed) there is nothing to cache and
  // nothing to upgrade, but every viewer still needs its waiting state
  // cleared — so settle each currently-active language.
  const languages = results ? results.map((result) => result.language) : deps.session.getActiveLanguages();

  if (results) cacheCorrectedTranslations(deps, line, results);

  for (const language of languages) {
    const result = results?.find((entry) => entry.language === language);

    // Only rewrite the viewer's text when there is genuinely something new to
    // show. A verification failure makes prepareTranslationsForPublish fall
    // back to the English we already published, which is a settle, not an
    // upgrade.
    const isUpgrade = result !== undefined && withinWindow && result.translated !== line.english;
    const payload = JSON.stringify({
      type: 'caption-corrected',
      id: line.id,
      ...(isUpgrade
        ? {
            translated: result.translated,
            ...(result.flagged ? { flagged: true, reason: result.reason } : {}),
          }
        : {}),
    });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}

// Waits for the retained translation and delivers the line's terminal
// message — but never waits past the correction window itself. Nothing in
// the translate+verify chain (raceAgainstDeadline included) ever cancels or
// times out the underlying LLM calls; raceAgainstDeadline only decides what
// to *publish* at the deadline. So an LLM call that hangs outright, rather
// than erroring, must not leave a viewer's waiting state stuck forever.
// Racing `preparedPromise` against the *remaining* window (from `shedAt`)
// guarantees exactly one terminal message even then. If the translation
// lands after the settle already went out, it is still cached — never pushed
// live — for future subscribers, per sendCorrection's cache-is-unconditional
// rule above.
//
// Gated on `sendPromise` — the ordered-send link for this line's own English
// caption — because the translation can resolve while that link is still
// queued behind other work, and a correction that overtook its own caption
// would patch a line the viewer does not have yet.
function scheduleCorrection(
  deps: WsServerDeps,
  line: CaptionLine,
  preparedPromise: Promise<PreparedLanguageResult[] | null>,
  shedAt: number,
  sendPromise: Promise<void>
): void {
  const sessionId = deps.session.id;
  void (async () => {
    try {
      await sendPromise;

      const remaining = deps.maxCorrectionLagMs - (Date.now() - shedAt);
      let results: PreparedLanguageResult[] | null;
      let timedOut: boolean;

      if (remaining <= 0) {
        results = null;
        timedOut = true;
      } else {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<typeof DEADLINE_REACHED>((resolve) => {
          timer = setTimeout(() => resolve(DEADLINE_REACHED), remaining);
        });
        try {
          // Neutralize a preparedPromise rejection into the race itself
          // (rather than a separate unguarded subscription) so a failed
          // translate/verify still settles instead of leaving this branch's
          // rejection unhandled.
          const outcome = await Promise.race([preparedPromise.catch(() => null), timeout]);
          timedOut = outcome === DEADLINE_REACHED;
          results = outcome === DEADLINE_REACHED ? null : outcome;
        } finally {
          clearTimeout(timer!);
        }
      }

      // A correction from a previous session must never patch a line in a new
      // one; Session.start() assigns a fresh id.
      if (deps.session.id !== sessionId) return;
      // Admin-removed while the translation was in flight — the viewer already
      // got line-removed, so there is no line left to correct.
      if (line.suppressed) return;

      sendCorrection(deps, line, results, !timedOut);

      if (timedOut) {
        // The translation may still land after the window closed (or never,
        // if it truly hung or failed outright) — cache it for future
        // subscribers if and when it does, re-checking the same guards at
        // that later point since a session restart or admin removal could
        // happen in the meantime too.
        void preparedPromise
          .then((lateResults) => {
            if (deps.session.id !== sessionId) return;
            if (line.suppressed) return;
            if (lateResults) cacheCorrectedTranslations(deps, line, lateResults);
          })
          .catch(() => {});
      }
    } catch {
      // sendPromise is not expected to reject here — ws's send() only throws
      // synchronously for a CONNECTING socket, and viewers are only
      // registered once OPEN — but every other promise in this file is
      // guarded against an unhandled rejection on principle, and this one is
      // no exception.
    }
  })();
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
  publishEnglish: (line: CaptionLine, viewerMessageType?: 'caption' | 'caption-inserted') => void,
  schedulePrefetch: (line: CaptionLine, precedingContext: string[]) => void,
  receivedAt: number
): Promise<void> {
  reportIngestLag(deps, Date.now() - receivedAt);

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

  const lagMs = deps.session.liveLag.lagMs(Date.now());
  reportLag(deps, lagMs);
  if (lagMs >= deps.maxPublishLagMs) {
    // Behind: skip translation entirely and publish the (already
    // transcription-verified) English now, so the live LLM budget frees up and
    // the pipeline catches up.
    void logEvent('warn', { event: 'caption_lag_shed', reason: 'ingest_backpressure', english, lagMs: Math.round(lagMs) });
    publishEnglish(line);
    return;
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
  items: VerificationItem[],
  provider: LlmProvider = deps.session.providers!.translationVerifier
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};
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
      translations = await deps.session.backlogProviders!.translation.translateBacklog(
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
    const verifications = await verifyTranslationsWithRetry(
      deps,
      verificationItems,
      deps.session.backlogProviders!.translationVerifier
    );

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
          const missingEntries = selectBacklogEntriesToTranslate(
            visibleEntries,
            (line) => cache.get(language, line.id) !== undefined,
            deps.viewerBacklogTranslateLimit
          );

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
