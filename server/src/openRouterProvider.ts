import type { OpenRouterClient, OpenRouterMessage } from './openRouterClient.js';
import type { LlmProvider, OpenRouterReasoningEffort } from './llmTypes.js';
import type { SermonCacheRef } from './gemini.js';
import type { TranscriptionCheckResult } from './transcriptionVerifier.js';
import type { VerificationItem, VerificationResult } from './translationVerifier.js';
import {
  TRANSLATION_FIXED_RULES,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_INTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_OUTRO,
  buildTranslateTaskText,
  buildTranslateBacklogTaskText,
  buildTranscriptionVerifierTaskText,
  buildTranslationVerifierTaskText,
} from './llmPrompts.js';

function isUnsupportedResponseFormatError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /response_format|json_schema/i.test(message);
}

export class OpenRouterProvider implements LlmProvider {
  constructor(
    private readonly client: OpenRouterClient,
    private readonly model: string,
    private readonly notes: string,
    private readonly reasoning?: OpenRouterReasoningEffort
  ) {}

  async translate(
    englishText: string,
    languageCodes: string[],
    precedingContext: string[],
    _cacheRef: SermonCacheRef | null
  ): Promise<Record<string, string>> {
    if (languageCodes.length === 0) return {};
    const properties: Record<string, { type: string }> = {};
    for (const code of languageCodes) properties[code] = { type: 'string' };
    const userText = buildTranslateTaskText(languageCodes, englishText, precedingContext);
    const systemText = `${this.notes}\n\n${TRANSLATION_FIXED_RULES}`;
    const parsed = await this.requestJson('translate', systemText, userText, {
      type: 'object',
      properties,
      required: languageCodes,
      additionalProperties: false,
    });
    return (parsed ?? {}) as Record<string, string>;
  }

  async translateBacklog(
    englishLines: string[],
    languageCode: string,
    _cacheRef: SermonCacheRef | null
  ): Promise<string[]> {
    if (englishLines.length === 0) return [];
    const userText = buildTranslateBacklogTaskText(englishLines, languageCode);
    const systemText = `${this.notes}\n\n${TRANSLATION_FIXED_RULES}`;
    const parsed = (await this.requestJson('translate_backlog', systemText, userText, {
      type: 'object',
      properties: { translations: { type: 'array', items: { type: 'string' } } },
      required: ['translations'],
      additionalProperties: false,
    })) as { translations?: string[] } | null;
    return parsed?.translations ?? [];
  }

  async verifyTranscription(
    english: string,
    precedingContext: string[],
    _cacheRef: SermonCacheRef | null
  ): Promise<TranscriptionCheckResult> {
    const userText = buildTranscriptionVerifierTaskText(english, precedingContext);
    const systemText = `${TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO}\n\n${this.notes}\n\n${TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO}`;
    const parsed = await this.requestJson('verify_transcription', systemText, userText, {
      type: 'object',
      properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['safe', 'reason'],
      additionalProperties: false,
    });
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).safe === 'boolean' &&
      typeof (parsed as Record<string, unknown>).reason === 'string'
    ) {
      return parsed as TranscriptionCheckResult;
    }
    return { safe: false, reason: 'malformed response' };
  }

  async verifyTranslations(
    items: VerificationItem[],
    _cacheRef: SermonCacheRef | null
  ): Promise<Record<string, VerificationResult>> {
    if (items.length === 0) return {};
    const properties: Record<string, Record<string, unknown>> = {};
    for (const item of items) {
      properties[item.id] = {
        type: 'object',
        properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['safe', 'reason'],
        additionalProperties: false,
      };
    }
    const userText = buildTranslationVerifierTaskText(items);
    const systemText = `${TRANSLATION_VERIFIER_FIXED_RULES_INTRO}\n\n${this.notes}\n\n${TRANSLATION_VERIFIER_FIXED_RULES_OUTRO}`;
    const parsed = await this.requestJson('verify_translations', systemText, userText, {
      type: 'object',
      properties,
      required: items.map((item) => item.id),
      additionalProperties: false,
    });
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, VerificationResult>) : {};
  }

  private async requestJson(
    schemaName: string,
    systemText: string,
    userText: string,
    schema: Record<string, unknown>
  ): Promise<unknown> {
    const messages: OpenRouterMessage[] = [
      { role: 'system', content: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: userText },
    ];
    const reasoningParam =
      this.reasoning && this.reasoning !== 'off' ? { reasoning: { effort: this.reasoning } } : {};

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
        ...reasoningParam,
      });
      return JSON.parse(response.choices[0]?.message.content ?? '{}');
    } catch (error) {
      if (!isUnsupportedResponseFormatError(error)) throw error;
      const fallbackMessages: OpenRouterMessage[] = [
        messages[0],
        {
          role: 'user',
          content: `${userText}\n\nRespond with a single JSON object matching this shape (no other text): ${JSON.stringify(schema)}`,
        },
      ];
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: fallbackMessages,
        response_format: { type: 'json_object' },
        ...reasoningParam,
      });
      return JSON.parse(response.choices[0]?.message.content ?? '{}');
    }
  }
}
