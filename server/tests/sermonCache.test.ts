import { describe, it, expect, vi } from 'vitest';
import {
  buildSermonContextInstruction,
  createSermonContextCache,
  deleteSermonContextCache,
} from '../src/sermonCache';
import type { GeminiClient } from '../src/gemini';

function fakeClientWithCaches(
  overrides: { createResult?: { name?: string }; createError?: Error } = {}
): GeminiClient {
  return {
    models: { generateContent: vi.fn() },
    caches: {
      create: vi.fn().mockImplementation(() => {
        if (overrides.createError) return Promise.reject(overrides.createError);
        return Promise.resolve(overrides.createResult ?? { name: 'cachedContents/abc123' });
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('buildSermonContextInstruction', () => {
  it('labels and includes both feedback and sermon sections when both are present', () => {
    const instruction = buildSermonContextInstruction(
      'Cain should be 该隐 in Chinese',
      'Today we talk about Cain and Abel.'
    );
    expect(instruction).toContain('Known corrections from past sessions');
    expect(instruction).toContain('Cain should be 该隐');
    expect(instruction).toContain("This week's sermon material");
    expect(instruction).toContain('Cain and Abel');
  });

  it('omits the feedback section when feedback text is empty', () => {
    const instruction = buildSermonContextInstruction('', 'Sermon content here.');
    expect(instruction).not.toContain('Known corrections from past sessions');
    expect(instruction).toContain('Sermon content here.');
  });
});

describe('createSermonContextCache', () => {
  it('creates a cache and returns its name when content is long enough', async () => {
    const client = fakeClientWithCaches({ createResult: { name: 'cachedContents/xyz' } });
    const ref = await createSermonContextCache(client, '', 'A'.repeat(500));
    expect(ref).toEqual({ name: 'cachedContents/xyz' });
    expect(client.caches.create).toHaveBeenCalledTimes(1);
  });

  it('returns null without calling the API when combined content is too short to cache', async () => {
    const client = fakeClientWithCaches();
    const ref = await createSermonContextCache(client, '', 'short');
    expect(ref).toBeNull();
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('returns null and logs when cache creation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClientWithCaches({ createError: new Error('API down') });
    const ref = await createSermonContextCache(client, '', 'A'.repeat(500));
    expect(ref).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('deleteSermonContextCache', () => {
  it('deletes the cache by name when a ref is provided', async () => {
    const client = fakeClientWithCaches();
    await deleteSermonContextCache(client, { name: 'cachedContents/xyz' });
    expect(client.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/xyz' });
  });

  it('does nothing when the ref is null', async () => {
    const client = fakeClientWithCaches();
    await deleteSermonContextCache(client, null);
    expect(client.caches.delete).not.toHaveBeenCalled();
  });
});
