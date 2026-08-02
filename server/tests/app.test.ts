import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createApp, type AppDeps } from '../src/app';
import { createSermonDocStore } from '../src/sermonDocStore';
import { createFeedbackStore } from '../src/feedbackStore';
import { createViewerFeedbackStore } from '../src/viewerFeedbackStore';
import { Session } from '../src/session';
import { createModelConfigStore, DEFAULT_MODEL_CONFIG } from '../src/modelConfigStore';
import { createPromptConfigStore, DEFAULT_PROMPT_CONFIG } from '../src/promptConfigStore';
import {
  createTranslationFlagDisplayStore,
  DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG,
} from '../src/translationFlagDisplayStore';
import { createOpenRouterModelsStore } from '../src/openRouterModelsStore';
import { createLogFileStore, type LogFileStore } from '../src/logFiles';

vi.mock('../src/docExtraction', () => ({
  extractDocumentText: vi.fn().mockResolvedValue('Extracted sermon text'),
}));

import { extractDocumentText } from '../src/docExtraction';

function testDeps(): AppDeps & { logsDir: string } {
  const logsDir = mkdtempSync(join(tmpdir(), 'app-logs-test-'));
  return {
    sermonDocStore: createSermonDocStore(),
    feedbackStore: createFeedbackStore(join(tmpdir(), `feedback-app-test-${Date.now()}-${Math.random()}.txt`)),
    viewerFeedbackStore: createViewerFeedbackStore(
      join(tmpdir(), `viewer-feedback-app-test-${Date.now()}-${Math.random()}.json`)
    ),
    session: new Session(),
    modelConfigStore: createModelConfigStore(join(tmpdir(), `model-config-app-test-${Date.now()}-${Math.random()}.json`)),
    promptConfigStore: createPromptConfigStore(join(tmpdir(), `prompt-config-app-test-${Date.now()}-${Math.random()}.json`)),
    translationFlagDisplayStore: createTranslationFlagDisplayStore(
      join(tmpdir(), `translation-flag-display-app-test-${Date.now()}-${Math.random()}.json`)
    ),
    openRouterModelsStore: createOpenRouterModelsStore(
      join(tmpdir(), `openrouter-models-app-test-${Date.now()}-${Math.random()}.json`)
    ),
    logFiles: createLogFileStore(logsDir, join(logsDir, 'events.log')),
    logsDir,
    adminPasscode: 'test-passcode',
  };
}

// A store double whose given method rejects, used to prove the admin routes
// never let a rejected promise escape as an unhandled rejection (Express 4
// does not forward those to error middleware — the request would just hang).
function brokenLogFiles(overrides: Partial<LogFileStore>): LogFileStore {
  return {
    currentPath: () => '',
    openSession: () => {},
    closeSession: () => {},
    activeName: () => null,
    reset: () => {},
    initFromDisk: async () => {},
    list: async () => [],
    read: async () => {
      throw new Error('not implemented in this double');
    },
    remove: async () => {},
    ...overrides,
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
      .set('x-admin-passcode', 'test-passcode')
      .attach('file', Buffer.from('fake pdf bytes'), { filename: 'sermon.pdf', contentType: 'application/pdf' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, characterCount: 'Extracted sermon text'.length });
    expect(deps.sermonDocStore.get()).toBe('Extracted sermon text');
  });

  it('returns 400 when no file is attached', async () => {
    const response = await request(createApp(testDeps()))
      .post('/sermon-doc')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(400);
  });

  it('returns 400 when extraction yields no text', async () => {
    (extractDocumentText as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');
    const response = await request(createApp(testDeps()))
      .post('/sermon-doc')
      .set('x-admin-passcode', 'test-passcode')
      .attach('file', Buffer.from('fake'), { filename: 'sermon.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(400);
  });

  it('returns 400 with the error message when extraction throws', async () => {
    (extractDocumentText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Unsupported document type: text/plain')
    );
    const response = await request(createApp(testDeps()))
      .post('/sermon-doc')
      .set('x-admin-passcode', 'test-passcode')
      .attach('file', Buffer.from('fake'), { filename: 'sermon.txt', contentType: 'text/plain' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Unsupported document type: text/plain' });
  });
});

describe('GET/PUT /feedback', () => {
  it('returns an empty string when nothing has been saved yet', async () => {
    const response = await request(createApp(testDeps()))
      .get('/feedback')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.body).toEqual({ text: '' });
  });

  it('saves feedback text and returns it on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const putResponse = await request(app)
      .put('/feedback')
      .set('x-admin-passcode', 'test-passcode')
      .send({ text: 'Cain -> 该隐' });
    expect(putResponse.status).toBe(200);

    const getResponse = await request(app).get('/feedback').set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual({ text: 'Cain -> 该隐' });
  });

  it('returns 401 without the passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/feedback');
    expect(response.status).toBe(401);
  });

  it('succeeds with the correct passcode header', async () => {
    const response = await request(createApp(testDeps()))
      .get('/feedback')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
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
    const response = await request(createApp(testDeps()))
      .get('/viewer-feedback')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.body).toEqual({ items: [] });
  });

  it('returns submitted items newest first', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 0, english: 'A', translated: 'あ' });
    await request(app).post('/viewer-feedback').send({ language: 'ja', lineIndex: 1, english: 'B', translated: 'い' });

    const response = await request(app).get('/viewer-feedback').set('x-admin-passcode', 'test-passcode');
    expect(response.body.items.map((item: { english: string }) => item.english)).toEqual(['B', 'A']);
  });
});

describe('POST /viewer-feedback/:id/download', () => {
  it('returns 404 for an unknown id', async () => {
    const response = await request(createApp(testDeps()))
      .post('/viewer-feedback/does-not-exist/download')
      .set('x-admin-passcode', 'test-passcode');
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

    const response = await request(app)
      .post(`/viewer-feedback/${id}/download`)
      .set('x-admin-passcode', 'test-passcode');

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

    const response = await request(app)
      .post(`/viewer-feedback/${id}/download`)
      .set('x-admin-passcode', 'test-passcode');

    expect(response.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });
});

describe('POST /viewer-feedback/download-all', () => {
  it('returns a header-only CSV when nothing is undownloaded', async () => {
    const response = await request(createApp(testDeps()))
      .post('/viewer-feedback/download-all')
      .set('x-admin-passcode', 'test-passcode');
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
    await request(app)
      .post(`/viewer-feedback/${alphaId}/download`)
      .set('x-admin-passcode', 'test-passcode'); // marks Alpha downloaded

    const response = await request(app)
      .post('/viewer-feedback/download-all')
      .set('x-admin-passcode', 'test-passcode');

    expect(response.status).toBe(200);
    expect(response.text).toContain('Beta line');
    expect(response.text).not.toContain('Alpha line');
    expect(deps.viewerFeedbackStore.list().every((item) => item.downloaded)).toBe(true);
  });
});

describe('gated review routes', () => {
  it('POST /viewer-feedback stays open (used by the public /view page)', async () => {
    const response = await request(createApp(testDeps()))
      .post('/viewer-feedback')
      .send({ language: 'es', lineIndex: 0, english: 'Hi', translated: 'Hola' });
    expect(response.status).toBe(200);
  });

  it('GET /viewer-feedback requires the passcode', async () => {
    const response = await request(createApp(testDeps())).get('/viewer-feedback');
    expect(response.status).toBe(401);
  });

  it('GET /viewer-feedback succeeds with the passcode', async () => {
    const response = await request(createApp(testDeps()))
      .get('/viewer-feedback')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
  });

  it('POST /sermon-doc requires the passcode', async () => {
    const response = await request(createApp(testDeps()))
      .post('/sermon-doc')
      .attach('file', Buffer.from('fake pdf bytes'), { filename: 'sermon.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(401);
  });
});

describe('GET/PUT /admin/model-config', () => {
  it('returns 401 without the admin passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/admin/model-config');
    expect(response.status).toBe(401);
  });

  it('returns the default config on first read', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/model-config')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('saves a valid config and returns it on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const newConfig = {
      transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      translation: { provider: 'openrouter', model: 'qwen/qwen3.6-flash' },
      translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    };

    const putResponse = await request(app)
      .put('/admin/model-config')
      .set('x-admin-passcode', 'test-passcode')
      .send(newConfig);
    expect(putResponse.status).toBe(200);

    const getResponse = await request(app).get('/admin/model-config').set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual(newConfig);
  });

  it('rejects an invalid model id with 400 and does not persist it', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const putResponse = await request(app)
      .put('/admin/model-config')
      .set('x-admin-passcode', 'test-passcode')
      .send({ transcriptionVerifier: 'gpt-5', translation: 'gemini-3.5-flash', translationVerifier: 'gemini-3.1-flash-lite' });
    expect(putResponse.status).toBe(400);

    const getResponse = await request(app).get('/admin/model-config').set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual(DEFAULT_MODEL_CONFIG);
  });
});

describe('GET/PUT /admin/prompt-config', () => {
  it('returns 401 without the admin passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/admin/prompt-config');
    expect(response.status).toBe(401);
  });

  it('returns the default notes and the fixed rules for reference on first read', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/prompt-config')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body.notes).toEqual(DEFAULT_PROMPT_CONFIG);
    expect(typeof response.body.fixedRules.transcriptionVerifier).toBe('string');
    expect(typeof response.body.fixedRules.translation).toBe('string');
    expect(typeof response.body.fixedRules.translationVerifier).toBe('string');
  });

  it('saves valid notes and returns them on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const newNotes = { transcriptionVerifier: 'a', translation: 'b', translationVerifier: 'c' };

    const putResponse = await request(app)
      .put('/admin/prompt-config')
      .set('x-admin-passcode', 'test-passcode')
      .send(newNotes);
    expect(putResponse.status).toBe(200);

    const getResponse = await request(app).get('/admin/prompt-config').set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body.notes).toEqual(newNotes);
  });

  it('rejects a payload missing a role with 400', async () => {
    const response = await request(createApp(testDeps()))
      .put('/admin/prompt-config')
      .set('x-admin-passcode', 'test-passcode')
      .send({ transcriptionVerifier: 'a', translation: 'b' });
    expect(response.status).toBe(400);
  });
});

describe('GET/PUT /admin/translation-flag-display', () => {
  it('returns 401 without the admin passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/admin/translation-flag-display');
    expect(response.status).toBe(401);
  });

  it('returns the default config (hide) on first read', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });

  it('saves a valid config and returns it on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const putResponse = await request(app)
      .put('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode')
      .send({ mode: 'flag' });
    expect(putResponse.status).toBe(200);

    const getResponse = await request(app)
      .get('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual({ mode: 'flag' });
  });

  it('rejects an invalid mode with 400 and does not persist it', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const putResponse = await request(app)
      .put('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode')
      .send({ mode: 'delete-everything' });
    expect(putResponse.status).toBe(400);

    const getResponse = await request(app)
      .get('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });
});

describe('GET/POST /admin/openrouter-models', () => {
  it('returns 401 without the admin passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/admin/openrouter-models');
    expect(response.status).toBe(401);
  });

  it('returns an empty list on first read', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/openrouter-models')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ models: [] });
  });

  it('adds a model id and returns it on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const postResponse = await request(app)
      .post('/admin/openrouter-models')
      .set('x-admin-passcode', 'test-passcode')
      .send({ model: 'qwen/qwen3.6-flash' });
    expect(postResponse.status).toBe(200);
    expect(postResponse.body).toEqual({ models: ['qwen/qwen3.6-flash'] });

    const getResponse = await request(app).get('/admin/openrouter-models').set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual({ models: ['qwen/qwen3.6-flash'] });
  });

  it('rejects an empty model id with 400', async () => {
    const response = await request(createApp(testDeps()))
      .post('/admin/openrouter-models')
      .set('x-admin-passcode', 'test-passcode')
      .send({ model: '' });
    expect(response.status).toBe(400);
  });
});

function logLine(timestamp: string, event: string): string {
  return JSON.stringify({ timestamp, level: 'info', event }) + '\n';
}

describe('GET /admin/logs', () => {
  it('requires the admin passcode', async () => {
    const response = await request(createApp(testDeps())).get('/admin/logs');
    expect(response.status).toBe(401);
  });

  it('lists the files in the log directory', async () => {
    const deps = testDeps();
    writeFileSync(join(deps.logsDir, 'session-2026-07-26T15-27+1000.log'), logLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    const response = await request(createApp(deps)).get('/admin/logs').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0]).toMatchObject({
      name: 'session-2026-07-26T15-27+1000.log',
      kind: 'session',
      startedAt: '2026-07-26T05:27:05.418Z',
      active: false,
    });
  });

  it('returns 500 instead of hanging when the store throws unexpectedly', async () => {
    const deps = testDeps();
    deps.logFiles = brokenLogFiles({
      list: async () => {
        throw new Error('disk on fire');
      },
    });
    const response = await request(createApp(deps)).get('/admin/logs').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(500);
  });
});

describe('GET /admin/logs/:name', () => {
  it('requires the admin passcode', async () => {
    const response = await request(createApp(testDeps())).get('/admin/logs/server.log');
    expect(response.status).toBe(401);
  });

  it('returns the parsed entries with counts', async () => {
    const deps = testDeps();
    writeFileSync(join(deps.logsDir, 'server.log'), logLine('2026-07-27T01:00:00.000Z', 'cost_file_load_failed'));
    const response = await request(createApp(deps)).get('/admin/logs/server.log').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 1, skipped: 0, unparseable: 0 });
    expect(response.body.entries[0].event).toBe('cost_file_load_failed');
  });

  it('returns 404 for a name that fails validation', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/logs/' + encodeURIComponent('../../etc/passwd'))
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(404);
  });

  it('returns 404 for a well-formed name that does not exist', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/logs/session-2026-07-26T15-27+1000.log')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(404);
  });

  it('returns 500 instead of hanging when the store throws unexpectedly', async () => {
    const deps = testDeps();
    deps.logFiles = brokenLogFiles({
      read: async () => {
        throw new Error('disk on fire');
      },
    });
    const response = await request(createApp(deps)).get('/admin/logs/server.log').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(500);
  });
});

describe('DELETE /admin/logs/:name', () => {
  it('requires the admin passcode', async () => {
    const response = await request(createApp(testDeps())).delete('/admin/logs/server.log');
    expect(response.status).toBe(401);
  });

  it('deletes a past session file', async () => {
    const deps = testDeps();
    writeFileSync(join(deps.logsDir, 'session-2026-07-26T15-27+1000.log'), logLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    const app = createApp(deps);
    const response = await request(app).delete('/admin/logs/session-2026-07-26T15-27+1000.log').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(204);
    const list = await request(app).get('/admin/logs').set('x-admin-passcode', 'test-passcode');
    expect(list.body.files).toEqual([]);
  });

  it('returns 409 when the file is the running session', async () => {
    const deps = testDeps();
    deps.logFiles.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    writeFileSync(join(deps.logsDir, 'session-2026-07-26T15-27+1000.log'), logLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    const response = await request(createApp(deps))
      .delete('/admin/logs/session-2026-07-26T15-27+1000.log')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(409);
  });

  it('returns 403 for the legacy file', async () => {
    const deps = testDeps();
    writeFileSync(join(deps.logsDir, 'events.log'), logLine('2026-07-18T00:00:00.000Z', 'dg_diag_open'));
    const response = await request(createApp(deps)).delete('/admin/logs/events.log').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(403);
  });

  it('returns 404 for a name that fails validation', async () => {
    const response = await request(createApp(testDeps()))
      .delete('/admin/logs/' + encodeURIComponent('../../etc/passwd'))
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(404);
  });

  it('returns 404 for a well-formed name that does not exist', async () => {
    const response = await request(createApp(testDeps()))
      .delete('/admin/logs/session-2026-07-26T15-27+1000.log')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(404);
  });

  it('returns 500 instead of hanging when the store throws unexpectedly', async () => {
    const deps = testDeps();
    deps.logFiles = brokenLogFiles({
      remove: async () => {
        throw new Error('disk on fire');
      },
    });
    const response = await request(createApp(deps))
      .delete('/admin/logs/server.log')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(500);
  });
});
