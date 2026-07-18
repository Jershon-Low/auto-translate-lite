import express, { type Express } from 'express';
import cors from 'cors';
import multer from 'multer';
import { extractDocumentText } from './docExtraction.js';
import { toCsv } from './csv.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { ViewerFeedbackStore } from './viewerFeedbackStore.js';
import type { Session } from './session.js';
import { createAdminAuth } from './adminAuth.js';
import { validateModelConfig, type ModelConfigStore } from './modelConfigStore.js';
import { validatePromptConfig, type PromptConfigStore } from './promptConfigStore.js';
import {
  validateTranslationFlagDisplayConfig,
  type TranslationFlagDisplayStore,
} from './translationFlagDisplayStore.js';
import type { OpenRouterModelsStore } from './openRouterModelsStore.js';
import {
  TRANSLATION_FIXED_RULES,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_INTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_OUTRO,
} from './llmPrompts.js';

export interface AppDeps {
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
  viewerFeedbackStore: ViewerFeedbackStore;
  session: Session;
  modelConfigStore: ModelConfigStore;
  promptConfigStore: PromptConfigStore;
  openRouterModelsStore: OpenRouterModelsStore;
  translationFlagDisplayStore: TranslationFlagDisplayStore;
  adminPasscode: string | undefined;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json());

  const adminAuth = createAdminAuth(deps.adminPasscode);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/sermon-doc', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const text = await extractDocumentText(req.file.buffer, req.file.mimetype);
      if (text.length === 0) {
        res.status(400).json({ error: 'Could not extract any text from this document' });
        return;
      }
      deps.sermonDocStore.set(text);
      res.json({ ok: true, characterCount: text.length });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to process document' });
    }
  });

  app.get('/feedback', async (_req, res) => {
    const text = await deps.feedbackStore.read();
    res.json({ text });
  });

  app.put('/feedback', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    await deps.feedbackStore.write(text);
    res.json({ ok: true });
  });

  app.post('/viewer-feedback', (req, res) => {
    const { language, lineIndex, english, translated, comment } = req.body ?? {};
    if (
      typeof language !== 'string' ||
      typeof lineIndex !== 'number' ||
      typeof english !== 'string' ||
      typeof translated !== 'string'
    ) {
      res.status(400).json({ error: 'language, lineIndex, english, and translated are required' });
      return;
    }
    deps.viewerFeedbackStore.add({
      sessionId: deps.session.id,
      language,
      lineIndex,
      english,
      translated,
      comment: typeof comment === 'string' ? comment : '',
    });
    res.json({ ok: true });
  });

  app.get('/viewer-feedback', (_req, res) => {
    res.json({ items: deps.viewerFeedbackStore.list() });
  });

  const VIEWER_FEEDBACK_CSV_HEADER = ['Timestamp', 'Language', 'English', 'Translated', 'Comment', 'Session ID'];

  app.post('/viewer-feedback/:id/download', (req, res) => {
    const item = deps.viewerFeedbackStore.get(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Feedback item not found' });
      return;
    }
    deps.viewerFeedbackStore.markDownloaded([item.id]);
    const csv = toCsv(VIEWER_FEEDBACK_CSV_HEADER, [
      [item.timestamp, item.language, item.english, item.translated, item.comment, item.sessionId],
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-${item.id}.csv"`);
    res.send(csv);
  });

  app.post('/viewer-feedback/download-all', (_req, res) => {
    const undownloaded = deps.viewerFeedbackStore.getUndownloaded();
    deps.viewerFeedbackStore.markDownloaded(undownloaded.map((item) => item.id));
    const csv = toCsv(
      VIEWER_FEEDBACK_CSV_HEADER,
      undownloaded.map((item) => [item.timestamp, item.language, item.english, item.translated, item.comment, item.sessionId])
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-all-${Date.now()}.csv"`);
    res.send(csv);
  });

  app.get('/admin/model-config', adminAuth, async (_req, res) => {
    res.json(await deps.modelConfigStore.read());
  });

  app.put('/admin/model-config', adminAuth, async (req, res) => {
    const config = validateModelConfig(req.body);
    if (!config) {
      res.status(400).json({ error: 'Invalid model config: all three roles must be set to a supported model id' });
      return;
    }
    await deps.modelConfigStore.write(config);
    res.json({ ok: true });
  });

  app.get('/admin/prompt-config', adminAuth, async (_req, res) => {
    res.json({
      notes: await deps.promptConfigStore.read(),
      fixedRules: {
        transcriptionVerifier: `${TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO}\n\n${TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO}`,
        translation: TRANSLATION_FIXED_RULES,
        translationVerifier: `${TRANSLATION_VERIFIER_FIXED_RULES_INTRO}\n\n${TRANSLATION_VERIFIER_FIXED_RULES_OUTRO}`,
      },
    });
  });

  app.put('/admin/prompt-config', adminAuth, async (req, res) => {
    const config = validatePromptConfig(req.body);
    if (!config) {
      res.status(400).json({ error: 'Invalid prompt config: all three roles must be set to a string' });
      return;
    }
    await deps.promptConfigStore.write(config);
    res.json({ ok: true });
  });

  app.get('/admin/openrouter-models', adminAuth, async (_req, res) => {
    res.json({ models: await deps.openRouterModelsStore.read() });
  });

  app.post('/admin/openrouter-models', adminAuth, async (req, res) => {
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    if (model.length === 0) {
      res.status(400).json({ error: 'model is required' });
      return;
    }
    const models = await deps.openRouterModelsStore.addModel(model);
    res.json({ models });
  });

  app.get('/admin/translation-flag-display', adminAuth, async (_req, res) => {
    res.json(await deps.translationFlagDisplayStore.read());
  });

  app.put('/admin/translation-flag-display', adminAuth, async (req, res) => {
    const config = validateTranslationFlagDisplayConfig(req.body);
    if (!config) {
      res.status(400).json({ error: 'Invalid translation flag display config: mode must be "hide" or "flag"' });
      return;
    }
    await deps.translationFlagDisplayStore.write(config);
    res.json({ ok: true });
  });

  return app;
}
