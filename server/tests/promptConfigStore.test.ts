import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPromptConfigStore, validatePromptConfig, DEFAULT_PROMPT_CONFIG } from '../src/promptConfigStore';
import { TRANSLATION_DEFAULT_NOTES } from '../src/llmPrompts';

describe('createPromptConfigStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the default notes when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'prompt-config-test-'));
    const store = createPromptConfigStore(join(tempDir, 'prompt-config.json'));
    expect(await store.read()).toEqual(DEFAULT_PROMPT_CONFIG);
    expect((await store.read()).translation).toBe(TRANSLATION_DEFAULT_NOTES);
  });

  it('writes then reads back the same notes, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'prompt-config-test-'));
    const filePath = join(tempDir, 'nested', 'prompt-config.json');
    const store = createPromptConfigStore(filePath);
    const config = { transcriptionVerifier: 'custom tv notes', translation: 'custom t notes', translationVerifier: 'custom vv notes' };
    await store.write(config);
    expect(await store.read()).toEqual(config);
  });

  it('falls back to the default notes when the file is corrupt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'prompt-config-test-'));
    const filePath = join(tempDir, 'prompt-config.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const store = createPromptConfigStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_PROMPT_CONFIG);
  });
});

describe('validatePromptConfig', () => {
  it('accepts a config with all three roles as strings', () => {
    const config = { transcriptionVerifier: 'a', translation: 'b', translationVerifier: 'c' };
    expect(validatePromptConfig(config)).toEqual(config);
  });

  it('rejects a config missing a role', () => {
    expect(validatePromptConfig({ transcriptionVerifier: 'a', translation: 'b' })).toBeNull();
  });

  it('rejects a config with a non-string role value', () => {
    expect(validatePromptConfig({ transcriptionVerifier: 1, translation: 'b', translationVerifier: 'c' })).toBeNull();
  });

  it('rejects a non-object value', () => {
    expect(validatePromptConfig(null)).toBeNull();
  });
});
