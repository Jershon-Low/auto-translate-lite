import type { OpenRouterClient } from './openRouterClient.js';
import type { GeminiCallLimiter, CallPriority } from './geminiLimiter.js';
import type { OpenRouterRateLimiter } from './openRouterRateLimiter.js';

export function withOpenRouterLimiter(
  client: OpenRouterClient,
  limiter: GeminiCallLimiter,
  rateLimiter?: OpenRouterRateLimiter,
  priority: CallPriority = 'live'
): OpenRouterClient {
  return {
    chat: {
      completions: {
        create(params) {
          const call = () => limiter.run(() => client.chat.completions.create(params), priority);
          return rateLimiter ? rateLimiter.run(call, priority) : call();
        },
      },
    },
  };
}
