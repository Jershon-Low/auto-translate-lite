import { describe, it, expect, vi } from 'vitest';
import { withGeminiLimiter } from '../src/geminiRateLimiting';
import { GeminiCallLimiter } from '../src/geminiLimiter';
import type { GeminiClient } from '../src/gemini';

function fakeClient(): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: '{}' }),
    },
    caches: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe('withGeminiLimiter', () => {
  it('routes generateContent calls through the limiter and returns the original response', async () => {
    const client = fakeClient();
    const limiter = new GeminiCallLimiter(1);
    const runSpy = vi.spyOn(limiter, 'run');
    const wrapped = withGeminiLimiter(client, limiter);

    const response = await wrapped.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: 'hi',
      config: { responseMimeType: 'application/json', responseSchema: {} },
    });

    expect(response).toEqual({ text: '{}' });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent calls beyond the limiter cap', async () => {
    const client = fakeClient();
    let concurrent = 0;
    let maxConcurrent = 0;
    (client.models.generateContent as any).mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return { text: '{}' };
    });
    const limiter = new GeminiCallLimiter(2);
    const wrapped = withGeminiLimiter(client, limiter);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        wrapped.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: 'hi',
          config: { responseMimeType: 'application/json', responseSchema: {} },
        })
      )
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('passes the caches object through unchanged', () => {
    const client = fakeClient();
    const limiter = new GeminiCallLimiter();
    const wrapped = withGeminiLimiter(client, limiter);
    expect(wrapped.caches).toBe(client.caches);
  });
});
