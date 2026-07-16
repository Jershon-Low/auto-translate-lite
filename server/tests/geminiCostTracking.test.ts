import { describe, it, expect, vi } from 'vitest';
import { withCostTracking } from '../src/geminiCostTracking';
import type { GeminiClient } from '../src/gemini';
import type { CostTracker } from '../src/costTracker';

function fakeClient(usageMetadata?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}): GeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: '{}', usageMetadata }),
    },
    caches: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
}

function fakeCostTracker(): CostTracker {
  return {
    recordGeminiUsage: vi.fn(),
    recordDeepgramSeconds: vi.fn(),
    resetSession: vi.fn(),
    getSessionCostUsd: vi.fn().mockReturnValue(0),
    getLifetimeCostUsd: vi.fn().mockReturnValue(0),
    onUpdate: vi.fn().mockReturnValue(() => {}),
  };
}

describe('withCostTracking', () => {
  it('records Gemini usage from the response and still returns the original response', async () => {
    const client = fakeClient({ promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 10 });
    const tracker = fakeCostTracker();
    const wrapped = withCostTracking(client, tracker);

    const response = await wrapped.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: 'hi',
      config: { responseMimeType: 'application/json', responseSchema: {} },
    });

    expect(response).toEqual({
      text: '{}',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 10 },
    });
    expect(tracker.recordGeminiUsage).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-lite',
      promptTokens: 100,
      candidatesTokens: 20,
      cachedTokens: 10,
    });
  });

  it('defaults missing token counts to zero', async () => {
    const client = fakeClient({});
    const tracker = fakeCostTracker();
    const wrapped = withCostTracking(client, tracker);

    await wrapped.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: 'hi',
      config: { responseMimeType: 'application/json', responseSchema: {} },
    });

    expect(tracker.recordGeminiUsage).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-lite',
      promptTokens: 0,
      candidatesTokens: 0,
      cachedTokens: 0,
    });
  });

  it('does not record usage when the response has no usageMetadata', async () => {
    const client = fakeClient(undefined);
    const tracker = fakeCostTracker();
    const wrapped = withCostTracking(client, tracker);

    await wrapped.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: 'hi',
      config: { responseMimeType: 'application/json', responseSchema: {} },
    });

    expect(tracker.recordGeminiUsage).not.toHaveBeenCalled();
  });

  it('passes the caches object through unchanged, without tracking cache creation', async () => {
    const client = fakeClient();
    const tracker = fakeCostTracker();
    const wrapped = withCostTracking(client, tracker);

    expect(wrapped.caches).toBe(client.caches);
  });
});
