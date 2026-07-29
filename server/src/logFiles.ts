import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { open, readdir } from 'node:fs/promises';

// A session's log file stays current for a short window after the session
// stops, so a capture-device dropout (which fires session.stop() via the
// socket close handler) and its reconnect land in one file rather than two.
export const GRACE_MS = 5 * 60 * 1000;
export const MAX_ENTRIES_RETURNED = 20_000;

const SERVER_LOG = 'server.log';
const TAIL_BYTES = 64 * 1024;

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

// Reading only the head and tail keeps listing dozens of multi-megabyte files
// down to a few hundred bytes of I/O.
export async function firstLine(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(TAIL_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TAIL_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf-8');
    const newline = text.indexOf('\n');
    const line = (newline === -1 ? text : text.slice(0, newline)).trim();
    return line.length > 0 ? line : null;
  } finally {
    await handle.close();
  }
}

export async function lastLine(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    if (length === 0) return null;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    // A tail read can split a multi-byte character at the front of the buffer;
    // taking the last line means that partial line is never the one returned.
    const lines = buffer
      .toString('utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.at(-1) ?? null;
  } finally {
    await handle.close();
  }
}

function entryTimestamp(line: string | null): number | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown };
    if (typeof parsed.timestamp !== 'string') return null;
    const ms = Date.parse(parsed.timestamp);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

async function sessionFileNames(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.startsWith('session-') && name.endsWith('.log')).sort();
  } catch {
    return [];
  }
}

export interface LogFileStore {
  currentPath(now?: number): string;
  openSession(now?: number): void;
  closeSession(now?: number): void;
  activeName(): string | null;
  reset(): void;
  initFromDisk(): Promise<void>;
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

    async initFromDisk() {
      if (pinnedPath()) return;
      const names = await sessionFileNames(dir);
      const newest = names.at(-1);
      if (!newest) return;
      const stoppedAt = entryTimestamp(await lastLine(join(dir, newest)));
      if (stoppedAt === null) return;
      // Seed the same state a live stop would leave behind; the grace
      // comparison in currentPath() then decides whether to resume.
      currentSessionFile = newest;
      sessionStoppedAt = stoppedAt;
    },
  };
}
