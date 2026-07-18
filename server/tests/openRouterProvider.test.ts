import { describe, it, expect, vi } from 'vitest';
import { OpenRouterProvider } from '../src/openRouterProvider';
import type { OpenRouterClient } from '../src/openRouterClient';

function fakeClient(content: string): OpenRouterClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }),
      },
    },
  };
}

describe('OpenRouterProvider', () => {
  it('translate() sends the model, a system message with cache_control containing the notes, and a json_schema response_format', async () => {
    const client = fakeClient('{"zh":"你好"}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'custom notes');
    const result = await provider.translate('Hello', ['zh'], [], null);
    expect(result).toEqual({ zh: '你好' });

    const call = (client.chat.completions.create as any).mock.calls[0][0];
    expect(call.model).toBe('qwen/qwen3.6-flash');
    expect(call.messages[0].role).toBe('system');
    expect(call.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(call.messages[0].content[0].text).toContain('custom notes');
    expect(call.messages[1].role).toBe('user');
    expect(call.messages[1].content).toContain('Hello');
    expect(call.response_format.type).toBe('json_schema');
  });

  it('skips the API call and returns an empty object when no languages are active', async () => {
    const client = fakeClient('{}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.translate('Hello', [], [], null);
    expect(result).toEqual({});
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('translateBacklog() returns translations in the same order as the input lines', async () => {
    const client = fakeClient('{"translations":["你好","再见"]}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.translateBacklog(['Hello', 'Goodbye'], 'zh', null);
    expect(result).toEqual(['你好', '再见']);
  });

  it('translateBacklog() skips the API call and returns an empty array for an empty backlog', async () => {
    const client = fakeClient('{"translations":[]}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.translateBacklog([], 'zh', null);
    expect(result).toEqual([]);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('verifyTranscription() returns the parsed safe/reason result', async () => {
    const client = fakeClient('{"safe":true,"reason":""}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.verifyTranscription('Jesus loves you', [], null);
    expect(result).toEqual({ safe: true, reason: '' });
  });

  it('verifyTranscription() treats a well-formed but incomplete response as unsafe', async () => {
    const client = fakeClient('{"unexpected":"shape"}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.verifyTranscription('Hello', [], null);
    expect(result).toEqual({ safe: false, reason: 'malformed response' });
  });

  it('verifyTranslations() batches every item into a single call', async () => {
    const client = fakeClient('{"zh":{"safe":true,"reason":""},"ko":{"safe":true,"reason":""}}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.verifyTranslations(
      [
        { id: 'zh', english: 'Hello', translated: '你好' },
        { id: 'ko', english: 'Hello', translated: '안녕' },
      ],
      null
    );
    expect(result).toEqual({ zh: { safe: true, reason: '' }, ko: { safe: true, reason: '' } });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('verifyTranslations() skips the API call and returns an empty object when there are no items', async () => {
    const client = fakeClient('{}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    const result = await provider.verifyTranslations([], null);
    expect(result).toEqual({});
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('retries once with json_object mode when the model rejects json_schema response_format, keeping the same system message', async () => {
    const client: OpenRouterClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(new Error('400 Invalid parameter: response_format is not supported for this model'))
            .mockResolvedValueOnce({ choices: [{ message: { content: '{"zh":"你好"}' } }] }),
        },
      },
    };
    const provider = new OpenRouterProvider(client, 'some-model', 'custom notes');
    const result = await provider.translate('Hello', ['zh'], [], null);
    expect(result).toEqual({ zh: '你好' });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    const secondCall = (client.chat.completions.create as any).mock.calls[1][0];
    expect(secondCall.response_format).toEqual({ type: 'json_object' });
    expect(secondCall.messages[0].content[0].text).toContain('custom notes');
  });

  it('does not retry and rethrows when the failure is unrelated to response_format support', async () => {
    const client: OpenRouterClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
        },
      },
    };
    const provider = new OpenRouterProvider(client, 'some-model', 'notes');
    await expect(provider.translate('Hello', ['zh'], [], null)).rejects.toThrow('401 Unauthorized');
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('includes reasoning.effort in the request when configured', async () => {
    const client = fakeClient('{"zh":"你好"}');
    const provider = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes', 'high');
    await provider.translate('Hello', ['zh'], [], null);
    const call = (client.chat.completions.create as any).mock.calls[0][0];
    expect(call.reasoning).toEqual({ effort: 'high' });
  });

  it('omits the reasoning key when reasoning is "off" or unset', async () => {
    const client = fakeClient('{"zh":"你好"}');
    const providerOff = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes', 'off');
    await providerOff.translate('Hello', ['zh'], [], null);
    const offCall = (client.chat.completions.create as any).mock.calls[0][0];
    expect(offCall.reasoning).toBeUndefined();

    const providerUnset = new OpenRouterProvider(client, 'qwen/qwen3.6-flash', 'notes');
    await providerUnset.translate('Hello', ['zh'], [], null);
    const unsetCall = (client.chat.completions.create as any).mock.calls[1][0];
    expect(unsetCall.reasoning).toBeUndefined();
  });

  it('includes reasoning.effort in the json_object fallback retry as well', async () => {
    const client: OpenRouterClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(new Error('400 Invalid parameter: response_format is not supported for this model'))
            .mockResolvedValueOnce({ choices: [{ message: { content: '{"zh":"你好"}' } }] }),
        },
      },
    };
    const provider = new OpenRouterProvider(client, 'some-model', 'notes', 'medium');
    await provider.translate('Hello', ['zh'], [], null);
    const secondCall = (client.chat.completions.create as any).mock.calls[1][0];
    expect(secondCall.reasoning).toEqual({ effort: 'medium' });
  });
});
