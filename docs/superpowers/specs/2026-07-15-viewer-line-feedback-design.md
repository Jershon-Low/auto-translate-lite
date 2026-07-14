# Viewer Per-Line Feedback — Design

## Purpose

Viewers on the `/view` page currently have no way to flag a specific caption line whose translation seems wrong, confusing, or otherwise off. The only existing "feedback" concept in this codebase (`feedbackStore.ts`, the `/feedback` GET/PUT endpoints, and the "Feedback notes" textarea on the capture page) is unrelated: it's operator-authored notes fed into the AI as translation context, not something viewers submit.

This design adds a way for viewers to flag an individual caption line with an optional comment, and for the person operating the capture page to skim, and download, what's been flagged — as a separate mechanism from the existing operator notes file.

## Scope

- A flag affordance on every non-removed caption line on `/view`, opening a small inline optional-comment box.
- Server-side storage of each flagged-line submission, tagged with session, timestamp, language, and a snapshot of the line's text — separate from `feedback.txt`.
- A "Viewer Feedback" list on the capture page: per-item download (marks that item downloaded) and a "download all undownloaded" bulk action, each producing a CSV.
- A downloaded/not-downloaded indicator per item, so the operator can see at a glance what's new.
- Static, hand-authored translation of the small set of feedback-UI strings (flag prompt, submit/cancel, confirmation) into the same 12 language codes `TARGET_LANGUAGES` already supports, so the flagging UI itself matches the viewer's chosen caption language.
- Explicitly out of scope: a general (non-line-scoped) feedback form; viewer identity/accounts; category/severity tagging; auto-pruning old feedback; localizing the rest of the `/view` page chrome (status line, "Download Transcript (PDF)", "Change language").

## Design

### 1. Storage: `ViewerFeedbackStore`

New `server/src/viewerFeedbackStore.ts`, following the same file-backed, explicit-interface shape as `costTracker.ts` (persisted JSON, survives restarts — necessary here since feedback must remain downloadable across server restarts even though session state itself is in-memory-only):

```ts
interface ViewerFeedbackItem {
  id: string;          // uuid
  sessionId: string;
  timestamp: string;   // ISO 8601
  language: string;    // viewer's target language code
  lineIndex: number;   // position in the viewer's lines array
  english: string;     // snapshot at submission time
  translated: string;  // snapshot at submission time
  comment: string;     // may be empty
  downloaded: boolean;
}

interface ViewerFeedbackStore {
  add(entry: Omit<ViewerFeedbackItem, 'id' | 'timestamp' | 'downloaded'>): ViewerFeedbackItem;
  list(): ViewerFeedbackItem[]; // newest first
  markDownloaded(ids: string[]): void;
  getUndownloaded(): ViewerFeedbackItem[];
  get(id: string): ViewerFeedbackItem | undefined;
}
```

- Backed by `server/data/viewer-feedback.json` (array of `ViewerFeedbackItem`), path configurable via `VIEWER_FEEDBACK_FILE_PATH` env var (default `data/viewer-feedback.json`), following the same convention as `FEEDBACK_FILE_PATH`/`COST_FILE_PATH` in `index.ts`.
- Loads on startup (missing file → empty array, same missing-file-means-empty precedent as `feedbackStore.read()`). Persists to disk after every `add`/`markDownloaded`.
- Storing a text **snapshot** (not just `lineIndex`) means a downloaded CSV is self-contained and skimmable without needing the original session's live buffer state, which may no longer exist by the time someone reads the file.

### 2. API endpoints

New routes in `app.ts`, distinct from the existing `/feedback`:

- `POST /viewer-feedback` — body `{ language, lineIndex, english, translated, comment }`. Server stamps `id` (uuid), `sessionId` (current `Session.id`), `timestamp`, `downloaded: false`. Responds `{ ok: true }`.
- `GET /viewer-feedback` — returns `{ items: ViewerFeedbackItem[] }`, newest first, for the capture-page list.
- `POST /viewer-feedback/:id/download` — looks up the item, marks it downloaded, responds with a one-row CSV (`Content-Type: text/csv`, `Content-Disposition: attachment; filename="feedback-<id>.csv"`). 404 if the id doesn't exist.
- `POST /viewer-feedback/download-all` — takes the current `getUndownloaded()` snapshot, marks all of them downloaded, responds with a CSV of those rows (`filename="feedback-all-<timestamp>.csv"`). Empty undownloaded set → CSV with header row only.

CSV columns (both endpoints): `Timestamp, Language, English, Translated, Comment, Session ID`. POST (not GET) is used for both download endpoints since they have a side effect (marking downloaded) — matches this codebase's existing convention of using `PUT`/`POST` for anything that mutates state (`PUT /feedback`, `POST /sermon-doc`).

### 3. Viewer UI (`/view` page)

For each rendered line where `!line.removed`, a flag icon sits at the end of the line block, always visible (not hover-only, for discoverability).

- **Click** → icon is replaced inline by a compact form: a small textarea (placeholder from the localized string table, e.g. "Optional: what's wrong with this line?") + Submit + Cancel buttons.
- **Submit** → `POST /viewer-feedback` with `{ language, lineIndex, english: line.english, translated: line.translated, comment }`. `lineIndex` is the line's index in the local `lines` array — consistent across viewers because backlog-on-join plus appended `caption`/`line-removed` messages arrive in the same order for every viewer subscribed to a language.
- **Success** → line shows a brief localized confirmation ("Thanks, flagged") for ~2s, then settles into a dimmed/filled flag icon indicating "already flagged" — but remains clickable, since there's no dedup requirement; a viewer can flag the same line again (e.g. to add a second comment).
- **Failure** → inline localized error text under the box; the form stays open so the viewer can retry. Mirrors the existing `exportError`/`feedbackError` inline-error pattern already used on this page and on the capture page.
- Blank comment is a valid submission (a bare flag with no explanation is still useful signal).

### 4. UI string localization

New `web/lib/feedbackStrings.ts`:

```ts
interface FeedbackStrings {
  flagPlaceholder: string;
  submit: string;
  cancel: string;
  thanksConfirmation: string;
  submitError: string;
}

const FEEDBACK_STRINGS: Record<string, FeedbackStrings> = {
  zh: { ... }, id: { ... }, tl: { ... }, ko: { ... }, ja: { ... },
  vi: { ... }, th: { ... }, es: { ... }, pt: { ... }, fr: { ... },
  hi: { ... }, my: { ... },
};

const EN_FALLBACK: FeedbackStrings = { ... };

export function getFeedbackStrings(languageCode: string): FeedbackStrings {
  return FEEDBACK_STRINGS[languageCode] ?? EN_FALLBACK;
}
```

Translations for all 12 codes are hand-authored during implementation (not machine-translated at request time — this is a small, static, rarely-changing string set, so a maintained lookup table is simpler and cheaper than a runtime translation call). These are AI-drafted translations, not reviewed by native speakers of each language — worth a quick review pass by someone fluent before relying on them in a live service, same caveat that would apply to any hand-authored static translation.

### 5. Capture-page (admin) UI

A new "Viewer Feedback" section added to `capture/page.tsx`, below the existing "Feedback notes" block:

- Fetches `GET /viewer-feedback` on mount (and after any download action) into local state.
- **Header row**: "Viewer Feedback" heading + an undownloaded count badge (e.g. "3 new") + a **"Download all undownloaded"** button, disabled when the count is 0.
- **Empty state**: "No feedback yet" when the list is empty, download controls hidden.
- **List**, newest first, each row showing: timestamp, language, the english/translated snapshot, the comment (if present), a downloaded/not-downloaded visual indicator (e.g. a filled vs. hollow dot), and a per-row **"Download"** button.
- Clicking a download button (per-row or "download all") triggers the corresponding `POST`, then downloads the returned CSV via a Blob + temporary `<a download>` (same general client-side-download technique already used by `exportTranscriptPdf`, adapted for a server-returned blob instead of a client-generated one), then re-fetches the list so indicators update.

## Error Handling

- **`POST /viewer-feedback` with a malformed body** (missing `language`/`english`/`translated`) → `400` with an error message; client shows the inline retry error.
- **`viewer-feedback.json` unreadable/corrupt at startup** → treat as empty list and continue, logging a warning (same "never block the app over an optional feature" precedent as `feedbackStore`/`costTracker`).
- **`viewer-feedback.json` write fails** (disk full, permissions) → log a warning; the in-memory list still reflects the new item for the running process, but it won't survive a restart until writes succeed again. Doesn't block or throw into the request path.
- **Download of a nonexistent id** (stale client list) → `404`; client shows an inline error and re-fetches the list to reconcile.
- **Concurrent "download all"** (two admin tabs/operators): each request computes undownloaded-at-that-moment and marks them atomically before responding, so a second concurrent request naturally gets whatever remains (typically empty) rather than duplicating rows — acceptable given this app's single-operator-in-practice usage.

## Testing

- **Unit**: `viewerFeedbackStore.ts` — `add` assigns id/timestamp/downloaded defaults; `list` returns newest-first; `markDownloaded` flips the right items; `getUndownloaded` excludes already-downloaded items; missing/corrupt `viewer-feedback.json` on load falls back to an empty list rather than throwing.
- **Unit**: `app.ts` — `POST /viewer-feedback` persists an item and stamps the current session id; `GET /viewer-feedback` returns items newest-first; `POST /viewer-feedback/:id/download` returns a correct one-row CSV and flips `downloaded`; a second call with the same id still succeeds (the item still exists, just already marked downloaded) and returns the same row again; `POST /viewer-feedback/:id/download` with an unknown id returns 404; `POST /viewer-feedback/download-all` returns only previously-undownloaded rows and marks them all downloaded; a second call to `download-all` returns a header-only CSV.
- **Unit**: `getFeedbackStrings` — known codes return their table entry; unknown codes fall back to English.
- **Manual** (browser): flag a line as a viewer with a comment, confirm it appears in the capture page's Viewer Feedback list with the right snapshot text; download it individually and confirm the indicator flips and the CSV content is correct; flag a second line, use "download all undownloaded", confirm only the new one is included and the count badge returns to 0.

## Known Simplifications

- No dedup — a viewer can flag the same line multiple times; each submission is a separate row.
- No viewer identity — feedback is anonymous, consistent with the rest of the app having no accounts.
- No auto-pruning of `viewer-feedback.json` — it grows indefinitely. Acceptable at this app's scale (low feedback volume); revisit if it ever becomes unwieldy.
- Feedback UI translations are hand-authored/AI-drafted, not verified by native speakers.
- `lineIndex` correctness depends on all viewers of a language receiving messages in the same order, which holds today (single active session, in-order WebSocket delivery) but would need revisiting if the "multiple concurrent sessions" future extension (noted in the original app design) is ever built.

## Future Extensions (explicitly out of scope now)

- A general (not line-scoped) feedback form/channel.
- Category or severity tagging on feedback items.
- Marking feedback as "resolved"/"actioned" beyond just "downloaded".
- Localizing the rest of the `/view` page chrome to match the viewer's language.
- Native-speaker review pass over the static translation table.
