import { describe, it, expect, vi } from 'vitest';
import { GeminiProvider } from '../src/geminiProvider';
import type { GeminiClient } from '../src/gemini';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: { generateContent: vi.fn().mockResolvedValue({ text: responseText }) },
    caches: { create: vi.fn(), delete: vi.fn() },
  };
}

describe('GeminiProvider', () => {
  it('translate() delegates to translateSegment with the configured model and notes', async () => {
    const client = fakeClient('{"zh":"你好"}');
    const provider = new GeminiProvider(client, 'gemini-3.5-flash', 'custom notes');
    const result = await provider.translate('Hello', ['zh'], [], null);
    expect(result).toEqual({ zh: '你好' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.model).toBe('gemini-3.5-flash');
    expect(call.contents).toContain('custom notes');
  });

  it('translateBacklog() delegates to translateBacklog with the configured model and notes', async () => {
    const client = fakeClient('{"translations":["你好"]}');
    const provider = new GeminiProvider(client, 'gemini-3.1-flash-lite', 'custom notes');
    const result = await provider.translateBacklog(['Hello'], 'zh', null);
    expect(result).toEqual(['你好']);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('custom notes');
  });

  it('verifyTranscription() delegates to verifyTranscription with the configured model and notes', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    const provider = new GeminiProvider(client, 'gemini-3.1-flash-lite', 'custom transcription notes');
    const result = await provider.verifyTranscription('Hello', [], null);
    expect(result).toEqual({ safe: true, reason: '' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('custom transcription notes');
  });

  it('verifyTranslations() delegates to verifyTranslations with the configured model and notes', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""}}');
    const provider = new GeminiProvider(client, 'gemini-3.1-flash-lite', 'custom verifier notes');
    const result = await provider.verifyTranslations([{ id: 'zh', english: 'Hi', translated: '你好' }], null);
    expect(result).toEqual({ zh: { safe: true, reason: '' } });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('custom verifier notes');
  });
});
