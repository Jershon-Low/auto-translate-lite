import { describe, it, expect, vi } from 'vitest';
import { getProvider } from '../src/llmRegistry';
import { GeminiProvider } from '../src/geminiProvider';
import type { GeminiClient } from '../src/gemini';

function fakeClient(): GeminiClient {
  return {
    models: { generateContent: vi.fn() },
    caches: { create: vi.fn(), delete: vi.fn() },
  };
}

describe('getProvider', () => {
  it('returns a GeminiProvider for gemini-3.1-flash-lite', () => {
    const provider = getProvider('gemini-3.1-flash-lite', 'notes', fakeClient());
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('returns a GeminiProvider for gemini-3.5-flash', () => {
    const provider = getProvider('gemini-3.5-flash', 'notes', fakeClient());
    expect(provider).toBeInstanceOf(GeminiProvider);
  });
});
