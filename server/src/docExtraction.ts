import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

const MAX_CHARS = 30000;
const PDF_MIME_TYPE = 'application/pdf';
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function extractDocumentText(buffer: Buffer, mimetype: string): Promise<string> {
  let text: string;
  if (mimetype === PDF_MIME_TYPE) {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      text = result.text;
    } finally {
      await parser.destroy();
    }
  } else if (mimetype === DOCX_MIME_TYPE) {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else {
    throw new Error(`Unsupported document type: ${mimetype}`);
  }

  const trimmed = text.trim();
  return trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;
}
