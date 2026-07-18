import { describe, it, expect, vi } from 'vitest';
import { withOpenRouterCostTracking } from '../src/openRouterCostTracking';
import type { OpenRouterClient } from '../src/openRouterClient';
import type { CostTracker } from '../src/costTracker';

function fakeClient(content: string, usage?: { cost?: number }): OpenRouterClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }], usage }),
      },
    },
  };
}

function fakeCostTracker(): CostTracker {
  return {
    recordGeminiUsage: vi.fn(),
    recordOpenRouterUsage: vi.fn(),
    recordDeepgramSeconds: vi.fn(),
    resetSession: vi.fn(),
    getSessionCostUsd: vi.fn().mockReturnValue(0),
    getLifetimeCostUsd: vi.fn().mockReturnValue(0),
    onUpdate: vi.fn().mockReturnValue(() => {}),
  };
}

describe('withOpenRouterCostTracking', () => {
  it('records the model and cost from response.usage.cost, and still returns the original response', async () => {
    const client = fakeClient('{}', { cost: 0.0037 });
    const tracker = fakeCostTracker();
    const wrapped = withOpenRouterCostTracking(client, tracker);

    const response = await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(response).toEqual({ choices: [{ message: { content: '{}' } }], usage: { cost: 0.0037 } });
    expect(tracker.recordOpenRouterUsage).toHaveBeenCalledWith({ model: 'qwen/qwen3.6-flash', costUsd: 0.0037 });
  });

  it('does not record usage when the response has no usage field', async () => {
    const client = fakeClient('{}', undefined);
    const tracker = fakeCostTracker();
    const wrapped = withOpenRouterCostTracking(client, tracker);

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(tracker.recordOpenRouterUsage).not.toHaveBeenCalled();
  });

  it('does not record usage when usage.cost is absent', async () => {
    const client = fakeClient('{}', {});
    const tracker = fakeCostTracker();
    const wrapped = withOpenRouterCostTracking(client, tracker);

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(tracker.recordOpenRouterUsage).not.toHaveBeenCalled();
  });
});
