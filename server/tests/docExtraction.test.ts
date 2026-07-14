import { describe, it, expect, vi } from 'vitest';

const getTextMock = vi.fn().mockResolvedValue({ text: '  Extracted PDF text  ' });
const destroyMock = vi.fn().mockResolvedValue(undefined);

vi.mock('pdf-parse', () => ({
  PDFParse: vi.fn().mockImplementation(() => ({
    getText: getTextMock,
    destroy: destroyMock,
  })),
}));
vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn().mockResolvedValue({ value: '  Extracted docx text  ' }) },
}));

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
    getTextMock.mockResolvedValueOnce({ text: 'A'.repeat(40000) });
    const result = await extractDocumentText(Buffer.from('fake'), 'application/pdf');
    expect(result).toHaveLength(30000);
  });
});
