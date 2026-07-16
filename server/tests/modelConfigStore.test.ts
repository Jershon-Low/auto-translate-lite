import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelConfigStore, validateModelConfig, DEFAULT_MODEL_CONFIG } from '../src/modelConfigStore';

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
    const config = {
      transcriptionVerifier: 'gemini-3.1-flash-lite' as const,
      translation: 'gemini-3.5-flash' as const,
      translationVerifier: 'gemini-3.1-flash-lite' as const,
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
});

describe('validateModelConfig', () => {
  it('accepts a config with all three valid model ids', () => {
    const config = {
      transcriptionVerifier: 'gemini-3.1-flash-lite',
      translation: 'gemini-3.5-flash',
      translationVerifier: 'gemini-3.1-flash-lite',
    };
    expect(validateModelConfig(config)).toEqual(config);
  });

  it('rejects a config missing a role', () => {
    expect(validateModelConfig({ transcriptionVerifier: 'gemini-3.1-flash-lite', translation: 'gemini-3.5-flash' })).toBeNull();
  });

  it('rejects a config with an unknown model id', () => {
    expect(
      validateModelConfig({ transcriptionVerifier: 'gpt-5', translation: 'gemini-3.5-flash', translationVerifier: 'gemini-3.1-flash-lite' })
    ).toBeNull();
  });

  it('rejects a non-object value', () => {
    expect(validateModelConfig(null)).toBeNull();
    expect(validateModelConfig('gemini-3.1-flash-lite')).toBeNull();
  });
});
