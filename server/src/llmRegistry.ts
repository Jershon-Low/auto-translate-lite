import type { GeminiClient } from './gemini.js';
import { GeminiProvider } from './geminiProvider.js';
import type { LlmProvider, ModelId } from './llmTypes.js';

export function getProvider(model: ModelId, notes: string, client: GeminiClient): LlmProvider {
  return new GeminiProvider(client, model, notes);
}
