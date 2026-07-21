# Admin Live Logs Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Logs" tab to the admin page that streams the server's structured `logEvent` entries live into the browser, with recent history shown on open.

**Architecture:** A new in-memory `logHub` singleton buffers the last 500 log entries and fans each new one out to subscribers. `logEvent` pushes every entry into the hub (in addition to its existing console + file writes). A new admin-authenticated `/ws/logs` WebSocket sends the buffer on connect, then forwards live entries. The admin page's new tab opens that socket and renders the stream with level filter, search, pause/autoscroll, and clear/copy/download controls.

**Tech Stack:** Node + TypeScript (ESM) + `ws` on the server; Next.js (App Router) + React + shadcn/ui + Tailwind on the web client; Vitest for server tests.

## Global Constraints

- **ESM import specifiers:** server files import local modules with a `.js` extension (e.g. `import { logHub } from './logHub.js'`) even though the source is `.ts`. Match existing files.
- **TypeScript strict:** no `any` in new code except where mirroring existing test helpers.
- **Admin auth reuse:** `/ws/logs` uses the same `?passcode=` query gate as `/ws/capture` and `/ws/review`; the passcode value comes from `deps.adminPasscode` on the server and `sessionStorage` / component `passcode` state on the client.
- **Client URL pattern:** the client already defines `const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001'`. Reuse it; do not introduce a new base URL constant.
- **UI patterns:** before editing `web/app/admin/page.tsx` or components, follow `web/docs/STYLE_GUIDE.md`. Reuse shadcn primitives already imported in that file (`Tabs`, `Button`, `Input`, `ToggleGroup`) rather than adding new dependencies.
- **Commits:** every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (omitted from the short commands below for brevity — append it to each).
- **Never break logging:** logging paths must never throw into the app. Any subscriber/socket work triggered by a log entry is wrapped so it cannot propagate back into `logEvent`.

---

### Task 1: `logHub` broadcast module

**Files:**
- Create: `server/src/logHub.ts`
- Test: `server/tests/logHub.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface LogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    event?: string;
    [key: string]: unknown;
  }
  export interface LogHub {
    push(entry: LogEntry): void;
    getHistory(): LogEntry[];
    subscribe(listener: (entry: LogEntry) => void): () => void; // returns unsubscribe
  }
  export function createLogHub(bufferSize?: number): LogHub; // default bufferSize = 500
  export const logHub: LogHub; // default singleton
  ```

- [ ] **Step 1: Write the failing tests**

Create `server/tests/logHub.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createLogHub, type LogEntry } from '../src/logHub';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return { timestamp: new Date().toISOString(), level: 'info', event: 'test', ...overrides };
}

describe('logHub', () => {
  it('keeps only the most recent entries up to the buffer size, in order', () => {
    const hub = createLogHub(2);
    hub.push(entry({ event: 'a' }));
    hub.push(entry({ event: 'b' }));
    hub.push(entry({ event: 'c' }));
    expect(hub.getHistory().map((e) => e.event)).toEqual(['b', 'c']);
  });

  it('getHistory returns a copy, not the internal buffer', () => {
    const hub = createLogHub();
    hub.push(entry({ event: 'a' }));
    const history = hub.getHistory();
    history.push(entry({ event: 'mutated' }));
    expect(hub.getHistory().map((e) => e.event)).toEqual(['a']);
  });

  it('delivers newly pushed entries to subscribers', () => {
    const hub = createLogHub();
    const received: string[] = [];
    hub.subscribe((e) => received.push(String(e.event)));
    hub.push(entry({ event: 'live' }));
    expect(received).toEqual(['live']);
  });

  it('unsubscribe stops further delivery', () => {
    const hub = createLogHub();
    const received: string[] = [];
    const unsubscribe = hub.subscribe((e) => received.push(String(e.event)));
    unsubscribe();
    hub.push(entry({ event: 'after' }));
    expect(received).toEqual([]);
  });

  it('a throwing subscriber does not break push or other subscribers', () => {
    const hub = createLogHub();
    const received: string[] = [];
    hub.subscribe(() => {
      throw new Error('bad subscriber');
    });
    hub.subscribe((e) => received.push(String(e.event)));
    expect(() => hub.push(entry({ event: 'ok' }))).not.toThrow();
    expect(received).toEqual(['ok']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/logHub.test.ts`
Expected: FAIL — cannot find module `../src/logHub` / `createLogHub is not a function`.

- [ ] **Step 3: Implement `logHub.ts`**

Create `server/src/logHub.ts`:

```ts
export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event?: string;
  [key: string]: unknown;
}

export interface LogHub {
  push(entry: LogEntry): void;
  getHistory(): LogEntry[];
  subscribe(listener: (entry: LogEntry) => void): () => void;
}

export function createLogHub(bufferSize = 500): LogHub {
  const buffer: LogEntry[] = [];
  const listeners = new Set<(entry: LogEntry) => void>();

  return {
    push(entry) {
      buffer.push(entry);
      if (buffer.length > bufferSize) {
        buffer.shift();
      }
      for (const listener of listeners) {
        try {
          listener(entry);
        } catch {
          // A subscriber must never break logging or the other subscribers.
          // Its failure is swallowed here; logEvent's own error paths remain
          // the app's real signal.
        }
      }
    },
    getHistory() {
      return [...buffer];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Default process-wide singleton: logger.ts pushes into it, wsServer subscribes.
export const logHub = createLogHub();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/logHub.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/logHub.ts server/tests/logHub.test.ts
git commit -m "Add logHub: bounded in-memory log buffer with live subscribers"
```

---

### Task 2: Fan `logEvent` entries into `logHub`

**Files:**
- Modify: `server/src/logger.ts`
- Test: `server/tests/logger.test.ts` (create)

**Interfaces:**
- Consumes: `logHub`, `LogEntry` from Task 1.
- Produces: no signature change — `logEvent(level, payload)` is unchanged for all ~30 existing call sites; it now additionally calls `logHub.push(entry)`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/logger.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logEvent } from '../src/logger';
import { logHub } from '../src/logHub';

beforeAll(() => {
  // Point the file write at a throwaway path so the test doesn't touch data/.
  process.env.LOG_FILE_PATH = join(tmpdir(), 'auto-translate-lite-logger-test.log');
});

describe('logEvent', () => {
  it('pushes a well-formed entry into logHub', async () => {
    await logEvent('warn', { event: 'unit_test_event', detail: 42 });
    const last = logHub.getHistory().at(-1);
    expect(last).toMatchObject({ level: 'warn', event: 'unit_test_event', detail: 42 });
    expect(typeof last?.timestamp).toBe('string');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/logger.test.ts`
Expected: FAIL — `logHub.getHistory()` last entry does not include the event (logEvent doesn't push yet).

- [ ] **Step 3: Modify `logger.ts` to build the entry once and push it**

Replace the full contents of `server/src/logger.ts` with:

```ts
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logHub, type LogEntry } from './logHub.js';

function getLogFilePath(): string {
  return process.env.LOG_FILE_PATH ?? 'data/events.log';
}

export async function logEvent(level: 'info' | 'warn' | 'error', payload: Record<string, unknown>): Promise<void> {
  // timestamp/level lead the line (output unchanged from before). The cast is
  // needed because spreading a Record<string, unknown> widens the leading
  // keys' types; no call site overrides timestamp/level.
  const entry = { timestamp: new Date().toISOString(), level, ...payload } as LogEntry;

  // Fan out to live log subscribers first; push is synchronous and never
  // throws, so viewers see the entry even if the file write below fails.
  logHub.push(entry);

  const line = JSON.stringify(entry);
  if (level === 'info') {
    console.log(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.error(line);
  }

  const filePath = getLogFilePath();
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line + '\n', 'utf-8');
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/logger.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full server suite to confirm no regression**

Run: `cd server && npm test`
Expected: PASS — all existing tests plus the two new files.

- [ ] **Step 6: Commit**

```bash
git add server/src/logger.ts server/tests/logger.test.ts
git commit -m "Fan logEvent entries into logHub for live streaming"
```

---

### Task 3: `/ws/logs` admin WebSocket channel

**Files:**
- Modify: `server/src/wsServer.ts` (add `logHub` to `WsServerDeps`, extend upgrade handler + connection dispatch, add `handleLogsConnection`)
- Modify: `server/src/index.ts` (inject the `logHub` singleton into `attachWsServer`)
- Modify: `server/tests/wsServer.test.ts` (add `logHub` to test deps; add `/ws/logs` tests)

**Interfaces:**
- Consumes: `logHub` / `LogHub` from Task 1; existing `WsServerDeps`, `attachWsServer`.
- Produces: server → client messages on `/ws/logs`:
  - on connect: `{ type: 'history', entries: LogEntry[] }`
  - per new entry: `{ type: 'log', entry: LogEntry }`

- [ ] **Step 1: Write the failing tests**

In `server/tests/wsServer.test.ts`, add this import near the other `../src/*` imports:

```ts
import { createLogHub, type LogHub } from '../src/logHub';
```

Add a hub variable alongside the other `let` declarations in the `describe('wsServer', …)` block:

```ts
  let logHub: LogHub;
```

In `beforeEach`, before `deps = { … }`, create a fresh hub:

```ts
    logHub = createLogHub();
```

Add `logHub` to the `deps` object literal (anywhere among its properties):

```ts
      logHub,
```

Then add these three tests inside the `describe('wsServer', …)` block:

```ts
  it('rejects a /ws/logs connection without the admin passcode', async () => {
    const socket = new WebSocket(`ws://localhost:${port}/ws/logs`);
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.once('error', () => resolve());
    });
    expect(socket.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
  });

  it('sends buffered history to a new /ws/logs subscriber', async () => {
    logHub.push({ timestamp: new Date().toISOString(), level: 'info', event: 'preexisting' });
    const socket = new WebSocket(`ws://localhost:${port}/ws/logs?passcode=test-passcode`);
    await waitForOpen(socket);
    const message = await waitForMessage(socket);
    expect(message.type).toBe('history');
    expect(message.entries).toEqual([{ timestamp: expect.any(String), level: 'info', event: 'preexisting' }]);
    socket.close();
  });

  it('forwards a newly pushed log entry to a subscribed /ws/logs socket', async () => {
    const socket = new WebSocket(`ws://localhost:${port}/ws/logs?passcode=test-passcode`);
    await waitForOpen(socket);
    await waitForMessage(socket); // history (empty)
    const logPromise = waitForMessage(socket);
    logHub.push({ timestamp: new Date().toISOString(), level: 'warn', event: 'translation_fallback' });
    const message = await logPromise;
    expect(message.type).toBe('log');
    expect(message.entry.event).toBe('translation_fallback');
    socket.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: FAIL — `logHub` is not a valid `WsServerDeps` property (type error) and/or the `/ws/logs` path is destroyed so history never arrives.

- [ ] **Step 3: Add `logHub` to `WsServerDeps`**

In `server/src/wsServer.ts`, add the import (near the existing `import { logEvent } from './logger.js';`):

```ts
import type { LogHub } from './logHub.js';
```

Add the field to the `WsServerDeps` interface (after `adminPasscode`):

```ts
  logHub: LogHub;
```

- [ ] **Step 4: Extend the upgrade handler and connection dispatch**

In `attachWsServer`, update the pathname guard in the `httpServer.on('upgrade', …)` handler to accept `/ws/logs` and gate it by passcode. Replace:

```ts
    if (pathname !== '/ws/capture' && pathname !== '/ws/viewer' && pathname !== '/ws/review') {
      socket.destroy();
      return;
    }
    if (pathname === '/ws/capture' || pathname === '/ws/review') {
      const providedPasscode = searchParams.get('passcode');
      if (!deps.adminPasscode || providedPasscode !== deps.adminPasscode) {
        socket.destroy();
        return;
      }
    }
```

with:

```ts
    if (
      pathname !== '/ws/capture' &&
      pathname !== '/ws/viewer' &&
      pathname !== '/ws/review' &&
      pathname !== '/ws/logs'
    ) {
      socket.destroy();
      return;
    }
    if (pathname === '/ws/capture' || pathname === '/ws/review' || pathname === '/ws/logs') {
      const providedPasscode = searchParams.get('passcode');
      if (!deps.adminPasscode || providedPasscode !== deps.adminPasscode) {
        socket.destroy();
        return;
      }
    }
```

In the `wss.on('connection', …)` dispatch, add a `/ws/logs` branch. Replace:

```ts
    if (pathname === '/ws/capture') {
      handleCaptureConnection(ws, deps);
    } else if (pathname === '/ws/review') {
      handleReviewConnection(ws, deps);
    } else {
      handleViewerConnection(ws, deps);
    }
```

with:

```ts
    if (pathname === '/ws/capture') {
      handleCaptureConnection(ws, deps);
    } else if (pathname === '/ws/review') {
      handleReviewConnection(ws, deps);
    } else if (pathname === '/ws/logs') {
      handleLogsConnection(ws, deps);
    } else {
      handleViewerConnection(ws, deps);
    }
```

- [ ] **Step 5: Add `handleLogsConnection`**

Add this function to `server/src/wsServer.ts` (next to `handleReviewConnection`):

```ts
function handleLogsConnection(ws: WebSocket, deps: WsServerDeps): void {
  // Recent context first, then live entries. This is a read-only channel:
  // inbound messages from a logs socket are ignored.
  ws.send(JSON.stringify({ type: 'history', entries: deps.logHub.getHistory() }));

  const unsubscribe = deps.logHub.subscribe((entry) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'log', entry }));
    } catch {
      // A dead/broken socket must never propagate back into logHub.push and
      // break logging for everyone else; the close handler unsubscribes it.
    }
  });

  ws.on('close', () => unsubscribe());
  ws.on('error', () => unsubscribe());
}
```

- [ ] **Step 6: Inject the singleton in `index.ts`**

In `server/src/index.ts`, add the import (near the other local imports):

```ts
import { logHub } from './logHub.js';
```

Add `logHub` to the `attachWsServer({ … })` deps object (e.g. right after `adminPasscode: process.env.ADMIN_PASSCODE,`):

```ts
  logHub,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && npx vitest run tests/wsServer.test.ts`
Expected: PASS — including the three new `/ws/logs` tests.

- [ ] **Step 8: Confirm the whole server suite and a type build pass**

Run: `cd server && npm test && npm run build`
Expected: PASS; `tsc` compiles with no errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/wsServer.ts server/src/index.ts server/tests/wsServer.test.ts
git commit -m "Add admin-authed /ws/logs channel streaming logHub entries"
```

---

### Task 4: Logs tab — connection, history/live rendering, reconnect

**Files:**
- Modify: `web/app/admin/page.tsx`

**Interfaces:**
- Consumes: server messages `{ type: 'history', entries }` and `{ type: 'log', entry }` from Task 3; existing `WS_URL`, `authorized`, `passcode` state.
- Produces (used by Task 5): component-scoped `logEntries: LogEntry[]` state, `LogEntry` type, `CLIENT_LOG_CAP`, and the `"logs"` tab shell.

- [ ] **Step 1: Add the `LogEntry` type and cap constant**

At module scope in `web/app/admin/page.tsx` (near the other `type`/`interface` declarations, after the existing config interfaces), add:

```ts
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event?: string;
  [key: string]: unknown;
}

const CLIENT_LOG_CAP = 2000;

function capEntries(entries: LogEntry[]): LogEntry[] {
  return entries.length > CLIENT_LOG_CAP ? entries.slice(entries.length - CLIENT_LOG_CAP) : entries;
}
```

- [ ] **Step 2: Import `useRef`**

Change the React import at the top of the file:

```ts
import { useEffect, useRef, useState } from 'react';
```

- [ ] **Step 3: Add logs state**

Inside `AdminPage`, with the other `useState` hooks, add:

```ts
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logStatus, setLogStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
```

- [ ] **Step 4: Add the connection effect**

Inside `AdminPage`, after the existing `useEffect`, add:

```ts
  useEffect(() => {
    if (!authorized || passcode.length === 0) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closedByEffect = false;
    let attempts = 0;

    function connect() {
      socket = new WebSocket(`${WS_URL}/ws/logs?passcode=${encodeURIComponent(passcode)}`);

      socket.onopen = () => {
        attempts = 0;
        setLogStatus('connected');
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string);
        if (message.type === 'history') {
          // A (re)connect delivers the current server buffer; replace the view
          // with it so a reconnect after a server restart self-heals without
          // duplicating entries.
          setLogEntries(capEntries(message.entries as LogEntry[]));
        } else if (message.type === 'log') {
          setLogEntries((prev) => capEntries([...prev, message.entry as LogEntry]));
        }
      };

      socket.onclose = () => {
        if (closedByEffect) return;
        setLogStatus('reconnecting');
        attempts += 1;
        const backoff = Math.min(1000 * 2 ** (attempts - 1), 10000);
        reconnectTimer = setTimeout(connect, backoff);
      };

      socket.onerror = () => {
        socket?.close();
      };
    }

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [authorized, passcode]);
```

- [ ] **Step 5: Add the row color map and formatter at module scope**

Near the other module-scope constants, add:

```ts
const LEVEL_ROW_CLASS: Record<LogEntry['level'], string> = {
  info: 'text-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

function formatEntry(entry: LogEntry): string {
  const { timestamp, level, event, ...rest } = entry;
  const restText = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
  return `${timestamp} [${level}] ${event ?? ''}${restText}`.trimEnd();
}
```

- [ ] **Step 6: Add the tab trigger and a basic content panel**

In the `TabsList`, add a trigger after the existing three:

```tsx
          <TabsTrigger value="logs">Logs</TabsTrigger>
```

After the closing `</TabsContent>` of the `"display"` tab (and before `</Tabs>`), add:

```tsx
        <TabsContent value="logs" className="flex flex-col gap-3">
          <div className="text-xs text-muted-foreground">
            {logStatus === 'connected' ? 'Live' : logStatus === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
            {' · '}
            {logEntries.length} entries
          </div>
          <div
            ref={logScrollRef}
            className="h-[60vh] overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed"
          >
            {logEntries.map((entry, index) => (
              <div key={index} className={`whitespace-pre-wrap break-all ${LEVEL_ROW_CLASS[entry.level]}`}>
                {formatEntry(entry)}
              </div>
            ))}
          </div>
        </TabsContent>
```

- [ ] **Step 7: Add the scroll ref and autoscroll effect**

Inside `AdminPage`, add the ref with the other hooks:

```ts
  const logScrollRef = useRef<HTMLDivElement>(null);
```

And add an autoscroll effect after the connection effect (pause wiring comes in Task 5 — for now it always sticks to the bottom):

```ts
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logEntries]);
```

- [ ] **Step 8: Lint and type-check**

Run: `cd web && npm run lint && npm run build`
Expected: PASS — no ESLint errors, `next build` compiles with no type errors.

- [ ] **Step 9: Manual verification**

Start the server (`cd server && npm run dev`) and web (`cd web && npm run dev`). Open `/admin`, enter the passcode, open the **Logs** tab. Trigger server activity (start a capture session; the `session_context_cache` / audio-stats events will appear). Confirm: recent history shows on open, new entries stream in live, the status line reads "Live", and warn/error rows are colored. Stop the server and confirm the status flips to "Reconnecting…"; restart it and confirm the tab reconnects and repopulates.

- [ ] **Step 10: Commit**

```bash
git add web/app/admin/page.tsx
git commit -m "Add admin Logs tab: live log stream with history and reconnect"
```

---

### Task 5: Logs tab — controls (filter, search, pause, clear, copy/download)

**Files:**
- Modify: `web/app/admin/page.tsx`

**Interfaces:**
- Consumes: `logEntries`, `LogEntry`, `formatEntry`, `logScrollRef` from Task 4; existing `Button`, `Input`, `ToggleGroup`, `ToggleGroupItem`, `toast` imports.
- Produces: final Logs tab UI. No new exports.

- [ ] **Step 1: Add control state**

Inside `AdminPage`, with the other logs state, add:

```ts
  const [levelFilter, setLevelFilter] = useState<Record<LogEntry['level'], boolean>>({
    info: true,
    warn: true,
    error: true,
  });
  const [logSearch, setLogSearch] = useState('');
  const [logsPaused, setLogsPaused] = useState(false);
```

- [ ] **Step 2: Compute the visible (filtered) entries**

Inside `AdminPage`, before the `return`, add:

```ts
  const visibleLogEntries = logEntries.filter((entry) => {
    if (!levelFilter[entry.level]) return false;
    const query = logSearch.trim().toLowerCase();
    if (query.length > 0) {
      const haystack = `${entry.event ?? ''} ${JSON.stringify(entry)}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
```

- [ ] **Step 3: Update the autoscroll effect to honor pause and filtering**

Replace the Task 4 autoscroll effect with:

```ts
  useEffect(() => {
    if (logsPaused) return;
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleLogEntries, logsPaused]);
```

- [ ] **Step 4: Add copy, download, and clear handlers**

Inside `AdminPage`, add:

```ts
  function copyLogs() {
    void navigator.clipboard.writeText(visibleLogEntries.map(formatEntry).join('\n'));
    toast.success('Logs copied.');
  }

  function downloadLogs() {
    const blob = new Blob([visibleLogEntries.map(formatEntry).join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function clearLogs() {
    setLogEntries([]);
  }
```

- [ ] **Step 5: Replace the Logs tab body with the full control bar + filtered list**

Replace the entire `<TabsContent value="logs" …>…</TabsContent>` block from Task 4 with:

```tsx
        <TabsContent value="logs" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              value={(Object.keys(levelFilter) as LogEntry['level'][]).filter((level) => levelFilter[level])}
              onValueChange={(values) => {
                const active = new Set(values as LogEntry['level'][]);
                setLevelFilter({ info: active.has('info'), warn: active.has('warn'), error: active.has('error') });
              }}
            >
              <ToggleGroupItem value="info" size="sm">Info</ToggleGroupItem>
              <ToggleGroupItem value="warn" size="sm">Warn</ToggleGroupItem>
              <ToggleGroupItem value="error" size="sm">Error</ToggleGroupItem>
            </ToggleGroup>
            <Input
              value={logSearch}
              onChange={(event) => setLogSearch(event.target.value)}
              placeholder="Filter…"
              className="h-8 w-40"
            />
            <Button variant="secondary" size="sm" onClick={() => setLogsPaused((paused) => !paused)}>
              {logsPaused ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="secondary" size="sm" onClick={clearLogs}>Clear</Button>
            <Button variant="secondary" size="sm" onClick={copyLogs}>Copy</Button>
            <Button variant="secondary" size="sm" onClick={downloadLogs}>Download</Button>
          </div>
          <div className="text-xs text-muted-foreground">
            {logStatus === 'connected' ? 'Live' : logStatus === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
            {logsPaused ? ' · Paused' : ''}
            {' · '}
            {visibleLogEntries.length} / {logEntries.length} entries
          </div>
          <div
            ref={logScrollRef}
            className="h-[60vh] overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed"
          >
            {visibleLogEntries.map((entry, index) => (
              <div key={index} className={`whitespace-pre-wrap break-all ${LEVEL_ROW_CLASS[entry.level]}`}>
                {formatEntry(entry)}
              </div>
            ))}
          </div>
        </TabsContent>
```

- [ ] **Step 6: Lint and type-check**

Run: `cd web && npm run lint && npm run build`
Expected: PASS — no ESLint errors, compiles clean.

- [ ] **Step 7: Manual verification**

With server + web running and a capture session generating logs: toggle each level off/on and confirm rows hide/show; type an event substring (e.g. `audio_stats`) and confirm filtering; press Pause and confirm the view stops auto-scrolling while the entry count keeps climbing, then Resume; press Clear and confirm the view empties (new entries resume streaming); press Copy and paste elsewhere to confirm the shown lines are on the clipboard; press Download and confirm a `.log` file saves with the visible lines.

- [ ] **Step 8: Commit**

```bash
git add web/app/admin/page.tsx
git commit -m "Add Logs tab controls: level filter, search, pause, clear, copy, download"
```

---

## Self-Review

**Spec coverage:**
- Structured `logEvent` stream only → Task 2 (push in `logEvent`); no raw stdout captured. ✓
- Recent history (500) + live via in-memory ring buffer → Task 1 (`createLogHub(500)`), Task 3 (`history` on connect). ✓
- Admin-gated `/ws/logs` reusing `?passcode=` → Task 3 upgrade handler. ✓
- Level filter, text search, pause + autoscroll, clear + copy/download → Task 5. ✓
- Reconnect with backoff, re-pull history → Task 4 connection effect. ✓
- Bounded client buffer (~2000) → Task 4 `CLIENT_LOG_CAP` / `capEntries`. ✓
- Error handling: subscriber isolation (Task 1 try/catch), dead-socket isolation (Task 3 `handleLogsConnection` try/catch + `readyState`), never break logging (Task 2 push-before-file). ✓
- Testing: logHub unit (Task 1), logger push (Task 2), `/ws/logs` reject/history/forward (Task 3), manual client checks (Tasks 4–5). ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code; no "add error handling" hand-waves. ✓

**Type consistency:** `LogEntry` / `LogHub` / `createLogHub(bufferSize?)` / `logHub` singleton are defined in Task 1 and used with identical names and shapes in Tasks 2–5. `WsServerDeps.logHub: LogHub` (Task 3) matches the test deps addition (Task 3 Step 1). Message shapes `{ type: 'history', entries }` and `{ type: 'log', entry }` are produced in Task 3 and consumed unchanged in Task 4. `formatEntry` / `LEVEL_ROW_CLASS` / `logScrollRef` defined in Task 4 and reused in Task 5. ✓
