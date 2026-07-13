import { describe, it, expect, vi } from 'vitest';
import { translateSegment, translateBacklog, type GeminiClient } from '../src/gemini';

function fakeClient(responseText: string): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: responseText }),
    },
  };
}

describe('translateSegment', () => {
  it('returns parsed translations for the requested languages', async () => {
    const client = fakeClient('{"zh":"你好","ko":"안녕"}');
    const result = await translateSegment(client, 'Hello', ['zh', 'ko']);
    expect(result).toEqual({ zh: '你好', ko: '안녕' });
  });

  it('skips the API call and returns an empty object when no languages are active', async () => {
    const client = fakeClient('{}');
    const result = await translateSegment(client, 'Hello', []);
    expect(result).toEqual({});
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('includes Australian slang context and polarity-preservation guidance in the prompt', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, "G'day mate, no worries", ['zh']);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('Preserve polarity and negation exactly');
  });
});

describe('translateBacklog', () => {
  it('returns translations in the same order as the input lines', async () => {
    const client = fakeClient('{"translations":["你好","再见"]}');
    const result = await translateBacklog(client, ['Hello', 'Goodbye'], 'zh');
    expect(result).toEqual(['你好', '再见']);
  });

  it('skips the API call and returns an empty array for an empty backlog', async () => {
    const client = fakeClient('{"translations":[]}');
    const result = await translateBacklog(client, [], 'zh');
    expect(result).toEqual([]);
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('includes Australian slang context and polarity-preservation guidance in the prompt', async () => {
    const client = fakeClient('{"translations":["你好"]}');
    await translateBacklog(client, ["G'day mate, no worries"], 'zh');

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('Preserve polarity and negation exactly');
  });
});
