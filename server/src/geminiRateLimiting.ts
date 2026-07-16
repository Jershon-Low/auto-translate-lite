import type { GeminiClient } from './gemini.js';
import type { GeminiCallLimiter } from './geminiLimiter.js';

export function withGeminiLimiter(client: GeminiClient, limiter: GeminiCallLimiter): GeminiClient {
  return {
    models: {
      generateContent(params) {
        return limiter.run(() => client.models.generateContent(params));
      },
    },
    caches: client.caches,
  };
}
