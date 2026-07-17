import { ThinkingLevel } from '@google/genai';
import { describe, it, expect, vi } from 'vitest';
import { verifyTranslations } from '../src/translationVerifier';
import type { GeminiClient } from '../src/gemini';
import { TRANSLATION_VERIFIER_DEFAULT_NOTES } from '../src/llmPrompts';

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

describe('verifyTranslations', () => {
  it('returns safe:true results parsed from the model response', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    const result = await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Jesus loves you', translated: '耶稣爱你' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES
    );
    expect(result).toEqual({ zh: { safe: true, reason: '' } });
  });

  it('returns safe:false results for a flagged translation', async () => {
    const client = fakeClient('{"zh":{"safe":false,"reason":"polarity flip: negates original meaning"}}');
    const result = await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Jesus loves you', translated: '耶稣不爱你' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES
    );
    expect(result).toEqual({ zh: { safe: false, reason: 'polarity flip: negates original meaning' } });
  });

  it('pins thinkingLevel to LOW for gemini-3.5-flash but omits it for gemini-3.1-flash-lite', async () => {
    const items = [{ id: 'zh', english: 'Jesus loves you', translated: '耶稣爱你' }];

    const fastClient = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(fastClient, 'gemini-3.5-flash', items, TRANSLATION_VERIFIER_DEFAULT_NOTES);
    expect((fastClient.models.generateContent as any).mock.calls[0][0].config.thinkingConfig).toEqual({
      thinkingLevel: ThinkingLevel.LOW,
    });

    const liteClient = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(liteClient, MODEL, items, TRANSLATION_VERIFIER_DEFAULT_NOTES);
    expect((liteClient.models.generateContent as any).mock.calls[0][0].config.thinkingConfig).toBeUndefined();
  });

  it('batches every item into a single generateContent call', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""},"ko":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [
        { id: 'zh', english: 'Hello', translated: '你好' },
        { id: 'ko', english: 'Hello', translated: '안녕' },
      ],
      TRANSLATION_VERIFIER_DEFAULT_NOTES
    );
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('includes Australian slang guidance and the leave-reason-empty-when-safe instruction when uncached', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'No worries', translated: '没问题' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES
    );
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('set reason to an empty string');
  });

  it('skips the API call and returns an empty object when there are no items', async () => {
    const client = fakeClient('{}');
    const result = await verifyTranslations(client, MODEL, [], TRANSLATION_VERIFIER_DEFAULT_NOTES);
    expect(result).toEqual({});
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('includes cachedContent in the request config when a cache ref is provided', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Hello', translated: '你好' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES,
      { name: 'cachedContents/abc' }
    );
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('does not duplicate the routing marker sentence when no cache ref is provided, keeping contents byte-identical to the pre-refactor prompt', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Hello', translated: '你好' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES
    );
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('This is a safety checker');
    expect(call.contents.startsWith('You are a safety checker')).toBe(true);
  });

  it('still contains the safety-checker marker substring when a cache ref is provided, so response routing keeps working', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Hello', translated: '你好' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES,
      { name: 'cachedContents/abc' }
    );
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('safety checker');
  });

  it('omits notes and fixed rules from contents when a cache ref is provided', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(
      client,
      MODEL,
      [{ id: 'zh', english: 'Hello', translated: '你好' }],
      TRANSLATION_VERIFIER_DEFAULT_NOTES,
      { name: 'cachedContents/abc' }
    );
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('Australian slang');
  });

  it('omits cachedContent from the request config when no cache ref is provided', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    await verifyTranslations(client, MODEL, [{ id: 'zh', english: 'Hello', translated: '你好' }], TRANSLATION_VERIFIER_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });
});
