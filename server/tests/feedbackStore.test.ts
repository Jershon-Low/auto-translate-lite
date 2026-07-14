import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeedbackStore } from '../src/feedbackStore';

describe('createFeedbackStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns an empty string when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'feedback-test-'));
    const store = createFeedbackStore(join(tempDir, 'feedback.txt'));
    expect(await store.read()).toBe('');
  });

  it('writes then reads back the same content, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'feedback-test-'));
    const filePath = join(tempDir, 'nested', 'feedback.txt');
    const store = createFeedbackStore(filePath);
    await store.write('Cain should be 该隐 in Chinese');
    expect(await store.read()).toBe('Cain should be 该隐 in Chinese');
  });

  it('overwrites previous content on a second write', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'feedback-test-'));
    const store = createFeedbackStore(join(tempDir, 'feedback.txt'));
    await store.write('first version');
    await store.write('second version');
    expect(await store.read()).toBe('second version');
  });
});
