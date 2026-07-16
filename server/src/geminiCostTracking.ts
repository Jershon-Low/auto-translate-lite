import type { GeminiClient } from './gemini.js';
import type { CostTracker } from './costTracker.js';

export function withCostTracking(client: GeminiClient, tracker: CostTracker): GeminiClient {
  return {
    models: {
      async generateContent(params) {
        const response = await client.models.generateContent(params);
        const usage = response.usageMetadata;
        if (usage) {
          tracker.recordGeminiUsage({
            model: params.model,
            promptTokens: usage.promptTokenCount ?? 0,
            candidatesTokens: usage.candidatesTokenCount ?? 0,
            cachedTokens: usage.cachedContentTokenCount ?? 0,
          });
        }
        return response;
      },
    },
    caches: client.caches,
  };
}
