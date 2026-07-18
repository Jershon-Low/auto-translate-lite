// server/tests/llmPrompts.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildTranslateTaskText,
  buildTranslateBacklogTaskText,
  buildTranscriptionVerifierTaskText,
  buildTranslationVerifierTaskText,
} from '../src/llmPrompts';

describe('buildTranslateTaskText', () => {
  it('produces the intro line and the sentence, with no instruction block by default', () => {
    const text = buildTranslateTaskText(['zh'], 'Hello', []);
    expect(text).toBe(
      'Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: zh. Keep the tone natural and spoken, not overly formal.\n\n' +
        'Sentence: "Hello"'
    );
  });

  it('inserts the given instruction block between the intro and the sentence', () => {
    const text = buildTranslateTaskText(['zh'], 'Hello', [], 'NOTES AND RULES\n\n');
    expect(text).toContain('NOTES AND RULES\n\nSentence: "Hello"');
  });

  it('includes preceding context between the instruction block and the sentence', () => {
    const text = buildTranslateTaskText(['zh'], 'Hello', ['Hi everyone']);
    expect(text).toContain('Hi everyone');
    expect(text).toContain('do not translate these');
  });
});

describe('buildTranslateBacklogTaskText', () => {
  it('produces the intro line and the JSON-encoded sentence list', () => {
    const text = buildTranslateBacklogTaskText(['Hello', 'Bye'], 'zh');
    expect(text).toBe(
      'Translate each of these sentences, spoken during a live Australian church sermon, into language code "zh". Return the translations in the exact same order as the input.\n\n' +
        'Sentences: ["Hello","Bye"]'
    );
  });
});

describe('buildTranscriptionVerifierTaskText', () => {
  it('produces the line and instruction footer, with no context block when none given', () => {
    const text = buildTranscriptionVerifierTaskText('Jesus loves you', []);
    expect(text).toBe('Line: "Jesus loves you"\n\nReturn whether it is safe and a short reason.');
  });

  it('includes preceding context lines when given', () => {
    const text = buildTranscriptionVerifierTaskText('He rose again', ['Jesus died', 'Three days later']);
    expect(text).toContain('Jesus died');
    expect(text).toContain('Three days later');
  });
});

describe('buildTranslationVerifierTaskText', () => {
  it('numbers each pair with its id, English, and translation', () => {
    const text = buildTranslationVerifierTaskText([
      { id: 'zh', english: 'Hello', translated: '你好' },
      { id: 'ko', english: 'Hello', translated: '안녕' },
    ]);
    expect(text).toBe(
      'Pairs:\n1. [id: "zh"] English: "Hello" | Translation: "你好"\n2. [id: "ko"] English: "Hello" | Translation: "안녕"\n\n' +
        'Return, for each id, whether it is safe and a short reason.'
    );
  });
});
