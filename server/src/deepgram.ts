import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { logEvent } from './logger.js';

export interface DeepgramTranscriptEvent {
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

export function extractFinalTranscript(event: DeepgramTranscriptEvent): string | null {
  const transcript = event.channel?.alternatives?.[0]?.transcript ?? '';
  if (event.is_final && transcript.trim().length > 0) {
    return transcript.trim();
  }
  return null;
}

const DEFAULT_MAX_UTTERANCE_WAIT_MS = 5000;

export class UtteranceAccumulator {
  private pieces: string[] = [];

  addChunk(text: string): void {
    this.pieces.push(text);
  }

  hasPending(): boolean {
    return this.pieces.length > 0;
  }

  flush(): string {
    const text = this.pieces.join(' ').trim();
    this.pieces = [];
    return text;
  }
}

export interface UtteranceRouterOptions {
  maxWaitMs?: number;
}

export interface UtteranceRouter {
  handleTranscriptEvent(data: DeepgramTranscriptEvent): void;
  handleUtteranceEnd(): void;
  flushRemaining(): void;
}

export function createUtteranceRouter(
  onFinalSegment: (text: string) => void,
  options: UtteranceRouterOptions = {}
): UtteranceRouter {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_UTTERANCE_WAIT_MS;
  const accumulator = new UtteranceAccumulator();
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSafetyTimer(): void {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  }

  function flush(): void {
    clearSafetyTimer();
    const text = accumulator.flush();
    if (text.length > 0) onFinalSegment(text);
  }

  return {
    handleTranscriptEvent(data: DeepgramTranscriptEvent): void {
      const chunk = extractFinalTranscript(data);
      if (chunk) {
        const isNewUtterance = !accumulator.hasPending();
        accumulator.addChunk(chunk);
        if (isNewUtterance) {
          safetyTimer = setTimeout(flush, maxWaitMs);
        }
      }
      if (data.speech_final) flush();
    },
    handleUtteranceEnd(): void {
      flush();
    },
    flushRemaining(): void {
      flush();
    },
  };
}

export interface DeepgramCallbacks {
  onFinalSegment: (text: string) => void;
  onError: (error: Error) => void;
  onClose: () => void;
  // Fires when the live connection has finished opening and is ready to
  // receive audio. Callers use this to avoid streaming (and dropping) audio —
  // notably the WebM header chunk — before Deepgram can accept it.
  onOpen?: () => void;
}

export interface DeepgramConnection {
  send(data: Buffer): void;
  finish(): void;
}

export function createDeepgramConnection(
  apiKey: string,
  callbacks: DeepgramCallbacks
): DeepgramConnection {
  const deepgram = createClient(apiKey);
  const connection = deepgram.listen.live({
    model: 'nova-3',
    language: 'en',
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 1000,
    encoding: 'opus',
    mimetype: 'audio/webm',
    keyterm: ['Planetshakers', 'CIEL'],
  });

  const router = createUtteranceRouter(callbacks.onFinalSegment);

  connection.on(LiveTranscriptionEvents.Transcript, (data: DeepgramTranscriptEvent) => {
    router.handleTranscriptEvent(data);
  });
  connection.on(LiveTranscriptionEvents.UtteranceEnd, () => router.handleUtteranceEnd());
  connection.on(LiveTranscriptionEvents.Error, (error: Error) => callbacks.onError(error));
  connection.on(LiveTranscriptionEvents.Close, () => callbacks.onClose());
  connection.on(LiveTranscriptionEvents.Open, () => callbacks.onOpen?.());

  // --- TEMP DIAGNOSTIC (remove after debugging localhost transcription) ---
  // Extra passive listeners: they log the raw Deepgram lifecycle without
  // altering the callback behaviour above, so we can see whether the live
  // connection opens, what it sends back, and why it closes (e.g. net0000).
  let dgTranscriptEvents = 0;
  connection.on(LiveTranscriptionEvents.Open, () => {
    void logEvent('info', { event: 'dg_diag_open' });
  });
  connection.on(LiveTranscriptionEvents.Metadata, (m: unknown) => {
    void logEvent('info', { event: 'dg_diag_metadata', meta: JSON.stringify(m).slice(0, 300) });
  });
  connection.on(LiveTranscriptionEvents.Transcript, (data: DeepgramTranscriptEvent) => {
    dgTranscriptEvents += 1;
    const t = data.channel?.alternatives?.[0]?.transcript ?? '';
    if (dgTranscriptEvents <= 3 || t.trim().length > 0) {
      void logEvent('info', {
        event: 'dg_diag_transcript',
        n: dgTranscriptEvents,
        is_final: data.is_final ?? null,
        text: t.slice(0, 120),
      });
    }
  });
  connection.on(LiveTranscriptionEvents.Error, (error: unknown) => {
    void logEvent('error', { event: 'dg_diag_error', error: JSON.stringify(error)?.slice(0, 400) });
  });
  connection.on(LiveTranscriptionEvents.Close, (event: { code?: number; reason?: string } = {}) => {
    void logEvent('warn', {
      event: 'dg_diag_close',
      code: event.code ?? null,
      reason: event.reason ?? null,
      transcriptEventsReceived: dgTranscriptEvents,
    });
  });
  // --- END TEMP DIAGNOSTIC ---

  return {
    send: (data: Buffer) => connection.send(data as unknown as ArrayBufferLike),
    finish: () => {
      router.flushRemaining();
      connection.finish();
    },
  };
}

export type DeepgramConnectionFactory = typeof createDeepgramConnection;
