import { describe, it, expect, vi } from 'vitest';
import { verifyTranscription } from '../src/transcriptionVerifier';
import type { GeminiClient } from '../src/gemini';

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
    const client = fakeClient('{"safe":true,"reason":"plausible statement"}');
    const result = await verifyTranscription(client, 'Jesus loves you');
    expect(result).toEqual({ safe: true, reason: 'plausible statement' });
  });

  it('returns safe:false for a flagged line', async () => {
    const client = fakeClient(
      '{"safe":false,"reason":"likely mis-heard: negates a core statement about Jesus"}'
    );
    const result = await verifyTranscription(client, 'Jesus is not the son of God');
    expect(result).toEqual({
      safe: false,
      reason: 'likely mis-heard: negates a core statement about Jesus',
    });
  });

  it('includes Australian slang guidance so idiomatic lines are not penalized', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, "No worries, she'll be right");
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
  });

  it('includes preceding context as reference-only lines when provided', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, 'He rose again', [
      'Jesus died on the cross',
      'Three days later',
    ]);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Jesus died on the cross');
    expect(call.contents).toContain('Three days later');
  });

  it('produces a prompt marker that cannot collide with the translation verifier', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, 'Hello');
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('safety checker');
    expect(call.contents).toContain('transcription accuracy checker');
  });

  it('includes cachedContent in the request config when a sermon cache is provided', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, 'Hello', [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('omits cachedContent from the request config when no sermon cache is provided', async () => {
    const client = fakeClient('{"safe":true,"reason":"ok"}');
    await verifyTranscription(client, 'Hello');
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });

  it('throws when the response is not valid JSON, so the caller can retry/fail-safe', async () => {
    const client = fakeClient('not json');
    await expect(verifyTranscription(client, 'Hello')).rejects.toThrow();
  });

  it('treats a well-formed but incomplete JSON response as unsafe', async () => {
    const client = fakeClient('{"unexpected":"shape"}');
    const result = await verifyTranscription(client, 'Hello');
    expect(result).toEqual({ safe: false, reason: 'malformed response' });
  });
});
