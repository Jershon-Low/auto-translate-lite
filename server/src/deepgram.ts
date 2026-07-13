import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

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
    encoding: 'opus',
    mimetype: 'audio/webm',
    keyterm: ['Planetshakers'],
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data: DeepgramTranscriptEvent) => {
    const finalText = extractFinalTranscript(data);
    if (finalText) callbacks.onFinalSegment(finalText);
  });

  connection.on(LiveTranscriptionEvents.Error, (error: Error) => callbacks.onError(error));
  connection.on(LiveTranscriptionEvents.Close, () => callbacks.onClose());

  return {
    send: (data: Buffer) => connection.send(data as unknown as ArrayBufferLike),
    finish: () => connection.finish(),
  };
}

export type DeepgramConnectionFactory = typeof createDeepgramConnection;
