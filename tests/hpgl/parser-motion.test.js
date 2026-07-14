import { describe, expect, it } from 'vitest';
import { parseHpgl } from '../../src/hpgl/parser.js';

const ascii = text => new TextEncoder().encode(text);
const context = { fileName: 'a.hpgl', layerName: 'a' };

describe('parseHpgl motion commands', () => {
  it('creates line and polyline geometries with the current ACI and context', () => {
    const result = parseHpgl(
      ascii('SP2;PA0,0;PD40,0;PU;PD80,0,80,40;PU;'),
      context,
    );

    expect(result.geometries).toEqual([
      {
        type: 'line',
        layer: 'a',
        color: 2,
        fileName: 'a.hpgl',
        offset: 10,
        points: [[0, 0], [1, 0]],
      },
      {
        type: 'polyline',
        layer: 'a',
        color: 2,
        fileName: 'a.hpgl',
        offset: 20,
        points: [[1, 0], [2, 0], [2, 1]],
      },
    ]);
    expect(result.summary).toEqual({ geometryCount: 2, errorCount: 0, warningCount: 0 });
  });

  it('persists PA and PR modes for PU and PD coordinates', () => {
    const result = parseHpgl(ascii('PA40,40;PR;PD40,0,0,40;PU;'), context);

    expect(result.geometries[0].points).toEqual([[1, 1], [2, 1], [2, 2]]);
  });

  it('applies IP and SC to parser motion', () => {
    const result = parseHpgl(
      ascii('IP0,0,4000,2000;SC0,100,0,100;PA50,50;PD100,100;PU;'),
      context,
    );

    expect(result.geometries[0].points).toEqual([[50, 25], [100, 50]]);
  });

  it('does not move the current physical position when applying a transform', () => {
    const result = parseHpgl(
      ascii('PA40,0;IP40,0,4040,4000;PR;PD40,0;PU;'),
      context,
    );

    expect(result.geometries[0].points).toEqual([[1, 0], [2, 0]]);
  });

  it('rejects IR without explicit P2 and preserves the prior transform', () => {
    const result = parseHpgl(
      ascii('IP40,40;IR;PA80,40;PD120,40;PU;'),
      context,
    );

    expect(result.geometries[0].points).toEqual([[1, 0], [2, 0]]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', command: 'IR', offset: 8 }),
    ]);
    expect(result.summary).toEqual({ geometryCount: 1, errorCount: 1, warningCount: 0 });
  });

  it('skips an odd-coordinate command without changing pen state', () => {
    const result = parseHpgl(
      ascii('PA0,0;PD40,0;PU20;PD80,0;PU;'),
      context,
    );

    expect(result.geometries).toHaveLength(1);
    expect(result.geometries[0].points).toEqual([[0, 0], [1, 0], [2, 0]]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', command: 'PU', offset: 13 }),
    ]);
  });

  it('skips junk numeric bytes without changing position', () => {
    const result = parseHpgl(
      ascii('PA40,0x;PD80,0;PU;'),
      context,
    );

    expect(result.geometries[0].points).toEqual([[0, 0], [2, 0]]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', command: 'PA', offset: 0 }),
    ]);
  });

  it('flushes an open line at EOF', () => {
    const result = parseHpgl(ascii('PD40,0;'), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ type: 'line', offset: 0, points: [[0, 0], [1, 0]] }),
    ]);
  });

  it('flushes motion around an unsupported independent shape', () => {
    const result = parseHpgl(ascii('PD40,0;CI40;PD80,0;'), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ type: 'line', points: [[0, 0], [1, 0]] }),
      expect.objectContaining({ type: 'line', points: [[1, 0], [2, 0]] }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', command: 'CI' }),
    ]);
  });

  it('accepts ACI 0 and warns for unsupported commands while DF is a no-op', () => {
    const result = parseHpgl(ascii('SP0;DF;ZZ;PD40,0;PU;'), context);

    expect(result.geometries[0]).toMatchObject({ color: 0 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', command: 'ZZ', offset: 7 }),
    ]);
    expect(result.summary).toEqual({ geometryCount: 1, errorCount: 0, warningCount: 1 });
  });

  it('includes tokenizer diagnostics in the summary', () => {
    const result = parseHpgl(ascii('?bad;PD40,0;'), context);

    expect(result.summary).toEqual({ geometryCount: 1, errorCount: 0, warningCount: 1 });
  });
});
