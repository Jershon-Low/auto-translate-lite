# Transcript PDF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Download Transcript (PDF)" button to the viewer page that exports the currently-loaded caption lines (English + translated pairs) as a downloadable PDF.

**Architecture:** A new `web/lib/exportTranscriptPdf.ts` module renders the transcript into a hidden off-screen DOM element, rasterizes it with `html2canvas` (reusing the browser's own font rendering — no font files to embed), slices the result into page-sized image chunks, and assembles them into a PDF with `jsPDF`. The viewer page wires a button to this function.

**Tech Stack:** `jspdf`, `html2canvas` (new client-side dependencies for `web/`). No backend changes.

## Global Constraints

- Client-side only — no new backend endpoint, no changes to `server/`.
- Exports exactly the `lines` currently held in `useViewerSocket`'s state (`CaptionLine[]` from `web/lib/useViewerSocket.ts`) — no fetching additional history from the server.
- PDF renders as images (via `html2canvas`), not embedded text/fonts — this is a deliberate choice to guarantee correct rendering of all 12 target languages without sourcing font binaries.
- No automated tests — this project verifies frontend behavior manually (matches Tasks 8-11 of the main implementation plan).
- Filename format: `sermon-transcript-<language-code>-<YYYY-MM-DD>.pdf`.

---

### Task 1: PDF export module

**Files:**
- Modify: `web/package.json` (add `jspdf`, `html2canvas` dependencies)
- Create: `web/lib/exportTranscriptPdf.ts`

**Interfaces:**
- Consumes: `CaptionLine { english: string; translated: string }` from `web/lib/useViewerSocket.ts` (already exists).
- Produces: `exportTranscriptPdf(lines: CaptionLine[], languageCode: string, languageLabel: string): Promise<void>` — builds and downloads the PDF; throws on failure so the caller can catch and show an error. Used by `web/app/view/page.tsx` (Task 2).

- [ ] **Step 1: Install dependencies**

Run: `cd web && npm install jspdf html2canvas`
Expected: `web/package.json`'s `dependencies` gains `jspdf` and `html2canvas` entries; install completes with no errors.

- [ ] **Step 2: Implement the export module**

`web/lib/exportTranscriptPdf.ts`:
```typescript
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import type { CaptionLine } from './useViewerSocket';

function buildTranscriptElement(
  lines: CaptionLine[],
  languageLabel: string
): HTMLDivElement {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '0';
  container.style.width = '800px';
  container.style.padding = '32px';
  container.style.backgroundColor = '#ffffff';
  container.style.color = '#000000';
  container.style.fontFamily = 'sans-serif';

  const title = document.createElement('h1');
  title.textContent = 'Sermon Transcript';
  title.style.fontSize = '24px';
  title.style.margin = '0 0 4px 0';
  container.appendChild(title);

  const meta = document.createElement('p');
  meta.textContent = `Language: ${languageLabel} — Exported: ${new Date().toLocaleString()}`;
  meta.style.fontSize = '12px';
  meta.style.color = '#555555';
  meta.style.margin = '0 0 24px 0';
  container.appendChild(meta);

  for (const line of lines) {
    const englishEl = document.createElement('p');
    englishEl.textContent = line.english;
    englishEl.style.fontSize = '12px';
    englishEl.style.color = '#777777';
    englishEl.style.margin = '0';
    container.appendChild(englishEl);

    const translatedEl = document.createElement('p');
    translatedEl.textContent = line.translated;
    translatedEl.style.fontSize = '16px';
    translatedEl.style.color = '#000000';
    translatedEl.style.margin = '0 0 16px 0';
    container.appendChild(translatedEl);
  }

  return container;
}

export async function exportTranscriptPdf(
  lines: CaptionLine[],
  languageCode: string,
  languageLabel: string
): Promise<void> {
  const container = buildTranscriptElement(lines, languageLabel);
  document.body.appendChild(container);

  try {
    const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff' });

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    const scaleFactor = pageWidth / canvas.width;
    const pageHeightInCanvasPx = pageHeight / scaleFactor;

    let renderedHeight = 0;
    let firstPage = true;

    while (renderedHeight < canvas.height) {
      const sliceHeight = Math.min(pageHeightInCanvasPx, canvas.height - renderedHeight);

      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = sliceHeight;
      const ctx = pageCanvas.getContext('2d');
      if (!ctx) throw new Error('Could not create canvas context for PDF page slicing');
      ctx.drawImage(
        canvas,
        0, renderedHeight, canvas.width, sliceHeight,
        0, 0, canvas.width, sliceHeight
      );

      const imageData = pageCanvas.toDataURL('image/png');

      if (!firstPage) doc.addPage();
      doc.addImage(imageData, 'PNG', 0, 0, pageWidth, sliceHeight * scaleFactor);

      renderedHeight += sliceHeight;
      firstPage = false;
    }

    const dateStamp = new Date().toISOString().slice(0, 10);
    doc.save(`sermon-transcript-${languageCode}-${dateStamp}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. If `html2canvas` reports missing type declarations, run `cd web && npm install --save-dev @types/html2canvas` and re-run the type check.

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/package-lock.json web/lib/exportTranscriptPdf.ts
git commit -m "feat(web): add transcript PDF export module"
```

---

### Task 2: Wire the download button into the viewer page

**Files:**
- Modify: `web/app/view/page.tsx`

**Interfaces:**
- Consumes: `exportTranscriptPdf(lines, languageCode, languageLabel)` from Task 1; `lines` and `language` already available in `ViewerPageContent` from `useViewerSocket` (Task 10 of the main plan) and `useSearchParams` respectively; `TARGET_LANGUAGES` from `web/lib/languages.ts` (to resolve the human-readable language label for the given code).

- [ ] **Step 1: Add the button, loading/error state, and handler**

In `web/app/view/page.tsx`, add the import and resolve the language label, then add state and a handler inside `ViewerPageContent`:

```tsx
import { exportTranscriptPdf } from '@/lib/exportTranscriptPdf';
import { TARGET_LANGUAGES } from '@/lib/languages';
```

Add inside `ViewerPageContent`, alongside the other `useState` calls:
```tsx
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
```

Add this handler function inside `ViewerPageContent`, before the `return`:
```tsx
  async function handleExportPdf() {
    setExportError(null);
    setIsExporting(true);
    try {
      const languageLabel =
        TARGET_LANGUAGES.find((entry) => entry.code === language)?.label ?? language;
      await exportTranscriptPdf(lines, language, languageLabel);
    } catch {
      setExportError("Couldn't generate PDF — try again");
    } finally {
      setIsExporting(false);
    }
  }
```

Add the button next to "Change language" in the header `<div>`:
```tsx
      <div className="p-3 text-sm text-muted-foreground flex justify-between items-center border-b">
        <span>
          {status === 'connecting' && 'Connecting…'}
          {status === 'reconnecting' && 'Reconnecting…'}
          {status === 'live' && lines.length === 0 && 'Waiting for the service to start…'}
          {status === 'live' && lines.length > 0 && 'Live'}
        </span>
        <div className="flex items-center gap-4">
          <button
            onClick={handleExportPdf}
            disabled={lines.length === 0 || isExporting}
            className="underline disabled:opacity-50 disabled:no-underline"
          >
            {isExporting ? 'Generating…' : 'Download Transcript (PDF)'}
          </button>
          <a href="/?reset=1" className="underline">
            Change language
          </a>
        </div>
      </div>
      {exportError && <p className="px-3 pt-2 text-sm text-destructive">{exportError}</p>}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually verify in the browser**

Run: `cd web && npm run dev` (and `cd server && npm run dev` with valid or dummy env vars per Task 7 of the main plan, so the viewer can actually receive backlog/caption messages).

Open `http://localhost:3000/view?lang=es` (or any language) after some captions have arrived (real captions from a live capture session, or — for a quick check without speaking — temporarily verify the button is disabled with zero lines, then confirm it enables once at least one line exists).

Expected:
- With zero lines, "Download Transcript (PDF)" is disabled (greyed out, not clickable).
- Once lines exist, clicking it briefly shows "Generating…", then a file named `sermon-transcript-es-<today's date>.pdf` downloads.
- Opening the PDF shows the title, language, timestamp, and each English/translated pair, matching the on-screen order.
- If the transcript is long enough to span more than one page, confirm the second page continues correctly (no cut-off or duplicated content at the page boundary).

Repeat once for a non-Latin-script language (e.g. `ko` or `zh`) and confirm the script renders correctly in the PDF (not blank boxes) — since this reuses the browser's own on-screen font rendering, it should match exactly what's displayed in the viewer's caption feed.

Stop both dev servers when done (don't leave background processes running).

- [ ] **Step 4: Commit**

```bash
git add web/app/view/page.tsx
git commit -m "feat(web): add PDF transcript download button to viewer page"
```
