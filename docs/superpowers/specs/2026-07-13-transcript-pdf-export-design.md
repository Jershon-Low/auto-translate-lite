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
2. Builds a hidden, styled, off-screen DOM element containing the title, language, export timestamp, and every English/translated line pair.
3. Rasterizes that element with `html2canvas`, using the browser's own font rendering.
4. Slices the resulting canvas into page-sized chunks and embeds each as an image page in a `jsPDF` document.
5. Triggers a direct browser download via `doc.save(filename)`. Filename: `sermon-transcript-<language-code>-<YYYY-MM-DD>.pdf`.

No backend changes. No automated test — this project verifies frontend behavior manually (see Testing below).

## Font Handling (revised)

`jsPDF`'s built-in fonts only cover Latin script, and reliably sourcing embeddable TTF binaries for CJK/Thai/Devanagari/Myanmar carries real risk (format/licensing/packaging uncertainty, especially for Noto CJK). Rather than embedding font files, the export renders the transcript as an **image**: `html2canvas` rasterizes a hidden DOM element using whatever fonts the browser already has loaded to display the on-screen caption view. Since the viewer is already reading the translated text correctly on screen, rasterizing that same rendering guarantees every one of the 12 languages renders correctly in the PDF too, with zero font files to source, license, or embed.

Trade-off: the resulting PDF's text is not selectable/searchable (it's an image), and file size is larger than a text-based PDF. Both are acceptable for this feature's purpose (a portable, readable record of what was said).

## Data Flow

1. User clicks "Download Transcript (PDF)".
2. Handler reads `lines` from the already-connected `useViewerSocket` hook state.
3. Handler creates an off-screen container `<div>` (positioned off-canvas, not visible), populates it with a title, language + timestamp metadata, and one English/translated pair per line, styled to mirror the on-screen caption layout.
4. Handler calls `html2canvas(container, { scale: 2, backgroundColor: '#ffffff' })` to rasterize it into a single tall canvas, then removes the container from the DOM.
5. Handler slices that canvas into page-height chunks (matching the PDF page's aspect ratio) and calls `doc.addImage(...)` once per chunk, calling `doc.addPage()` between chunks.
6. `doc.save(filename)` triggers the download.

## Error Handling

- The button is disabled whenever `lines.length === 0` — no point generating a blank PDF, and it avoids a confusing empty download.
- If rendering fails (e.g. `html2canvas` throws), the handler catches the error, shows a brief inline message (e.g. "Couldn't generate PDF — try again"), and does not crash the page. The off-screen container is removed in a `finally` block so a failed export never leaves stray DOM nodes behind.

## Testing

No automated tests — matches this project's existing frontend approach (manual verification only). Manual verification: click the button after both backlog and live lines have accumulated, confirm the PDF downloads and opens with correct content and ordering across multiple pages if the transcript is long enough, and confirm for at least one non-Latin language (e.g. Korean or Mandarin) that the script renders correctly (since it's rasterized from the same on-screen rendering, this should always hold, but worth confirming once).
