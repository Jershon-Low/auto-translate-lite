import { ThinkingLevel } from '@google/genai';
import { describe, it, expect, vi } from 'vitest';
import { verifyTranscription } from '../src/transcriptionVerifier';
import type { GeminiClient } from '../src/gemini';
import { TRANSCRIPTION_VERIFIER_DEFAULT_NOTES } from '../src/llmPrompts';

const MODEL = 'gemini-3.1-flash-lite';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: responseText }),
    },
    caches: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe('verifyTranscription', () => {
  it('returns safe:true parsed from the model response', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    const result = await verifyTranscription(client, MODEL, 'Jesus loves you', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    expect(result).toEqual({ safe: true, reason: '' });
  });

  it('returns safe:false for a flagged line', async () => {
    const client = fakeClient(
      '{"safe":false,"reason":"likely mis-heard: negates a core statement about Jesus"}'
    );
    const result = await verifyTranscription(client, MODEL, 'Jesus is not the son of God', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    expect(result).toEqual({
      safe: false,
      reason: 'likely mis-heard: negates a core statement about Jesus',
    });
  });

  it('pins thinkingLevel to LOW for gemini-3.5-flash but omits it for gemini-3.1-flash-lite', async () => {
    const fastClient = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(fastClient, 'gemini-3.5-flash', 'Jesus loves you', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    expect((fastClient.models.generateContent as any).mock.calls[0][0].config.thinkingConfig).toEqual({
      thinkingLevel: ThinkingLevel.LOW,
    });

    const liteClient = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(liteClient, MODEL, 'Jesus loves you', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    expect((liteClient.models.generateContent as any).mock.calls[0][0].config.thinkingConfig).toBeUndefined();
  });

  it('includes Australian slang guidance and the leave-reason-empty-when-safe instruction when uncached', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, "No worries, she'll be right", TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('set reason to an empty string');
  });

  it('includes preceding context as reference-only lines when provided', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'He rose again', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES, [
      'Jesus died on the cross',
      'Three days later',
    ]);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Jesus died on the cross');
    expect(call.contents).toContain('Three days later');
  });

  it('produces a prompt marker that cannot collide with the translation verifier', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('safety checker');
    expect(call.contents).toContain('transcription accuracy checker');
  });

  it('does not duplicate the routing marker sentence when no cache ref is provided, keeping contents byte-identical to the pre-refactor prompt', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('This is a transcription accuracy checker');
    expect(call.contents.startsWith('You are a transcription accuracy checker')).toBe(true);
  });

  it('still contains the transcription-accuracy-checker marker substring when a cache ref is provided, so response routing keeps working', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES, [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('transcription accuracy checker');
  });

  it('includes cachedContent in the request config when a cache ref is provided', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES, [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('omits notes and fixed rules from contents when a cache ref is provided', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES, [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('Australian slang');
    expect(call.contents).not.toContain('Naming Notes');
  });

  it('omits cachedContent from the request config when no cache ref is provided', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });

  it('throws when the response is not valid JSON, so the caller can retry/fail-safe', async () => {
    const client = fakeClient('not json');
    await expect(verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES)).rejects.toThrow();
  });

  it('treats a well-formed but incomplete JSON response as unsafe', async () => {
    const client = fakeClient('{"unexpected":"shape"}');
    const result = await verifyTranscription(client, MODEL, 'Hello', TRANSCRIPTION_VERIFIER_DEFAULT_NOTES);
    expect(result).toEqual({ safe: false, reason: 'malformed response' });
  });
});
