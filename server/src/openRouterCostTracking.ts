import type { OpenRouterClient } from './openRouterClient.js';
import type { CostTracker } from './costTracker.js';

export function withOpenRouterCostTracking(client: OpenRouterClient, tracker: CostTracker): OpenRouterClient {
  return {
    chat: {
      completions: {
        async create(params) {
          const response = await client.chat.completions.create(params);
          if (typeof response.usage?.cost === 'number') {
            tracker.recordOpenRouterUsage({ model: params.model, costUsd: response.usage.cost });
          }
          return response;
        },
      },
    },
  };
}
