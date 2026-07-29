import { existsSync } from 'node:fs';
import { join } from 'node:path';

// A session's log file stays current for a short window after the session
// stops, so a capture-device dropout (which fires session.stop() via the
// socket close handler) and its reconnect land in one file rather than two.
export const GRACE_MS = 5 * 60 * 1000;
export const MAX_ENTRIES_RETURNED = 20_000;

const SERVER_LOG = 'server.log';

// Melbourne wall-clock sorts chronologically, reads correctly over SSH, and
// the explicit offset disambiguates the repeated hour at the April DST
// rollback (+1100 before it, +1000 after).
export function melbourneStamp(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(ms);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  // longOffset gives 'GMT+10:00'; the filename wants '+1000'.
  const offset = get('timeZoneName').replace('GMT', '').replace(':', '') || '+0000';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}-${get('minute')}${offset}`;
}

export interface LogFileStore {
  currentPath(now?: number): string;
  openSession(now?: number): void;
  closeSession(now?: number): void;
  activeName(): string | null;
  reset(): void;
}

export function createLogFileStore(dir: string, legacyPath: string): LogFileStore {
  void legacyPath; // used from Task 3 (list) onward

  let currentSessionFile: string | null = null;
  let sessionStoppedAt: number | null = null;

  function pinnedPath(): string | undefined {
    return process.env.LOG_FILE_PATH;
  }

  function withinGrace(now: number): boolean {
    return sessionStoppedAt !== null && now - sessionStoppedAt <= GRACE_MS;
  }

  function uniqueName(ms: number): string {
    const stamp = melbourneStamp(ms);
    let name = `session-${stamp}.log`;
    let suffix = 2;
    while (existsSync(join(dir, name))) {
      name = `session-${stamp}-${suffix}.log`;
      suffix += 1;
    }
    return name;
  }

  return {
    currentPath(now = Date.now()) {
      const pinned = pinnedPath();
      if (pinned) return pinned;
      if (currentSessionFile && (sessionStoppedAt === null || withinGrace(now))) {
        return join(dir, currentSessionFile);
      }
      return join(dir, SERVER_LOG);
    },

    openSession(now = Date.now()) {
      if (pinnedPath()) return;
      // Already running — a second 'start' must not rotate mid-service.
      if (currentSessionFile && sessionStoppedAt === null) return;
      // A reconnect inside the grace window resumes the same file.
      if (currentSessionFile && withinGrace(now)) {
        sessionStoppedAt = null;
        return;
      }
      currentSessionFile = uniqueName(now);
      sessionStoppedAt = null;
    },

    closeSession(now = Date.now()) {
      if (pinnedPath()) return;
      if (!currentSessionFile || sessionStoppedAt !== null) return;
      sessionStoppedAt = now;
    },

    activeName() {
      if (pinnedPath()) return null;
      return currentSessionFile && sessionStoppedAt === null ? currentSessionFile : null;
    },

    reset() {
      currentSessionFile = null;
      sessionStoppedAt = null;
    },
  };
}
