# Per-Session Log Files and a Readable Log Browser — Design

## Purpose

Today every structured event the server emits is appended to one file,
`server/data/events.log`. That file is now 13.7 MB and 42,305 entries covering
13 separate services going back to 18 July, with no rotation and no way to
answer "show me what happened during last Sunday morning's service" short of
SSHing in and reading timestamps.

The [2026-07-21 admin live logs tab](2026-07-21-admin-live-logs-tab-design.md)
deferred exactly two things: reading `data/events.log` from the browser, and a
retention/rotation policy. This design does both. It splits the log by session,
and gives the admin Logs tab a file picker labelled in Melbourne time — plus a
readable rendering of each entry, so someone who does not read JSON can follow
what the system did.

## Scope

- Each capture session writes its own log file. Events logged while no session
  is running go to a separate `server.log`.
- The admin Logs tab gains a file picker: the live session, past sessions
  newest-first, `server.log`, and the frozen legacy log. Sortable and
  filterable by date.
- Each entry renders as a plain-English sentence, with Detailed and Raw modes
  available.
- Two bundled fixes: the double-`start` Deepgram connection leak, and two test
  files that write into the production log.

Out of scope: searching across multiple session files at once (the text search
covers the file you have open); automatic deletion by age or count; rotating
`server.log`; streaming a historical file's tail as it grows; any change to
what the server writes into a log line.

## Storage layout

```
server/data/
  events.log                       ← frozen. Never appended to again.
  logs/
    session-2026-07-26T15-27+1000.log
    session-2026-07-27T09-42+1000.log
    server.log
```

Session filenames are `session-<YYYY-MM-DD>T<HH>-<mm><±HHMM>.log`, built from
the session's start instant rendered in `Australia/Melbourne`. Melbourne
wall-clock sorts chronologically, reads correctly over SSH, and the explicit
offset disambiguates the one repeated hour at the April DST rollback (`+1100`
before, `+1000` after). Two sessions starting inside the same minute would
collide; the second gets a `-2` suffix before `.log`.

## Design

### 1. `server/src/logFiles.ts` — which file, and what's in the directory

A new module owns everything about the log directory: naming, which file is
current, listing, reading, deleting. `logger.ts` stays thin — it keeps doing
console + `logHub.push` + one `appendFile`, and only asks this module for a
path.

```ts
export const GRACE_MS = 5 * 60 * 1000;
export const MAX_ENTRIES_RETURNED = 20_000;

export interface LogFileInfo {
  name: string;                          // 'session-2026-07-26T15-27+1000.log'
  kind: 'session' | 'server' | 'legacy';
  startedAt: string | null;              // ISO, from the file's first entry
  endedAt: string | null;                // ISO, from the file's last entry
  bytes: number;
  active: boolean;                       // true only for the running session
}

export interface LogFileContents {
  entries: LogEntry[];
  total: number;                         // lines in the file
  skipped: number;                       // total - entries.length
  unparseable: number;                   // lines that were not valid JSON
}

export interface LogFileStore {
  currentPath(): string;
  openSession(now?: number): void;
  closeSession(now?: number): void;
  initFromDisk(): Promise<void>;
  activeName(): string | null;
  list(): Promise<LogFileInfo[]>;
  read(name: string): Promise<LogFileContents>;
  remove(name: string): Promise<void>;
  reset(): void;
}

export function createLogFileStore(dir: string, legacyPath: string): LogFileStore;
export const logFiles: LogFileStore;   // process-wide singleton
```

The factory-plus-singleton shape follows the codebase's existing
`createFeedbackStore(path)` / `createModelConfigStore(path)` pattern. `logger.ts`
and `session.ts` use the singleton — `logger.ts` already reaches for the
`logHub` singleton the same way — while `app.ts` receives a store through
`AppDeps`, so `app.test.ts` can inject one pointed at a temp directory.

**State.** Two fields: `currentSessionFile: string | null` and
`sessionStoppedAt: number | null` (null while a session is running).

**Resolution, evaluated per write — no timers:**

| condition | target |
| --- | --- |
| session running (`currentSessionFile` set, `sessionStoppedAt === null`) | `currentSessionFile` |
| stopped within `GRACE_MS` | `currentSessionFile` |
| stopped longer ago than `GRACE_MS` | `server.log` |
| never started | `server.log` |

Events logged during the grace window go to the session file, not `server.log`.
If the capture device drops at 4:10 PM, the reconnect diagnostics are the most
relevant thing in that service's log; `server.log` correspondingly will not
contain the disconnect.

**`openSession`.** If `currentSessionFile` is set and the stop was within
`GRACE_MS`, keep appending to it. Otherwise mint a new filename from `now`.
Idempotent: calling it while a session is already running is a no-op, so the
double-`start` path cannot rotate the file mid-service.

**`closeSession`.** Sets `sessionStoppedAt`. Idempotent — `session.stop()` fires
from both the `'stop'` message handler and the capture socket's `'close'`
handler, and commit `5669042` established that both can run for the same
session. A `closeSession` when no session is open is a no-op.

**Boot resumption.** `initFromDisk()` reads the newest session file's last line
and seeds `currentSessionFile` and `sessionStoppedAt` from its timestamp;
`index.ts` awaits it once at startup, before the server listens. The resolution
table above then does the rest — a `pm2 restart` mid-service resumes the same
file, and so does a crash, through the same lazy comparison as the reconnect
case. It is a separate explicit call rather than lazy initialisation because
reading the tail is asynchronous while `currentPath()` must stay synchronous
(`logEvent` resolves its target before awaiting the append).

**Escape hatch.** If `process.env.LOG_FILE_PATH` is set, `currentLogPath()`
returns it and no rotation happens. This preserves today's single-file
behaviour and keeps the existing test-isolation pattern in `logger.test.ts`,
`openRouterReasoningLogging.test.ts`, `wsServer.test.ts` and `sermonCache.test.ts`
working unchanged.

**Hook-up.** `session.start()` calls `openSession()`; `session.stop()` calls
`closeSession()`. Both handlers already funnel through those two methods.

**Listing.** `listLogFiles` reads each file's first line and seeks the tail for
its last, so listing 50 files is a few hundred bytes of I/O rather than
150 MB. `endedAt` is simply the last entry's timestamp — which is why a
session killed by `kill -9` still labels correctly. `events.log` is reported
with `kind: 'legacy'`; the running session is the only entry with
`active: true`.

**Reading.** `readLogFile` parses NDJSON, keeps the newest
`MAX_ENTRIES_RETURNED`, and reports `total`, `skipped` and `unparseable`. A
normal service is 8–12k entries so the cap never bites; it exists for the
42,305-entry legacy file and for any future marathon session.

**Name validation.** `readLogFile` and `deleteLogFile` accept only names
matching `/^(session-[\w+-]+\.log|server\.log|events\.log)$/`, and additionally
verify the resolved path's directory is the expected one. An admin passcode
must not become a way to read arbitrary files off the box.

### 2. Endpoints

Three routes in `app.ts`, all behind the existing `adminAuth` middleware and
the `x-admin-passcode` header, matching `/admin/model-config` and every other
admin data route. The live stream stays on the `/ws/logs` WebSocket, unchanged.

- **`GET /admin/logs`** → `{ files: LogFileInfo[] }`, newest first.
- **`GET /admin/logs/:name`** → `LogFileContents`. `404` if the name fails
  validation or the file is absent.
- **`DELETE /admin/logs/:name`** → `204`. `409` if the name is the active
  session's file; `403` for `events.log`, which is not deletable through the
  API; `404` if absent.

### 3. Admin Logs tab

**Picker.** A trigger showing the current selection, opening a menu listing
`Live — current session` first, then `Past sessions` newest-first, then
`Other` (`server.log`, Legacy). Each option shows a Melbourne label and a
sub-line: `Sun 26 Jul 2026, 3:27 PM – 5:07 PM AEST` / `1h 40m · 2.8 MB`. The
menu header holds a date input ("from this date onward") and a newest/oldest
toggle. Both act on the list only — which is why they live inside the menu
rather than on the toolbar, where they would imply they filter the log being
read.

Selecting `Live` is exactly today's `/ws/logs` behaviour. Selecting a file
fetches it once and renders the entries through the same row renderer.

**Two control rows.** The first answers "which log" (picker, Delete); the
second answers "how do I read it" (view mode, severity, search, Pause, Copy,
Download). Today's single row is already seven controls wide and would wrap
unpredictably at laptop widths if extended.

**View modes** as a `ToggleGroup`: `Simple` (default) · `Detailed` · `Raw`.
Raw is today's exact rendering. Any row in Simple or Detailed can be clicked to
expand its raw payload in place, so the readable view is never a dead end.

**Severity.** The level filter is relabelled `Normal` / `Attention` /
`Problems`, filtering the same underlying `info` / `warn` / `error` levels.
Severity renders as a 2 px coloured left stripe plus a glyph, not only as
coloured text — today's amber text disappears the moment a row wraps.

**Other controls.** `Pause` is disabled unless Live is selected. `Copy` and
`Download` produce the readable, filtered text currently on screen; historical
files additionally offer a raw-file download. `Delete` is on the file row, away
from Copy/Download, always confirms by name, and is disabled for Live and
Legacy.

**States.** Loading, empty ("Nothing matches those filters"), a truncation
banner when `skipped > 0`, and a notice when `unparseable > 0`.

### 4. `web/lib/logFormat.ts` — the phrasing table

One table keyed by event name:

```ts
type Phrasing = {
  simple: boolean;                       // shown in Simple mode
  text: (payload: LogEntry) => string;
};
export function formatEntry(entry: LogEntry): { text: string; simple: boolean };
```

An unmapped event falls back to de-underscoring its name and listing payload
key–value pairs, and is marked `simple: false` — so a newly added event is
never silently dropped, but the Simple view stays curated until someone writes
it a phrasing. Language codes render through the existing `TARGET_LANGUAGES` in
`web/lib/languages.ts` rather than a second mapping.

The table lives entirely on the client. The server keeps writing exactly the
JSON it writes today, so old files stay readable under a newer table and the
durable record is unaffected.

**Simple-mode membership.** Session lifecycle, hidden lines, failed or missing
translations, corrections, backpressure, and the edge-triggered ingest/verify
lag events are `simple: true`.
`dg_diag_transcript` (59% of all entries), `openrouter_reasoning` (19%),
`session_context_cache` and `dg_diag_metadata` are Detailed-only.
`caption_lag_shed` is Detailed-only as well: at ~2,300 per bad service it is
the noisiest thing that would otherwise reach the Simple view, and the
`caption_corrected` entry that follows each one already tells the operator the
line was fixed.

**Run collapsing.** In Simple mode only, three or more consecutive entries with
the same event *and* level collapse into one row showing the count and the time
span, expandable to the individual entries. Detailed and Raw stay
line-for-line. Grouping is by event and level, not by payload, so a burst of
Japanese fallbacks interleaved with Spanish ones breaks into several groups
rather than merging.

**Times** render in `Australia/Melbourne` as `3:31:12 PM`, with a date
separator row when the day changes.

### 5. Bundled fixes

- **Double-`start` connection leak.** `wsServer.ts` overwrites
  `deepgramConnection` on a second `'start'` message without finishing the
  first, leaking a live Deepgram connection — observed twice in `events.log`
  (14:15:20/14:15:32 on 25 July, 05:01:18/05:05:51 on 26 July). Finish the
  existing connection before replacing it. Without this, the grace period
  merely hides the symptom while the session boundaries this feature depends
  on stay dirty.
- **Test pollution.** `costTracker.test.ts` and `viewerFeedbackStore.test.ts`
  do not set `LOG_FILE_PATH`, so `npm test` writes into the real log — the
  source of the `viewer_feedback_file_load_failed` and `cost_file_load_failed`
  entries in `events.log`. Point both at a temp path, as the other seven test
  files already do.

## Error handling

- **Log directory missing** → created on demand by the existing
  `mkdir(dirname, { recursive: true })` in `logger.ts`.
- **A write lands mid-rotation** → `currentLogPath()` is resolved
  synchronously at call time, before the awaited `appendFile`, so an entry
  logged just before a rotation lands in the file that was current when it was
  logged.
- **File write fails** (existing behaviour) → unchanged; the entry has already
  reached `logHub` and the console.
- **Unparseable line in a file** → skipped and counted in `unparseable`; the
  tab shows a notice rather than failing the whole read.
- **File deleted by another admin session** → `404`; the tab reports it and
  falls back to Live.
- **Boot resumption reads a corrupt tail** → treated as no resumable session; a
  new file is started.
- **Bad or missing passcode** → `401` from `adminAuth`, as with every other
  admin route.

## Testing

Server-side, following the existing 37-file suite:

- **`logFiles`** — filename generation in AEST and in AEDT; the `-2` collision
  suffix; resume within `GRACE_MS` vs. a new file past it; `openSession` and
  `closeSession` idempotence; idle events routing to `server.log`; grace-window
  events routing to the session file; boot resumption from the newest file's
  last line, including a corrupt tail; `LOG_FILE_PATH` bypassing all of it;
  listing metadata derived from first and last line, including an empty file
  and a single-line file; the entry cap reporting `skipped`; `unparseable`
  counting; name-validation rejecting traversal attempts.
- **`logger`** — routes to the path `currentLogPath()` returns.
- **`app`** — all three routes reject a missing passcode; `GET /admin/logs`
  shape; `404` on an unknown name; `409` deleting the active session; `403`
  deleting `events.log`.
- **`session`** — `start()` opens a session file, `stop()` closes it.
- **`wsServer`** — a second `'start'` finishes the first Deepgram connection.
- **Phrasing coverage** — a server test greps `server/src/**` for
  `event: '<name>'` strings and asserts each appears in `web/lib/logFormat.ts`,
  read from disk as text. Adding a `logEvent` call without a phrasing fails
  with the missing name. It reads the file rather than importing it because the
  two packages have separate builds.

The web package has no test runner (`web/package.json` has no `test` script),
matching how the live logs tab itself was shipped. The tab is verified
manually: pick each kind of file, switch all three modes, expand a run and a
payload, exercise search and severity filters, confirm Pause is disabled off
Live, delete a file and confirm the picker updates, and confirm the truncation
banner on Legacy.

## Known simplifications

- `server.log` never rotates. It only receives idle events, so it grows slowly,
  but it is unbounded.
- The date filter is "from this date onward", not a from–to range.
- Historical files are a point-in-time read; a file that grows after you open
  it does not update until you reselect it. Only Live streams.
- Run collapsing groups consecutive entries only. A run interrupted by one
  unrelated entry becomes two rows.
- The phrasing table is client-side and untested by machine; the server-side
  coverage test proves every event *has* a phrasing, not that the phrasing
  reads well.

## Future extensions

- Search across all session files at once, returning matches with the session
  they came from.
- Retention: automatic pruning by age or count, if the current
  keep-everything-plus-delete-button proves insufficient.
- Dropping `dg_diag_transcript` and `openrouter_reasoning` from what is
  written at all — together 78% of log bytes — which would shrink a session
  file from ~2.8 MB to ~600 KB.
