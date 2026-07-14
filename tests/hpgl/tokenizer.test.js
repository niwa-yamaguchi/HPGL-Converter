import { describe, expect, it } from 'vitest';
import { tokenizeHpgl } from '../../src/hpgl/tokenizer.js';

const ascii = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder().decode(bytes);

describe('tokenizeHpgl', () => {
  it('splits numeric commands across CRLF and concatenated mnemonics', () => {
    const result = tokenizeHpgl(ascii('PA0,0;PDPR40,0;\r\nPU;'));

    expect(result.tokens.map(token => token.code)).toEqual(['PA', 'PD', 'PR', 'PU']);
    expect(decode(result.tokens[2].params)).toBe('40,0');
  });

  it('strips reference-compatible ESC sequences and preserves byte offsets', () => {
    const result = tokenizeHpgl(ascii('\x1b.Eignored:\nPA40,80;'));

    expect(result.tokens).toMatchObject([{ code: 'PA', offset: 12 }]);
  });

  it('strips ESC sequences inside ordinary params without losing original offsets', () => {
    const result = tokenizeHpgl(ascii('PA0,0\x1b.Eignored:PR40,0;'));

    expect(result.tokens.map(token => token.code)).toEqual(['PA', 'PR']);
    expect(decode(result.tokens[0].params)).toBe('0,0');
    expect(result.tokens[1]).toMatchObject({ code: 'PR', offset: 16 });
    expect(decode(result.tokens[1].params)).toBe('40,0');
  });

  it('reads LB through ETX even when the label contains a semicolon', () => {
    const result = tokenizeHpgl(ascii('LBABC;DEF\x03PA0,0;'));

    expect(result.tokens[0]).toMatchObject({ code: 'LB', label: 'ABC;DEF' });
    expect(decode(result.tokens[0].params)).toBe('ABC;DEF');
    expect(result.tokens[1].code).toBe('PA');
  });

  it('replaces malformed UTF-8 bytes in LB labels', () => {
    const result = tokenizeHpgl(new Uint8Array([0x4c, 0x42, 0xc3, 0x28, 0x03]));

    expect(result.tokens[0].label).toBe('\ufffd(');
  });

  it('uppercases lowercase command codes', () => {
    const result = tokenizeHpgl(ascii('pa0,0;pu;'));

    expect(result.tokens.map(token => token.code)).toEqual(['PA', 'PU']);
  });

  it('preserves high-bit PE parameter bytes exactly', () => {
    const data = new Uint8Array([0x50, 0x45, 0x80, 0xff, 0x7f, 0x3b]);

    const result = tokenizeHpgl(data);

    expect(result.tokens[0].code).toBe('PE');
    expect(result.tokens[0].params).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.tokens[0].params)).toEqual([0x80, 0xff, 0x7f]);
  });

  it('warns once for an invalid prefix and recovers at the next semicolon', () => {
    const result = tokenizeHpgl(ascii('?broken;PA0,0;'));

    expect(result.tokens.map(token => token.code)).toEqual(['PA']);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toEqual({
      severity: 'warning',
      command: '',
      offset: 0,
      message: 'Invalid HPGL command start',
      skippedCommands: 1,
      skippedShapes: 0,
    });
  });

  it('recovers an LB missing ETX at a semicolon', () => {
    const result = tokenizeHpgl(ascii('LBunterminated;PA0,0;'));

    expect(result.tokens).toMatchObject([
      { code: 'LB', label: 'unterminated', offset: 0 },
      { code: 'PA', offset: 15 },
    ]);
  });

  it('returns no tokens or diagnostics for empty input and trailing whitespace', () => {
    expect(tokenizeHpgl(new Uint8Array())).toEqual({ tokens: [], diagnostics: [] });

    const result = tokenizeHpgl(ascii('PA; \t\r\n'));
    expect(result.tokens).toMatchObject([{ code: 'PA', offset: 0 }]);
    expect(result.diagnostics).toEqual([]);
  });
});
