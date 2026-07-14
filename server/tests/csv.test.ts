import { describe, it, expect } from 'vitest';
import { toCsv } from '../src/csv';

describe('toCsv', () => {
  it('joins a header and rows with CRLF, ending in a trailing CRLF', () => {
    const result = toCsv(['A', 'B'], [['1', '2'], ['3', '4']]);
    expect(result).toBe('A,B\r\n1,2\r\n3,4\r\n');
  });

  it('returns just the header line when there are no rows', () => {
    const result = toCsv(['A', 'B'], []);
    expect(result).toBe('A,B\r\n');
  });

  it('wraps a field containing a comma in double quotes', () => {
    const result = toCsv(['A'], [['hello, world']]);
    expect(result).toBe('A\r\n"hello, world"\r\n');
  });

  it('wraps a field containing a double quote and doubles the internal quote', () => {
    const result = toCsv(['A'], [['she said "hi"']]);
    expect(result).toBe('A\r\n"she said ""hi"""\r\n');
  });

  it('wraps a field containing a newline in double quotes', () => {
    const result = toCsv(['A'], [['line one\nline two']]);
    expect(result).toBe('A\r\n"line one\nline two"\r\n');
  });

  it('leaves plain fields unquoted', () => {
    const result = toCsv(['A'], [['plain text']]);
    expect(result).toBe('A\r\nplain text\r\n');
  });
});
