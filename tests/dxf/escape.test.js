import { describe, expect, it } from 'vitest';
import { escapeDxfText } from '../../src/dxf/escape.js';

describe('escapeDxfText', () => {
  it('escapes non-ASCII UTF-16 code units and replaces line controls', () => {
    expect(escapeDxfText('部品\nA')).toBe('\\U+90E8\\U+54C1 A');
  });

  it('escapes each half of a surrogate pair separately', () => {
    expect(escapeDxfText('😀')).toBe('\\U+D83D\\U+DE00');
  });

  it('replaces unsafe ASCII controls without changing printable ASCII', () => {
    expect(escapeDxfText('A\0\t\r\n\x1f\x7f !~\\'))
      .toBe(`A${' '.repeat(7)}!~\\`);
  });

  it('rejects non-string values', () => {
    expect(() => escapeDxfText(null)).toThrow(TypeError);
  });
});
