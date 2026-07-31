import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import type { LogEntry } from './logHub.js';

// A session's log file stays current for a short window after the session
// stops, so a capture-device dropout (which fires session.stop() via the
// socket close handler) and its reconnect land in one file rather than two.
export const GRACE_MS = 5 * 60 * 1000;
export const MAX_ENTRIES_RETURNED = 20_000;

const SERVER_LOG = 'server.log';
const TAIL_BYTES = 64 * 1024;

// Only these three shapes are addressable. The character class excludes '.'
// and '/', so '..' and absolute paths cannot appear — an admin passcode must
// not become a way to read arbitrary files off the box.
const NAME_PATTERN = /^(session-[A-Za-z0-9+-]+\.log|server\.log|events\.log)$/;

export class LogFileNameError extends Error {
  constructor(name: string) {
    super(`unknown log file: ${name}`);
    this.name = 'LogFileNameError';
  }
}

export class LogFileActiveError extends Error {
  constructor(name: string) {
    super(`log file is the running session: ${name}`);
    this.name = 'LogFileActiveError';
  }
}

export class LogFileProtectedError extends Error {
  constructor(name: string) {
    super(`log file cannot be deleted: ${name}`);
    this.name = 'LogFileProtectedError';
  }
}

export interface LogFileContents {
  entries: LogEntry[];
  total: number;
  skipped: number;
  unparseable: number;
}

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

function entryTimestampIso(line: string | null): string | null {
  const ms = entryTimestamp(line);
  return ms === null ? null : new Date(ms).toISOString();
}

async function sessionFileNames(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.startsWith('session-') && name.endsWith('.log')).sort();
  } catch {
    return [];
  }
}

export interface LogFileInfo {
  name: string;
  kind: 'session' | 'server' | 'legacy';
  startedAt: string | null;
  endedAt: string | null;
  bytes: number;
  active: boolean;
}

export interface LogFileStore {
  currentPath(now?: number): string;
  openSession(now?: number): void;
  closeSession(now?: number): void;
  activeName(): string | null;
  reset(): void;
  initFromDisk(): Promise<void>;
  list(): Promise<LogFileInfo[]>;
  read(name: string): Promise<LogFileContents>;
  remove(name: string): Promise<void>;
}

export function createLogFileStore(dir: string, legacyPath: string): LogFileStore {
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

  function activeNameOf(): string | null {
    if (pinnedPath()) return null;
    return currentSessionFile && sessionStoppedAt === null ? currentSessionFile : null;
  }

  function resolveName(name: string): string {
    if (!NAME_PATTERN.test(name)) throw new LogFileNameError(name);
    return name === 'events.log' ? legacyPath : join(dir, name);
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
      return activeNameOf();
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
      // lastLine() opens and reads the file directly (unlike sessionFileNames'
      // readdir or entryTimestamp's JSON.parse, neither of which touch the
      // filesystem this way) and can reject on EACCES, EMFILE, or ENOENT — the
      // last one realistically when an admin deletes this exact file through
      // the Logs tab while a restart is in flight. This runs from a bare
      // top-level await in index.ts; a rejection here would stop the process
      // before httpServer.listen(), taking the whole service down over a
      // logging concern. Leave the state unseeded and return, exactly as for
      // a missing directory or a corrupt tail.
      let stoppedAt: number | null;
      try {
        stoppedAt = entryTimestamp(await lastLine(join(dir, newest)));
      } catch {
        return;
      }
      if (stoppedAt === null) return;
      // Seed the same state a live stop would leave behind; the grace
      // comparison in currentPath() then decides whether to resume.
      currentSessionFile = newest;
      sessionStoppedAt = stoppedAt;
    },

    async list() {
      const active = activeNameOf();
      const candidates: { name: string; kind: LogFileInfo['kind']; path: string }[] = [];
      for (const name of await sessionFileNames(dir)) {
        candidates.push({ name, kind: 'session', path: join(dir, name) });
      }
      candidates.push({ name: SERVER_LOG, kind: 'server', path: join(dir, SERVER_LOG) });
      candidates.push({ name: 'events.log', kind: 'legacy', path: legacyPath });

      const files: LogFileInfo[] = [];
      for (const candidate of candidates) {
        let bytes: number;
        try {
          bytes = (await stat(candidate.path)).size;
        } catch {
          continue; // server.log or the legacy file may simply not exist
        }
        const first = entryTimestampIso(await firstLine(candidate.path));
        const last = entryTimestampIso(await lastLine(candidate.path));
        files.push({
          name: candidate.name,
          kind: candidate.kind,
          startedAt: first,
          endedAt: last,
          bytes,
          active: candidate.name === active,
        });
      }

      // Newest first; a file with no readable first entry sorts last rather
      // than jumping to the top on a null comparison.
      return files.sort((a, b) => {
        if (a.startedAt === null && b.startedAt === null) return a.name.localeCompare(b.name);
        if (a.startedAt === null) return 1;
        if (b.startedAt === null) return -1;
        return Date.parse(b.startedAt) - Date.parse(a.startedAt);
      });
    },

    async read(name) {
      const text = await readFile(resolveName(name), 'utf-8');
      const lines = text.split('\n').filter((line) => line.trim().length > 0);
      const total = lines.length;
      const kept = lines.slice(Math.max(0, total - MAX_ENTRIES_RETURNED));
      const entries: LogEntry[] = [];
      let unparseable = 0;
      for (const line of kept) {
        try {
          entries.push(JSON.parse(line) as LogEntry);
        } catch {
          unparseable += 1;
        }
      }
      return { entries, total, skipped: total - kept.length, unparseable };
    },

    async remove(name) {
      if (name === 'events.log') throw new LogFileProtectedError(name);
      const path = resolveName(name);
      if (name === activeNameOf()) throw new LogFileActiveError(name);
      await unlink(path);
    },
  };
}

// Process-wide singleton: logger.ts resolves its append target through this,
// session.ts opens and closes it, index.ts seeds it from disk at boot.
export const logFiles = createLogFileStore('data/logs', 'data/events.log');
