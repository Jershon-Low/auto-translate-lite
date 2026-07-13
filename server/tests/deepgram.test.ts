import { describe, it, expect } from 'vitest';
import { extractFinalTranscript } from '../src/deepgram';

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
