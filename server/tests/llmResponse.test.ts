import { describe, it, expect } from 'vitest';
import { parseLlmJson } from '../src/llmResponse';

describe('parseLlmJson', () => {
  it('parses a normal JSON body', () => {
    expect(parseLlmJson('{"ja":"こんにちは"}', 'translate')).toEqual({ ja: 'こんにちは' });
  });

  // The regression this exists for: every provider entry point used to default
  // an absent body to '{}', which callers read as "no language came back" and
  // silently degraded a viewer to English with no retry and no log.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   \n  '],
  ])('throws on a %s body rather than yielding an empty object', (_label, body) => {
    expect(() => parseLlmJson(body as string | null | undefined, 'translate')).toThrow(/empty translate response/);
  });

  it('names the failing role so the log says which call came back empty', () => {
    expect(() => parseLlmJson(null, 'verify_transcription')).toThrow(/verify_transcription/);
  });

  it('still throws on malformed (non-empty) JSON', () => {
    expect(() => parseLlmJson('{"ja":', 'translate')).toThrow();
  });

  it('does not produce a message wsServer would misread as a cache failure', () => {
    // wsServer's isCacheRelatedError matches /cache/i to decide whether to drop
    // a role's context cache for the rest of the session. An empty response
    // says nothing about the cache, so the message must not trip that check.
    let message = '';
    try {
      parseLlmJson(null, 'translate');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toMatch(/cache/i);
  });
});
