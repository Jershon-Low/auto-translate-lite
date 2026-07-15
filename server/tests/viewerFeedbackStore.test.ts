import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewerFeedbackStore } from '../src/viewerFeedbackStore';

describe('createViewerFeedbackStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('starts with an empty list when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const store = createViewerFeedbackStore(join(tempDir, 'viewer-feedback.json'));
    expect(store.list()).toEqual([]);
  });

  it('add() assigns an id, timestamp, and downloaded:false, and persists to disk', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const filePath = join(tempDir, 'nested', 'viewer-feedback.json');
    const store = createViewerFeedbackStore(filePath);

    const item = store.add({
      sessionId: 'session-1',
      language: 'es',
      lineIndex: 3,
      english: 'In the beginning',
      translated: 'En el principio',
      comment: 'sounds robotic',
    });

    expect(item.id).toBeTruthy();
    expect(item.timestamp).toBeTruthy();
    expect(item.downloaded).toBe(false);
    expect(item.sessionId).toBe('session-1');

    const raw = await readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(item.id);
  });

  it('list() returns items newest first', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const store = createViewerFeedbackStore(join(tempDir, 'viewer-feedback.json'));

    const first = store.add({ sessionId: 's', language: 'fr', lineIndex: 0, english: 'A', translated: 'a', comment: '' });
    const second = store.add({ sessionId: 's', language: 'fr', lineIndex: 1, english: 'B', translated: 'b', comment: '' });

    expect(store.list().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('get() finds an item by id, and returns undefined for an unknown id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const store = createViewerFeedbackStore(join(tempDir, 'viewer-feedback.json'));
    const item = store.add({ sessionId: 's', language: 'ja', lineIndex: 0, english: 'A', translated: 'あ', comment: '' });

    expect(store.get(item.id)?.id).toBe(item.id);
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('getUndownloaded() excludes items already marked downloaded', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const store = createViewerFeedbackStore(join(tempDir, 'viewer-feedback.json'));
    const first = store.add({ sessionId: 's', language: 'ko', lineIndex: 0, english: 'A', translated: '가', comment: '' });
    const second = store.add({ sessionId: 's', language: 'ko', lineIndex: 1, english: 'B', translated: '나', comment: '' });

    store.markDownloaded([first.id]);

    expect(store.getUndownloaded().map((item) => item.id)).toEqual([second.id]);
  });

  it('markDownloaded() flips downloaded to true for the given ids and persists it', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const filePath = join(tempDir, 'viewer-feedback.json');
    const store = createViewerFeedbackStore(filePath);
    const item = store.add({ sessionId: 's', language: 'th', lineIndex: 0, english: 'A', translated: 'ก', comment: '' });

    store.markDownloaded([item.id]);

    expect(store.get(item.id)?.downloaded).toBe(true);
    const raw = await readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted[0].downloaded).toBe(true);
  });

  it('reloads persisted items from disk when constructed again with the same path', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const filePath = join(tempDir, 'viewer-feedback.json');
    const first = createViewerFeedbackStore(filePath);
    first.add({ sessionId: 's', language: 'vi', lineIndex: 0, english: 'A', translated: 'a', comment: '' });

    const second = createViewerFeedbackStore(filePath);
    expect(second.list()).toHaveLength(1);
  });

  it('treats an unreadable/corrupt file as an empty list rather than throwing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viewer-feedback-test-'));
    const filePath = join(tempDir, 'viewer-feedback.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'not valid json', 'utf-8');

    const store = createViewerFeedbackStore(filePath);
    expect(store.list()).toEqual([]);
  });
});
