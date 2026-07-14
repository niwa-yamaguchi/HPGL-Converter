import { describe, expect, it } from 'vitest';
import { parseHpgl } from '../../src/hpgl/parser.js';

function encodeValue(value, base = 64) {
  let n = value >= 0 ? value * 2 : Math.abs(value) * 2 + 1;
  const bytes = [];
  while (n >= base) {
    bytes.push(63 + (n % base));
    n = Math.floor(n / base);
  }
  bytes.push((base === 64 ? 191 : 95) + n);
  return bytes;
}

const ascii = text => Array.from(new TextEncoder().encode(text));
const flag = value => value.charCodeAt(0);
const context = { fileName: 'a.hpgl', layerName: 'a' };

function hpgl(...parts) {
  return Uint8Array.from(parts.flatMap(part => (
    typeof part === 'string' ? ascii(part) : Array.from(part)
  )));
}

describe('parseHpgl PE commands', () => {
  it('creates millimetre polylines and line boundaries around pen-up pairs', () => {
    const pe = [
      ...encodeValue(40), ...encodeValue(0),
      ...encodeValue(40), ...encodeValue(40),
      flag('<'), ...encodeValue(40), ...encodeValue(0),
      ...encodeValue(0), ...encodeValue(40),
    ];

    const result = parseHpgl(hpgl('PE', pe, ';'), context);

    expect(result.geometries).toEqual([
      {
        type: 'polyline', layer: 'a', color: 1, fileName: 'a.hpgl', offset: 0,
        points: [[0, 0], [1, 0], [2, 1]],
      },
      {
        type: 'line', layer: 'a', color: 1, fileName: 'a.hpgl', offset: 0,
        points: [[3, 1], [3, 2]],
      },
    ]);
    expect(result.summary).toEqual({ geometryCount: 2, errorCount: 0, warningCount: 0 });
  });

  it('flushes embedded pen changes at the event position and keeps token metadata', () => {
    const pe = [
      ...encodeValue(40), ...encodeValue(0),
      flag(':'), ...encodeValue(3),
      ...encodeValue(40), ...encodeValue(0),
      flag(':'), ...encodeValue(4),
      ...encodeValue(40), ...encodeValue(0),
    ];

    const result = parseHpgl(hpgl('PA0,0;', 'PE', pe, ';'), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ color: 1, offset: 6, points: [[0, 0], [1, 0]] }),
      expect.objectContaining({ color: 3, offset: 6, points: [[1, 0], [2, 0]] }),
      expect.objectContaining({ color: 4, offset: 6, points: [[2, 0], [3, 0]] }),
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it.each(['PA', 'PR'])('treats default PE pairs as relative after %s mode', mode => {
    const pe = [...encodeValue(40), ...encodeValue(0)];
    const result = parseHpgl(hpgl('PA40,0;', mode, ';PE', pe, ';'), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ points: [[1, 0], [2, 0]] }),
    ]);
  });

  it('applies one-shot absolute PE coordinates without changing PA/PR mode', () => {
    const pe = [
      flag('='), ...encodeValue(80), ...encodeValue(40),
      ...encodeValue(40), ...encodeValue(0),
    ];
    const result = parseHpgl(hpgl('PR;PE', pe, ';PU40,0;PD40,0;PU;'), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ points: [[0, 0], [2, 1], [3, 1]] }),
      expect.objectContaining({ points: [[4, 1], [5, 1]] }),
    ]);
  });

  it('keeps an open polyline, position, and color unchanged when PE decoding fails', () => {
    const malformed = [
      flag(':'), ...encodeValue(3),
      ...encodeValue(40), ...encodeValue(0),
      63,
    ];

    const result = parseHpgl(hpgl(
      'SP2;PD40,0;PE', malformed, ';PD80,0;PU;',
    ), context);

    expect(result.geometries).toEqual([
      {
        type: 'polyline', layer: 'a', color: 2, fileName: 'a.hpgl', offset: 4,
        points: [[0, 0], [1, 0], [2, 0]],
      },
    ]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'error', fileName: 'a.hpgl', command: 'PE', offset: 11,
      skippedCommands: 1, skippedShapes: 0,
    });
    expect(Object.keys(result.diagnostics[0])).toHaveLength(7);
    expect(result.summary).toEqual({ geometryCount: 1, errorCount: 1, warningCount: 0 });
  });

  it('maps embedded pen zero to ACI 1 and invalid pens to recovery ACI 7', () => {
    const pe = [
      flag(':'), ...encodeValue(0),
      ...encodeValue(40), ...encodeValue(0),
      flag(':'), ...encodeValue(256),
      ...encodeValue(40), ...encodeValue(0),
    ];

    const result = parseHpgl(hpgl('SP2;PE', pe, ';PU;'), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ color: 1, points: [[0, 0], [1, 0]] }),
      expect.objectContaining({ color: 7, points: [[1, 0], [2, 0]] }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', command: 'PE' }),
    ]);
  });
});
