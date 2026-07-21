# Admin Live Logs Tab — Design

## Purpose

Everything meaningful the server does is already recorded through one function — `logEvent(level, payload)` in [server/src/logger.ts](../../../server/src/logger.ts) — which writes a structured JSON line to both the console and `data/events.log`. There are ~30 call sites: Deepgram diagnostics, translation fallbacks, transcription flags, cost warnings, OpenRouter reasoning traces, publish/WebSocket errors, feedback-store failures. Today the only way to watch these while a sermon is running is to SSH into the box and `tail -f` the log file (or read `pm2 logs`).

This design adds a **Logs tab to the admin page** that streams those structured events live into the browser, with recent history shown on open, so an operator can watch what the pipeline is doing — and spot an error the moment it happens — without touching a terminal.

## Scope

- Streams the **structured `logEvent` stream only** — every entry routed through `logEvent`, already labeled with a `level` and (by convention) an `event` name. Raw `console.log` lines outside `logEvent` (e.g. the `Server listening on port …` line) and third-party stdout noise are **out of scope** — the two such call sites are startup/plumbing, not operational signal.
- On connect, shows **recent history** from an in-memory ring buffer (last 500 entries), then **live** entries as they are emitted.
- Admin-authenticated over a new `/ws/logs` WebSocket, gated by the same `?passcode=` mechanism already used by `/ws/capture` and `/ws/review`.
- Client controls: **level filter** (info/warn/error), **text search**, **pause + autoscroll**, **clear + copy/download**.
- Explicitly out of scope: persisting a scrollback across server restarts (buffer is in-memory — a restart resets it; the file on disk remains the durable record); reading/tailing `data/events.log` from the browser; capturing raw stdout/stderr; log retention/rotation policy; per-user log access below the single admin passcode.

## Design

### 1. `logHub` — the broadcast hub

New `server/src/logHub.ts`, a module-singleton that keeps broadcast concerns out of `logger.ts`'s file/console I/O. It holds a bounded ring buffer and a set of subscribers:

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

export function createLogHub(bufferSize?: number): LogHub;
```

- `push` appends to the ring buffer (dropping the oldest past `bufferSize`, default **500**) and notifies every subscriber. **Each listener call is wrapped in try/catch** — a throwing or slow subscriber must never break logging or affect other subscribers.
- `getHistory` returns the current buffer contents (oldest → newest) as a copy.
- `subscribe` registers a listener and returns an unsubscribe function.

A default singleton (`export const logHub = createLogHub()`) is what `logger.ts` pushes into. `createLogHub` is exported separately so tests can construct an isolated hub with a small buffer.

### 2. `logger.ts` — build the entry once, fan out three ways

`logEvent` today stringifies `{ timestamp, level, ...payload }` and does console + file writes. It is refactored to build the entry **object** once, push it to the hub, then do the existing console/file writes off that object. No call site changes — the signature is unchanged.

```ts
import { logHub } from './logHub.js';

export async function logEvent(level, payload) {
  const entry = { timestamp: new Date().toISOString(), level, ...payload };
  logHub.push(entry);              // new: fan out to live subscribers + buffer

  const line = JSON.stringify(entry);
  if (level === 'info') console.log(line);
  else if (level === 'warn') console.warn(line);
  else console.error(line);

  // …existing mkdir + appendFile, unchanged…
}
```

`logHub.push` runs synchronously before the awaitable file write, so subscribers see an entry even if the disk write later fails — and `push` never throws (its listener loop is guarded), so it cannot regress the existing "logging never breaks the app" posture.

```
logEvent(level, payload)
   └─ build entry ─┬─► logHub.push ─► ring buffer + notify subscribers ─► each /ws/logs socket
                   ├─► console.*
                   └─► append data/events.log
```

### 3. `wsServer.ts` — the `/ws/logs` channel

`logHub` is added to `WsServerDeps` (injected from `index.ts` using the singleton) rather than reached via a hidden import, so `attachWsServer` stays testable with a fake hub.

- **Upgrade handler:** add `/ws/logs` to the set of accepted pathnames, and include it in the passcode-gated branch alongside `/ws/capture` and `/ws/review` (missing or wrong `?passcode=` → `socket.destroy()`). Dispatch it to a new `handleLogsConnection`.
- **`handleLogsConnection(ws, deps)`:**
  1. On connect, send the buffer as one batch: `{ type: 'history', entries: LogEntry[] }`.
  2. `const unsubscribe = deps.logHub.subscribe(entry => …)` — forward each new entry as `{ type: 'log', entry }`, guarded by `ws.readyState === WebSocket.OPEN` and wrapped in try/catch so a dead socket never propagates back into `push`.
  3. On `ws.on('close')` (and error), call `unsubscribe()` — mirrors the existing subscribe/unsubscribe cleanup pattern already used elsewhere in this file (e.g. the cost-tracker unsubscribe).

This is a read-only channel: the server does not process any inbound messages from a logs socket.

### 4. Client — the Logs tab

`web/app/admin/page.tsx` gains a fourth tab, `"logs"`, added to `TabsList` and `TabsContent`. Its behavior:

- **Connection:** a `useEffect` (keyed on `authorized` + `passcode`) opens `` `${WS_URL}/ws/logs?passcode=${passcode}` ``. It appends `history` entries on the initial message and each `log` entry as it arrives, into a bounded local array (cap **~2000**, dropping oldest — the browser view doesn't need unbounded scrollback). The effect closes the socket on cleanup.
- **Reconnect:** if the socket closes unexpectedly (server restart), show a small "disconnected — reconnecting…" indicator and retry with a simple backoff; a successful reconnect re-pulls fresh `history`, so the view self-heals. A `401`-equivalent (server destroys the socket on bad passcode) stops retrying.
- **Rendering:** a monospace, scrollable panel; each row shows `time · level · event · compact payload`. `warn` rows amber, `error` rows red, regardless of the level filter.
- **Controls (per approved scope):**
  - *Level filter* — toggle info/warn/error visibility.
  - *Text search* — substring filter over the event name + stringified payload.
  - *Pause + autoscroll* — stick to newest by default; entries keep buffering into state while paused, only the scroll-to-bottom is suspended so the operator can read.
  - *Clear + copy/download* — clear empties the on-screen array (new entries still stream in afterward); copy puts the currently shown (post-filter) lines on the clipboard; download saves them as a `.log`/`.txt` text file.

Filtering and search are applied at render time over the local array; they never change what the server sends.

This is an additive change to `page.tsx`: a new tab, new state, a new `useEffect`, and a new render block. It does not modify the existing Models/Prompt notes/Display tabs or the passcode gate. Follow `docs/STYLE_GUIDE.md` for accent color and component patterns, reusing the existing shadcn primitives already imported (`Tabs`, `Button`, `Input`, `ToggleGroup`, etc.).

## Error Handling

- **A subscriber throws or is slow** → `logHub.push`'s per-listener try/catch isolates it; logging and other subscribers are unaffected.
- **Send to a logs socket fails / socket already closed** → guarded by `readyState` + try/catch in the forwarder; the entry is simply skipped for that socket, and `close` will unsubscribe it. Never propagates into `logEvent`.
- **File write still fails** (existing behavior) → unchanged; the hub has already fanned the entry out to live viewers, so a disk problem no longer blinds the operator.
- **Client socket drops (server restart)** → client shows a reconnecting state and retries with backoff; reconnect re-pulls history. In-memory buffer resetting on restart is expected (documented in Scope).
- **Wrong/missing passcode** → server destroys the socket during upgrade (same as capture/review); client stops retrying and the tab shows a disconnected state rather than looping.
- **High log volume** → both buffers are bounded (server 500, client ~2000) so memory stays flat; pause lets the operator read without the view scrolling away.

## Testing

- **Unit — `logHub`:** `push` past `bufferSize` drops the oldest and preserves order; a new subscriber via `subscribe` receives subsequently-pushed entries; `getHistory` returns current contents; a throwing listener does not prevent other listeners from receiving the entry or cause `push` to throw; `unsubscribe` stops delivery.
- **Unit — `logger.ts`:** calling `logEvent` pushes a well-formed entry (`timestamp`, `level`, spread payload) to an injected/fake hub, in addition to the existing console/file behavior.
- **Unit — `wsServer.ts` `/ws/logs`** (following the existing `server/tests/wsServer.test.ts` patterns): a connection with a missing or wrong passcode is rejected; a valid connection receives a `history` message on connect; a subsequent `logEvent` (i.e. `logHub.push`) is delivered to the socket as a `{ type: 'log' }` message; closing the socket unsubscribes (no further delivery / no leak).
- **Manual:** run a real session, open the Logs tab, confirm recent history appears immediately and new entries stream in live; trigger a warn/error path (e.g. a translation fallback) and confirm it shows color-coded; exercise level filter, search, pause/autoscroll, clear, and copy/download; restart the server and confirm the tab reconnects and re-pulls history.

## Known simplifications

- The live buffer is **in-memory** — a server restart clears the streamed scrollback (the durable record remains `data/events.log`). Tailing the file into the tab was considered and deferred (see Future Extensions).
- Only the structured `logEvent` stream is shown; the two raw `console.log` plumbing lines and any third-party stdout are not captured.
- A single admin passcode gates the channel — no per-user identity or read-scoping.
- Filtering/search/clear are client-side view operations only; they do not affect the server buffer or what other admin sessions see.

## Future Extensions (explicitly out of scope now)

- Tail `data/events.log` on connect for full history across restarts, then stream live (the "read from log file" option considered during brainstorming).
- Server-side filtering (e.g. subscribe to only `error`-level entries) to reduce bandwidth on a very chatty session.
- Log retention/rotation and a "download full log file" affordance.
- Structured/expandable payload rendering (pretty-printed JSON per row) beyond the compact single-line view.
