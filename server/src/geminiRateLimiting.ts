import type { GeminiClient } from './gemini.js';
import type { GeminiCallLimiter, CallPriority } from './geminiLimiter.js';

export function withGeminiLimiter(
  client: GeminiClient,
  limiter: GeminiCallLimiter,
  priority: CallPriority = 'live'
): GeminiClient {
  return {
    models: {
      generateContent(params) {
        return limiter.run(() => client.models.generateContent(params), priority);
      },
    },
    caches: client.caches,
  };
}
