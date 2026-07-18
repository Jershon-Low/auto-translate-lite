import type { OpenRouterClient } from './openRouterClient.js';
import { logEvent } from './logger.js';

export function withOpenRouterReasoningLogging(client: OpenRouterClient): OpenRouterClient {
  return {
    chat: {
      completions: {
        async create(params) {
          const response = await client.chat.completions.create(params);
          const reasoning = response.choices[0]?.message?.reasoning;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            void logEvent('info', {
              event: 'openrouter_reasoning',
              model: params.model,
              schema: params.response_format.type === 'json_schema' ? params.response_format.json_schema.name : undefined,
              reasoning,
            });
          }
          return response;
        },
      },
    },
  };
}
