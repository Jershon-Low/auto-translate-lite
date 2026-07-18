import type { GeminiClient } from './gemini.js';
import type { OpenRouterClient } from './openRouterClient.js';
import { GeminiProvider } from './geminiProvider.js';
import { OpenRouterProvider } from './openRouterProvider.js';
import type { LlmProvider, RoleModelSelection } from './llmTypes.js';

export interface LlmClients {
  gemini: GeminiClient;
  openRouter: OpenRouterClient | null;
}

export function getProvider(selection: RoleModelSelection, notes: string, clients: LlmClients): LlmProvider {
  if (selection.provider === 'gemini') {
    return new GeminiProvider(clients.gemini, selection.model, notes);
  }
  if (!clients.openRouter) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }
  return new OpenRouterProvider(clients.openRouter, selection.model, notes, selection.reasoning);
}
