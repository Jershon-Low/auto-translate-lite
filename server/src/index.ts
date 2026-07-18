import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachWsServer } from './wsServer.js';
import { Session } from './session.js';
import { createGeminiClient } from './gemini.js';
import { createDeepgramConnection } from './deepgram.js';
import { createSermonDocStore } from './sermonDocStore.js';
import { createFeedbackStore } from './feedbackStore.js';
import { createViewerFeedbackStore } from './viewerFeedbackStore.js';
import { createCostTracker } from './costTracker.js';
import { createModelConfigStore } from './modelConfigStore.js';
import { createPromptConfigStore } from './promptConfigStore.js';
import { createTranslationFlagDisplayStore } from './translationFlagDisplayStore.js';
import { createOpenRouterModelsStore } from './openRouterModelsStore.js';
import { withCostTracking } from './geminiCostTracking.js';
import { withGeminiLimiter } from './geminiRateLimiting.js';
import { GeminiCallLimiter } from './geminiLimiter.js';
import { createOpenRouterClient } from './openRouterClient.js';
import { withOpenRouterCostTracking } from './openRouterCostTracking.js';
import { withOpenRouterLimiter } from './openRouterLimiter.js';

const requiredEnvVars = ['DEEPGRAM_API_KEY', 'GEMINI_API_KEY'] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const session = new Session();
const costTracker = createCostTracker(process.env.COST_FILE_PATH ?? 'data/cost.json');
const geminiLimiter = new GeminiCallLimiter();
const geminiClient = withCostTracking(
  withGeminiLimiter(createGeminiClient(process.env.GEMINI_API_KEY!), geminiLimiter),
  costTracker
);
const openRouterLimiter = new GeminiCallLimiter();
const openRouterClient = process.env.OPENROUTER_API_KEY
  ? withOpenRouterCostTracking(
      withOpenRouterLimiter(createOpenRouterClient(process.env.OPENROUTER_API_KEY), openRouterLimiter),
      costTracker
    )
  : null;
const sermonDocStore = createSermonDocStore();
const feedbackStore = createFeedbackStore(process.env.FEEDBACK_FILE_PATH ?? 'data/feedback.txt');
const viewerFeedbackStore = createViewerFeedbackStore(
  process.env.VIEWER_FEEDBACK_FILE_PATH ?? 'data/viewer-feedback.json'
);
const modelConfigStore = createModelConfigStore(process.env.MODEL_CONFIG_FILE_PATH ?? 'data/model-config.json');
const promptConfigStore = createPromptConfigStore(process.env.PROMPT_CONFIG_FILE_PATH ?? 'data/prompt-config.json');
const openRouterModelsStore = createOpenRouterModelsStore(
  process.env.OPENROUTER_MODELS_FILE_PATH ?? 'data/openrouter-models.json'
);
const translationFlagDisplayStore = createTranslationFlagDisplayStore(
  process.env.TRANSLATION_FLAG_DISPLAY_FILE_PATH ?? 'data/translation-flag-display.json'
);

const app = createApp({
  sermonDocStore,
  feedbackStore,
  viewerFeedbackStore,
  session,
  modelConfigStore,
  promptConfigStore,
  openRouterModelsStore,
  translationFlagDisplayStore,
  adminPasscode: process.env.ADMIN_PASSCODE,
});
const httpServer = createServer(app);

attachWsServer({
  httpServer,
  session,
  geminiClient,
  llmClients: { gemini: geminiClient, openRouter: openRouterClient },
  deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
  createDeepgramConnection,
  sermonDocStore,
  feedbackStore,
  costTracker,
  modelConfigStore,
  promptConfigStore,
  translationFlagDisplayStore,
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
