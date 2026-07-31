import { TARGET_LANGUAGES } from './languages';

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event?: string;
  [key: string]: unknown;
}

export interface FormattedEntry {
  text: string;
  simple: boolean;
}

// Labels are '日本語 (Japanese)'; log prose wants the English name alone.
const LANGUAGE_NAME = new Map(
  TARGET_LANGUAGES.map((language) => [language.code, /\(([^)]+)\)/.exec(language.label)?.[1] ?? language.label])
);

function languageName(code: unknown): string | null {
  return typeof code === 'string' ? LANGUAGE_NAME.get(code) ?? code : null;
}

function languageNames(codes: unknown): string | null {
  if (!Array.isArray(codes)) return null;
  const names = codes.map((c) => languageName(c)).filter((n): n is string => n !== null);
  return names.length > 0 ? names.join(', ') : null;
}

function seconds(ms: unknown): string | null {
  return typeof ms === 'number' ? `${Math.round(ms / 100) / 10}s` : null;
}

interface Phrasing {
  /** Whether Simple mode shows this event at all. */
  simple: boolean;
  text: (payload: LogEntry) => string;
}

// Every event name emitted by server/src is expected here; a server-side test
// (server/tests/logEventCoverage.test.ts) fails if one is missing.
const PHRASING: Record<string, Phrasing> = {
  // ── session lifecycle ────────────────────────────────────────────────
  dg_diag_open: { simple: true, text: () => 'Session started' },
  dg_diag_close: {
    simple: true,
    text: (p) => `Session ended${typeof p.transcriptEventsReceived === 'number' ? ` — ${p.transcriptEventsReceived.toLocaleString()} transcript events` : ''}`,
  },
  dg_diag_error: { simple: true, text: (p) => `Transcription service error — ${String(p.error ?? 'no detail given')}` },
  dg_diag_metadata: { simple: false, text: () => 'Transcription service metadata received' },
  dg_diag_transcript: {
    simple: false,
    text: (p) => `${p.is_final ? 'Heard' : 'Hearing'}: "${String(p.text ?? '')}"`,
  },
  session_context_cache: { simple: false, text: () => 'Sermon context prepared for the models' },

  // ── captions the congregation sees ───────────────────────────────────
  transcription_flagged: { simple: true, text: () => "Line hidden — the transcription didn't make sense" },
  transcription_verify_timeout: { simple: true, text: () => 'Transcription check timed out — line shown unchecked' },
  transcription_verification_failed: { simple: true, text: (p) => `Transcription check failed — ${String(p.error ?? 'no detail given')}` },
  translation_fallback: { simple: true, text: (p) => {
    const name = languageName(p.language);
    return name ? `${name} translation rejected by the checker — showed English instead` : 'A translation was rejected by the checker — showed English instead';
  } },
  translation_missing_language: { simple: true, text: (p) => {
    const names = languageNames(p.languages);
    return names ? `No ${names} came back from the model — showed English instead` : 'No translation came back from the model — showed English instead';
  } },
  translation_failed: { simple: true, text: (p) => `Translation failed — ${String(p.error ?? 'no detail given')}` },
  backlog_translation_failed: { simple: true, text: (p) => `Catch-up translation failed — ${String(p.error ?? 'no detail given')}` },
  verification_failed: { simple: true, text: (p) => `Translation check failed — ${String(p.error ?? 'no detail given')}` },
  caption_corrected: {
    simple: true,
    text: (p) => {
      const outcome = String(p.outcome ?? '');
      if (outcome === 'upgrade') {
        const settled = languageNames(p.settledLanguages);
        if (settled) return `Caption improved for most languages, but ${settled} still showing English`;
        return 'Caption updated with the final translation';
      }
      if (outcome === 'settle') return 'No better translation arrived — line stays as shown';
      if (outcome === 'bailed') {
        const reason = String(p.reason ?? '');
        if (reason === 'session_restarted') return 'Correction abandoned — session restarted';
        if (reason === 'suppressed') return 'Correction abandoned — line was removed';
        if (reason === 'text_edited') return 'Correction abandoned — line text was edited';
        return 'Correction abandoned';
      }
      return 'Caption correction completed';
    },
  },
  correction_failed: { simple: true, text: (p) => `Could not send the corrected caption — ${String(p.error ?? 'no detail given')}` },
  publish_failed: { simple: true, text: (p) => `Could not send a caption to viewers — ${String(p.error ?? 'no detail given')}` },
  segment_processing_failed: { simple: true, text: (p) => `A line failed to process — ${String(p.error ?? 'no detail given')}` },

  // ── keeping up with the speaker ──────────────────────────────────────
  // caption_lag_shed is Detailed-only: ~2,300 fire in a bad service, and the
  // caption_corrected that follows each one already reports the outcome.
  caption_lag_shed: { simple: false, text: () => "Translation wasn't ready in time — showed English first" },
  caption_backpressure_engaged: { simple: true, text: (p) => {
    const dur = seconds(p.lagMs);
    return dur ? `Falling behind by ${dur} — pausing catch-up work` : 'Falling behind — pausing catch-up work';
  } },
  caption_backpressure_disengaged: { simple: true, text: () => 'Caught up — catch-up work resumed' },
  ingest_lag_high: { simple: true, text: (p) => {
    const dur = seconds(p.ingestWaitMs);
    return dur ? `Transcription checker is running ${dur} behind` : 'Transcription checker is running behind';
  } },
  ingest_lag_cleared: { simple: true, text: () => 'Transcription checker caught up' },
  verify_lag_high: { simple: true, text: (p) => {
    const dur = seconds(p.verifyLagMs);
    return dur ? `Transcription checks are ${dur} behind` : 'Transcription checks are running behind';
  } },
  verify_lag_cleared: { simple: true, text: () => 'Transcription checks caught up' },

  // ── operator actions and plumbing ────────────────────────────────────
  admin_remove_processing_failed: { simple: true, text: (p) => `Removing a line failed — ${String(p.error ?? 'no detail given')}` },
  reinstate_processing_failed: { simple: true, text: (p) => `Restoring a line failed — ${String(p.error ?? 'no detail given')}` },
  capture_message_error: { simple: true, text: (p) => `Capture page sent something unreadable — ${String(p.error ?? 'no detail given')}` },
  review_message_error: { simple: true, text: (p) => `Review page sent something unreadable — ${String(p.error ?? 'no detail given')}` },
  viewer_message_error: { simple: false, text: (p) => `A viewer sent something unreadable — ${String(p.error ?? 'no detail given')}` },
  capture_audio_stats_diag: { simple: false, text: (p) => `Audio statistics: ${String(p.audioChunkCount ?? 0)} chunks` },
  openrouter_reasoning: {
    simple: false,
    text: (p) => `Model reasoning recorded (${String(p.schema ?? 'unknown')} · ${String(p.model ?? '').split('/').pop() ?? ''})`,
  },
  role_cache_create_failed: { simple: true, text: (p) => `Could not cache the sermon context — ${String(p.error ?? 'no detail given')}` },
  role_cache_delete_failed: { simple: false, text: (p) => `Could not clear a context cache — ${String(p.error ?? 'no detail given')}` },
  cost_file_load_failed: { simple: false, text: () => 'Could not read the saved cost total' },
  cost_file_write_failed: { simple: true, text: () => 'Could not save the cost total' },
  viewer_feedback_file_load_failed: { simple: false, text: () => 'Could not read saved viewer feedback' },
  viewer_feedback_file_write_failed: { simple: true, text: () => 'Could not save viewer feedback' },
  unknown_gemini_pricing_model: { simple: false, text: (p) => `No price on file for model ${String(p.model ?? '')} — cost not counted` },
  log_rotation_disabled: {
    simple: true,
    text: (p) => `Logs are not being split by session — ${String(p.path ?? 'a fixed file')} is being used for everything`,
  },
};

function humanize(name: string): string {
  const spaced = name.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const STRUCTURAL_KEYS = new Set(['timestamp', 'level', 'event']);

export function formatEntry(entry: LogEntry): FormattedEntry {
  const phrasing = entry.event ? PHRASING[entry.event] : undefined;
  if (phrasing) return { text: phrasing.text(entry), simple: phrasing.simple };

  // An event with no phrasing is never dropped — it renders mechanically and
  // stays out of Simple until someone writes it one.
  const details = Object.keys(entry)
    .filter((key) => !STRUCTURAL_KEYS.has(key))
    .map((key) => `${key}: ${typeof entry[key] === 'string' ? entry[key] : JSON.stringify(entry[key])}`)
    .join(', ');
  return {
    text: humanize(entry.event ?? 'unnamed event') + (details ? ` — ${details}` : ''),
    simple: false,
  };
}

export const MIN_RUN_LENGTH = 3;

export interface LogRow {
  kind: 'one' | 'run';
  entry: LogEntry;
  count: number;
  from: string;
  to: string;
  items: LogEntry[];
}

/**
 * Collapses consecutive entries sharing an event name and level into one row.
 * Simple mode only — Detailed and Raw stay line-for-line. Grouping is by event
 * and level rather than by payload, so a burst of Japanese fallbacks
 * interleaved with Spanish ones breaks into several runs instead of merging
 * across the gap.
 */
export function collapseRuns(entries: LogEntry[]): LogRow[] {
  const rows: LogRow[] = [];
  let index = 0;
  while (index < entries.length) {
    let end = index;
    while (
      end + 1 < entries.length &&
      entries[end + 1].event === entries[index].event &&
      entries[end + 1].level === entries[index].level
    ) {
      end += 1;
    }
    const count = end - index + 1;
    if (count >= MIN_RUN_LENGTH) {
      rows.push({
        kind: 'run',
        entry: entries[index],
        count,
        from: entries[index].timestamp,
        to: entries[end].timestamp,
        items: entries.slice(index, end + 1),
      });
    } else {
      for (let cursor = index; cursor <= end; cursor += 1) {
        const entry = entries[cursor];
        rows.push({ kind: 'one', entry, count: 1, from: entry.timestamp, to: entry.timestamp, items: [entry] });
      }
    }
    index = end + 1;
  }
  return rows;
}
