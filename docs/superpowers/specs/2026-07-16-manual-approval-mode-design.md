# Manual Approval Mode — Design

## Purpose

Today the capture page has one control mode: every finalized transcription line flows straight to translation and viewers, except lines the automatic safety check ([`transcriptionVerifier.ts`](../../../server/src/transcriptionVerifier.ts)) flags as unsafe. This is "Automatic" mode.

This design adds a second mode, **Manual**, in which the AV operator must explicitly approve every finalized line — optionally editing it first — before it reaches translation and viewers. The operator can switch between Automatic and Manual at any time, including mid-session, from the same capture page they already use for Start/Stop/Remove/Reinstate.

## Scope

- A mode toggle (Automatic / Manual) on the capture page, changeable before Start or live during a recording session.
- In Manual mode, every finalized line is suppressed by default and requires operator action (Approve, Edit-then-approve, or Reject) before it can reach viewers.
- The automatic safety check still runs on every line in both modes. In Automatic mode it behaves as it does today (suppresses unsafe lines). In Manual mode it can't suppress anything further (everything's already suppressed) — its flag/reason is instead surfaced to the operator as a prioritization hint.
- A "pending approval" queue view on the capture page, filtered from the existing full transcript feed, so the operator works a focused list instead of scrolling.
- Approve and Edit reuse the existing Reinstate mechanism unchanged in shape (`{ type: 'reinstate', id, english }`). Reject is a client-side-only dismissal from the pending queue — the line stays suppressed and remains reinstatable later, same as an AI-flagged line the operator never acted on.
- Switching Manual → Automatic mid-session does **not** auto-approve whatever is still queued; those lines stay suppressed until explicitly Approved/Edited/Rejected.
- Translation results computed at transcription time (already computed in parallel with the safety check, for every line, regardless of suppression) are cached on the buffer entry and reused on approval when possible, instead of always re-translating from scratch.
- The existing Remove action (any line, any time, from [admin-remove-any-line](2026-07-15-admin-remove-any-line-design.md)) already works unchanged on lines approved through this feature, since an approved line becomes an ordinary unsuppressed buffer entry indistinguishable from an automatic-mode line.
- A configurable two-key keyboard shortcut for rapid Approve/Reject on the oldest pending line.
- Explicitly out of scope: a separate operator role/page; server-side audit logging of Rejects; any change to the automatic safety check's own decision logic; keyboard shortcuts for Edit; modifier-key (Ctrl/Alt/Shift) shortcut combinations.

## Design

### 1. Mode field

`Session` gains `mode: 'automatic' | 'manual'`, default `'automatic'`. New capture-socket message `{ type: 'set-mode', mode }` updates it — valid whether the session is idle, not yet started, or actively recording. There is no persistence beyond the session; a fresh session starts in Automatic mode.

### 2. Append-time suppression (`handleFinalSegment`, `server/src/wsServer.ts`)

The existing parallel step is unchanged:

```
compute precedingContext from buffer (before appending)
run in parallel:
  - verifyTranscriptionWithRetry(english, precedingContext, sermonCache)   [always runs]
  - translateSegment(...) + verifyTranslationsWithRetry(...)               [only if activeLanguages.length > 0]
await both
```

What changes is what happens with the results:

```
suppressed = (session.mode === 'manual') || (transcription check unsafe)

reason =
  if session.mode === 'manual' and transcription check unsafe:
    'Pending manual approval — AI also flagged: <reason>'
  elif session.mode === 'manual':
    'Pending manual approval'
  elif transcription check unsafe:
    '<AI reason>'   // unchanged from today
  else:
    n/a (not suppressed)

line = buffer.append(english, suppressed, timestampMs)
line.translationCache = { languages, translations, verified }   // from the parallel translate/verify step above,
                                                                  // stored regardless of suppressed — today this
                                                                  // work is computed and thrown away for
                                                                  // suppressed lines; now it's kept.

send { type: 'transcript', id: line.id, english, flagged: suppressed, reason } to capture socket
if suppressed:
  broadcast { type: 'line-removed', id: line.id } to all current viewers
  return
// unsuppressed path — unchanged from today
broadcast per language from translationCache
```

`CaptionLine` (`server/src/types.ts`) gains an optional field:

```ts
translationCache?: {
  languages: string[];
  translations: Record<string, string>;
  safe: Record<string, boolean>;
};
```

### 3. Reinstate, extended to consume the cache (`server/src/transcriptBuffer.ts` / `handleReinstate` in `wsServer.ts`)

This path is shared by both Manual-mode Approve/Edit and today's AI-flag Reinstate — one mechanism, no branching by *why* the line was suppressed.

```
entry = buffer lookup by id
activeLanguages = session.getActiveLanguages()   // may differ from append time

if english === entry.english (unedited — an "Approve"):
  cachedLangs = entry.translationCache.languages ∩ activeLanguages
  newLangs = activeLanguages - cachedLangs
  results = { ...pick from entry.translationCache for cachedLangs,
              ...translateWithFallback + verify for newLangs only }
else (edited text — an "Edit"):
  results = translateWithFallback + verify for all activeLanguages   // cache invalidated, unchanged from today

line = buffer.reinstate(id, english)   // mutates in place: english updated, suppressed = false
send { type: 'transcript', id: line.id, english: line.english, flagged: false } to capture socket
broadcast { type: 'caption-inserted', id: line.id, english: line.english, translated } per language in results
```

The common case — Approve on unedited text with no new viewers since transcription — needs no Gemini call at all and broadcasts immediately. Edited text always pays full translation latency, since the cached translation is for different words. A newly-active language (viewer joined between transcription and approval) is translated fresh for just that delta, not the whole set.

### 4. Reject (client-side only, `web/app/capture/page.tsx`)

No new server message. Reject sets a local `dismissed: true` flag on that row's client-side state. This:
- Removes the row from the "pending approval" queue view.
- Leaves the row visible, struck through, in the full transcript feed — unchanged from how an AI-flagged line displays today.
- Leaves it reinstatable at any time by scrolling to it in the full feed and using the existing Reinstate control there.

`dismissed` resets implicitly on every `start()`, since `transcriptLines` is already cleared there.

### 5. Capture Page UI

- **Mode toggle**: near Start/Stop, always interactive. Shows current mode and a pending count in Manual mode, e.g. "Manual mode — 3 pending".
- **Pending approval queue**: a panel showing `transcriptLines` filtered to `suppressed && !dismissed`, in chronological order. Each row shows the English text, an AI-flag badge if the safety check also caught it, and three actions:
  - **Approve** → `{ type: 'reinstate', id, english: originalText }`.
  - **Edit** → opens the existing inline edit box (pre-filled, editable) → **Send** does `{ type: 'reinstate', id, english: editedText.trim() }`. Identical component to today's Reinstate edit flow.
  - **Reject** → sets `dismissed: true` locally, no server round-trip.
- The full transcript feed (unchanged) continues to show every line, including pending/dismissed/approved ones, struck through while suppressed.
- **Remove** (existing, unchanged): still available by hover on any row, including ones just approved through this flow — no new code needed, since an approved line is an ordinary unsuppressed buffer entry.

### 6. Keyboard shortcuts

- Two configurable single-key bindings: default **Enter** = Approve, **Space** = Reject.
- Always act on the **oldest item** in the pending queue (FIFO — first spoken, first reviewed). That row gets a visible highlight and an inline hint ("Enter to approve · Space to reject"). Empty queue → no-op.
- A "Keyboard shortcuts" control near the mode toggle lets the operator rebind either key: click a field, press the desired key, it's captured via `keydown` (`event.key`, normalized for display, e.g. `' '` → "Space") and saved to `localStorage` (same persistence pattern as the existing viewer language preference), so it carries across sessions.
- Rebinding a key already assigned to the other action is rejected inline: "Approve and Reject can't share a key."
- The global `keydown` listener ignores events while focus is inside any text input/textarea/contenteditable — so typing (e.g. a space) into the Edit box is never hijacked as Reject.
- Edit is not bound to a shortcut — mouse/click only, since it's the deliberate slower path.
- No modifier-key (Ctrl/Alt/Shift) combinations in this version — single keys only.

## Error Handling

- **Buffer-trimmed line** (older than the 10-minute `BUFFER_WINDOW_MS`): `reinstate()` returns `null` → existing `reinstate-error` path, unchanged.
- **Double-approve** (rapid double-click or shortcut spam): existing `suppressed === true` re-check inside `reinstate()` before mutating already prevents this; a second attempt gets `reinstate-error`.
- **Mode flips mid-flight**: a segment's `handleFinalSegment` call reads `session.mode` once, synchronously, at the point suppression is decided — no race, no partial state.
- **Session stopped/restarted with lines still pending**: identical to today — `start()`/`stop()` clear `transcriptLines` client-side and `buffer.clear()` server-side; nothing extra to reconcile.
- **Cached translation for a language that's gone inactive by approval time**: simply not read (excluded from `activeLanguages` at reinstate time); no cleanup needed, it ages out with the rest of the buffer window.

## Testing

- **Unit (`wsServer.test.ts`)**: Manual mode suppresses every line regardless of the safety check's result; reason string differs correctly for pending-only vs. pending-and-AI-flagged; `set-mode` mid-session only affects lines appended afterward, not ones already in the buffer.
- **Unit (`transcriptBuffer.test.ts`)**: `append` stores `translationCache`; `reinstate` with unedited text reuses cached entries for languages present in both cache and current active set, and only fresh-translates languages newly active since append; `reinstate` with edited text ignores the cache and translates all active languages, matching today's behavior.
- **Unit (capture-page component)**: pending queue is a correctly-filtered, chronologically-ordered subset of the full feed; Reject sets local `dismissed` without a server round-trip and the row remains reinstatable from the full feed; keyboard shortcut acts only on the oldest pending row and is a no-op on an empty queue; shortcut keydown is ignored while a text field has focus; rebinding to a duplicate key is rejected with an inline message and the previous binding is retained.
- **Manual (browser)**: run a live session in Manual mode, confirm nothing reaches a viewer tab until Approve; confirm an unedited Approve renders near-instantly on the viewer (cache hit) versus a noticeably slower Edit-then-approve (fresh translation); confirm Reject removes a row from the pending queue but it remains struck-through and reinstatable in the full feed; confirm Manual → Automatic mid-session leaves existing pending rows queued while newly spoken lines flow straight through; confirm the default Enter/Space shortcuts work end-to-end, then rebind both and confirm the new keys work and the old ones no longer do; confirm Remove still works on a line that was just Approved.

## Known Simplifications

- No server-side audit log entry for Rejects — a rejected line is distinguishable from an ignored one only by client-side `dismissed` state, which doesn't survive a page refresh.
- No modifier-key shortcut combinations — single keys only.
- Edit has no shortcut — click/button only.
- The original 5-second live-caption latency budget does not hold in Manual mode by definition; this is an intentional tradeoff of the feature, not a regression.
- A busy speaker in Manual mode can produce a fast-growing pending queue faster than one operator can process it, even with keyboard shortcuts — no batching/bulk-approve is built here.

## Future Extensions (explicitly out of scope now)

- Bulk approve/reject of multiple queued lines at once.
- Server-side logging of Reject actions for post-service review.
- A separate operator role/page, decoupled from the capture page, for manual approval specifically.
- Modifier-key or multi-key-combo shortcut support.
