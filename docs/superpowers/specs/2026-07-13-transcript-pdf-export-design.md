# Transcript PDF Export — Design

## Purpose

Let a viewer download the caption transcript they've seen so far as a PDF, directly from the viewer page.

## Scope

- Viewer page only (`web/app/view/page.tsx`), not the capture page.
- Exports whatever is currently held in the browser tab's `lines` state from `useViewerSocket` — the backlog received on connect plus every live caption since. Purely client-side; no new backend endpoint. If the viewer joined mid-sermon, the PDF starts from wherever their backlog began (bounded by the server's 10-minute rolling buffer, per the main design spec).
- Includes both the English original and the translated line for every entry, in the same order shown on screen.

## Architecture

A "Download Transcript (PDF)" button sits in the viewer page's header bar, next to "Change language". Clicking it:

1. Reads the current `lines` array (already in memory — no network call).
2. Dynamically imports the Unicode font(s) needed to render the viewer's target language (see Font Handling below).
3. Assembles a PDF with `jsPDF`: a title, the language name, an export timestamp, then each line as an English/translated pair — grey/smaller English above, larger translated text beneath, mirroring the on-screen caption layout.
4. Triggers a direct browser download via `doc.save(filename)`. Filename: `sermon-transcript-<language-code>-<YYYY-MM-DD>.pdf`.

No backend changes. No automated test — this project verifies frontend behavior manually (see Testing below).

## Font Handling

`jsPDF`'s built-in fonts (Helvetica, Times, Courier) only cover Latin script. Since every exported line always pairs English (Latin) with the viewer's one target language, at most two font files are needed per export:

- **Latin group** (English, Spanish, French, Portuguese, Indonesian, Tagalog, Vietnamese): a single embedded "Noto Sans" font covers all of these, including Vietnamese's diacritics.
- **Script-specific font**, only loaded if the target language isn't in the Latin group:
  - `zh` (Mandarin) → Noto Sans SC
  - `ko` (Korean) → Noto Sans KR
  - `ja` (Japanese) → Noto Sans JP
  - `th` (Thai) → Noto Sans Thai
  - `hi` (Hindi) → Noto Sans Devanagari
  - `my` (Burmese) → Noto Sans Myanmar

Font files are dynamically imported (`import()`) at click-time, not bundled into the page's initial load — a Mandarin viewer never downloads the Thai font, keeping the per-user cost to at most two font files regardless of the 12-language target list.

## Data Flow

1. User clicks "Download Transcript (PDF)".
2. Handler reads `lines` from the already-connected `useViewerSocket` hook state.
3. Handler resolves which font group the current `language` belongs to and dynamically imports the Latin font plus, if needed, the one matching script-specific font.
4. Handler builds the `jsPDF` document, registering the imported font(s) and iterating `lines` to add each English/translated pair.
5. `doc.save(filename)` triggers the download.

## Error Handling

- The button is disabled whenever `lines.length === 0` — no point generating a blank PDF, and it avoids a confusing empty download.
- If the dynamic font import fails (e.g. a network hiccup), the handler catches the error, shows a brief inline message (e.g. "Couldn't generate PDF — try again"), and does not crash the page.

## Testing

No automated tests — matches this project's existing frontend approach (manual verification only). Manual verification: click the button after both backlog and live lines have accumulated, confirm the PDF downloads and opens with correct content and ordering, and confirm for at least one non-Latin language (e.g. Korean or Mandarin) that the embedded font renders the actual script rather than blank boxes.
