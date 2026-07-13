import { describe, it, expect, vi } from 'vitest';
import { verifyTranslations } from '../src/translationVerifier';
import type { GeminiClient } from '../src/gemini';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: responseText }),
    },
  };
}

describe('verifyTranslations', () => {
  it('returns safe:true results parsed from the model response', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":"meaning preserved"}}');
    const result = await verifyTranslations(client, [
      { id: 'zh', english: 'Jesus loves you', translated: '耶稣爱你' },
    ]);
    expect(result).toEqual({ zh: { safe: true, reason: 'meaning preserved' } });
  });

  it('returns safe:false results for a flagged translation', async () => {
    const client = fakeClient('{"zh":{"safe":false,"reason":"polarity flip: negates original meaning"}}');
    const result = await verifyTranslations(client, [
      { id: 'zh', english: 'Jesus loves you', translated: '耶稣不爱你' },
    ]);
    expect(result).toEqual({ zh: { safe: false, reason: 'polarity flip: negates original meaning' } });
  });

  it('batches every item into a single generateContent call', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":"ok"},"ko":{"safe":true,"reason":"ok"}}');
    await verifyTranslations(client, [
      { id: 'zh', english: 'Hello', translated: '你好' },
      { id: 'ko', english: 'Hello', translated: '안녕' },
    ]);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('includes Australian slang guidance so idiomatic translations are not penalized', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":"ok"}}');
    await verifyTranslations(client, [{ id: 'zh', english: 'No worries', translated: '没问题' }]);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
  });

  it('skips the API call and returns an empty object when there are no items', async () => {
    const client = fakeClient('{}');
    const result = await verifyTranslations(client, []);
    expect(result).toEqual({});
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });
});
