# Admin Remove-Any-Line — Design

## Purpose

Today, an AV operator on the capture page can only act on a line the *system* has already flagged (via [`verifyTranscription`](../../../server/src/transcriptionVerifier.ts)) — see [2026-07-15-reinstate-flagged-transcription-design.md](2026-07-15-reinstate-flagged-transcription-design.md). If a line was transcribed and translated correctly but is simply wrong for some other reason the safety check can't catch — a stray aside caught by the mic, a name misspelled in a way that isn't a "misrepresentation," a sentence better left unsaid — the operator has no way to pull it back. That spec explicitly listed "editing lines that were never flagged" as future, out-of-scope work; this is that follow-up.

This design adds a **Remove** action, available on every transcript line on the capture page regardless of whether the system ever flagged it. Removing a line puts it into exactly the same suppressed state a system-flagged line is already in — struck through, with a reason, and reinstatable — so the entire recovery path (edit text, confirm, send back into the live transcript at its original position) is inherited from the existing Reinstate feature with no changes.

## Scope

- A **Remove** action per transcript line on the capture page (shown on hover, to avoid cluttering a fast-scrolling live transcript), gated by a confirmation dialog.
- Removing a line suppresses it using the same mechanism a system-flagged line already uses: struck through on the capture page, replaced with a "Line removed" placeholder for viewers, and available for **Reinstate** — including editing the text before sending it back — via the existing, unmodified Reinstate UI.
- The one behavioral gap this closes on the viewer side: today `line-removed` only ever *appends* a fresh placeholder row, so a viewer who has already rendered a line and then has it removed sees a duplicate/orphaned row rather than that line being blanked in place. This design makes `line-removed` find-and-replace an existing row by id (falling back to append if the id isn't present yet), matching how `caption-inserted` already behaves.
- Explicitly out of scope: a standalone "Edit" action that corrects a line's text without hiding it first (considered and rejected during design — see Future Extensions); bulk remove of multiple lines; un-removing without going through Reinstate's edit box; any change to the automatic flagging/verification logic itself.

## Design

### 1. Buffer changes

`server/src/transcriptBuffer.ts` gains a method that is the mirror image of the existing `reinstate`:

```ts
suppress(id: string): CaptionLine | null
```

Finds the entry with matching `id`. Returns `null` if it doesn't exist (trimmed out of the 10-minute window) or is already `suppressed: true` (already removed). Otherwise sets `suppressed = true` in place and returns the entry — preserving its position and id exactly as `reinstate` does in reverse.

### 2. `admin-remove` handling (new, in `handleCaptureConnection`, `server/src/wsServer.ts`)

Capture socket sends `{ type: 'admin-remove', id }`. Routed through the same `processingQueue` serialization as `reinstate` and finalized segments, to avoid concurrent buffer mutation races:

```
processingQueue = processingQueue.then(() => handleAdminRemove(id, deps, ws))
```

`handleAdminRemove`:

```
line = deps.session.buffer.suppress(id)
if line === null:
  send { type: 'admin-remove-error', id, error: 'not found' } to capture socket
  return

send { type: 'transcript', id: line.id, english: line.english, flagged: true, reason: 'Removed by admin' } to capture socket
broadcast { type: 'line-removed', id: line.id } to all current viewers
```

This reuses the exact same `transcript` and `line-removed` message shapes the automatic-flag path already produces — the capture page's existing upsert-by-id rendering (built for reinstate) picks this up with zero new client-side branching. `reason: 'Removed by admin'` is what lets the operator visually distinguish an admin removal from a system flag on the same row.

### 3. Reinstate (unchanged)

No changes. An admin-removed line is, from the buffer's and Reinstate's point of view, indistinguishable from a system-flagged one: `suppressed: true`, with an `english` value and an `id`. The existing `reinstate` buffer method, `handleReinstate` handler, and capture-page Reinstate button/edit-box/confirm flow all work on it unmodified.

### 4. Viewer WebSocket protocol (`web/lib/useViewerSocket.ts`)

`line-removed` handling changes from unconditional append to find-or-replace:

```
on 'line-removed' { id }:
  index = find index in lines where lines[index].id === id
  placeholder = { id, english: '', translated: '', removed: true }
  if index !== -1:
    lines[index] = placeholder   // in place, same position
  else:
    lines.push(placeholder)      // defensive fallback, matches caption-inserted's pattern
```

This is the same shape of change `caption-inserted` already introduced for reinstate; it now applies uniformly to both the automatic-flag path and the new admin-remove path, since both send the same `line-removed` message. A viewer who has already rendered the line (admin-remove case, the line was live before removal) gets it blanked in place; a viewer who never saw it (system-flag case, the line was never broadcast) gets the placeholder appended at the right backlog position — both existing behaviors are preserved.

### 5. Capture page (`web/app/capture/page.tsx`)

- Every rendered transcript line — not just flagged ones — gets a small **Remove** icon button, `visibility: hidden` by default and shown via a row-level `:hover` CSS rule (no extra JS state for visibility).
- Click → `window.confirm('Remove this line? It can be reinstated afterward.')`. On confirm, `{ type: 'admin-remove', id }` is sent and the row moves to a `pending` state (button disabled) — same interaction shape as the existing Reinstate send.
- On the `transcript` echo with matching `id` and `flagged: true`, the row settles into the existing flagged/struck-through rendering (unchanged code path) — reason text reads "Removed by admin," and the existing Reinstate button/edit-box appears exactly as it does for a system-flagged line.
- On `admin-remove-error` with matching `id`, the row returns to normal (non-pending) state with a transient inline error, same visual pattern as `reinstateError`.
- The Remove button is only shown/enabled while `status === 'recording'`, matching the existing gate on Reinstate.

## Error Handling

- **Buffer-trimmed line** (operator tries to remove a line older than the 10-minute `BUFFER_WINDOW_MS`): `buffer.suppress()` returns `null` → `admin-remove-error`, inline error shown. Same inherent limit the Reinstate feature already has in reverse.
- **Double-remove** (rapid double-click, two operator tabs): server re-checks `suppressed === false` inside `buffer.suppress()` before mutating; a second attempt gets `admin-remove-error` rather than double-broadcasting `line-removed`. Client-side `pending` state (button disabled) prevents the common case.
- **Remove racing a live segment for the same line**: not possible — `id` is only known to the capture client once the server has already assigned it via a `transcript` message, and both `admin-remove` and finalized-segment processing share the same `processingQueue`, so mutations are strictly ordered.
- **Session stopped/restarted mid-removal**: identical to the existing Reinstate case — `start()`/`stop()` clear `transcriptLines` client-side and `buffer.clear()` server-side, so a stale id has nothing to look up and fails cleanly via the not-found path.

## Testing

- **Unit (`transcriptBuffer.test.ts`)**: `suppress` mutates the matching entry's `suppressed` to `true` in place and preserves its id/position/`english`; `suppress` on an unknown id returns `null`; `suppress` on an already-suppressed entry returns `null`; trimmed (expired) entries are unreachable via `suppress`; a `suppress` followed by `reinstate` round-trips correctly (same as a system-flag-then-reinstate cycle today).
- **Unit (`wsServer.test.ts`)**:
  - `admin-remove` on a live (non-suppressed) line → buffer entry's `suppressed` flips to `true`; capture socket gets `transcript` with `flagged: true`, `reason: 'Removed by admin'`, matching `id`; all currently-connected viewers get `line-removed` with matching `id`.
  - `admin-remove` on an already-suppressed (system-flagged or already-admin-removed) line → `admin-remove-error`, no further mutation, no broadcast.
  - `admin-remove` on an unknown/trimmed id → `admin-remove-error`, no buffer mutation, no broadcast.
  - An admin-removed line can subsequently be reinstated through the existing `reinstate` handler with no code changes required to that handler — assert this with an integration-style test that chains `admin-remove` → `reinstate` and checks the final broadcast content.
- **Unit (`useViewerSocket.test.ts` or equivalent)**: `line-removed` for an id already present in `lines` replaces that entry in place (same array index, `removed: true`); `line-removed` for an id not yet present appends, matching current behavior.
- **Manual (browser)**: with a session running and at least one viewer tab connected, let a normal (non-flagged) line broadcast and render on the viewer; on the capture page, hover that line, click Remove, confirm — verify the viewer tab's *existing* row for that line is replaced with "Line removed" (not duplicated), and the capture page row becomes struck through with "Removed by admin" and a Reinstate button; reinstate it with corrected text and confirm the viewer tab's same row updates in place with the correction.

## Known Simplifications

- No standalone "Edit" that corrects text without first removing the line — correcting any line's wording, flagged or not, goes through Remove → Reinstate. This keeps the feature to a single new mechanism (`suppress`) instead of two, at the cost of an extra click and a momentary "Line removed" flash for viewers during a pure typo fix.
- No bulk remove — one line at a time, matching Reinstate's existing one-at-a-time scope.
- Same 10-minute buffer trim window as Reinstate: a line older than that is no longer removable (or reinstatable) through this UI.
- Removal is confirmation-gated by a native `window.confirm()`, consistent with the existing pattern elsewhere on the capture page (not a custom modal).
- No new auth/access control on the capture page — it already has zero protection today (anyone with the URL has full start/stop/reinstate control), so this doesn't change the existing risk profile.

## Future Extensions (explicitly out of scope now)

- A standalone Edit action that corrects a line's text live, without ever showing viewers a "Line removed" state.
- Bulk remove/reinstate of multiple lines at once.
- Any lightweight auth/access gate on the capture page in general.
