import { describe, it, expect } from 'vitest';
import { extractFinalTranscript, createUtteranceRouter } from '../src/deepgram';

describe('extractFinalTranscript', () => {
  it('returns the transcript when is_final is true and text is non-empty', () => {
    const event = { is_final: true, channel: { alternatives: [{ transcript: 'Hello there' }] } };
    expect(extractFinalTranscript(event)).toBe('Hello there');
  });

  it('returns null for interim (non-final) results', () => {
    const event = { is_final: false, channel: { alternatives: [{ transcript: 'Hello' }] } };
    expect(extractFinalTranscript(event)).toBeNull();
  });

  it('returns null for a final result with empty transcript', () => {
    const event = { is_final: true, channel: { alternatives: [{ transcript: '   ' }] } };
    expect(extractFinalTranscript(event)).toBeNull();
  });

  it('returns null when there are no alternatives', () => {
    const event = { is_final: true, channel: { alternatives: [] } };
    expect(extractFinalTranscript(event)).toBeNull();
  });
});

describe('createUtteranceRouter', () => {
  it('joins multiple is_final chunks and emits them together when speech_final arrives', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'Hello' }] } });
    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'there friend' }] } });
    router.handleTranscriptEvent({
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'how are you' }] },
    });

    expect(segments).toEqual(['Hello there friend how are you']);
  });

  it('ignores interim (non-final) chunks', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleTranscriptEvent({ is_final: false, channel: { alternatives: [{ transcript: 'Hel' }] } });
    router.handleTranscriptEvent({
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'Hello' }] },
    });

    expect(segments).toEqual(['Hello']);
  });

  it('flushes the accumulated buffer on UtteranceEnd even without speech_final', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'Partial thought' }] } });
    router.handleUtteranceEnd();

    expect(segments).toEqual(['Partial thought']);
  });

  it('force-flushes after maxWaitMs elapses with no natural pause', async () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text), { maxWaitMs: 30 });

    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'Still going' }] } });
    expect(segments).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(segments).toEqual(['Still going']);
  });

  it('flushRemaining emits any buffered text (used when the connection finishes)', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleTranscriptEvent({ is_final: true, channel: { alternatives: [{ transcript: 'Trailing words' }] } });
    router.flushRemaining();

    expect(segments).toEqual(['Trailing words']);
  });

  it('does not emit an empty segment when flushed with nothing buffered', () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text));

    router.handleUtteranceEnd();
    router.flushRemaining();

    expect(segments).toEqual([]);
  });

  it('clears the safety timer after a speech_final flush so it does not fire twice', async () => {
    const segments: string[] = [];
    const router = createUtteranceRouter((text) => segments.push(text), { maxWaitMs: 30 });

    router.handleTranscriptEvent({
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'Complete sentence.' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(segments).toEqual(['Complete sentence.']);
  });
});
