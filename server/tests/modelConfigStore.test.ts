import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelConfigStore, validateModelConfig, DEFAULT_MODEL_CONFIG, type ModelConfig } from '../src/modelConfigStore';

describe('createModelConfigStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the default config when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const store = createModelConfigStore(join(tempDir, 'model-config.json'));
    expect(await store.read()).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('writes then reads back the same config, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const filePath = join(tempDir, 'nested', 'model-config.json');
    const store = createModelConfigStore(filePath);
    const config: ModelConfig = {
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'openrouter', model: 'qwen/qwen3.6-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    };
    await store.write(config);
    expect(await store.read()).toEqual(config);
  });

  it('falls back to the default config when the file is corrupt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const filePath = join(tempDir, 'model-config.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const store = createModelConfigStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('falls back to the default config when the file has an unrecognized model id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const filePath = join(tempDir, 'model-config.json');
    await writeFile(
      filePath,
      JSON.stringify({ transcriptionVerifier: 'gpt-5', translation: 'gemini-3.5-flash', translationVerifier: 'gemini-3.1-flash-lite' }),
      'utf-8'
    );
    const store = createModelConfigStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('migrates a legacy on-disk bare-string config to the { provider, model } shape when reading', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-config-test-'));
    const filePath = join(tempDir, 'model-config.json');
    await writeFile(
      filePath,
      JSON.stringify({
        transcriptionVerifier: 'gemini-3.1-flash-lite',
        translation: 'gemini-3.5-flash',
        translationVerifier: 'gemini-3.1-flash-lite',
      }),
      'utf-8'
    );
    const store = createModelConfigStore(filePath);
    expect(await store.read()).toEqual({
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'gemini', model: 'gemini-3.5-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    });
  });
});

describe('validateModelConfig', () => {
  it('accepts a config already using the { provider, model } shape and returns it unchanged', () => {
    const config: ModelConfig = {
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'openrouter', model: 'qwen/qwen3.6-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    };
    expect(validateModelConfig(config)).toEqual(config);
  });

  it('migrates a legacy bare Gemini model-id string to { provider: "gemini", model }', () => {
    const legacy = {
      transcriptionVerifier: 'gemini-3.1-flash-lite',
      translation: 'gemini-3.5-flash',
      translationVerifier: 'gemini-3.1-flash-lite',
    };
    expect(validateModelConfig(legacy)).toEqual({
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'gemini', model: 'gemini-3.5-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    });
  });

  it('accepts an openrouter role selection with any non-empty model id', () => {
    const config: ModelConfig = {
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translationVerifier: { provider: 'openrouter', model: 'deepseek/deepseek-chat' },
    };
    expect(validateModelConfig(config)).toEqual(config);
  });

  it('rejects a config missing a role', () => {
    expect(validateModelConfig({ transcriptionVerifier: 'gemini-3.1-flash-lite', translation: 'gemini-3.5-flash' })).toBeNull();
  });

  it('rejects a legacy bare string that is not a known Gemini model id', () => {
    expect(
      validateModelConfig({ transcriptionVerifier: 'gpt-5', translation: 'gemini-3.5-flash', translationVerifier: 'gemini-3.1-flash-lite' })
    ).toBeNull();
  });

  it('rejects an openrouter selection with an empty model id', () => {
    expect(
      validateModelConfig({
        transcriptionVerifier: { provider: 'openrouter', model: '' },
        translation: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      })
    ).toBeNull();
  });

  it('rejects an unrecognized provider value', () => {
    expect(
      validateModelConfig({
        transcriptionVerifier: { provider: 'openai', model: 'gpt-5' },
        translation: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      })
    ).toBeNull();
  });

  it('rejects a non-object value', () => {
    expect(validateModelConfig(null)).toBeNull();
    expect(validateModelConfig('gemini-3.1-flash-lite')).toBeNull();
  });
});
