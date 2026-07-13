import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

export interface DeepgramTranscriptEvent {
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

export function extractFinalTranscript(event: DeepgramTranscriptEvent): string | null {
  const transcript = event.channel?.alternatives?.[0]?.transcript ?? '';
  if (event.is_final && transcript.trim().length > 0) {
    return transcript.trim();
  }
  return null;
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
