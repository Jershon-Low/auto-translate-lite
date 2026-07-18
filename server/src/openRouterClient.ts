import OpenAI from 'openai';

export interface OpenRouterMessageContent {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface OpenRouterMessage {
  role: 'system' | 'user';
  content: string | OpenRouterMessageContent[];
}

export interface OpenRouterUsage {
  cost?: number;
}

export type OpenRouterResponseFormat =
  | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> } }
  | { type: 'json_object' };

export interface OpenRouterChatCompletionParams {
  model: string;
  messages: OpenRouterMessage[];
  response_format: OpenRouterResponseFormat;
}

export interface OpenRouterChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage?: OpenRouterUsage;
}

export interface OpenRouterClient {
  chat: {
    completions: {
      create(params: OpenRouterChatCompletionParams): Promise<OpenRouterChatCompletionResponse>;
    };
  };
}

export function createOpenRouterClient(apiKey: string): OpenRouterClient {
  // Cast: the installed `openai` SDK's own types are a much richer superset of
  // the minimal shape this app actually calls (mirrors the hand-rolled
  // GeminiClient pattern in gemini.ts) — the cast just narrows what callers see.
  return new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' }) as unknown as OpenRouterClient;
}
