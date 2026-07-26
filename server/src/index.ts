import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachWsServer } from './wsServer.js';
import { Session } from './session.js';
import { logHub } from './logHub.js';
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
import { GeminiCallLimiter, type CallPriority } from './geminiLimiter.js';
import { createOpenRouterClient } from './openRouterClient.js';
import type { OpenRouterClient } from './openRouterClient.js';
import { withOpenRouterCostTracking } from './openRouterCostTracking.js';
import { withOpenRouterLimiter } from './openRouterLimiter.js';
import { OpenRouterRateLimiter } from './openRouterRateLimiter.js';
import { withOpenRouterReasoningLogging } from './openRouterReasoningLogging.js';

const requiredEnvVars = ['DEEPGRAM_API_KEY', 'GEMINI_API_KEY'] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const session = new Session();
const costTracker = createCostTracker(process.env.COST_FILE_PATH ?? 'data/cost.json');
const geminiLimiter = new GeminiCallLimiter();
const geminiBaseClient = createGeminiClient(process.env.GEMINI_API_KEY!);
const geminiClient = withCostTracking(withGeminiLimiter(geminiBaseClient, geminiLimiter), costTracker);
// Same tier reasoning as openRouterClientCritical below — applies whenever the
// transcription-verifier role is configured onto a Gemini model rather than OpenRouter.
const geminiClientCritical = withCostTracking(
  withGeminiLimiter(geminiBaseClient, geminiLimiter, 'critical'),
  costTracker
);
// Parse a positive-integer env override, falling back to `fallback` when the
// var is unset, non-numeric (NaN), or below `min`. Without the NaN guard a typo
// like OPENROUTER_MAX_CONCURRENT=eight would make `active < NaN` always false and
// silently deadlock the OpenRouter path; a 0 backlog sub-cap would hang the
// backlog fill. min defaults to 1 so every knob stays in a safe range.
function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}
const openRouterLimiter = new GeminiCallLimiter(
  envInt('OPENROUTER_MAX_CONCURRENT', 8),
  envInt('OPENROUTER_BACKLOG_MAX_CONCURRENT', 2)
);
const openRouterRateLimiter = new OpenRouterRateLimiter(
  envInt('OPENROUTER_MAX_CALLS_PER_WINDOW', 5),
  envInt('OPENROUTER_RATE_WINDOW_MS', 2000),
  envInt('OPENROUTER_BACKLOG_MAX_CALLS_PER_WINDOW', 1)
);
const openRouterBaseClient = process.env.OPENROUTER_API_KEY
  ? createOpenRouterClient(process.env.OPENROUTER_API_KEY)
  : null;
function buildOpenRouterClient(priority: CallPriority): OpenRouterClient | null {
  if (!openRouterBaseClient) return null;
  return withOpenRouterReasoningLogging(
    withOpenRouterCostTracking(
      withOpenRouterLimiter(openRouterBaseClient, openRouterLimiter, openRouterRateLimiter, priority),
      costTracker
    )
  );
}
const openRouterClient = buildOpenRouterClient('live');
const openRouterClientBacklog = buildOpenRouterClient('backlog');
// The transcription check gates every caption in every language, so it gets
// the top limiter tier: it must never wait behind the translation calls it
// would otherwise share a queue with.
const openRouterClientCritical = buildOpenRouterClient('critical');
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

// Unset/empty -> default 30; a malformed (non-numeric) value falls back to 30
// too, rather than becoming NaN (which the backlog cap would read as "translate
// zero lines" — silently disabling backlog translation on a config typo).
const rawBacklogLimit = process.env.VIEWER_BACKLOG_TRANSLATE_LIMIT;
const parsedBacklogLimit = Number(rawBacklogLimit);
const viewerBacklogTranslateLimit =
  rawBacklogLimit && Number.isFinite(parsedBacklogLimit) ? parsedBacklogLimit : 30;

attachWsServer({
  httpServer,
  session,
  geminiClient,
  llmClients: { gemini: geminiClient, openRouter: openRouterClient },
  backlogLlmClients: { gemini: geminiClient, openRouter: openRouterClientBacklog },
  criticalLlmClients: { gemini: geminiClientCritical, openRouter: openRouterClientCritical },
  deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
  createDeepgramConnection,
  sermonDocStore,
  feedbackStore,
  costTracker,
  modelConfigStore,
  promptConfigStore,
  translationFlagDisplayStore,
  adminPasscode: process.env.ADMIN_PASSCODE,
  logHub,
  deepgramCostFlushIntervalMs: 5000,
  viewerBacklogTranslateLimit,
  maxPublishLagMs: process.env.MAX_PUBLISH_LAG_MS ? Number(process.env.MAX_PUBLISH_LAG_MS) : 8000,
  maxCorrectionLagMs: process.env.MAX_CORRECTION_LAG_MS ? Number(process.env.MAX_CORRECTION_LAG_MS) : 30000,
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
