# Per-Session Log Files and a Readable Log Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `server/data/events.log` into one log file per capture session, and give the admin Logs tab a Melbourne-labelled file picker with plain-English rendering of each entry.

**Architecture:** A new `server/src/logFiles.ts` owns the log directory — naming, which file is current, listing, reading, deleting — exposed as a `createLogFileStore(dir, legacyPath)` factory plus a process-wide singleton. `logger.ts` and `session.ts` use the singleton; `app.ts` receives a store through `AppDeps` so tests can inject a temp directory. Three new admin HTTP routes serve the list, one file's contents, and deletion. On the client, `web/lib/logFormat.ts` holds a phrasing table keyed by event name, and `web/app/admin/page.tsx` gains a file picker and Simple/Detailed/Raw view modes.

**Tech Stack:** Node 22 + TypeScript (ESM, `.js` import specifiers), Express 5, vitest + supertest, Next.js 16 + React 19, Tailwind v4, shadcn `base-nova` style backed by `@base-ui/react`.

**Spec:** [`docs/superpowers/specs/2026-07-29-per-session-log-files-design.md`](../specs/2026-07-29-per-session-log-files-design.md)

## Global Constraints

- Server source is ESM TypeScript: **every relative import must end in `.js`** (e.g. `import { logFiles } from './logFiles.js'`). Test files import without the extension (`from '../src/logFiles'`) — follow the existing files exactly.
- `GRACE_MS = 5 * 60 * 1000`. `MAX_ENTRIES_RETURNED = 20_000`. `TAIL_BYTES = 64 * 1024`.
- Timezone string is exactly `'Australia/Melbourne'`.
- Session filename format: `session-<YYYY>-<MM>-<DD>T<HH>-<mm><±HHMM>.log`, e.g. `session-2026-07-26T15-27+1000.log`. Collisions get `-2`, `-3`, … before `.log`.
- Log directory is `data/logs`; idle file is `data/logs/server.log`; frozen legacy file stays at `data/events.log` and is reported under the name `events.log`.
- `process.env.LOG_FILE_PATH`, when set, overrides everything and disables rotation. This is how the existing tests isolate themselves — never break it.
- Never change what a log line contains. The server keeps writing `{ timestamp, level, ...payload }` exactly as today.
- Web UI: dark mode only, single blue accent from `--primary`. Read `web/docs/STYLE_GUIDE.md` before touching `web/app/` or `web/components/`. This project's `ToggleGroup` has **no `type="single"`** — it takes an array `value` with a `multiple` flag defaulting to false; for single-select pass `value={[current]}` and read `values[0]`.
- Web is Next.js **16.2.10** / React **19.2.4**. `web/AGENTS.md`: this is not the Next.js in your training data — read `web/node_modules/next/dist/docs/` before using an unfamiliar API.
- Run `npx tsc --noEmit` in `server/` before every server commit; `npm test` must stay green (439 tests across 37 files at branch start).

---

### Task 1: `logFiles` — Melbourne naming and current-file resolution

**Files:**
- Create: `server/src/logFiles.ts`
- Test: `server/tests/logFiles.test.ts`

**Interfaces:**
- Consumes: `LogEntry` from `server/src/logHub.ts` (already exists: `{ timestamp: string; level: 'info'|'warn'|'error'; event?: string; [key: string]: unknown }`).
- Produces: `melbourneStamp(ms: number): string`, `createLogFileStore(dir: string, legacyPath: string): LogFileStore`, and the constants `GRACE_MS`, `MAX_ENTRIES_RETURNED`. This task implements only `currentPath()`, `openSession()`, `closeSession()`, `activeName()`, `reset()` on the store; Tasks 2–4 add `initFromDisk()`, `list()`, `read()`, `remove()`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/logFiles.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogFileStore, melbourneStamp, GRACE_MS } from '../src/logFiles';

let dir: string;

beforeEach(async () => {
  delete process.env.LOG_FILE_PATH;
  dir = await mkdtemp(join(tmpdir(), 'logfiles-test-'));
});

afterEach(async () => {
  delete process.env.LOG_FILE_PATH;
  await rm(dir, { recursive: true, force: true });
});

function store() {
  return createLogFileStore(dir, join(dir, 'events.log'));
}

describe('melbourneStamp', () => {
  it('renders an AEST instant with a +1000 offset', () => {
    // 2026-07-26T05:27:05Z is 3:27 PM in Melbourne, winter (AEST, UTC+10).
    expect(melbourneStamp(Date.parse('2026-07-26T05:27:05.418Z'))).toBe('2026-07-26T15-27+1000');
  });

  it('renders an AEDT instant with a +1100 offset', () => {
    // 2026-01-15T05:00:00Z is 4:00 PM in Melbourne, summer (AEDT, UTC+11).
    expect(melbourneStamp(Date.parse('2026-01-15T05:00:00.000Z'))).toBe('2026-01-15T16-00+1100');
  });

  it('renders midnight as hour 00, not 24', () => {
    // 2026-07-25T14:00:00Z is exactly midnight in Melbourne.
    expect(melbourneStamp(Date.parse('2026-07-25T14:00:00.000Z'))).toBe('2026-07-26T00-00+1000');
  });
});

describe('current file resolution', () => {
  it('writes to server.log before any session has started', () => {
    expect(store().currentPath()).toBe(join(dir, 'server.log'));
  });

  it('writes to a session file named for the start instant once a session opens', () => {
    const s = store();
    s.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('keeps writing to the session file during the grace window after a stop', () => {
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    s.closeSession(start + 60_000);
    // A disconnect diagnostic logged 30s after the stop belongs to that service.
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('falls back to server.log once the grace window has elapsed', async () => {
    const s = store();
    const start = Date.now() - GRACE_MS * 3;
    s.openSession(start);
    s.closeSession(start + 1000);
    expect(s.currentPath()).toBe(join(dir, 'server.log'));
  });

  it('resumes the same file when a reconnect lands inside the grace window', () => {
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    s.closeSession(start + 60_000);
    s.openSession(start + 120_000);
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('starts a new file when the next session is past the grace window', () => {
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    s.closeSession(start + 60_000);
    s.openSession(start + 60_000 + GRACE_MS + 1);
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-28+1000.log'));
  });

  it('is a no-op when openSession is called twice without a stop', () => {
    // The double-start bug fires session.start() twice; it must not rotate mid-service.
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    s.openSession(start + 12_000);
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('is a no-op when closeSession is called twice', () => {
    // session.stop() fires from both the 'stop' message and the socket close handler.
    const s = store();
    const start = Date.now();
    s.openSession(start);
    s.closeSession(start + 1000);
    s.closeSession(start + 2000);
    expect(s.activeName()).toBeNull();
    expect(s.currentPath()).toBe(join(dir, melbourneSessionName(start)));
  });

  it('reports the running session as active, and nothing once it stops', () => {
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    expect(s.activeName()).toBe('session-2026-07-26T15-27+1000.log');
    s.closeSession(start + 1000);
    expect(s.activeName()).toBeNull();
  });

  it('suffixes a colliding filename rather than appending to the wrong session', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), '');
    const s = store();
    s.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000-2.log'));
  });
});

describe('LOG_FILE_PATH override', () => {
  it('returns the override and never rotates', () => {
    process.env.LOG_FILE_PATH = '/tmp/pinned.log';
    const s = store();
    s.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    expect(s.currentPath()).toBe('/tmp/pinned.log');
    expect(s.activeName()).toBeNull();
  });
});

function melbourneSessionName(ms: number): string {
  return `session-${melbourneStamp(ms)}.log`;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/logFiles.test.ts`
Expected: FAIL — `Failed to resolve import "../src/logFiles"`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/logFiles.ts`:

```ts
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
  currentPath(): string;
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
    currentPath() {
      const pinned = pinnedPath();
      if (pinned) return pinned;
      if (currentSessionFile && (sessionStoppedAt === null || withinGrace(Date.now()))) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/logFiles.test.ts && npx tsc --noEmit`
Expected: PASS, 14 tests. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/logFiles.ts server/tests/logFiles.test.ts
git commit -m "Add logFiles store: Melbourne naming and session-file resolution"
```

---

### Task 2: `logFiles` — boot resumption from the newest file's tail

**Files:**
- Modify: `server/src/logFiles.ts`
- Test: `server/tests/logFiles.test.ts`

**Interfaces:**
- Consumes: `createLogFileStore` from Task 1.
- Produces: `initFromDisk(): Promise<void>` on `LogFileStore`, plus internal `firstLine(path)` / `lastLine(path)` helpers that Task 3 reuses. Export both helpers so Task 3 can use them: `export async function firstLine(path: string): Promise<string | null>` and `export async function lastLine(path: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/logFiles.test.ts`:

```ts
import { writeFile } from 'node:fs/promises';

describe('initFromDisk', () => {
  it('resumes the newest session file when its last entry is inside the grace window', async () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    await writeFile(
      join(dir, 'session-2026-07-26T15-27+1000.log'),
      JSON.stringify({ timestamp: recent, level: 'info', event: 'dg_diag_open' }) + '\n'
    );
    const s = store();
    await s.initFromDisk();
    // A pm2 restart mid-service must keep writing to the same file.
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('does not resume a session whose last entry is older than the grace window', async () => {
    const old = new Date(Date.now() - GRACE_MS * 4).toISOString();
    await writeFile(
      join(dir, 'session-2026-07-26T15-27+1000.log'),
      JSON.stringify({ timestamp: old, level: 'info', event: 'dg_diag_close' }) + '\n'
    );
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe(join(dir, 'server.log'));
  });

  it('picks the newest of several session files', async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    const old = new Date(Date.now() - GRACE_MS * 10).toISOString();
    await writeFile(join(dir, 'session-2026-07-25T09-00+1000.log'), JSON.stringify({ timestamp: old, level: 'info' }) + '\n');
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), JSON.stringify({ timestamp: recent, level: 'info' }) + '\n');
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('treats a corrupt tail as no resumable session', async () => {
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), '{"timestamp":"2026-07-2\n');
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe(join(dir, 'server.log'));
  });

  it('treats an empty session file as no resumable session', async () => {
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), '');
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe(join(dir, 'server.log'));
  });

  it('does nothing when the log directory does not exist yet', async () => {
    const s = createLogFileStore(join(dir, 'missing'), join(dir, 'events.log'));
    await expect(s.initFromDisk()).resolves.toBeUndefined();
    expect(s.currentPath()).toBe(join(dir, 'missing', 'server.log'));
  });

  it('does nothing when LOG_FILE_PATH is set', async () => {
    const recent = new Date().toISOString();
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), JSON.stringify({ timestamp: recent, level: 'info' }) + '\n');
    process.env.LOG_FILE_PATH = '/tmp/pinned.log';
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe('/tmp/pinned.log');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/logFiles.test.ts -t initFromDisk`
Expected: FAIL — `s.initFromDisk is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `server/src/logFiles.ts` (module scope, above `createLogFileStore`):

```ts
import { open, readdir } from 'node:fs/promises';

const TAIL_BYTES = 64 * 1024;

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
```

Add `initFromDisk` to the returned object in `createLogFileStore`:

```ts
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
```

Add `initFromDisk(): Promise<void>;` to the `LogFileStore` interface.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/logFiles.test.ts && npx tsc --noEmit`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/logFiles.ts server/tests/logFiles.test.ts
git commit -m "Resume the current session log across a restart or crash"
```

---

### Task 3: `logFiles` — listing files with metadata

**Files:**
- Modify: `server/src/logFiles.ts`
- Test: `server/tests/logFiles.test.ts`

**Interfaces:**
- Consumes: `firstLine`, `lastLine` from Task 2; `legacyPath` constructor argument from Task 1.
- Produces: `LogFileInfo` and `list(): Promise<LogFileInfo[]>`.

```ts
export interface LogFileInfo {
  name: string;
  kind: 'session' | 'server' | 'legacy';
  startedAt: string | null;
  endedAt: string | null;
  bytes: number;
  active: boolean;
}
```

- [ ] **Step 1: Write the failing test**

Append to `server/tests/logFiles.test.ts`:

```ts
import { stat } from 'node:fs/promises';

function entryLine(timestamp: string, event: string): string {
  return JSON.stringify({ timestamp, level: 'info', event }) + '\n';
}

describe('list', () => {
  it('returns an empty array when the directory does not exist', async () => {
    const s = createLogFileStore(join(dir, 'missing'), join(dir, 'nope.log'));
    expect(await s.list()).toEqual([]);
  });

  it('reports start and end from the first and last entries', async () => {
    await writeFile(
      join(dir, 'session-2026-07-26T15-27+1000.log'),
      entryLine('2026-07-26T05:27:05.418Z', 'dg_diag_open') +
        entryLine('2026-07-26T06:00:00.000Z', 'caption_corrected') +
        entryLine('2026-07-26T07:07:45.006Z', 'dg_diag_close')
    );
    const [file] = await store().list();
    expect(file.name).toBe('session-2026-07-26T15-27+1000.log');
    expect(file.kind).toBe('session');
    expect(file.startedAt).toBe('2026-07-26T05:27:05.418Z');
    expect(file.endedAt).toBe('2026-07-26T07:07:45.006Z');
    expect(file.bytes).toBe((await stat(join(dir, 'session-2026-07-26T15-27+1000.log'))).size);
    expect(file.active).toBe(false);
  });

  it('reports a single-entry file with equal start and end', async () => {
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), entryLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    const [file] = await store().list();
    expect(file.startedAt).toBe('2026-07-26T05:27:05.418Z');
    expect(file.endedAt).toBe('2026-07-26T05:27:05.418Z');
  });

  it('reports an empty file with null timestamps rather than failing the listing', async () => {
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), '');
    const [file] = await store().list();
    expect(file.startedAt).toBeNull();
    expect(file.endedAt).toBeNull();
    expect(file.bytes).toBe(0);
  });

  it('sorts newest first, with unknown-start files last', async () => {
    await writeFile(join(dir, 'session-2026-07-25T09-00+1000.log'), entryLine('2026-07-24T23:00:00.000Z', 'dg_diag_open'));
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), entryLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    await writeFile(join(dir, 'session-2026-07-27T09-42+1000.log'), '');
    const names = (await store().list()).map((file) => file.name);
    expect(names).toEqual([
      'session-2026-07-26T15-27+1000.log',
      'session-2026-07-25T09-00+1000.log',
      'session-2026-07-27T09-42+1000.log',
    ]);
  });

  it('includes server.log and the legacy file with their own kinds', async () => {
    await writeFile(join(dir, 'server.log'), entryLine('2026-07-27T01:00:00.000Z', 'cost_file_load_failed'));
    await writeFile(join(dir, 'events.log'), entryLine('2026-07-18T00:00:00.000Z', 'dg_diag_open'));
    const kinds = Object.fromEntries((await store().list()).map((file) => [file.name, file.kind]));
    expect(kinds).toEqual({ 'server.log': 'server', 'events.log': 'legacy' });
  });

  it('omits the legacy file when it does not exist', async () => {
    await writeFile(join(dir, 'server.log'), entryLine('2026-07-27T01:00:00.000Z', 'x'));
    expect((await store().list()).map((file) => file.name)).toEqual(['server.log']);
  });

  it('marks only the running session as active', async () => {
    const s = store();
    s.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), entryLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    await writeFile(join(dir, 'session-2026-07-25T09-00+1000.log'), entryLine('2026-07-24T23:00:00.000Z', 'dg_diag_open'));
    const active = Object.fromEntries((await s.list()).map((file) => [file.name, file.active]));
    expect(active).toEqual({
      'session-2026-07-26T15-27+1000.log': true,
      'session-2026-07-25T09-00+1000.log': false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/logFiles.test.ts -t list`
Expected: FAIL — `s.list is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the `LogFileInfo` interface (shown in the Interfaces block above) and `list(): Promise<LogFileInfo[]>` to `LogFileStore`. Add `import { stat } from 'node:fs/promises';` to the existing import, then add to the returned object:

```ts
    async list() {
      const active = this.activeName();
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
```

`this.activeName()` requires the returned object literal to be typed; if TypeScript complains, hoist `activeName` to a local `function activeNameOf(): string | null` in the closure and call that from both places. Add the ISO helper at module scope beside `entryTimestamp`:

```ts
function entryTimestampIso(line: string | null): string | null {
  const ms = entryTimestamp(line);
  return ms === null ? null : new Date(ms).toISOString();
}
```

Delete the `void legacyPath;` line added in Task 1 — it is now used.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/logFiles.test.ts && npx tsc --noEmit`
Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/logFiles.ts server/tests/logFiles.test.ts
git commit -m "List log files with metadata read from head and tail only"
```

---

### Task 4: `logFiles` — reading, deleting, and name validation

**Files:**
- Modify: `server/src/logFiles.ts`
- Test: `server/tests/logFiles.test.ts`

**Interfaces:**
- Produces: `LogFileContents`, `read(name)`, `remove(name)`, and three error classes used by Task 6 to pick status codes.

```ts
export interface LogFileContents {
  entries: LogEntry[];
  total: number;
  skipped: number;
  unparseable: number;
}
export class LogFileNameError extends Error {}      // → 404
export class LogFileActiveError extends Error {}    // → 409
export class LogFileProtectedError extends Error {} // → 403
```

- [ ] **Step 1: Write the failing test**

Append to `server/tests/logFiles.test.ts` (extend the top-level import to include the three error classes and `MAX_ENTRIES_RETURNED`):

```ts
describe('read', () => {
  it('parses NDJSON entries in file order', async () => {
    await writeFile(
      join(dir, 'server.log'),
      entryLine('2026-07-27T01:00:00.000Z', 'first') + entryLine('2026-07-27T01:00:01.000Z', 'second')
    );
    const contents = await store().read('server.log');
    expect(contents.entries.map((entry) => entry.event)).toEqual(['first', 'second']);
    expect(contents).toMatchObject({ total: 2, skipped: 0, unparseable: 0 });
  });

  it('keeps only the newest MAX_ENTRIES_RETURNED and reports how many it skipped', async () => {
    const lines: string[] = [];
    for (let index = 0; index < MAX_ENTRIES_RETURNED + 5; index += 1) {
      lines.push(entryLine('2026-07-27T01:00:00.000Z', `e${index}`));
    }
    await writeFile(join(dir, 'server.log'), lines.join(''));
    const contents = await store().read('server.log');
    expect(contents.entries).toHaveLength(MAX_ENTRIES_RETURNED);
    expect(contents.total).toBe(MAX_ENTRIES_RETURNED + 5);
    expect(contents.skipped).toBe(5);
    // The newest are the ones kept.
    expect(contents.entries.at(-1)?.event).toBe(`e${MAX_ENTRIES_RETURNED + 4}`);
  });

  it('counts unparseable lines instead of failing the whole read', async () => {
    await writeFile(join(dir, 'server.log'), entryLine('2026-07-27T01:00:00.000Z', 'ok') + '{"broken\n');
    const contents = await store().read('server.log');
    expect(contents.entries).toHaveLength(1);
    expect(contents.unparseable).toBe(1);
    expect(contents.total).toBe(2);
  });

  it('reads the legacy file from its own path', async () => {
    await writeFile(join(dir, 'events.log'), entryLine('2026-07-18T00:00:00.000Z', 'legacy_event'));
    const contents = await store().read('events.log');
    expect(contents.entries[0].event).toBe('legacy_event');
  });

  it.each(['../../etc/passwd', 'session-x.log/../../secret', '/etc/passwd', 'other.log', 'session-x.txt'])(
    'rejects the unsafe name %s',
    async (name) => {
      await expect(store().read(name)).rejects.toBeInstanceOf(LogFileNameError);
    }
  );

  it('propagates ENOENT for a well-formed name that does not exist', async () => {
    await expect(store().read('session-2026-07-26T15-27+1000.log')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('remove', () => {
  it('deletes a past session file', async () => {
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), entryLine('2026-07-26T05:27:05.418Z', 'x'));
    const s = store();
    await s.remove('session-2026-07-26T15-27+1000.log');
    expect(await s.list()).toEqual([]);
  });

  it('refuses to delete the running session', async () => {
    const s = store();
    s.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), entryLine('2026-07-26T05:27:05.418Z', 'x'));
    await expect(s.remove('session-2026-07-26T15-27+1000.log')).rejects.toBeInstanceOf(LogFileActiveError);
  });

  it('refuses to delete the legacy file', async () => {
    await writeFile(join(dir, 'events.log'), entryLine('2026-07-18T00:00:00.000Z', 'x'));
    await expect(store().remove('events.log')).rejects.toBeInstanceOf(LogFileProtectedError);
  });

  it('rejects an unsafe name', async () => {
    await expect(store().remove('../../etc/passwd')).rejects.toBeInstanceOf(LogFileNameError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/logFiles.test.ts -t read`
Expected: FAIL — `s.read is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `server/src/logFiles.ts` — extend the `node:fs/promises` import with `readFile, unlink`, add `import type { LogEntry } from './logHub.js';`, then at module scope:

```ts
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
```

Add `LogFileContents`, plus `read` and `remove` to the interface, and inside `createLogFileStore`:

```ts
  function resolveName(name: string): string {
    if (!NAME_PATTERN.test(name)) throw new LogFileNameError(name);
    return name === 'events.log' ? legacyPath : join(dir, name);
  }
```

and on the returned object:

```ts
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
```

Note the ordering: the protected check runs before `resolveName` so `events.log` reports 403 rather than being read as a valid name, and the active check runs after validation so an unsafe name still reports 404.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/logFiles.test.ts && npx tsc --noEmit`
Expected: PASS, 42 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/logFiles.ts server/tests/logFiles.test.ts
git commit -m "Read, delete, and validate log file names"
```

---

### Task 5: Wire the store into `logger`, `session`, and `index`

**Files:**
- Modify: `server/src/logFiles.ts` (add the singleton export)
- Modify: `server/src/logger.ts:5-7`
- Modify: `server/src/session.ts` (the `start()` and `stop()` methods)
- Modify: `server/src/index.ts` (await `initFromDisk()` at boot)
- Test: `server/tests/logger.test.ts`, `server/tests/session.test.ts`

**Interfaces:**
- Consumes: `createLogFileStore`, `LogFileStore` from Tasks 1–4.
- Produces: `export const logFiles: LogFileStore` — the process-wide singleton, constructed as `createLogFileStore('data/logs', 'data/events.log')`.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/logger.test.ts` (inside the existing `describe('logEvent')`):

```ts
  it('writes into the session file the log store reports as current', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    const { createLogFileStore } = await import('../src/logFiles');
    const store = createLogFileStore(tempDir, join(tempDir, 'events.log'));
    store.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    // logEvent resolves its target through the singleton; assert the contract
    // the singleton implements rather than reaching into module state.
    expect(store.currentPath()).toBe(join(tempDir, 'session-2026-07-26T15-27+1000.log'));
  });
```

Add to the top of `server/tests/session.test.ts`, before the imports of `Session`:

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Session.start()/stop() drive the log-file store; pinning LOG_FILE_PATH keeps
// these unit tests from creating files under server/data/logs.
process.env.LOG_FILE_PATH = join(tmpdir(), 'auto-translate-lite-session-test-events.log');
```

And add a new test to `server/tests/session.test.ts`:

```ts
  it('opens a log-file session on start and closes it on stop', () => {
    const session = new Session();
    session.start();
    session.stop();
    // With LOG_FILE_PATH pinned the store is inert; this asserts the calls
    // exist and do not throw, which is what the wiring must guarantee.
    expect(session.id).toEqual(expect.any(String));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/logger.test.ts tests/session.test.ts`
Expected: the logger test FAILS on the missing `../src/logFiles` export path only if Task 1–4 are absent; otherwise it passes and the session test fails once `session.ts` has no `openSession` call — verify by checking `git diff` shows no `logFiles` import in `session.ts` yet.

- [ ] **Step 3: Write minimal implementation**

Add to the bottom of `server/src/logFiles.ts`:

```ts
// Process-wide singleton: logger.ts resolves its append target through this,
// session.ts opens and closes it, index.ts seeds it from disk at boot.
export const logFiles = createLogFileStore('data/logs', 'data/events.log');
```

Replace `server/src/logger.ts:5-7`:

```ts
import { logFiles } from './logFiles.js';

function getLogFilePath(): string {
  return logFiles.currentPath();
}
```

In `server/src/session.ts`, add `import { logFiles } from './logFiles.js';` and one call in each method:

```ts
  start(): void {
    this.id = randomUUID();
    // …existing resets, unchanged…
    logFiles.openSession();
  }

  stop(): void {
    // …existing body, unchanged…
    logFiles.closeSession();
  }
```

In `server/src/index.ts`, before the server starts listening, add `import { logFiles } from './logFiles.js';` and:

```ts
  // Seed the store from disk so a restart mid-service resumes the same file
  // instead of splitting the session across two logs.
  await logFiles.initFromDisk();
```

Place it inside whatever async bootstrap already exists; if `index.ts` has no top-level async context, use `await` at module top level (the server is ESM, so top-level await is available).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS — the full suite, now 441+ tests. Confirm no new files appeared under `server/data/logs/` from the test run: `ls server/data/logs 2>/dev/null` should be empty or absent.

- [ ] **Step 5: Commit**

```bash
git add server/src/logFiles.ts server/src/logger.ts server/src/session.ts server/src/index.ts server/tests/logger.test.ts server/tests/session.test.ts
git commit -m "Route logEvent through the per-session log file store"
```

---

### Task 6: Admin HTTP routes for the log files

**Files:**
- Modify: `server/src/app.ts` (`AppDeps`, and three new routes beside `/admin/translation-flag-display`)
- Modify: `server/src/index.ts` (pass `logFiles` into `createApp`)
- Test: `server/tests/app.test.ts`

**Interfaces:**
- Consumes: `LogFileStore`, `LogFileNameError`, `LogFileActiveError`, `LogFileProtectedError`, `createLogFileStore` from Tasks 1–5.
- Produces: `GET /admin/logs` → `{ files: LogFileInfo[] }`; `GET /admin/logs/:name` → `LogFileContents`; `DELETE /admin/logs/:name` → `204`. `AppDeps` gains `logFiles: LogFileStore`.

- [ ] **Step 1: Write the failing test**

In `server/tests/app.test.ts`, extend `testDeps()` with a per-test temp store. Add at the top of the file:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createLogFileStore } from '../src/logFiles';
```

and inside `testDeps()`, before the `return`:

```ts
  const logsDir = mkdtempSync(join(tmpdir(), 'app-logs-test-'));
```

and in the returned object: `logFiles: createLogFileStore(logsDir, join(logsDir, 'events.log')), logsDir,`.

`logsDir` is not part of `AppDeps`; declare `testDeps()`'s return type as the inline object (it is currently inferred) so the extra key is available to tests. If TypeScript rejects the extra property where `AppDeps` is expected, keep `logsDir` out of the object and have each test create its own directory instead.

Then append these tests:

```ts
function logLine(timestamp: string, event: string): string {
  return JSON.stringify({ timestamp, level: 'info', event }) + '\n';
}

describe('GET /admin/logs', () => {
  it('requires the admin passcode', async () => {
    const response = await request(createApp(testDeps())).get('/admin/logs');
    expect(response.status).toBe(401);
  });

  it('lists the files in the log directory', async () => {
    const deps = testDeps();
    writeFileSync(join(deps.logsDir, 'session-2026-07-26T15-27+1000.log'), logLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    const response = await request(createApp(deps)).get('/admin/logs').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0]).toMatchObject({
      name: 'session-2026-07-26T15-27+1000.log',
      kind: 'session',
      startedAt: '2026-07-26T05:27:05.418Z',
      active: false,
    });
  });
});

describe('GET /admin/logs/:name', () => {
  it('requires the admin passcode', async () => {
    const response = await request(createApp(testDeps())).get('/admin/logs/server.log');
    expect(response.status).toBe(401);
  });

  it('returns the parsed entries with counts', async () => {
    const deps = testDeps();
    writeFileSync(join(deps.logsDir, 'server.log'), logLine('2026-07-27T01:00:00.000Z', 'cost_file_load_failed'));
    const response = await request(createApp(deps)).get('/admin/logs/server.log').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 1, skipped: 0, unparseable: 0 });
    expect(response.body.entries[0].event).toBe('cost_file_load_failed');
  });

  it('returns 404 for a name that fails validation', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/logs/' + encodeURIComponent('../../etc/passwd'))
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(404);
  });

  it('returns 404 for a well-formed name that does not exist', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/logs/session-2026-07-26T15-27+1000.log')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(404);
  });
});

describe('DELETE /admin/logs/:name', () => {
  it('requires the admin passcode', async () => {
    const response = await request(createApp(testDeps())).delete('/admin/logs/server.log');
    expect(response.status).toBe(401);
  });

  it('deletes a past session file', async () => {
    const deps = testDeps();
    writeFileSync(join(deps.logsDir, 'session-2026-07-26T15-27+1000.log'), logLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    const app = createApp(deps);
    const response = await request(app).delete('/admin/logs/session-2026-07-26T15-27+1000.log').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(204);
    const list = await request(app).get('/admin/logs').set('x-admin-passcode', 'test-passcode');
    expect(list.body.files).toEqual([]);
  });

  it('returns 409 when the file is the running session', async () => {
    const deps = testDeps();
    deps.logFiles.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    writeFileSync(join(deps.logsDir, 'session-2026-07-26T15-27+1000.log'), logLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    const response = await request(createApp(deps))
      .delete('/admin/logs/session-2026-07-26T15-27+1000.log')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(409);
  });

  it('returns 403 for the legacy file', async () => {
    const deps = testDeps();
    writeFileSync(join(deps.logsDir, 'events.log'), logLine('2026-07-18T00:00:00.000Z', 'dg_diag_open'));
    const response = await request(createApp(deps)).delete('/admin/logs/events.log').set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/app.test.ts -t admin/logs`
Expected: FAIL — 404 from Express for every route (no handler registered).

- [ ] **Step 3: Write minimal implementation**

In `server/src/app.ts`, add to the imports:

```ts
import {
  LogFileActiveError,
  LogFileNameError,
  LogFileProtectedError,
  type LogFileStore,
} from './logFiles.js';
```

Add `logFiles: LogFileStore;` to `AppDeps`, then add the three routes after the `/admin/translation-flag-display` block:

```ts
  app.get('/admin/logs', adminAuth, async (_req, res) => {
    res.json({ files: await deps.logFiles.list() });
  });

  app.get('/admin/logs/:name', adminAuth, async (req, res) => {
    try {
      res.json(await deps.logFiles.read(req.params.name));
    } catch (error) {
      // An unknown name and an absent file are the same answer to a client:
      // there is no such log.
      if (error instanceof LogFileNameError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      throw error;
    }
  });

  app.delete('/admin/logs/:name', adminAuth, async (req, res) => {
    try {
      await deps.logFiles.remove(req.params.name);
      res.status(204).end();
    } catch (error) {
      if (error instanceof LogFileProtectedError) {
        res.status(403).json({ error: 'This log cannot be deleted.' });
        return;
      }
      if (error instanceof LogFileActiveError) {
        res.status(409).json({ error: 'That session is still running.' });
        return;
      }
      if (error instanceof LogFileNameError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      throw error;
    }
  });
```

In `server/src/index.ts`, add `logFiles` to the `createApp({ … })` call.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS. If Express 5 does not forward a rejected async handler to the error middleware in this version, the two `throw error` branches will surface as unhandled rejections — in that case replace each `throw error` with `res.status(500).json({ error: 'Failed to read the log.' })` and note it in your report.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/tests/app.test.ts
git commit -m "Add admin endpoints to list, read, and delete log files"
```

---

### Task 7: Bundled fixes — double-`start` leak and test log pollution

**Files:**
- Modify: `server/src/wsServer.ts` (the `message.type === 'start'` handler, around line 415)
- Modify: `server/tests/costTracker.test.ts`, `server/tests/viewerFeedbackStore.test.ts`
- Test: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. This task is independent and may be implemented in any order relative to Tasks 1–6.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Add to `server/tests/wsServer.test.ts`, in the capture-connection describe block, following the file's existing socket-test patterns:

```ts
  it('finishes the previous Deepgram connection when a second start arrives', async () => {
    // Observed twice in production (25 Jul 14:15:20/14:15:32, 26 Jul
    // 05:01:18/05:05:51): a second 'start' replaced deepgramConnection without
    // finishing the first, leaking a live Deepgram socket for the rest of the
    // process.
    const { socket, deps } = await openCaptureSocket();
    socket.send(JSON.stringify({ type: 'start' }));
    await waitForDeepgramOpen(deps);
    const first = deps.createDeepgramConnection.mock.results[0].value;

    socket.send(JSON.stringify({ type: 'start' }));
    await waitForDeepgramOpen(deps, 2);

    expect(first.finish).toHaveBeenCalledTimes(1);
    socket.close();
  });
```

Use the helper names this test file already defines for opening a capture socket and for the Deepgram factory mock; if they differ, adapt the test to the existing helpers rather than adding new ones. If the file has no helper that waits for the nth Deepgram connection, add a local one in the same style as the file's existing waiters.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/wsServer.test.ts -t "second start"`
Expected: FAIL — `expect(first.finish).toHaveBeenCalledTimes(1)` receives 0.

- [ ] **Step 3: Write minimal implementation**

In `server/src/wsServer.ts`, inside the `if (message.type === 'start') {` branch, before `deps.session.start();`:

```ts
            // A second 'start' on the same socket must not orphan the first
            // Deepgram connection — it stays open and billing otherwise.
            if (deepgramConnection) {
              deepgramConnection.finish();
              deepgramConnection = null;
              deepgramReady = false;
              resetAudioBuffering();
            }
```

In `server/tests/costTracker.test.ts` and `server/tests/viewerFeedbackStore.test.ts`, add above the first import of the module under test (matching `wsServer.test.ts:22`):

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LOG_FILE_PATH = join(tmpdir(), 'auto-translate-lite-test-events.log');
```

If either file already imports `tmpdir` or `join`, extend the existing import rather than duplicating it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS. Then verify the pollution fix: `wc -l server/data/events.log` before and after a `npm test` run — the count must not change.

- [ ] **Step 5: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts server/tests/costTracker.test.ts server/tests/viewerFeedbackStore.test.ts
git commit -m "Finish the prior Deepgram connection on a second start; stop tests writing to the real log"
```

---

### Task 8: `web/lib/logFormat.ts` — the phrasing table

**Files:**
- Create: `web/lib/logFormat.ts`

**Interfaces:**
- Consumes: `TARGET_LANGUAGES` from `web/lib/languages.ts` (shape: `{ code: string; label: string }[]`, labels like `'日本語 (Japanese)'`).
- Produces: `LogEntry`, `FormattedEntry`, `LogRow`, `formatEntry(entry)`, `collapseRuns(entries)`, `MIN_RUN_LENGTH`. Task 11 consumes all of these.

- [ ] **Step 1: Write the implementation**

There is no test runner in `web/` (`web/package.json` has no `test` script), so this task's gate is the typecheck plus Task 9's coverage test. Create `web/lib/logFormat.ts`:

```ts
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

function languageName(code: unknown): string {
  return typeof code === 'string' ? LANGUAGE_NAME.get(code) ?? code : String(code);
}

function languageNames(codes: unknown): string {
  return Array.isArray(codes) ? codes.map(languageName).join(', ') : languageName(codes);
}

function seconds(ms: unknown): string {
  return typeof ms === 'number' ? `${Math.round(ms / 100) / 10}s` : String(ms);
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
    text: (p) => `${p.is_final ? 'Heard' : 'Hearing'}: “${String(p.text ?? '')}”`,
  },
  session_context_cache: { simple: false, text: () => 'Sermon context prepared for the models' },

  // ── captions the congregation sees ───────────────────────────────────
  transcription_flagged: { simple: true, text: () => "Line hidden — the transcription didn't make sense" },
  transcription_verify_timeout: { simple: true, text: () => 'Transcription check timed out — line shown unchecked' },
  transcription_verification_failed: { simple: true, text: (p) => `Transcription check failed — ${String(p.error ?? 'no detail given')}` },
  translation_fallback: { simple: true, text: (p) => `${languageName(p.language)} translation rejected by the checker — showed English instead` },
  translation_missing_language: { simple: true, text: (p) => `No ${languageNames(p.languages)} came back from the model — showed English instead` },
  translation_failed: { simple: true, text: (p) => `Translation failed — ${String(p.error ?? 'no detail given')}` },
  backlog_translation_failed: { simple: true, text: (p) => `Catch-up translation failed — ${String(p.error ?? 'no detail given')}` },
  verification_failed: { simple: true, text: (p) => `Translation check failed — ${String(p.error ?? 'no detail given')}` },
  caption_corrected: {
    simple: true,
    text: (p) => `Caption updated with the final translation${Array.isArray(p.languages) ? ` (${languageNames(p.languages)})` : ''}`,
  },
  correction_failed: { simple: true, text: (p) => `Could not send the corrected caption — ${String(p.error ?? 'no detail given')}` },
  publish_failed: { simple: true, text: (p) => `Could not send a caption to viewers — ${String(p.error ?? 'no detail given')}` },
  segment_processing_failed: { simple: true, text: (p) => `A line failed to process — ${String(p.error ?? 'no detail given')}` },

  // ── keeping up with the speaker ──────────────────────────────────────
  // caption_lag_shed is Detailed-only: ~2,300 fire in a bad service, and the
  // caption_corrected that follows each one already reports the outcome.
  caption_lag_shed: { simple: false, text: () => "Translation wasn't ready in time — showed English first" },
  caption_backpressure_engaged: { simple: true, text: (p) => `Falling behind by ${seconds(p.lagMs)} — pausing catch-up work` },
  caption_backpressure_disengaged: { simple: true, text: () => 'Caught up — catch-up work resumed' },
  ingest_lag_high: { simple: true, text: (p) => `Transcription checker is running ${seconds(p.lagMs)} behind` },
  ingest_lag_cleared: { simple: true, text: () => 'Transcription checker caught up' },
  verify_lag_high: { simple: true, text: (p) => `Transcription checks are ${seconds(p.lagMs)} behind` },
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
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify the language extraction against the real table**

Run: `cd web && node --input-type=module -e "const m = await import('./lib/languages.ts').catch(() => null); console.log(m ? 'ok' : 'inspect manually')"`
If that fails because Node cannot load TypeScript directly, instead open `web/lib/languages.ts` and confirm by eye that every entry's `label` contains a parenthesised English name. Record which languages, if any, do not — those fall back to the full label, which is acceptable but should be named in your report.

- [ ] **Step 4: Commit**

```bash
git add web/lib/logFormat.ts
git commit -m "Add the log phrasing table and run collapsing"
```

---

### Task 9: Server-side phrasing coverage test

**Files:**
- Create: `server/tests/logEventCoverage.test.ts`

**Interfaces:**
- Consumes: `web/lib/logFormat.ts` from Task 8, read from disk as text.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `server/tests/logEventCoverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC_DIR = join(__dirname, '..', 'src');
const PHRASING_FILE = join(__dirname, '..', '..', 'web', 'lib', 'logFormat.ts');

async function eventNamesInSource(): Promise<string[]> {
  const names = new Set<string>();
  for (const file of await readdir(SRC_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(join(SRC_DIR, file), 'utf-8');
    for (const match of source.matchAll(/event: '([a-z_]+)'/g)) names.add(match[1]);
  }
  return [...names].sort();
}

describe('log phrasing coverage', () => {
  it('finds the event names emitted by the server', async () => {
    const names = await eventNamesInSource();
    // Guards the regex itself: if it silently stopped matching, every
    // coverage assertion below would vacuously pass.
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain('translation_fallback');
  });

  it('has a phrasing in web/lib/logFormat.ts for every event the server emits', async () => {
    const phrasings = await readFile(PHRASING_FILE, 'utf-8');
    const missing = (await eventNamesInSource()).filter((name) => !phrasings.includes(`${name}:`));
    // Reading the file as text rather than importing it: the two packages have
    // separate builds and module resolution, and this only needs to know a key
    // is present.
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Temporarily delete one phrasing line from `web/lib/logFormat.ts`, then run:
`cd server && npx vitest run tests/logEventCoverage.test.ts`
Expected: FAIL, naming the deleted event. Restore the line.

- [ ] **Step 3: Make it pass**

Run the test against the real table and add a phrasing to `web/lib/logFormat.ts` for any event it names. `__dirname` is not defined in ESM — if the test file fails on it, replace both path constants with:

```ts
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
```

and build `SRC_DIR` / `PHRASING_FILE` from `HERE`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS, `missing` is `[]`.

- [ ] **Step 5: Commit**

```bash
git add server/tests/logEventCoverage.test.ts web/lib/logFormat.ts
git commit -m "Fail the build when a log event has no phrasing"
```

---

### Task 10: Admin tab — the file picker

**Files:**
- Modify: `web/app/admin/page.tsx`

**Interfaces:**
- Consumes: `GET /admin/logs`, `GET /admin/logs/:name`, `DELETE /admin/logs/:name` from Task 6; `LogEntry` from `web/lib/logFormat.ts` (Task 8).
- Produces: state that Task 11 renders from — `selected: string` (`'live'` or a filename), `fileEntries: LogEntry[]`, `fileMeta: { total: number; skipped: number; unparseable: number } | null`, and `isLive: boolean`.

Read `web/docs/STYLE_GUIDE.md` first. Use the existing `Popover` primitive (already in `web/components/ui/popover.tsx` and already used on the viewer page) for the picker rather than `Select`: the menu needs a filter header containing a focusable date input and a toggle group, which a listbox cannot host accessibly. Custom triggers use the `render` prop, not `asChild` — this project's shadcn style is `base-nova` backed by `@base-ui/react`.

- [ ] **Step 1: Add the types and fetch helpers**

Near the existing `LEVEL_ROW_CLASS` in `web/app/admin/page.tsx`:

```tsx
import { formatEntry, collapseRuns, type LogEntry as FormatLogEntry } from '@/lib/logFormat';

interface LogFileInfo {
  name: string;
  kind: 'session' | 'server' | 'legacy';
  startedAt: string | null;
  endedAt: string | null;
  bytes: number;
  active: boolean;
}

const MELBOURNE = 'Australia/Melbourne';

function melbourneDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', {
    timeZone: MELBOURNE, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

function melbourneTimeLabel(iso: string, withSeconds = false): string {
  return new Date(iso).toLocaleTimeString('en-AU', {
    timeZone: MELBOURNE, hour: 'numeric', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

function fileLabel(file: LogFileInfo): string {
  if (file.kind === 'server') return 'Server (idle events)';
  if (file.kind === 'legacy') return 'Legacy — everything before the split';
  if (!file.startedAt) return file.name;
  const start = melbourneDateLabel(file.startedAt) + ', ' + melbourneTimeLabel(file.startedAt);
  return file.endedAt ? `${start} – ${melbourneTimeLabel(file.endedAt)}` : start;
}

function durationLabel(file: LogFileInfo): string {
  if (!file.startedAt || !file.endedAt) return '';
  const ms = Date.parse(file.endedAt) - Date.parse(file.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function bytesLabel(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function fileSubLabel(file: LogFileInfo): string {
  return [durationLabel(file), bytesLabel(file.bytes)].filter(Boolean).join(' · ');
}
```

- [ ] **Step 2: Add the state and effects**

```tsx
  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([]);
  const [selectedLog, setSelectedLog] = useState<string>('live');
  const [fileEntries, setFileEntries] = useState<FormatLogEntry[]>([]);
  const [fileMeta, setFileMeta] = useState<{ total: number; skipped: number; unparseable: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sortNewestFirst, setSortNewestFirst] = useState(true);
  const [fromDate, setFromDate] = useState('');
  const [pendingDelete, setPendingDelete] = useState<LogFileInfo | null>(null);

  const isLive = selectedLog === 'live';

  const refreshLogFiles = useCallback(async () => {
    const response = await fetch(`${API_URL}/admin/logs`, { headers: { 'x-admin-passcode': passcode } });
    if (!response.ok) return;
    const body = (await response.json()) as { files: LogFileInfo[] };
    setLogFiles(body.files);
  }, [passcode]);

  useEffect(() => {
    if (!authorized) return;
    void refreshLogFiles();
  }, [authorized, refreshLogFiles]);

  useEffect(() => {
    if (!authorized || isLive) return;
    let cancelled = false;
    setFileLoading(true);
    setFileError(null);
    void (async () => {
      try {
        const response = await fetch(`${API_URL}/admin/logs/${encodeURIComponent(selectedLog)}`, {
          headers: { 'x-admin-passcode': passcode },
        });
        if (!response.ok) throw new Error(response.status === 404 ? 'That log is no longer on the server.' : 'Could not load that log.');
        const body = (await response.json()) as { entries: FormatLogEntry[]; total: number; skipped: number; unparseable: number };
        if (cancelled) return;
        setFileEntries(body.entries);
        setFileMeta({ total: body.total, skipped: body.skipped, unparseable: body.unparseable });
      } catch (error) {
        if (cancelled) return;
        setFileEntries([]);
        setFileMeta(null);
        setFileError(error instanceof Error ? error.message : 'Could not load that log.');
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authorized, isLive, selectedLog, passcode]);
```

Use whatever the file already calls its API base constant (`API_URL` or equivalent — check the existing `fetch` calls in this file and match them exactly, including how the passcode header is sent).

- [ ] **Step 3: Add the delete handler**

```tsx
  async function confirmDelete() {
    if (!pendingDelete) return;
    const response = await fetch(`${API_URL}/admin/logs/${encodeURIComponent(pendingDelete.name)}`, {
      method: 'DELETE',
      headers: { 'x-admin-passcode': passcode },
    });
    if (response.status === 409) { toast.error('That session is still running.'); setPendingDelete(null); return; }
    if (response.status === 403) { toast.error('That log cannot be deleted.'); setPendingDelete(null); return; }
    if (!response.ok) { toast.error('Could not delete that log.'); setPendingDelete(null); return; }
    toast.success(`Deleted ${pendingDelete.name}`);
    if (selectedLog === pendingDelete.name) setSelectedLog('live');
    setPendingDelete(null);
    await refreshLogFiles();
  }
```

- [ ] **Step 4: Render the picker row**

Above the existing controls row in the `logs` `TabsContent`, following the style guide's component patterns:

```tsx
          <div className="flex flex-wrap items-center gap-2">
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger
                render={
                  <Button variant="secondary" size="sm" className="min-w-64 justify-start">
                    {isLive ? 'Live — current session' : fileLabel(logFiles.find((f) => f.name === selectedLog) ?? { name: selectedLog, kind: 'session', startedAt: null, endedAt: null, bytes: 0, active: false })}
                  </Button>
                }
              />
              <PopoverContent className="w-96 p-1">
                <div className="flex items-center gap-2 border-b p-2">
                  <Input
                    type="date"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                    aria-label="Show logs from this date onward"
                    className="h-8 flex-1"
                  />
                  <ToggleGroup
                    value={[sortNewestFirst ? 'new' : 'old']}
                    onValueChange={(values) => setSortNewestFirst((values as string[])[0] !== 'old')}
                  >
                    <ToggleGroupItem value="new" size="sm">Newest</ToggleGroupItem>
                    <ToggleGroupItem value="old" size="sm">Oldest</ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <ScrollArea className="max-h-72">
                  <button
                    type="button"
                    onClick={() => { setSelectedLog('live'); setPickerOpen(false); }}
                    className="flex w-full flex-col items-start rounded-sm px-2 py-2 text-left hover:bg-muted"
                  >
                    <span className="text-sm">Live — current session</span>
                    <span className="text-xs text-muted-foreground">Streaming from the server</span>
                  </button>
                  {visibleLogFiles.map((file) => (
                    <button
                      key={file.name}
                      type="button"
                      onClick={() => { setSelectedLog(file.name); setPickerOpen(false); }}
                      className="flex w-full flex-col items-start rounded-sm px-2 py-2 text-left hover:bg-muted"
                    >
                      <span className="text-sm">{fileLabel(file)}</span>
                      <span className="text-xs text-muted-foreground">{fileSubLabel(file)}</span>
                    </button>
                  ))}
                </ScrollArea>
              </PopoverContent>
            </Popover>

            <Button
              variant="secondary"
              size="sm"
              disabled={isLive || selectedLog === 'events.log'}
              onClick={() => setPendingDelete(logFiles.find((f) => f.name === selectedLog) ?? null)}
            >
              Delete
            </Button>
          </div>
```

with, alongside the other derived values:

```tsx
  const visibleLogFiles = useMemo(() => {
    const filtered = logFiles.filter((file) => !fromDate || (file.startedAt ?? '') >= fromDate);
    return [...filtered].sort((a, b) => {
      const left = a.startedAt ? Date.parse(a.startedAt) : 0;
      const right = b.startedAt ? Date.parse(b.startedAt) : 0;
      return sortNewestFirst ? right - left : left - right;
    });
  }, [logFiles, fromDate, sortNewestFirst]);
```

Render the delete confirmation with the primitives already imported in this file. If the project has no dialog component in `web/components/ui/`, use an `Alert` rendered inline above the picker row with "Delete log" and "Keep it" buttons rather than adding a new shadcn component — check `web/components/ui/` first and report which you used.

Add any newly used imports (`Popover`, `PopoverTrigger`, `PopoverContent`, `ScrollArea`, `useCallback`, `useMemo`) to the file's existing import statements.

- [ ] **Step 5: Verify**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 6: Commit**

```bash
git add web/app/admin/page.tsx
git commit -m "Add the log file picker to the admin Logs tab"
```

---

### Task 11: Admin tab — Simple, Detailed, and Raw rendering

**Files:**
- Modify: `web/app/admin/page.tsx`

**Interfaces:**
- Consumes: `formatEntry`, `collapseRuns`, `LogRow` from Task 8; `selectedLog`, `fileEntries`, `fileMeta`, `fileError`, `fileLoading`, `isLive` from Task 10.
- Produces: nothing.

- [ ] **Step 1: Add view-mode state and the source switch**

```tsx
  type LogViewMode = 'simple' | 'detailed' | 'raw';
  const [logViewMode, setLogViewMode] = useState<LogViewMode>('simple');
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [openPayload, setOpenPayload] = useState<string | null>(null);

  const sourceEntries = isLive ? logEntries : fileEntries;

  const visibleLogRows = useMemo(() => {
    const search = logSearch.toLowerCase();
    const kept = sourceEntries.filter((entry) => {
      if (!levelFilter[entry.level]) return false;
      if (logViewMode === 'simple' && !formatEntry(entry).simple) return false;
      if (!search) return true;
      return `${entry.event ?? ''} ${formatEntry(entry).text} ${JSON.stringify(entry)}`.toLowerCase().includes(search);
    });
    if (logViewMode !== 'simple') {
      return kept.map((entry) => ({ kind: 'one' as const, entry, count: 1, from: entry.timestamp, to: entry.timestamp, items: [entry] }));
    }
    return collapseRuns(kept);
  }, [sourceEntries, levelFilter, logSearch, logViewMode]);
```

Keep the existing `visibleLogEntries` if other code depends on it; otherwise replace its uses with `visibleLogRows`.

- [ ] **Step 2: Add the view-mode toggle and relabel the severity filter**

In the existing controls row, replace the `Info`/`Warn`/`Error` labels with `Normal`/`Attention`/`Problems` (the `value` props stay `info`/`warn`/`error` — only the visible text changes), and add before them:

```tsx
            <ToggleGroup
              value={[logViewMode]}
              onValueChange={(values) => setLogViewMode(((values as string[])[0] ?? 'simple') as LogViewMode)}
            >
              <ToggleGroupItem value="simple" size="sm">Simple</ToggleGroupItem>
              <ToggleGroupItem value="detailed" size="sm">Detailed</ToggleGroupItem>
              <ToggleGroupItem value="raw" size="sm">Raw</ToggleGroupItem>
            </ToggleGroup>
```

Disable Pause off Live: `<Button … disabled={!isLive} onClick={…}>`.

- [ ] **Step 3: Render the rows**

Replace the panel's `visibleLogEntries.map(...)` body with:

```tsx
            {fileLoading && <div className="p-6 text-center text-muted-foreground">Loading…</div>}
            {fileError && <div className="p-6 text-center text-red-400">{fileError}</div>}
            {!fileLoading && !fileError && fileMeta && fileMeta.skipped > 0 && (
              <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300">
                Showing the most recent {(fileMeta.total - fileMeta.skipped).toLocaleString()} of {fileMeta.total.toLocaleString()} entries.
              </div>
            )}
            {!fileLoading && !fileError && fileMeta && fileMeta.unparseable > 0 && (
              <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300">
                {fileMeta.unparseable.toLocaleString()} line(s) could not be read and were skipped.
              </div>
            )}
            {!fileLoading && !fileError && visibleLogRows.length === 0 && (
              <div className="p-6 text-center text-muted-foreground">
                Nothing matches those filters. Try turning a severity back on, or clearing the search.
              </div>
            )}
            {visibleLogRows.map((row, index) => {
              const key = `${row.entry.event ?? 'x'}-${row.from}-${index}`;
              if (logViewMode === 'raw') {
                return (
                  <div key={key} className={`whitespace-pre-wrap break-all ${LEVEL_ROW_CLASS[row.entry.level] ?? LEVEL_ROW_CLASS.info}`}>
                    {formatRawEntry(row.entry)}
                  </div>
                );
              }
              const formatted = formatEntry(row.entry);
              const expanded = expandedRuns[key] ?? false;
              return (
                <div key={key}>
                  <button
                    type="button"
                    onClick={() => (row.kind === 'run'
                      ? setExpandedRuns((current) => ({ ...current, [key]: !expanded }))
                      : setOpenPayload((current) => (current === key ? null : key)))}
                    className={`flex w-full gap-2 border-l-2 px-2 py-1 text-left hover:bg-muted/40 ${SEVERITY_BORDER[row.entry.level]}`}
                  >
                    <span className="w-24 shrink-0 tabular-nums text-muted-foreground">
                      {melbourneTimeLabel(row.entry.timestamp, true)}
                    </span>
                    <span className={`w-4 shrink-0 ${LEVEL_ROW_CLASS[row.entry.level]}`}>{SEVERITY_GLYPH[row.entry.level]}</span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className={LEVEL_ROW_CLASS[row.entry.level]}>
                        {formatted.text}
                        {row.kind === 'run' && <span className="ml-2 rounded-full border px-1.5 text-[10px] text-muted-foreground">×{row.count}</span>}
                      </span>
                      {row.kind === 'run' && (
                        <span className="text-[11px] text-muted-foreground">
                          {row.count} times, {melbourneTimeLabel(row.from)} to {melbourneTimeLabel(row.to)} · {expanded ? 'hide' : 'show each one'}
                        </span>
                      )}
                    </span>
                  </button>
                  {row.kind === 'one' && openPayload === key && (
                    <pre className="my-1 overflow-x-auto rounded-md border bg-background p-2 text-[11px] text-muted-foreground">
                      {JSON.stringify(row.entry, null, 2)}
                    </pre>
                  )}
                  {row.kind === 'run' && expanded && row.items.map((item, itemIndex) => (
                    <div key={`${key}-${itemIndex}`} className="flex gap-2 px-2 py-0.5 pl-8 text-muted-foreground">
                      <span className="w-24 shrink-0 tabular-nums">{melbourneTimeLabel(item.timestamp, true)}</span>
                      <span className="min-w-0">{formatEntry(item).text}</span>
                    </div>
                  ))}
                </div>
              );
            })}
```

with these module-scope constants beside `LEVEL_ROW_CLASS`:

```tsx
// Severity as a border stripe as well as text colour: amber text alone
// disappears the moment a row wraps.
const SEVERITY_BORDER: Record<LogEntry['level'], string> = {
  info: 'border-transparent',
  warn: 'border-amber-400',
  error: 'border-red-400',
};
const SEVERITY_GLYPH: Record<LogEntry['level'], string> = { info: '●', warn: '⚠', error: '✕' };
```

Rename the existing `formatEntry` helper in `page.tsx` (the one at line 80 that produces the raw JSON line) to `formatRawEntry` and update its call sites, so it no longer collides with the import from `@/lib/logFormat`.

- [ ] **Step 4: Make Copy and Download match what's on screen**

```tsx
  function visibleLogText(): string {
    return visibleLogRows
      .map((row) => (logViewMode === 'raw'
        ? formatRawEntry(row.entry)
        : `${melbourneTimeLabel(row.entry.timestamp, true)}  ${formatEntry(row.entry).text}${row.kind === 'run' ? ` (×${row.count})` : ''}`))
      .join('\n');
  }
```

Point `copyLogs` and `downloadLogs` at `visibleLogText()`. For a historical file, add a second button beside Download labelled "Download raw file" that fetches `${API_URL}/admin/logs/${encodeURIComponent(selectedLog)}` and saves the raw JSON body; render it only when `!isLive`.

- [ ] **Step 5: Verify**

Run: `cd web && npx tsc --noEmit && npm run lint && npm run build`
Expected: all three clean.

- [ ] **Step 6: Manual verification**

Start the server (`cd server && npm run build && node dist/index.js`) and the web app (`cd web && npm run dev`), open `/admin`, and confirm each of:
1. The picker lists Live, then past sessions newest-first, then `server.log` and Legacy.
2. Sort toggle and date filter change the list, not the open log.
3. Simple mode hides `dg_diag_transcript` and `openrouter_reasoning`; Detailed shows them; Raw matches today's output exactly.
4. A run of three or more identical events collapses with a `×N` chip and expands on click.
5. Clicking a single row shows its raw payload; clicking again hides it.
6. Severity stripes render on warn and error rows and survive a wrapped row.
7. Pause is disabled unless Live is selected.
8. Deleting a past session asks for confirmation, then removes it from the picker.
9. Opening Legacy shows the truncation banner.
10. Copy and Download produce the readable text; "Download raw file" produces JSON.

- [ ] **Step 7: Commit**

```bash
git add web/app/admin/page.tsx
git commit -m "Render log entries as readable text with Simple, Detailed, and Raw modes"
```

---

## Plan Self-Review

**Spec coverage.** Storage layout → Task 1. Resolution table and grace window → Task 1. Boot resumption → Task 2. Listing → Task 3. Reading, cap, deletion, name validation → Task 4. Wiring and the `LOG_FILE_PATH` escape hatch → Tasks 1 and 5. Endpoints → Task 6. Bundled fixes → Task 7. Phrasing table, Simple membership including the `caption_lag_shed` demotion, run collapsing → Task 8. Coverage test → Task 9. Picker, sort, date filter, delete → Task 10. View modes, severity stripe, payload expansion, copy/download, Pause gating, banners and empty states → Task 11.

**Known gap.** The spec's error-handling line "file deleted by another admin session → the tab reports it and falls back to Live" is covered by Task 10's 404 branch setting `fileError`, but the fallback to Live happens only on delete, not on a failed load. Task 10's implementer should leave the failed load showing the error rather than silently switching — reporting is the requirement; switching would hide it.

**Type consistency.** `LogFileInfo` and `LogFileContents` are defined once in Task 3 and Task 4 and re-declared structurally in Task 10's client code; the field names match. `formatEntry` is imported from `@/lib/logFormat` in Tasks 10–11 while `page.tsx`'s existing same-named helper is renamed `formatRawEntry` in Task 11 Step 3 — Task 10 must not use the bare name `formatEntry` before that rename lands, so Task 11 depends on Task 10 and both touch the same file. Run them in order.
