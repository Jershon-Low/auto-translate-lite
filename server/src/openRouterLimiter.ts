import type { OpenRouterClient } from './openRouterClient.js';
import type { GeminiCallLimiter } from './geminiLimiter.js';

export function withOpenRouterLimiter(client: OpenRouterClient, limiter: GeminiCallLimiter): OpenRouterClient {
  return {
    chat: {
      completions: {
        create(params) {
          return limiter.run(() => client.chat.completions.create(params));
        },
      },
    },
  };
}
