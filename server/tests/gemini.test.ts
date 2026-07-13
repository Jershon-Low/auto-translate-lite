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

  it('includes preceding context as reference-only lines when provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, 'How are you', ['zh'], ['Hello everyone', 'Welcome to church']);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Hello everyone');
    expect(call.contents).toContain('Welcome to church');
    expect(call.contents).toContain('do not translate these');
  });

  it('produces an unchanged prompt when no preceding context is given', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, 'Hello', ['zh']);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toBe(
      'Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: zh. Keep the tone natural and spoken, not overly formal.\n\n' +
        'This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she\'ll be right," "having a go"). Translate for the speaker\'s intended meaning and tone, not word-for-word — don\'t flatten idiomatic phrasing into something overly formal, and don\'t translate slang literally into an unrelated meaning.\n\n' +
        'Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don\'t add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.\n\n' +
        'Sentence: "Hello"'
    );
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
