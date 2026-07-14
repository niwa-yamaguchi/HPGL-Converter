import { describe, expect, it } from 'vitest';
import { parseHpgl } from '../../src/hpgl/parser.js';

const ascii = text => new TextEncoder().encode(text);
const context = { fileName: 'a.hpgl', layerName: 'a' };

describe('parseHpgl recovery and diagnostics', () => {
  it.each([
    ['SP255', 255, 0],
    ['SP0', 1, 0],
    ['SP256', 7, 1],
    ['SP1.5', 7, 1],
    ['SP', 7, 1],
    ['SPx', 7, 1],
  ])('selects the recovery-safe ACI for %s', (command, color, errorCount) => {
    const result = parseHpgl(ascii(`${command};PD40,0;PU;`), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ type: 'line', color }),
    ]);
    expect(result.summary.errorCount).toBe(errorCount);
  });

  it.each(['SP256', 'SP1.5', 'SP', 'SPx'])('%s flushes an open line before recovery', command => {
    const result = parseHpgl(ascii(`PD40,0;${command};PD80,0;PU;`), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ type: 'line', color: 1, points: [[0, 0], [1, 0]] }),
      expect.objectContaining({ type: 'line', color: 7, points: [[1, 0], [2, 0]] }),
    ]);
  });

  it('accepts known no-op commands with arbitrary parameters and warns for unknown commands', () => {
    const result = parseHpgl(
      ascii('CT1,@;LT1 2;VS-;PG?;RO1,2;PSx;ZZ;'),
      context,
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', command: 'ZZ' }),
    ]);
    expect(result.summary).toEqual({ geometryCount: 0, errorCount: 0, warningCount: 1 });
  });

  it('caps diagnostic details at 100 while preserving total warning count and shape', () => {
    const result = parseHpgl(ascii('ZZ;'.repeat(150)), context);

    expect(result.diagnostics).toHaveLength(100);
    expect(result.summary).toEqual({ geometryCount: 0, errorCount: 0, warningCount: 150 });
    expect(Object.keys(result.diagnostics[0]).sort()).toEqual([
      'command',
      'fileName',
      'message',
      'offset',
      'severity',
      'skippedCommands',
      'skippedShapes',
    ].sort());
    expect(result.diagnostics[0].fileName).toBe('a.hpgl');
  });

  it('keeps mixed tokenizer and parser diagnostic details in input order', () => {
    const result = parseHpgl(ascii('ZZ;?bad;ZZ;'), context);

    expect(result.diagnostics.map(item => [item.command, item.offset])).toEqual([
      ['ZZ', 0],
      ['', 3],
      ['ZZ', 8],
    ]);
  });

  it('applies the first four SC values and warns once for ignored optional values', () => {
    const result = parseHpgl(
      ascii('IP0,0,4000,2000;SC0,100,0,100,999,888;PA50,50;PD100,100;PU;'),
      context,
    );

    expect(result.geometries[0].points).toEqual([[50, 25], [100, 50]]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning', command: 'SC', message: 'Optional SC parameters are ignored',
      }),
    ]);
    expect(result.summary).toEqual({ geometryCount: 1, errorCount: 0, warningCount: 1 });
  });

  it('reports ignored SC options without marking the applied command as skipped', () => {
    const result = parseHpgl(ascii('SC0,100,0,100,999;'), context);

    expect(result.diagnostics).toEqual([{
      severity: 'warning',
      fileName: 'a.hpgl',
      command: 'SC',
      offset: 0,
      message: 'Optional SC parameters are ignored',
      skippedCommands: 0,
      skippedShapes: 0,
    }]);
  });

  it('keeps transform state after malformed SC and accepts DF as a validated no-op', () => {
    const result = parseHpgl(
      ascii('PA40,40;SC0,100,@,100;DF;PD80,40;PU;ZZ1;CT0;'),
      context,
    );

    expect(result.geometries[0].points).toEqual([[1, 1], [2, 1]]);
    expect(result.diagnostics.map(item => [item.severity, item.command])).toEqual([
      ['error', 'SC'],
      ['warning', 'ZZ'],
    ]);
  });

  it('flushes then resets all parser and transform state for IN', () => {
    const result = parseHpgl(
      ascii('IP0,0,4000,2000;SC0,100,0,100;SP5;PR;PD10,10;IN;PU40,0;PD80,0;PU;'),
      context,
    );

    expect(result.geometries).toEqual([
      expect.objectContaining({ color: 5, points: [[0, 0], [10, 5]] }),
      expect.objectContaining({ color: 1, points: [[1, 0], [2, 0]] }),
    ]);
    expect(result.summary).toEqual({ geometryCount: 2, errorCount: 0, warningCount: 0 });
  });
});
