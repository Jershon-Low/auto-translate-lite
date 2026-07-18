import { describe, it, expect, vi } from 'vitest';
import { getProvider, type LlmClients } from '../src/llmRegistry';
import { GeminiProvider } from '../src/geminiProvider';
import { OpenRouterProvider } from '../src/openRouterProvider';
import type { GeminiClient } from '../src/gemini';
import type { OpenRouterClient } from '../src/openRouterClient';

function fakeGeminiClient(): GeminiClient {
  return {
    models: { generateContent: vi.fn() },
    caches: { create: vi.fn(), delete: vi.fn() },
  };
}

function fakeOpenRouterClient(): OpenRouterClient {
  return { chat: { completions: { create: vi.fn() } } };
}

describe('getProvider', () => {
  it('returns a GeminiProvider for a gemini selection', () => {
    const clients: LlmClients = { gemini: fakeGeminiClient(), openRouter: null };
    const provider = getProvider({ provider: 'gemini', model: 'gemini-3.1-flash-lite' }, 'notes', clients);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('returns an OpenRouterProvider for an openrouter selection when an OpenRouter client is configured', () => {
    const clients: LlmClients = { gemini: fakeGeminiClient(), openRouter: fakeOpenRouterClient() };
    const provider = getProvider({ provider: 'openrouter', model: 'qwen/qwen3.6-flash' }, 'notes', clients);
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it('throws when an openrouter selection is requested but no OpenRouter client is configured', () => {
    const clients: LlmClients = { gemini: fakeGeminiClient(), openRouter: null };
    expect(() => getProvider({ provider: 'openrouter', model: 'qwen/qwen3.6-flash' }, 'notes', clients)).toThrow(
      'OPENROUTER_API_KEY is not configured'
    );
  });
});
