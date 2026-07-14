import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GEMINI_PRICING_USD_PER_MILLION_TOKENS, DEEPGRAM_PRICING_USD_PER_MINUTE } from './costPricing.js';
import { logEvent } from './logger.js';

export interface GeminiUsage {
  promptTokens: number;
  candidatesTokens: number;
  cachedTokens: number;
}

export interface CostTracker {
  recordGeminiUsage(usage: GeminiUsage): void;
  recordDeepgramSeconds(seconds: number): void;
  resetSession(): void;
  getSessionCostUsd(): number;
  getLifetimeCostUsd(): number;
  onUpdate(listener: (sessionUsd: number, lifetimeUsd: number) => void): () => void;
}

function loadLifetimeUsd(filePath: string): number {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { lifetimeUsd?: unknown };
    return typeof parsed.lifetimeUsd === 'number' ? parsed.lifetimeUsd : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      void logEvent('warn', {
        event: 'cost_file_load_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return 0;
  }
}

export function createCostTracker(filePath: string): CostTracker {
  let sessionUsd = 0;
  let lifetimeUsd = loadLifetimeUsd(filePath);
  const listeners = new Set<(sessionUsd: number, lifetimeUsd: number) => void>();

  function persist(): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify({ lifetimeUsd }), 'utf-8');
    } catch (error) {
      void logEvent('warn', {
        event: 'cost_file_write_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function notify(): void {
    for (const listener of listeners) listener(sessionUsd, lifetimeUsd);
  }

  function addCost(usd: number): void {
    sessionUsd += usd;
    lifetimeUsd += usd;
    persist();
    notify();
  }

  return {
    recordGeminiUsage(usage: GeminiUsage): void {
      const pricing = GEMINI_PRICING_USD_PER_MILLION_TOKENS['gemini-3.1-flash-lite'];
      const nonCachedPromptTokens = Math.max(0, usage.promptTokens - usage.cachedTokens);
      const cost =
        (nonCachedPromptTokens / 1_000_000) * pricing.input +
        (usage.cachedTokens / 1_000_000) * pricing.cachedInput +
        (usage.candidatesTokens / 1_000_000) * pricing.output;
      addCost(cost);
    },
    recordDeepgramSeconds(seconds: number): void {
      const rate = DEEPGRAM_PRICING_USD_PER_MINUTE['nova-3'];
      addCost((seconds / 60) * rate);
    },
    resetSession(): void {
      sessionUsd = 0;
    },
    getSessionCostUsd(): number {
      return sessionUsd;
    },
    getLifetimeCostUsd(): number {
      return lifetimeUsd;
    },
    onUpdate(listener: (sessionUsd: number, lifetimeUsd: number) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
