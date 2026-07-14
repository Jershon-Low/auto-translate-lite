import { describe, it, expect, vi } from 'vitest';

vi.mock('pdf-parse', () => ({
  default: vi.fn().mockResolvedValue({ text: '  Extracted PDF text  ' }),
}));
vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn().mockResolvedValue({ value: '  Extracted docx text  ' }) },
}));

import pdfParse from 'pdf-parse';
import { extractDocumentText } from '../src/docExtraction';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('extractDocumentText', () => {
  it('extracts and trims text from a PDF', async () => {
    const result = await extractDocumentText(Buffer.from('fake'), 'application/pdf');
    expect(result).toBe('Extracted PDF text');
  });

  it('extracts and trims text from a docx', async () => {
    const result = await extractDocumentText(Buffer.from('fake'), DOCX_MIME);
    expect(result).toBe('Extracted docx text');
  });

  it('throws for an unsupported mimetype', async () => {
    await expect(extractDocumentText(Buffer.from('fake'), 'text/plain')).rejects.toThrow(
      'Unsupported document type: text/plain'
    );
  });

  it('truncates text longer than 30,000 characters', async () => {
    (pdfParse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: 'A'.repeat(40000) });
    const result = await extractDocumentText(Buffer.from('fake'), 'application/pdf');
    expect(result).toHaveLength(30000);
  });
});
