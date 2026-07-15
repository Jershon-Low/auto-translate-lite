import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { createSermonDocStore } from '../src/sermonDocStore';
import { createFeedbackStore } from '../src/feedbackStore';
import { createViewerFeedbackStore } from '../src/viewerFeedbackStore';
import { Session } from '../src/session';

vi.mock('../src/docExtraction', () => ({
  extractDocumentText: vi.fn().mockResolvedValue('Extracted sermon text'),
}));

import { extractDocumentText } from '../src/docExtraction';

function testDeps() {
  return {
    sermonDocStore: createSermonDocStore(),
    feedbackStore: createFeedbackStore(join(tmpdir(), `feedback-app-test-${Date.now()}-${Math.random()}.txt`)),
    viewerFeedbackStore: createViewerFeedbackStore(
      join(tmpdir(), `viewer-feedback-app-test-${Date.now()}-${Math.random()}.json`)
    ),
    session: new Session(),
  };
}

describe('GET /health', () => {
  it('returns status ok', async () => {
    const response = await request(createApp(testDeps())).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('includes a permissive CORS header so cross-origin browser requests are allowed', async () => {
    const response = await request(createApp(testDeps())).get('/health');
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('POST /sermon-doc', () => {
  it('extracts text and stores it in the sermon doc store', async () => {
    const deps = testDeps();
    const response = await request(createApp(deps))
      .post('/sermon-doc')
      .attach('file', Buffer.from('fake pdf bytes'), { filename: 'sermon.pdf', contentType: 'application/pdf' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, characterCount: 'Extracted sermon text'.length });
    expect(deps.sermonDocStore.get()).toBe('Extracted sermon text');
  });

  it('returns 400 when no file is attached', async () => {
    const response = await request(createApp(testDeps())).post('/sermon-doc');
    expect(response.status).toBe(400);
  });

  it('returns 400 when extraction yields no text', async () => {
    (extractDocumentText as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');
    const response = await request(createApp(testDeps()))
      .post('/sermon-doc')
      .attach('file', Buffer.from('fake'), { filename: 'sermon.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(400);
  });

  it('returns 400 with the error message when extraction throws', async () => {
    (extractDocumentText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Unsupported document type: text/plain')
    );
    const response = await request(createApp(testDeps()))
      .post('/sermon-doc')
      .attach('file', Buffer.from('fake'), { filename: 'sermon.txt', contentType: 'text/plain' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Unsupported document type: text/plain' });
  });
});

describe('GET/PUT /feedback', () => {
  it('returns an empty string when nothing has been saved yet', async () => {
    const response = await request(createApp(testDeps())).get('/feedback');
    expect(response.body).toEqual({ text: '' });
  });

  it('saves feedback text and returns it on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const putResponse = await request(app).put('/feedback').send({ text: 'Cain -> 该隐' });
    expect(putResponse.status).toBe(200);

    const getResponse = await request(app).get('/feedback');
    expect(getResponse.body).toEqual({ text: 'Cain -> 该隐' });
  });
});

describe('POST /viewer-feedback', () => {
  it('returns 400 when a required field is missing', async () => {
    const response = await request(createApp(testDeps()))
      .post('/viewer-feedback')
      .send({ language: 'es', english: 'Hi', translated: 'Hola' }); // missing lineIndex
    expect(response.status).toBe(400);
  });

  it('creates an item tagged with the current session id, defaulting comment to an empty string', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const response = await request(app).post('/viewer-feedback').send({
      language: 'es',
      lineIndex: 2,
      english: 'In the beginning',
      translated: 'En el principio',
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    const items = deps.viewerFeedbackStore.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sessionId: deps.session.id,
      language: 'es',
      lineIndex: 2,
      english: 'In the beginning',
      translated: 'En el principio',
      comment: '',
      downloaded: false,
    });
  });

  it('stores a provided comment', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({
      language: 'fr',
      lineIndex: 0,
      english: 'Hello',
      translated: 'Bonjour',
      comment: 'sounds off',
    });
    expect(deps.viewerFeedbackStore.list()[0].comment).toBe('sounds off');
  });
});

describe('GET /viewer-feedback', () => {
  it('returns an empty list when nothing has been submitted yet', async () => {
    const response = await request(createApp(testDeps())).get('/viewer-feedback');
    expect(response.body).toEqual({ items: [] });
  });

  it('returns submitted items newest first', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 0, english: 'A', translated: 'あ' });
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 1, english: 'B', translated: 'い' });

    const response = await request(app).get('/viewer-feedback');
    expect(response.body.items.map((item: { english: string }) => item.english)).toEqual(['B', 'A']);
  });
});

describe('POST /viewer-feedback/:id/download', () => {
  it('returns 404 for an unknown id', async () => {
    const response = await request(createApp(testDeps())).post('/viewer-feedback/does-not-exist/download');
    expect(response.status).toBe(404);
  });

  it('returns a one-row CSV for the item and marks it downloaded', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({
      language: 'ko',
      lineIndex: 1,
      english: 'Peace be with you',
      translated: '평안이 있기를',
      comment: 'unclear',
    });
    const [{ id }] = deps.viewerFeedbackStore.list();

    const response = await request(app).post(`/viewer-feedback/${id}/download`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('Peace be with you');
    expect(response.text).toContain('평안이 있기를');
    expect(response.text).toContain('unclear');
    expect(deps.viewerFeedbackStore.get(id)?.downloaded).toBe(true);
  });

  it('exposes the Content-Disposition header for cross-origin download requests', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({ language: 'fr', lineIndex: 0, english: 'A', translated: 'a' });
    const [{ id }] = deps.viewerFeedbackStore.list();

    const response = await request(app).post(`/viewer-feedback/${id}/download`);

    expect(response.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });
});

describe('POST /viewer-feedback/download-all', () => {
  it('returns a header-only CSV when nothing is undownloaded', async () => {
    const response = await request(createApp(testDeps())).post('/viewer-feedback/download-all');
    expect(response.status).toBe(200);
    expect(response.text).toBe('Timestamp,Language,English,Translated,Comment,Session ID\r\n');
  });

  it('returns only undownloaded items and marks them all downloaded', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 0, english: 'Alpha line', translated: 'あ' });
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 1, english: 'Beta line', translated: 'い' });
    const items = deps.viewerFeedbackStore.list(); // newest first: Beta, then Alpha
    const alphaId = items.find((item) => item.english === 'Alpha line')!.id;
    await request(app).post(`/viewer-feedback/${alphaId}/download`); // marks Alpha downloaded

    const response = await request(app).post('/viewer-feedback/download-all');

    expect(response.status).toBe(200);
    expect(response.text).toContain('Beta line');
    expect(response.text).not.toContain('Alpha line');
    expect(deps.viewerFeedbackStore.list().every((item) => item.downloaded)).toBe(true);
  });
});
