import { describe, expect, it } from 'vitest';
import { tokenizeGerber } from '../../src/gerber/tokenizer.js';

const ascii = text => new TextEncoder().encode(text);

describe('tokenizeGerber', () => {
  it('splits extended and standard commands and preserves byte offsets', () => {
    const result = tokenizeGerber(ascii('%FSLAX46Y46*%\nD10*\nX1000000Y2000000D02*'));

    expect(result.tokens).toEqual([
      { kind: 'extended', code: 'FS', raw: 'FSLAX46Y46', offset: 0 },
      { kind: 'standard', code: 'D10', raw: 'D10', offset: 14 },
      { kind: 'standard', code: 'D02', raw: 'X1000000Y2000000D02', offset: 19 },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('splits commands inside a percent block on each asterisk', () => {
    const result = tokenizeGerber(ascii('%AMDonut*\n1,1,$1,0,0*\n1,0,$2,0,0*\n%'));

    expect(result.tokens).toEqual([
      { kind: 'extended', code: 'AM', raw: 'AMDonut', offset: 0 },
      { kind: 'extended', code: '1', raw: '1,1,$1,0,0', offset: 10 },
      { kind: 'extended', code: '1', raw: '1,0,$2,0,0', offset: 22 },
    ]);
  });

  it('uses the D code as the token code when G, coordinates, and D share a command', () => {
    const result = tokenizeGerber(ascii('G01X1000000Y2000000D01*'));

    expect(result.tokens).toEqual([
      { kind: 'standard', code: 'D01', raw: 'G01X1000000Y2000000D01', offset: 0 },
    ]);
  });

  it('uppercases codes and skips whitespace between commands', () => {
    const result = tokenizeGerber(ascii('%momm*%  g01*\r\nd02*'));

    expect(result.tokens.map(token => ({ kind: token.kind, code: token.code }))).toEqual([
      { kind: 'extended', code: 'MO' },
      { kind: 'standard', code: 'G01' },
      { kind: 'standard', code: 'D02' },
    ]);
    expect(result.tokens.map(token => token.raw)).toEqual(['momm', 'g01', 'd02']);
  });

  it('treats coordinate-only commands as XY tokens', () => {
    const result = tokenizeGerber(ascii('X1000000Y2000000*'));

    expect(result.tokens).toEqual([
      { kind: 'standard', code: 'XY', raw: 'X1000000Y2000000', offset: 0 },
    ]);
  });

  it('warns for stray text and recovers at the next command', () => {
    const result = tokenizeGerber(ascii('?bad\nD10*'));

    expect(result.tokens).toEqual([
      { kind: 'standard', code: 'D10', raw: 'D10', offset: 5 },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        command: '',
        offset: 0,
        skippedCommands: 1,
        skippedShapes: 0,
      }),
    ]);
  });
});
