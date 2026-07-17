import { ThinkingLevel } from '@google/genai';
import { describe, it, expect, vi } from 'vitest';
import { translateSegment, translateBacklog, type GeminiClient } from '../src/gemini';
import { TRANSLATION_DEFAULT_NOTES } from '../src/llmPrompts';

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

describe('translateSegment', () => {
  it('returns parsed translations for the requested languages', async () => {
    const client = fakeClient('{"zh":"你好","ko":"안녕"}');
    const result = await translateSegment(client, MODEL, 'Hello', ['zh', 'ko'], TRANSLATION_DEFAULT_NOTES);
    expect(result).toEqual({ zh: '你好', ko: '안녕' });
  });

  it('skips the API call and returns an empty object when no languages are active', async () => {
    const client = fakeClient('{}');
    const result = await translateSegment(client, MODEL, 'Hello', [], TRANSLATION_DEFAULT_NOTES);
    expect(result).toEqual({});
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('includes Australian slang context and polarity-preservation guidance in the prompt when uncached', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, "G'day mate, no worries", ['zh'], TRANSLATION_DEFAULT_NOTES);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('Preserve polarity and negation exactly');
  });

  it('includes preceding context as reference-only lines when provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'How are you', ['zh'], TRANSLATION_DEFAULT_NOTES, ['Hello everyone', 'Welcome to church']);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Hello everyone');
    expect(call.contents).toContain('Welcome to church');
    expect(call.contents).toContain('do not translate these');
  });

  it('produces an unchanged prompt when no preceding context is given and no cache is used', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toBe(
      'Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: zh. Keep the tone natural and spoken, not overly formal.\n\n' +
        'This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she\'ll be right," "having a go"). Translate for the speaker\'s intended meaning and tone, not word-for-word — don\'t flatten idiomatic phrasing into something overly formal, and don\'t translate slang literally into an unrelated meaning.\n\n' +
        'Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don\'t add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.\n\n' +
        'Sentence: "Hello"'
    );
  });

  it('includes cachedContent in the request config when a cache ref is provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES, [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
  });

  it('omits cachedContent from the request config when no cache ref is provided', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBeUndefined();
  });

  it('omits the notes and fixed-rules text from contents when a cache ref is provided, since the cache already carries them', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES, [], { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).not.toContain('Australian slang');
    expect(call.contents).not.toContain('Preserve polarity and negation exactly');
  });

  it('passes the given model through to generateContent', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, 'gemini-3.5-flash', 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.model).toBe('gemini-3.5-flash');
  });

  it('pins thinkingLevel to MINIMAL for gemini-3.5-flash, which otherwise defaults to slower medium-effort thinking', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, 'gemini-3.5-flash', 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
  });

  it('omits thinkingConfig for gemini-3.1-flash-lite, which already defaults to its fastest thinking level', async () => {
    const client = fakeClient('{"zh":"你好"}');
    await translateSegment(client, MODEL, 'Hello', ['zh'], TRANSLATION_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.thinkingConfig).toBeUndefined();
  });
});

describe('translateBacklog', () => {
  it('returns translations in the same order as the input lines', async () => {
    const client = fakeClient('{"translations":["你好","再见"]}');
    const result = await translateBacklog(client, MODEL, ['Hello', 'Goodbye'], 'zh', TRANSLATION_DEFAULT_NOTES);
    expect(result).toEqual(['你好', '再见']);
  });

  it('skips the API call and returns an empty array for an empty backlog', async () => {
    const client = fakeClient('{"translations":[]}');
    const result = await translateBacklog(client, MODEL, [], 'zh', TRANSLATION_DEFAULT_NOTES);
    expect(result).toEqual([]);
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('includes Australian slang context and polarity-preservation guidance in the prompt when uncached', async () => {
    const client = fakeClient('{"translations":["你好"]}');
    await translateBacklog(client, MODEL, ["G'day mate, no worries"], 'zh', TRANSLATION_DEFAULT_NOTES);

    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.contents).toContain('Australian slang');
    expect(call.contents).toContain('Preserve polarity and negation exactly');
  });

  it('includes cachedContent in the request config when a cache ref is provided', async () => {
    const client = fakeClient('{"translations":["你好"]}');
    await translateBacklog(client, MODEL, ['Hello'], 'zh', TRANSLATION_DEFAULT_NOTES, { name: 'cachedContents/abc' });
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.cachedContent).toBe('cachedContents/abc');
    expect(call.contents).not.toContain('Australian slang');
  });

  it('pins thinkingLevel to MINIMAL for gemini-3.5-flash', async () => {
    const client = fakeClient('{"translations":["你好"]}');
    await translateBacklog(client, 'gemini-3.5-flash', ['Hello'], 'zh', TRANSLATION_DEFAULT_NOTES);
    const call = (client.models.generateContent as any).mock.calls[0][0];
    expect(call.config.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
  });
});
