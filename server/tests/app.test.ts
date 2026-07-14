import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { createSermonDocStore } from '../src/sermonDocStore';
import { createFeedbackStore } from '../src/feedbackStore';

vi.mock('../src/docExtraction', () => ({
  extractDocumentText: vi.fn().mockResolvedValue('Extracted sermon text'),
}));

import { extractDocumentText } from '../src/docExtraction';

function testDeps() {
  return {
    sermonDocStore: createSermonDocStore(),
    feedbackStore: createFeedbackStore(join(tmpdir(), `feedback-app-test-${Date.now()}-${Math.random()}.txt`)),
  };
}

describe('GET /health', () => {
  it('returns status ok', async () => {
    const response = await request(createApp(testDeps())).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
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
