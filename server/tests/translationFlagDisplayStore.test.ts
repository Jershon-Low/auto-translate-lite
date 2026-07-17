import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTranslationFlagDisplayStore,
  validateTranslationFlagDisplayConfig,
  DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG,
} from '../src/translationFlagDisplayStore';

describe('createTranslationFlagDisplayStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the default config (hide) when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'translation-flag-display-test-'));
    const store = createTranslationFlagDisplayStore(join(tempDir, 'translation-flag-display.json'));
    expect(await store.read()).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });

  it('writes then reads back the same config, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'translation-flag-display-test-'));
    const filePath = join(tempDir, 'nested', 'translation-flag-display.json');
    const store = createTranslationFlagDisplayStore(filePath);
    await store.write({ mode: 'flag' });
    expect(await store.read()).toEqual({ mode: 'flag' });
  });

  it('falls back to the default config when the file is corrupt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'translation-flag-display-test-'));
    const filePath = join(tempDir, 'translation-flag-display.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const store = createTranslationFlagDisplayStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });

  it('falls back to the default config when the file has an invalid mode', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'translation-flag-display-test-'));
    const filePath = join(tempDir, 'translation-flag-display.json');
    await writeFile(filePath, JSON.stringify({ mode: 'delete-everything' }), 'utf-8');
    const store = createTranslationFlagDisplayStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });
});

describe('validateTranslationFlagDisplayConfig', () => {
  it('accepts mode: "hide"', () => {
    expect(validateTranslationFlagDisplayConfig({ mode: 'hide' })).toEqual({ mode: 'hide' });
  });

  it('accepts mode: "flag"', () => {
    expect(validateTranslationFlagDisplayConfig({ mode: 'flag' })).toEqual({ mode: 'flag' });
  });

  it('rejects an unrecognized mode', () => {
    expect(validateTranslationFlagDisplayConfig({ mode: 'nonsense' })).toBeNull();
  });

  it('rejects a non-object value', () => {
    expect(validateTranslationFlagDisplayConfig(null)).toBeNull();
    expect(validateTranslationFlagDisplayConfig('hide')).toBeNull();
  });
});
