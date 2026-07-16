// Rates verified against Google's and Deepgram's published pricing as of mid-2026
// (see README.md's "Cost analysis" section, which these values match exactly).
// There is no live pricing API for either provider — update these manually if
// Google or Deepgram change their published rates.

export const GEMINI_PRICING_USD_PER_MILLION_TOKENS = {
  'gemini-3.1-flash-lite': {
    input: 0.25,
    cachedInput: 0.025,
    output: 1.5,
  },
  'gemini-3.5-flash': {
    input: 1.5,
    // Google publishes a 90% cached-input discount across Gemini models; verify
    // this exact figure against live pricing before relying on it for budgeting.
    cachedInput: 0.15,
    output: 9.0,
  },
} as const;

export const DEEPGRAM_PRICING_USD_PER_MINUTE = {
  'nova-3': 0.0077,
} as const;
