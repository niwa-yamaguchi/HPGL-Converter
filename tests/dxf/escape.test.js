import { describe, expect, it } from 'vitest';
import { escapeDxfText } from '../../src/dxf/escape.js';

describe('escapeDxfText', () => {
  it('escapes non-ASCII UTF-16 code units and replaces line controls', () => {
    expect(escapeDxfText('部品\nA')).toBe('\\U+90E8\\U+54C1 A');
  });

  it('escapes each half of a surrogate pair separately', () => {
    expect(escapeDxfText('😀')).toBe('\\U+D83D\\U+DE00');
  });

  it('escapes a literal backslash so it cannot impersonate a DXF Unicode escape', () => {
    expect(escapeDxfText('\\U+90E8')).toBe('\\U+005CU+90E8');
    expect(escapeDxfText('\\U+90E8')).not.toBe(escapeDxfText('部'));
  });

  it('replaces unsafe ASCII controls and keeps other printable ASCII', () => {
    expect(escapeDxfText('A\0\t\r\n\x1f\x7f !~\\'))
      .toBe(`A${' '.repeat(7)}!~\\U+005C`);
  });

  it('rejects non-string values', () => {
    expect(() => escapeDxfText(null)).toThrow(TypeError);
  });
});
