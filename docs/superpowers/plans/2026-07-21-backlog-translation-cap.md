# Backlog Translation Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the on-subscribe viewer backlog translation to the most recent N visible lines so a single subscribe/reconnect can no longer fire a 300+-line translate+verify burst at the shared OpenRouter budget.

**Architecture:** A new pure helper `selectBacklogEntriesToTranslate` picks the most-recent, still-uncached visible lines (bounded by a limit). `handleViewerConnection` uses it in place of the current "translate every uncached line" computation. The limit is a new `WsServerDeps` field wired from a `VIEWER_BACKLOG_TRANSLATE_LIMIT` env var (default 30). Lines beyond the cap are never translated and render as English via the existing `buildBacklogLine` fallback.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node.js, `ws`, Vitest.

## Global Constraints

- Helper signature (exact): `selectBacklogEntriesToTranslate(visibleEntries: CaptionLine[], isCached: (line: CaptionLine) => boolean, limit: number): CaptionLine[]`.
- Selection semantics (exact): `limit > 0 ? visibleEntries.slice(-limit).filter(line => !isCached(line)) : []`.
- Env var name (exact): `VIEWER_BACKLOG_TRANSLATE_LIMIT`. Default when unset: `30`.
- `WsServerDeps` field name (exact): `viewerBacklogTranslateLimit: number`.
- ESM imports within `server/src` use `.js` specifiers (e.g. `'./viewerBacklog.js'`), even though the source files are `.ts`.
- Server-only change. No files under `web/` are touched; the viewer already renders an uncached line's English text as its translation.
- Run server commands from the `server/` directory. Tests: `npm test` (Vitest). Type-check/build: `npm run build`.

---

### Task 1: Pure backlog-selection helper

**Files:**
- Create: `server/src/viewerBacklog.ts`
- Test: `server/tests/viewerBacklog.test.ts`

**Interfaces:**
- Consumes: `CaptionLine` from `server/src/types.ts` (fields used: `id: string`, `suppressed: boolean`; the helper treats entries opaquely otherwise).
- Produces: `selectBacklogEntriesToTranslate(visibleEntries: CaptionLine[], isCached: (line: CaptionLine) => boolean, limit: number): CaptionLine[]` — returns, in original order, the most-recent `limit` entries of `visibleEntries` that are not cached. Returns `[]` when `limit <= 0`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/viewerBacklog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectBacklogEntriesToTranslate } from '../src/viewerBacklog';
import type { CaptionLine } from '../src/types';

function line(id: string): CaptionLine {
  return { id, timestampMs: 0, english: id, suppressed: false };
}

const cachedNone = () => false;
const cachedAll = () => true;

describe('selectBacklogEntriesToTranslate', () => {
  it('returns only the most recent `limit` entries when more exist and none are cached', () => {
    const entries = ['a', 'b', 'c', 'd', 'e'].map(line);
    const result = selectBacklogEntriesToTranslate(entries, cachedNone, 2);
    expect(result.map((l) => l.id)).toEqual(['d', 'e']);
  });

  it('returns all entries when there are fewer than the limit', () => {
    const entries = ['a', 'b'].map(line);
    const result = selectBacklogEntriesToTranslate(entries, cachedNone, 5);
    expect(result.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('excludes cached entries within the recent window', () => {
    const entries = ['a', 'b', 'c', 'd'].map(line);
    const cached = (l: CaptionLine) => l.id === 'c';
    const result = selectBacklogEntriesToTranslate(entries, cached, 3); // window: b,c,d
    expect(result.map((l) => l.id)).toEqual(['b', 'd']);
  });

  it('returns empty when the whole recent window is already cached', () => {
    const entries = ['a', 'b', 'c'].map(line);
    const result = selectBacklogEntriesToTranslate(entries, cachedAll, 2);
    expect(result).toEqual([]);
  });

  it('excludes an uncached entry older than the recent window', () => {
    const entries = ['old', 'b', 'c'].map(line);
    const cached = (l: CaptionLine) => l.id !== 'old'; // only 'old' is uncached
    const result = selectBacklogEntriesToTranslate(entries, cached, 2); // window: b,c
    expect(result).toEqual([]);
  });

  it('returns empty when limit is 0', () => {
    const entries = ['a', 'b'].map(line);
    expect(selectBacklogEntriesToTranslate(entries, cachedNone, 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- viewerBacklog`
Expected: FAIL — cannot resolve `../src/viewerBacklog` / `selectBacklogEntriesToTranslate is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/viewerBacklog.ts`:

```ts
import type { CaptionLine } from './types.js';

// Of the visible backlog, return only the most-recent `limit` lines that are
// still uncached for the target language. Older lines are intentionally
// excluded — they fall back to their English text in the backlog snapshot
// rather than being translated — which bounds the size (and cost/latency) of a
// single on-subscribe backlog fill. See
// docs/superpowers/specs/2026-07-21-backlog-translation-cap-design.md.
export function selectBacklogEntriesToTranslate(
  visibleEntries: CaptionLine[],
  isCached: (line: CaptionLine) => boolean,
  limit: number
): CaptionLine[] {
  const recent = limit > 0 ? visibleEntries.slice(-limit) : [];
  return recent.filter((line) => !isCached(line));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- viewerBacklog`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/viewerBacklog.ts server/tests/viewerBacklog.test.ts
git commit -m "Add capped backlog-entry selection helper"
```

---

### Task 2: Wire the cap into the viewer subscribe path

**Files:**
- Modify: `server/src/wsServer.ts` (add import; add `viewerBacklogTranslateLimit` to `WsServerDeps`; use helper in `handleViewerConnection`)
- Modify: `server/src/index.ts` (thread `VIEWER_BACKLOG_TRANSLATE_LIMIT` into the `attachWsServer(...)` call)
- Modify: `server/.env.example` (document the new variable)
- Test: `server/tests/wsServer.test.ts` (add limit to test deps; add capped-backlog test)

**Interfaces:**
- Consumes: `selectBacklogEntriesToTranslate(...)` from Task 1.
- Produces: `WsServerDeps.viewerBacklogTranslateLimit: number` — the maximum number of most-recent visible backlog lines translated on a viewer subscribe.

- [ ] **Step 1: Write the failing test**

In `server/tests/wsServer.test.ts`, first add the new dep to the `deps = { ... }` object (currently ending with `deepgramCostFlushIntervalMs: 5000,` around line 188) so it reads:

```ts
      adminPasscode: 'test-passcode',
      deepgramCostFlushIntervalMs: 5000,
      viewerBacklogTranslateLimit: 30,
```

Then add this test immediately after the existing `it('sends translated backlog to a viewer joining after segments already arrived', ...)` test (around line 352):

```ts
  it('caps backlog translation to the most recent viewerBacklogTranslateLimit lines', async () => {
    // Override the default limit for this test; handleViewerConnection reads
    // deps.viewerBacklogTranslateLimit at subscribe time, so mutating it here
    // (same pattern as the deepgramCostFlushIntervalMs overrides) takes effect.
    deps.viewerBacklogTranslateLimit = 2;

    const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture?passcode=test-passcode`);
    await waitForOpen(captureSocket);
    captureSocket.send(JSON.stringify({ type: 'start' }));
    await waitForMessage(captureSocket); // status: recording

    session.buffer.append('Line 1', Date.now());
    session.buffer.append('Line 2', Date.now());
    session.buffer.append('Line 3', Date.now());
    session.buffer.append('Line 4', Date.now());
    session.buffer.append('Line 5', Date.now());

    // Only the last 2 lines are sent for backlog translation, so the fill's
    // translateBacklog call returns exactly two translations.
    (geminiClient.models.generateContent as any).mockResolvedValueOnce({
      text: '{"translations":["译文4","译文5"]}',
    });

    const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
    await waitForOpen(viewerSocket);
    viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
    const backlogMessage = (await waitForMessage(viewerSocket)) as {
      type: string;
      lines: Array<{ id: string; english: string; translated: string }>;
    };

    expect(backlogMessage.type).toBe('backlog');
    expect(backlogMessage.lines).toHaveLength(5);
    // Older-than-cap lines are never translated: English shown as-is.
    expect(backlogMessage.lines[0]).toEqual({ id: expect.any(String), english: 'Line 1', translated: 'Line 1' });
    expect(backlogMessage.lines[1]).toEqual({ id: expect.any(String), english: 'Line 2', translated: 'Line 2' });
    expect(backlogMessage.lines[2]).toEqual({ id: expect.any(String), english: 'Line 3', translated: 'Line 3' });
    // The most recent `limit` lines are translated.
    expect(backlogMessage.lines[3]).toEqual({ id: expect.any(String), english: 'Line 4', translated: '译文4' });
    expect(backlogMessage.lines[4]).toEqual({ id: expect.any(String), english: 'Line 5', translated: '译文5' });

    captureSocket.close();
    viewerSocket.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- wsServer`
Expected: FAIL — TypeScript error that `viewerBacklogTranslateLimit` is not assignable to `WsServerDeps` (the field doesn't exist yet), and/or the new test asserting only the last two lines are translated does not hold (today all five would be translated).

- [ ] **Step 3: Add the field to `WsServerDeps` and import the helper (`wsServer.ts`)**

At the top of `server/src/wsServer.ts`, alongside the other local imports, add:

```ts
import { selectBacklogEntriesToTranslate } from './viewerBacklog.js';
```

In the `WsServerDeps` interface, add the field after `deepgramCostFlushIntervalMs: number;`:

```ts
  deepgramCostFlushIntervalMs: number;
  viewerBacklogTranslateLimit: number;
```

- [ ] **Step 4: Use the helper in `handleViewerConnection` (`wsServer.ts`)**

Replace the `missingEntries` computation inside the `if (message.type === 'subscribe')` block. Current:

```ts
          const backlog = deps.session.buffer.getRecent();
          const visibleEntries = backlog.filter((line) => !line.suppressed);
          const missingEntries = visibleEntries.filter((line) => cache.get(language, line.id) === undefined);
```

New:

```ts
          const backlog = deps.session.buffer.getRecent();
          const visibleEntries = backlog.filter((line) => !line.suppressed);
          const missingEntries = selectBacklogEntriesToTranslate(
            visibleEntries,
            (line) => cache.get(language, line.id) !== undefined,
            deps.viewerBacklogTranslateLimit
          );
```

Leave the rest of the block unchanged: the `if (missingEntries.length > 0) { await ensureBacklogCached(...) }` call, the `backlog.map((line) => buildBacklogLine(line, cache, language))` snapshot, and `deps.session.addViewer(ws, language)`.

- [ ] **Step 5: Thread the env var in `index.ts`**

In `server/src/index.ts`, in the `attachWsServer({ ... })` call, add the field after `deepgramCostFlushIntervalMs: 5000,`:

```ts
  deepgramCostFlushIntervalMs: 5000,
  viewerBacklogTranslateLimit: process.env.VIEWER_BACKLOG_TRANSLATE_LIMIT
    ? Number(process.env.VIEWER_BACKLOG_TRANSLATE_LIMIT)
    : 30,
```

- [ ] **Step 6: Document the variable in `.env.example`**

Append to `server/.env.example`:

```
VIEWER_BACKLOG_TRANSLATE_LIMIT=30
```

- [ ] **Step 7: Run the new test to verify it passes**

Run: `npm test -- wsServer`
Expected: PASS — including the new `caps backlog translation ...` test. Existing wsServer tests remain green (the default limit of 30 in test deps is larger than every existing test's tiny backlog, so their behavior is unchanged).

- [ ] **Step 8: Type-check and run the full suite**

Run: `npm run build`
Expected: no TypeScript errors (confirms `index.ts` and the test deps both satisfy the new required `WsServerDeps` field).

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/wsServer.ts server/src/index.ts server/.env.example server/tests/wsServer.test.ts
git commit -m "Cap on-subscribe backlog translation to most recent N lines"
```

---

## Self-Review

**Spec coverage:**
- Cap to most-recent N visible lines → Task 1 helper + Task 2 Step 4. ✓
- Pure, isolated, unit-tested helper in its own module → Task 1. ✓
- Backlog snapshot still includes every visible line; older lines English → Task 2 Steps 4 & 1-test assertions on `lines[0..2]`. ✓
- `VIEWER_BACKLOG_TRANSLATE_LIMIT` env var, default 30, threaded through `WsServerDeps` → Task 2 Steps 3, 5, 6. ✓
- `.env.example` documents the variable → Task 2 Step 6. ✓
- Unit tests for M>limit / M<=limit / partial-cache / all-cached / older-than-window / limit=0 → Task 1 Step 1. ✓
- wsServer test: fresh subscribe against large buffer translates ≤ limit; snapshot keeps all lines; beyond-cap lines English → Task 2 Step 1. ✓
- wsServer test: small buffer still translates every line (regression guard) → covered by the pre-existing `sends translated backlog to a viewer joining after segments already arrived` test (1 line, limit 30), which must stay green (Task 2 Step 7). ✓
- No `web/` changes → confirmed in Global Constraints. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps; every code step shows complete code. ✓

**Type consistency:** `selectBacklogEntriesToTranslate` signature identical in Task 1 (definition), Task 1 test, and Task 2 usage. `viewerBacklogTranslateLimit: number` identical in `WsServerDeps` (Step 3), `index.ts` (Step 5), and test deps (Step 1). The `isCached` predicate passed in Task 2 (`cache.get(...) !== undefined`) matches the helper's `!isCached` filter (returns uncached entries). ✓
