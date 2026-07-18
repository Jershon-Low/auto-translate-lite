import { describe, it, expect, vi } from 'vitest';
import { withOpenRouterLimiter } from '../src/openRouterLimiter';
import { GeminiCallLimiter } from '../src/geminiLimiter';
import type { OpenRouterClient } from '../src/openRouterClient';

function fakeClient(): OpenRouterClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content: '{}' } }] }),
      },
    },
  };
}

describe('withOpenRouterLimiter', () => {
  it('routes chat.completions.create calls through the limiter and returns the original response', async () => {
    const client = fakeClient();
    const limiter = new GeminiCallLimiter(1);
    const runSpy = vi.spyOn(limiter, 'run');
    const wrapped = withOpenRouterLimiter(client, limiter);

    const response = await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(response).toEqual({ choices: [{ message: { content: '{}' } }] });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent calls beyond the limiter cap', async () => {
    const client = fakeClient();
    let concurrent = 0;
    let maxConcurrent = 0;
    (client.chat.completions.create as any).mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return { choices: [{ message: { content: '{}' } }] };
    });
    const limiter = new GeminiCallLimiter(2);
    const wrapped = withOpenRouterLimiter(client, limiter);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        wrapped.chat.completions.create({
          model: 'qwen/qwen3.6-flash',
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
        })
      )
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
