import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouterModelsStore } from '../src/openRouterModelsStore';

describe('createOpenRouterModelsStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns an empty list when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openrouter-models-test-'));
    const store = createOpenRouterModelsStore(join(tempDir, 'openrouter-models.json'));
    expect(await store.read()).toEqual([]);
  });

  it('adds a new model id and persists it, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openrouter-models-test-'));
    const filePath = join(tempDir, 'nested', 'openrouter-models.json');
    const store = createOpenRouterModelsStore(filePath);
    const updated = await store.addModel('qwen/qwen3.6-flash');
    expect(updated).toEqual(['qwen/qwen3.6-flash']);
    expect(await store.read()).toEqual(['qwen/qwen3.6-flash']);
  });

  it('does not duplicate an already-known model id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openrouter-models-test-'));
    const store = createOpenRouterModelsStore(join(tempDir, 'openrouter-models.json'));
    await store.addModel('qwen/qwen3.6-flash');
    const updated = await store.addModel('qwen/qwen3.6-flash');
    expect(updated).toEqual(['qwen/qwen3.6-flash']);
  });

  it('falls back to an empty list when the file is corrupt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openrouter-models-test-'));
    const filePath = join(tempDir, 'openrouter-models.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const store = createOpenRouterModelsStore(filePath);
    expect(await store.read()).toEqual([]);
  });
});
