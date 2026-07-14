import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas-pro';
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
