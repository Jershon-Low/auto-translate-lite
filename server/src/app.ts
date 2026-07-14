import express, { type Express } from 'express';
import cors from 'cors';
import multer from 'multer';
import { extractDocumentText } from './docExtraction.js';
import { toCsv } from './csv.js';
import type { SermonDocStore } from './sermonDocStore.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { ViewerFeedbackStore } from './viewerFeedbackStore.js';
import type { Session } from './session.js';

export interface AppDeps {
  sermonDocStore: SermonDocStore;
  feedbackStore: FeedbackStore;
  viewerFeedbackStore: ViewerFeedbackStore;
  session: Session;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

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

  return app;
}
