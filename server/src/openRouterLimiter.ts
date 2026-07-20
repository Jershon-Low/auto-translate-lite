import type { OpenRouterClient } from './openRouterClient.js';
import type { GeminiCallLimiter } from './geminiLimiter.js';
import type { OpenRouterRateLimiter } from './openRouterRateLimiter.js';

export function withOpenRouterLimiter(
  client: OpenRouterClient,
  limiter: GeminiCallLimiter,
  rateLimiter?: OpenRouterRateLimiter
): OpenRouterClient {
  return {
    chat: {
      completions: {
        create(params) {
          const call = () => limiter.run(() => client.chat.completions.create(params));
          return rateLimiter ? rateLimiter.run(call) : call();
        },
      },
    },
  };
}
