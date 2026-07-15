# Admin Remove-Any-Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the capture-page operator remove any transcript line — not just ones the safety verifier flagged — and later reinstate it, reusing the existing flag/reinstate machinery end to end.

**Architecture:** `TranscriptBuffer` gains `suppress(id)`, the mirror image of the existing `reinstate(id, english)`: it flips a currently-visible line's `suppressed` flag to `true` in place, preserving id and position. A new `admin-remove` WebSocket message on `/ws/capture` calls it and reuses the exact same `transcript`/`line-removed` broadcast shapes the automatic-flag path already produces, so the capture page's existing flagged/Reinstate rendering picks it up with no new branching. The one new client-side piece: the viewer's `line-removed` handler changes from always-append to find-or-replace-by-id, so a line the viewer has already rendered gets blanked in place instead of duplicated — mirroring how `caption-inserted` already behaves.

**Tech Stack:** TypeScript, `ws` (WebSocket server), Vitest (server tests), Next.js/React (capture + viewer pages, manually verified in-browser — no frontend test runner in this repo).

## Global Constraints

- No new REST endpoints — this feature is entirely WebSocket messages over the existing `/ws/capture` and `/ws/viewer` connections.
- Destructive/consequential client actions use the native `window.confirm()` pattern already established by "Clear all feedback notes?" and "Reinstate" on the capture page — no custom modal component.
- An admin-removed line is, from the buffer's and Reinstate's point of view, indistinguishable from a system-flagged one — no changes to `reinstate()`, `handleReinstate`, or the capture page's existing Reinstate UI.
- Server test commands run from the `server/` directory: `npm test` (= `vitest run`), or `npx vitest run tests/<file>.test.ts` for a single file.

---

### Task 1: `TranscriptBuffer.suppress()`

**Files:**
- Modify: `server/src/transcriptBuffer.ts`
- Modify: `server/tests/transcriptBuffer.test.ts`

**Interfaces:**
- Consumes: existing `CaptionLine { id, timestampMs, english, suppressed }` (`server/src/types.ts`, unchanged).
- Produces: `TranscriptBuffer.suppress(id: string, nowMs?: number): CaptionLine | null` — mirror image of the existing `reinstate`. Finds the entry with matching `id` that is currently `suppressed: false`, flips it to `suppressed: true` in place, and returns it. Returns `null` if no such entry exists (unknown id, already suppressed, or trimmed out of the 10-minute window).

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `server/tests/transcriptBuffer.test.ts`, as a sibling of the existing `describe('reinstate', ...)` block (after its closing `});`, before `describe('precedingContextFor', ...)`):

```ts
  describe('suppress', () => {
    it('flips suppressed to true, preserving id, position, and text', () => {
      const buffer = new TranscriptBuffer();
      buffer.append('Before', 1000);
      const visible = buffer.append('Visible line', 2000);
      buffer.append('After', 3000);

      const result = buffer.suppress(visible.id, 4000);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(visible.id);
      expect(result!.english).toBe('Visible line');
      expect(result!.suppressed).toBe(true);

      const recent = buffer.getRecent(4000);
      expect(recent.map((line) => line.english)).toEqual(['Before', 'Visible line', 'After']);
      expect(recent.find((line) => line.id === visible.id)?.suppressed).toBe(true);
    });

    it('returns null for an unknown id', () => {
      const buffer = new TranscriptBuffer();
      expect(buffer.suppress('does-not-exist', 1000)).toBeNull();
    });

    it('returns null for a line that is already suppressed', () => {
      const buffer = new TranscriptBuffer();
      const line = buffer.append('Already hidden', 1000, true);
      expect(buffer.suppress(line.id, 2000)).toBeNull();
    });

    it('returns null once the line has been trimmed out of the 10-minute window', () => {
      const buffer = new TranscriptBuffer();
      const visible = buffer.append('Old and visible', 0);
      const elevenMinutesLater = 11 * 60 * 1000;
      expect(buffer.suppress(visible.id, elevenMinutesLater)).toBeNull();
    });

    it('round-trips with reinstate', () => {
      const buffer = new TranscriptBuffer();
      const line = buffer.append('Round trip', 1000);

      buffer.suppress(line.id, 2000);
      expect(buffer.getRecent(2000)[0].suppressed).toBe(true);

      const result = buffer.reinstate(line.id, 'Round trip corrected', 3000);
      expect(result).not.toBeNull();
      expect(result!.suppressed).toBe(false);
      expect(result!.english).toBe('Round trip corrected');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `npx vitest run tests/transcriptBuffer.test.ts`
Expected: FAIL — `buffer.suppress` is not a function.

- [ ] **Step 3: Implement `suppress()`**

In `server/src/transcriptBuffer.ts`, add this method to the `TranscriptBuffer` class, directly after the existing `reinstate` method (after its closing `}`, before `precedingContextFor`):

```ts
  suppress(id: string, nowMs: number = Date.now()): CaptionLine | null {
    this.trim(nowMs);
    const line = this.lines.find((candidate) => candidate.id === id && !candidate.suppressed);
    if (!line) return null;
    line.suppressed = true;
    return line;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcriptBuffer.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Typecheck the server package**

Run (from `server/`): `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/transcriptBuffer.ts server/tests/transcriptBuffer.test.ts
git commit -m "$(cat <<'EOF'
Add TranscriptBuffer.suppress() to hide a currently-visible line

Mirror image of the existing reinstate(): flips a visible entry's
suppressed flag to true in place, preserving id and position. Lays
the buffer-level groundwork for an admin-triggered remove action on
lines the safety verifier never flagged.
EOF
)"
```

---

### Task 2: Server `admin-remove` handler

**Files:**
- Modify: `server/src/wsServer.ts` (`handleCaptureConnection`'s message switch; new `handleAdminRemove`)
- Modify: `server/tests/wsServer.test.ts` (new `describe('admin-remove', ...)` block)

**Interfaces:**
- Consumes: `TranscriptBuffer.suppress(id, nowMs?)` (Task 1); `deps.session.getAllViewers()` (existing, already used by `handleFinalSegment`'s flag path).
- Capture → server: `{ type: 'admin-remove', id: string }`.
- Server → capture: `{ type: 'admin-remove-error', id: string, error: string }` on failure; on success, a normal `{ type: 'transcript', id, english, flagged: true, reason: 'Removed by admin' }` (the exact shape the automatic-flag path already sends, so the capture page's existing flagged rendering and Reinstate button need no changes).
- Server → all viewers: `{ type: 'line-removed', id: string }` on success (identical shape/broadcast target to the existing auto-flag path).

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `server/tests/wsServer.test.ts`, as a sibling of the existing `describe('reinstate', ...)` block (after its closing `});`, before the closing `});` of the outer `describe('wsServer', ...)`):

```ts
  describe('admin-remove', () => {
    it('suppresses a live line, acks the capture socket with a "Removed by admin" reason, and broadcasts line-removed to viewers', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const captionPromise = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      await captionPromise;

      const line = session.buffer.getRecent()[0];

      const ackPromise = waitForMessage(captureSocket);
      const removedPromise = waitForMessage(viewerSocket);
      captureSocket.send(JSON.stringify({ type: 'admin-remove', id: line.id }));

      const ack = await ackPromise;
      expect(ack).toEqual({
        type: 'transcript',
        id: line.id,
        english: 'Hello everyone',
        flagged: true,
        reason: 'Removed by admin',
      });

      const removed = await removedPromise;
      expect(removed).toEqual({ type: 'line-removed', id: line.id });

      expect(session.buffer.getRecent().find((entry) => entry.id === line.id)?.suppressed).toBe(true);

      captureSocket.close();
      viewerSocket.close();
    });

    it('responds with admin-remove-error for an unknown id and does not touch the buffer', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const errorPromise = waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'admin-remove', id: 'no-such-id' }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'admin-remove-error', id: 'no-such-id', error: 'not found' });
      expect(session.buffer.getRecent()).toHaveLength(0);

      captureSocket.close();
    });

    it('responds with admin-remove-error for a line that is already suppressed', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const flagged = session.buffer.append('Already hidden', Date.now(), true);

      const errorPromise = waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'admin-remove', id: flagged.id }));
      const error = await errorPromise;

      expect(error).toEqual({ type: 'admin-remove-error', id: flagged.id, error: 'not found' });

      captureSocket.close();
    });

    it('an admin-removed line can subsequently be reinstated with corrected text', async () => {
      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const transcriptPromise = waitForMessage(captureSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const transcript = await transcriptPromise;

      const removeAckPromise = waitForMessage(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'admin-remove', id: transcript.id }));
      await removeAckPromise;

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: [{ ...removed placeholder }]

      const reinstateAckPromise = waitForMessage(captureSocket);
      const insertedPromise = waitForMessage(viewerSocket);
      captureSocket.send(
        JSON.stringify({ type: 'reinstate', id: transcript.id, english: 'Hello everyone, corrected' })
      );

      const reinstateAck = await reinstateAckPromise;
      expect(reinstateAck).toEqual({ type: 'transcript', id: transcript.id, english: 'Hello everyone, corrected' });

      const inserted = await insertedPromise;
      expect(inserted).toEqual({
        type: 'caption-inserted',
        id: transcript.id,
        english: 'Hello everyone, corrected',
        translated: '你好',
      });

      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/wsServer.test.ts -t admin-remove`
Expected: FAIL — no `admin-remove` message type is handled yet, so these hang/timeout or receive no message. (A timeout rather than a clean assertion failure is expected at this stage — proceed to implementation.)

- [ ] **Step 3: Add `handleAdminRemove`**

In `server/src/wsServer.ts`, add this function directly after `handleReinstate` (after its closing `}`, before `handleFinalSegment`):

```ts
async function handleAdminRemove(id: string, deps: WsServerDeps, captureSocket: WebSocket): Promise<void> {
  const line = deps.session.buffer.suppress(id);
  if (line === null) {
    captureSocket.send(JSON.stringify({ type: 'admin-remove-error', id, error: 'not found' }));
    return;
  }

  captureSocket.send(
    JSON.stringify({ type: 'transcript', id: line.id, english: line.english, flagged: true, reason: 'Removed by admin' })
  );
  const removedPayload = JSON.stringify({ type: 'line-removed', id: line.id });
  for (const viewerSocket of deps.session.getAllViewers()) {
    viewerSocket.send(removedPayload);
  }
}
```

- [ ] **Step 4: Wire `admin-remove` into the capture message handler**

In `handleCaptureConnection`, inside the `ws.on('message', ...)` handler's `if (!isBinary)` branch, the current structure (after the reinstate feature) ends with:

```ts
          } else if (message.type === 'reinstate') {
            processingQueue = processingQueue
              .then(() => handleReinstate(message.id, message.english, deps, ws))
              .catch((error) => {
                void logEvent('error', {
                  event: 'reinstate_processing_failed',
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
```

Add a fourth branch:

```ts
          } else if (message.type === 'reinstate') {
            processingQueue = processingQueue
              .then(() => handleReinstate(message.id, message.english, deps, ws))
              .catch((error) => {
                void logEvent('error', {
                  event: 'reinstate_processing_failed',
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          } else if (message.type === 'admin-remove') {
            processingQueue = processingQueue
              .then(() => handleAdminRemove(message.id, deps, ws))
              .catch((error) => {
                void logEvent('error', {
                  event: 'admin_remove_processing_failed',
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
```

(Leave the existing `start`/`stop`/`reinstate` bodies untouched — only add the new `else if` branch alongside them. Routing through `processingQueue`, same as `reinstate`, keeps buffer mutations strictly ordered relative to finalized segments and other admin actions.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/wsServer.test.ts`
Expected: all tests pass, including the new `admin-remove` describe block.

Run: `npm test` (from `server/`)
Expected: full suite passes.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/wsServer.ts server/tests/wsServer.test.ts
git commit -m "$(cat <<'EOF'
Add server-side admin-remove handling for any transcript line

A capture-page operator can now send { type: 'admin-remove', id } to
suppress a currently-visible buffer entry in place, reusing the exact
transcript/line-removed broadcast shapes the automatic-flag path
already produces. An admin-removed line is indistinguishable from a
system-flagged one to the existing reinstate machinery.
EOF
)"
```

---

### Task 3: Frontend — viewer in-place removal and capture-page Remove button

**Files:**
- Modify: `web/lib/useViewerSocket.ts`
- Modify: `web/app/capture/page.tsx`

**Interfaces:**
- Consumes: server messages `line-removed` (`{ id }`, existing shape, now handled in-place); capture messages `transcript` (existing, now also arriving with `reason: 'Removed by admin'`) and new `admin-remove-error` (`{ id, error }`).
- Produces: capture WebSocket message `{ type: 'admin-remove', id }`.

No automated frontend test suite exists in this repo (`web/` has no Vitest/Jest config for app code) — this task is verified manually in the browser per Step 4, following this repo's standing convention for UI changes (see Task 4/5 of `docs/superpowers/plans/2026-07-15-reinstate-flagged-transcription.md`).

- [ ] **Step 1: Make `line-removed` find-or-replace in `web/lib/useViewerSocket.ts`**

In `web/lib/useViewerSocket.ts`, the `socket.onmessage` handler currently includes:

```ts
        } else if (message.type === 'line-removed') {
          setLines((previous) => [...previous, { id: message.id, english: '', translated: '', removed: true }]);
          setStatus('live');
        } else if (message.type === 'caption-inserted') {
```

Replace the `line-removed` branch (leave `caption-inserted` untouched) with:

```ts
        } else if (message.type === 'line-removed') {
          setLines((previous) => {
            const index = previous.findIndex((line) => line.id === message.id);
            const placeholder = { id: message.id, english: '', translated: '', removed: true };
            if (index === -1) return [...previous, placeholder];
            const next = [...previous];
            next[index] = placeholder;
            return next;
          });
          setStatus('live');
        } else if (message.type === 'caption-inserted') {
```

This mirrors the find-or-append pattern `caption-inserted` already uses just below it. A viewer who never saw the line (the existing auto-flag case, where the line was suppressed before ever being broadcast) still gets the placeholder appended at the correct backlog position; a viewer who already has the line rendered (the new admin-remove case, where the line was live before removal) now gets that exact row replaced instead of getting a duplicate.

- [ ] **Step 2: Add remove state and the error handler to `web/app/capture/page.tsx`**

The `TranscriptLine` type currently reads:

```ts
type TranscriptLine = {
  id: string;
  text: string;
  flagged: boolean;
  reason?: string;
  reinstateState?: 'editing' | 'pending' | 'error';
  editedText?: string;
  reinstateError?: string;
};
```

Add two fields:

```ts
type TranscriptLine = {
  id: string;
  text: string;
  flagged: boolean;
  reason?: string;
  reinstateState?: 'editing' | 'pending' | 'error';
  editedText?: string;
  reinstateError?: string;
  removeState?: 'pending' | 'error';
  removeError?: string;
};
```

In `connectSocket`'s `socket.onmessage` handler, the current branches read:

```ts
      } else if (message.type === 'reinstate-error') {
        setTranscriptLines((previous) =>
          previous.map((line) =>
            line.id === message.id ? { ...line, reinstateState: 'error', reinstateError: message.error } : line
          )
        );
      } else if (message.type === 'cost') {
```

Add a new branch between them:

```ts
      } else if (message.type === 'reinstate-error') {
        setTranscriptLines((previous) =>
          previous.map((line) =>
            line.id === message.id ? { ...line, reinstateState: 'error', reinstateError: message.error } : line
          )
        );
      } else if (message.type === 'admin-remove-error') {
        setTranscriptLines((previous) =>
          previous.map((line) =>
            line.id === message.id ? { ...line, removeState: 'error', removeError: message.error } : line
          )
        );
      } else if (message.type === 'cost') {
```

Note: on a *successful* admin-remove, the server's `transcript` ack (existing branch, unchanged) fully replaces the line object with `{ id, text, flagged: true, reason: 'Removed by admin' }` — this naturally clears any `removeState: 'pending'` the same way it already clears `reinstateState` on a successful reinstate, so no extra handling is needed for the success path.

- [ ] **Step 3: Add `sendAdminRemove` and wire the Remove button**

Add this function in `web/app/capture/page.tsx`, directly after `sendReinstate` (before the component's `return (`):

```ts
  function sendAdminRemove(id: string) {
    if (status !== 'recording') return;
    const confirmed = window.confirm('Remove this line? It can be reinstated afterward.');
    if (!confirmed) return;
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, removeState: 'pending' } : entry))
    );
    socketRef.current?.send(JSON.stringify({ type: 'admin-remove', id }));
  }
```

The transcript list JSX currently reads:

```tsx
      <div ref={transcriptRef} className="w-full max-w-xl h-64 overflow-y-auto border rounded p-3 text-sm space-y-2">
        {transcriptLines.map((line) => (
          <div key={line.id}>
            <p className={line.flagged ? 'text-destructive line-through' : undefined}>{line.text}</p>
            {line.flagged && line.reinstateState !== 'editing' && (
              <div className="flex items-center gap-2 text-xs">
                {line.reason && <span className="text-muted-foreground">Flagged: {line.reason}</span>}
                <button
                  onClick={() => beginEditing(line.id, line.text)}
                  disabled={status !== 'recording' || line.reinstateState === 'pending'}
                  className="underline disabled:opacity-50 disabled:no-underline"
                >
                  {line.reinstateState === 'pending' ? 'Reinstating…' : 'Reinstate'}
                </button>
              </div>
            )}
            {line.flagged && line.reinstateState === 'editing' && status === 'recording' && (
              <div className="flex flex-col gap-1 mt-1">
                <textarea
                  value={line.editedText ?? line.text}
                  onChange={(event) => updateEditedText(line.id, event.target.value)}
                  rows={2}
                  className="w-full border rounded p-1 text-xs"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => sendReinstate(line.id)}
                    disabled={(line.editedText ?? line.text).trim().length === 0}
                    className="bg-primary text-primary-foreground px-2 py-1 rounded text-xs disabled:opacity-50"
                  >
                    Send
                  </button>
                  <button onClick={() => cancelEditing(line.id)} className="text-xs underline">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {line.reinstateState === 'error' && (
              <p className="text-xs text-destructive">Couldn&apos;t reinstate ({line.reinstateError}) — try again.</p>
            )}
          </div>
        ))}
      </div>
```

Replace it with:

```tsx
      <div ref={transcriptRef} className="w-full max-w-xl h-64 overflow-y-auto border rounded p-3 text-sm space-y-2">
        {transcriptLines.map((line) => (
          <div key={line.id} className="group">
            <div className="flex items-start justify-between gap-2">
              <p className={line.flagged ? 'text-destructive line-through' : undefined}>{line.text}</p>
              {!line.flagged && (
                <button
                  onClick={() => sendAdminRemove(line.id)}
                  disabled={status !== 'recording' || line.removeState === 'pending'}
                  className="opacity-0 group-hover:opacity-100 text-xs underline text-destructive shrink-0 disabled:opacity-50"
                >
                  {line.removeState === 'pending' ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
            {line.flagged && line.reinstateState !== 'editing' && (
              <div className="flex items-center gap-2 text-xs">
                {line.reason && <span className="text-muted-foreground">Flagged: {line.reason}</span>}
                <button
                  onClick={() => beginEditing(line.id, line.text)}
                  disabled={status !== 'recording' || line.reinstateState === 'pending'}
                  className="underline disabled:opacity-50 disabled:no-underline"
                >
                  {line.reinstateState === 'pending' ? 'Reinstating…' : 'Reinstate'}
                </button>
              </div>
            )}
            {line.flagged && line.reinstateState === 'editing' && status === 'recording' && (
              <div className="flex flex-col gap-1 mt-1">
                <textarea
                  value={line.editedText ?? line.text}
                  onChange={(event) => updateEditedText(line.id, event.target.value)}
                  rows={2}
                  className="w-full border rounded p-1 text-xs"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => sendReinstate(line.id)}
                    disabled={(line.editedText ?? line.text).trim().length === 0}
                    className="bg-primary text-primary-foreground px-2 py-1 rounded text-xs disabled:opacity-50"
                  >
                    Send
                  </button>
                  <button onClick={() => cancelEditing(line.id)} className="text-xs underline">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {line.reinstateState === 'error' && (
              <p className="text-xs text-destructive">Couldn&apos;t reinstate ({line.reinstateError}) — try again.</p>
            )}
            {line.removeState === 'error' && (
              <p className="text-xs text-destructive">Couldn&apos;t remove ({line.removeError}) — try again.</p>
            )}
          </div>
        ))}
      </div>
```

The Remove button only renders for `!line.flagged` (an already-flagged line uses the existing Reinstate control instead), is hidden until the row is hovered (`opacity-0 group-hover:opacity-100` on the `group` wrapper), and is disabled outside `status === 'recording'`, matching the existing Reinstate gating.

- [ ] **Step 4: Typecheck the web package**

Run (from `web/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manually verify in the browser**

1. Start the server (`npm run dev` in `server/`) and the web app (`npm run dev` in `web/`).
2. Open the capture page, click Start, and speak (or otherwise trigger) a normal segment that is *not* flagged.
3. Open `/view?lang=zh` in a second tab and confirm the line appears normally.
4. On the capture page, hover that line — confirm a "Remove" button fades in. Click it, confirm the `window.confirm` dialog, and confirm it.
5. Confirm: the capture-page row becomes struck through, showing "Flagged: Removed by admin" and a "Reinstate" button (identical to a system-flagged line). Confirm the `/view?lang=zh` tab's *existing* row for that line is replaced with the dashed "Line removed" marker — not duplicated as a second row.
6. Click "Reinstate" on the capture page, edit the text, send, and confirm the dialog. Confirm the viewer tab's same row updates in place with the corrected translation (not appended at the end).
7. Trigger another normal line, remove it, and open a *new* `/view?lang=zh` tab afterward — confirm its backlog shows the "Line removed" placeholder at the correct position (this path was already covered by the existing auto-flag backlog test/behavior; confirms admin-remove produces the same buffer state).
8. Attempt to remove a line, then click Stop before confirming the dialog — confirm the Remove button is disabled/hidden once `status !== 'recording'`.

- [ ] **Step 6: Commit**

```bash
git add web/lib/useViewerSocket.ts web/app/capture/page.tsx
git commit -m "$(cat <<'EOF'
Add admin remove-any-line action to the capture page

Every non-flagged transcript line now has a hover-revealed Remove
button (confirm-gated) that suppresses it via the existing flag
machinery, so it becomes reinstatable through the unmodified
Reinstate UI. The viewer's line-removed handling now replaces an
already-rendered row in place instead of only ever appending.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** `TranscriptBuffer.suppress()` → Task 1; `admin-remove` server handler, reusing `transcript`/`line-removed` shapes and the `processingQueue` ordering → Task 2; viewer find-or-replace on `line-removed`, capture-page Remove button (hover-shown, confirm-gated, `status === 'recording'` gated, error display) → Task 3. Reinstate itself is explicitly unmodified per the spec ("No changes... works on it unmodified") and no task touches `reinstate()`/`handleReinstate`/the Reinstate JSX. The spec's explicit non-goals (standalone Edit, bulk remove, auth) have no corresponding tasks, as intended.
- **Placeholder scan:** no TBD/TODO; every step has complete code.
- **Type consistency:** `TranscriptBuffer.suppress` (Task 1) is consumed by `handleAdminRemove` (Task 2) with the exact signature `suppress(id): CaptionLine | null`; `admin-remove`/`admin-remove-error` message shapes are identical between the server test assertions (Task 2) and the client handlers (Task 3); `TranscriptLine.removeState`/`removeError` (Task 3) follow the same naming convention as the existing `reinstateState`/`reinstateError`.
