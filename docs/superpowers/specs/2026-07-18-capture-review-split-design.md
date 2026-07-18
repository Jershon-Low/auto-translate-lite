# Capture / Review Split

## Problem

`web/app/capture/page.tsx` currently bundles two very different jobs onto one page, tied to one browser tab on one computer: (1) running the microphone (Start/Stop, audio streaming to Deepgram) and (2) reviewing/checking output (approve/reject the manual-mode queue, reinstate/remove flagged lines, feedback notes, viewer feedback, cost, sermon-doc upload). The reviewing half has nothing to do with owning a microphone, but it's stuck on the capture computer because its commands (`reinstate`, `admin-remove`, `set-mode`) ride over the same `/ws/capture` WebSocket that streams audio — and `Session` only tracks a single implicit "capture" connection, not a set of reviewer connections. The goal is to let one computer run capture while transcription checking, viewer feedback, and feedback notes happen concurrently from one or more other computers/people.

## Goals

- Split into two pages: `/capture` (mic operator, unchanged audio pipeline) and a new `/review` (checking/notes/feedback), reachable independently and usable from different computers at the same time.
- Support multiple concurrent `/review` connections (e.g. two people reviewing different lines) without stepping on each other.
- A `/review` tab that connects mid-session (or reconnects after a refresh) sees the current pending queue, transcript, mode, and status — not a blank slate.
- Passcode-gate both `/capture` and `/review` with the same shared passcode already used by `/admin`, and share the "already unlocked" state across all three pages.
- No change to the underlying capture/translation/verification pipeline, Deepgram integration, or viewer-facing behavior.

## Non-goals

- No changes to the viewer page (`/view`) or `/ws/viewer` protocol.
- No per-user identity/attribution for reviewers (who approved which line) — concurrent reviewers are anonymous and equal, same as today's single implicit reviewer.
- No new persistence beyond the two new `CaptionLine` fields described below — no reviewer accounts, no audit log.
- No change to admin page behavior beyond reusing its passcode-storage key.

## Design

### Server: `Session` and transcript metadata

- `server/src/types.ts`: `CaptionLine` gains `pending?: boolean` and `reason?: string`. Today these exist only as fields bolted onto the one-off outgoing WS message in `handleFinalSegmentFast`/`handleAdminRemove`; they're not stored on the line itself, so nothing joining after the fact can tell *why* a line is suppressed. Storing them makes the line's suppressed state fully reconstructable.
  - `TranscriptBuffer.append` accepts and stores `pending`/`reason` alongside `suppressed`.
  - `TranscriptBuffer.reinstate` clears `pending`/`reason` when un-suppressing.
  - `TranscriptBuffer.suppress` (admin-remove path) sets `reason: 'Removed by admin'`.
- `server/src/session.ts`: `Session` gains `reviewSockets: Set<WebSocket>` with `addReview(socket)`, `removeReview(socket)`, `getAllReview(): WebSocket[]`, and a `broadcastToReview(payload: string)` helper that sends to every socket in the set (skipping any not `OPEN`). Mirrors the existing `viewers` map pattern.

### Server: `/ws/review` endpoint

- `server/src/wsServer.ts`: the `upgrade` handler adds `/ws/review` alongside `/ws/capture` and `/ws/viewer`.
- New `handleReviewConnection(ws, deps)`:
  - On connect: sends `{ type: 'backlog', lines, mode, status }` where `lines` is `deps.session.buffer.getRecent()` mapped to `{ id, english, flagged: suppressed, reason, pending }` (parallel to the shape reviewers already get via live `transcript` messages), `mode` is `deps.session.mode`, and `status` is derived from `deps.session.isActive` (`'recording'` or `'idle'`; `'error'`/`'reconnecting'` remain transient client-side-only states as today).
  - Registers the socket via `deps.session.addReview(ws)`; deregisters on `close` via `removeReview`.
  - Handles incoming `reinstate` → `handleReinstateFast`, `admin-remove` → `handleAdminRemove`, `set-mode` → sets `deps.session.mode` **and** broadcasts `{ type: 'mode', mode }` to `getAllReview()` so every open review tab stays in sync (today this is implicit/local since there's only ever one reviewing client).
  - `reinstate-error`/`admin-remove-error` responses go back to the sending socket only (same as today), not broadcast — they're specific to the action that failed.

### Server: capture handler simplification

- `handleCaptureConnection` in `wsServer.ts` drops the `reinstate`/`admin-remove`/`set-mode` branches — those messages are no longer sent by the capture client. `start`/`stop`/audio-binary handling is unchanged.
- `finishPublishing`/`handleFinalSegmentFast`/`handleAdminRemove`/`handleReinstateFast` currently take a single `captureSocket: WebSocket` parameter to send status-of-this-line updates to. This becomes: send the update to the capture socket **and** broadcast it to all review sockets via `deps.session.broadcastToReview`. (`captureSocket` stays a parameter since the capture page still renders a live read-only transcript feed and needs its own copy of these updates.)
- The `costTracker.onUpdate` subscription (currently registered in the capture `'start'` handler, writing only to the capture `ws`) now also broadcasts to `deps.session.getAllReview()` on every update, since cost display lives on the review page. The subscription's lifecycle (start/stop-bound) is unchanged.
- `status` broadcasts (`recording`/`idle`/`error` on start/stop/Deepgram error) go to both the capture socket and all review sockets.

### Passcode gating

- `server/src/app.ts`: the `/feedback` (GET/PUT), `/viewer-feedback` (GET), `/viewer-feedback/:id/download` (POST), `/viewer-feedback/download-all` (POST), and `/sermon-doc` (POST) routes get the existing `adminAuth` middleware applied — they're only ever called from `/review` now (feedback/viewer-feedback/sermon-doc all moved off `/capture`).
- The `upgrade` handler in `wsServer.ts` validates a `passcode` query param (`?passcode=...`) for both `/ws/capture` and `/ws/review` against `deps.adminPasscode` before completing the handshake; on missing/mismatched passcode it calls `socket.destroy()` (same as the existing unknown-pathname branch), never emitting `'connection'`. Browsers can't attach custom headers to a WebSocket handshake, so the passcode travels as a query param instead of the `x-admin-passcode` header used by REST.
- `web/app/capture/page.tsx` and the new `web/app/review/page.tsx` both get the same passcode-gate card UI already used by `web/app/admin/page.tsx` (lock icon, `Input`, `Alert` on wrong passcode), reading/writing the *same* `sessionStorage` key (`adminPasscode`) the admin page already uses — entering the passcode on any one of the three pages unlocks all three for that browser tab's session storage scope.
- Once unlocked, the capture/review pages open their WebSocket as `${WS_URL}/ws/capture?passcode=${encodeURIComponent(stored)}` / `.../ws/review?passcode=...`.

### Capture page (`app/capture/page.tsx`)

Reduced to: passcode gate → Start/Stop buttons, status `Badge`, and the existing live read-only transcript feed (flagged lines still shown struck-through, same as today, but without Remove/Reinstate controls — those actions now live only on `/review`). Cost line, sermon-doc upload, mode toggle, pending-queue, keyboard shortcuts, feedback notes, and viewer feedback are removed from this page entirely (moved to `/review`).

### Review page (`app/review/page.tsx`, new)

Passcode gate, then the `Tabs` layout the capture page uses today, connected to `/ws/review` instead of `/ws/capture`:

- **Live** tab: mode `ToggleGroup`, pending-approval queue (approve/reject/edit, keyboard shortcuts, shortcut-rebinding popover — all unchanged from today's capture page, just fed by `/ws/review`), full transcript with remove/reinstate, cost line, sermon-doc upload control, status `Badge`. On connect, seeds its state from the `backlog` message (lines/mode/status) instead of starting empty.
- **Feedback notes** tab: unchanged, still plain REST against `/feedback` (now passcode-protected).
- **Viewer feedback** tab: unchanged, still plain REST against `/viewer-feedback*` (now passcode-protected).
- `mode` messages from the server update local mode state (so a second open review tab reflects a mode change made elsewhere); `status`/`cost`/`transcript` messages update the same way the capture page's did.

## Testing

Server (extends existing suites, no new test files needed beyond what's listed):

- `wsServer.test.ts`: `/ws/review` backlog snapshot shape (includes pending/reason for suppressed lines); reinstate/admin-remove/set-mode accepted from a review socket and rejected from a capture socket; `transcript`/`status`/`cost` broadcast to both a capture socket and multiple review sockets; a `set-mode` from one review socket produces a `mode` broadcast seen by a second review socket; missing/wrong `passcode` query param on `/ws/capture` and `/ws/review` closes the connection without emitting `'connection'`.
- `session.test.ts`: `addReview`/`removeReview`/`getAllReview`/`broadcastToReview`.
- `transcriptBuffer.test.ts`: `append` stores `pending`/`reason`; `reinstate` clears them; `suppress` sets the admin-remove reason.
- `app.test.ts`: the newly-gated REST routes return 401 without `x-admin-passcode` and succeed with it.

Manual (this is also a structural/UI change, so verify like the earlier web-UX-redesign work):

- Two browser windows both on `/review`, both authorized: approving a line in one makes it disappear from the pending queue in the other; approving the same line in both windows in quick succession shows a graceful error in the loser.
- Refresh `/review` mid-session: pending queue, transcript, current mode, and status all reappear (not blank).
- `/capture` shows only Start/Stop, status, and read-only transcript — no cost, sermon-doc, mode toggle, or approve/reject controls.
- Entering the passcode on `/admin` also unlocks `/capture` and `/review` without re-entering (same browser, same session).
- Sermon-doc upload and feedback notes save/load correctly from `/review`; viewer feedback list/download still works.
- Existing `server` test suite (`cd server && npm test`) passes.
