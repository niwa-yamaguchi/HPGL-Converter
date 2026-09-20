import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseExcellon } from '../../src/excellon/parser.js';

const ascii = (...lines) => new TextEncoder().encode(lines.join('\n'));
const context = { fileName: 'board.drl', layerName: 'drill' };
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'excellon');
const loadFixture = name => new Uint8Array(readFileSync(join(fixtureDir, name)));

function polylineBounds(geometry) {
  const xs = geometry.points.map(point => point[0]);
  const ys = geometry.points.map(point => point[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

describe('parseExcellon', () => {
  it('emits circles for known tools and crosses for unknown diameters', () => {
    const bytes = ascii(
      'M48',
      'METRIC',
      'T01C0.800',
      '%',
      'T01',
      'X1.0Y2.0',
      'T02',
      'X3.0Y4.0',
      'M30',
    );

    const result = parseExcellon(bytes, { fileName: 'board.drl', layerName: 'drill' }, {
      unknownToolMarkerMm: 1,
    });
    expect(result.geometries).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'circle', radius: 0.4, layer: 'drill' }),
      expect.objectContaining({ type: 'line', layer: 'drill_UNKNOWN_T02' }),
    ]));
    expect(result.summary.warningCount).toBe(1);
  });

  it('parses decimal coordinates in millimetres', () => {
    const result = parseExcellon(ascii(
      'M48',
      'METRIC',
      'T01C0.800',
      '%',
      'T01',
      'X10.5Y-2.25',
      'M30',
    ), context);

    expect(result.summary.errorCount).toBe(0);
    expect(result.geometries).toEqual([
      expect.objectContaining({
        type: 'circle',
        center: [10.5, -2.25],
        radius: 0.4,
        layer: 'drill',
      }),
    ]);
  });

  it('parses integer coordinates with leading-zero format', () => {
    const result = parseExcellon(ascii(
      'M48',
      'METRIC,LZ,0000.00',
      'T01C0.800',
      '%',
      'T01',
      'X000100Y000200',
      'M30',
    ), context);

    expect(result.summary.errorCount).toBe(0);
    expect(result.geometries[0]).toEqual(expect.objectContaining({
      type: 'circle',
      center: [1, 2],
      radius: 0.4,
    }));
  });

  it('treats G90 as absolute and G91 as incremental', () => {
    const absolute = parseExcellon(ascii(
      'M48',
      'METRIC',
      'T01C0.800',
      '%',
      'G90',
      'T01',
      'X1.0Y0.0',
      'X1.0Y2.0',
      'M30',
    ), context);
    const incremental = parseExcellon(ascii(
      'M48',
      'METRIC',
      'T01C0.800',
      '%',
      'G90',
      'T01',
      'X1.0Y0.0',
      'G91',
      'X1.0Y2.0',
      'M30',
    ), context);

    expect(absolute.geometries.map(item => item.center)).toEqual([[1, 0], [1, 2]]);
    expect(incremental.geometries.map(item => item.center)).toEqual([[1, 0], [2, 2]]);
  });

  it('accepts M71 as metric and M72 as inch', () => {
    const metric = parseExcellon(ascii(
      'M48',
      'M71',
      'T01C0.800',
      '%',
      'T01',
      'X1.0Y0.0',
      'M30',
    ), context);
    const inch = parseExcellon(ascii(
      'M48',
      'M72',
      'T01C1.000',
      '%',
      'T01',
      'X1.0Y0.0',
      'M30',
    ), context);

    expect(metric.geometries[0]).toEqual(expect.objectContaining({
      type: 'circle', center: [1, 0], radius: 0.4,
    }));
    expect(inch.geometries[0]).toEqual(expect.objectContaining({
      type: 'circle', center: [25.4, 0], radius: 12.7,
    }));
  });

  it('offsets a known-width G85 slot into a closed round-cap polyline', () => {
    const result = parseExcellon(ascii(
      'M48',
      'METRIC',
      'T01C0.800',
      '%',
      'T01',
      'X0.0Y0.0G85X10.0Y0.0',
      'M30',
    ), context);

    const slots = result.geometries.filter(item => item.type === 'polyline');
    expect(result.summary.errorCount).toBe(0);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toEqual(expect.objectContaining({
      type: 'polyline',
      closed: true,
      layer: 'drill',
    }));
    const bounds = polylineBounds(slots[0]);
    expect(bounds.minX).toBeCloseTo(-0.4, 1);
    expect(bounds.maxX).toBeCloseTo(10.4, 1);
    expect(bounds.minY).toBeCloseTo(-0.4, 1);
    expect(bounds.maxY).toBeCloseTo(0.4, 1);
  });

  it('builds a known-width M15/M16 slot from the routed path', () => {
    const result = parseExcellon(ascii(
      'M48',
      'METRIC',
      'T01C0.800',
      '%',
      'T01',
      'X0.0Y0.0',
      'M15',
      'X10.0Y0.0',
      'M16',
      'M30',
    ), context);

    const slots = result.geometries.filter(item => item.type === 'polyline');
    expect(result.summary.errorCount).toBe(0);
    expect(result.geometries.some(item => item.type === 'circle')).toBe(false);
    expect(slots).toHaveLength(1);
    expect(slots[0].closed).toBe(true);
    const bounds = polylineBounds(slots[0]);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(10.8, 1);
    expect(bounds.maxY - bounds.minY).toBeCloseTo(0.8, 1);
  });

  it.each(['M00', 'M02', 'M30'])('stops parsing after %s', endCode => {
    const result = parseExcellon(ascii(
      'M48',
      'METRIC',
      'T01C0.800',
      '%',
      'T01',
      'X1.0Y2.0',
      endCode,
      'X9.0Y9.0',
    ), context);

    expect(result.geometries).toHaveLength(1);
    expect(result.geometries[0]).toEqual(expect.objectContaining({
      type: 'circle',
      center: [1, 2],
    }));
  });

  it('emits center-path lines and a warning for unknown-width slots', () => {
    const result = parseExcellon(ascii(
      'M48',
      'METRIC',
      '%',
      'T02',
      'X0.0Y0.0G85X10.0Y0.0',
      'M30',
    ), context, { unknownToolMarkerMm: 1 });

    expect(result.geometries).toEqual([
      expect.objectContaining({
        type: 'line',
        points: [[0, 0], [10, 0]],
        layer: 'drill_UNKNOWN_T02',
      }),
    ]);
    expect(result.summary.warningCount).toBe(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        fileName: 'board.drl',
        skippedCommands: 0,
        skippedShapes: 0,
      }),
    ]);
  });

  it('draws unknown-hole crosses with arms of half the marker length', () => {
    const result = parseExcellon(ascii(
      'M48',
      'METRIC',
      '%',
      'T02',
      'X5.0Y5.0',
      'M30',
    ), context, { unknownToolMarkerMm: 2 });

    const lines = result.geometries.filter(item => item.type === 'line');
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ points: [[4, 5], [6, 5]], layer: 'drill_UNKNOWN_T02' }),
      expect.objectContaining({ points: [[5, 4], [5, 6]], layer: 'drill_UNKNOWN_T02' }),
    ]));
  });

  it('lets header values win over defaults for units and tools', () => {
    const result = parseExcellon(ascii(
      'M48',
      'METRIC',
      'T01C0.800',
      '%',
      'T01',
      'X1.0Y0.0',
      'M30',
    ), context, {
      defaults: {
        units: 'inch',
        integerDigits: 2,
        fractionDigits: 4,
        zeroSuppression: 'L',
        tools: new Map([[1, 10]]),
      },
    });

    expect(result.geometries[0]).toEqual(expect.objectContaining({
      type: 'circle',
      center: [1, 0],
      radius: 0.4,
    }));
  });

  it('converts a tool defined before METRIC without re-selecting it', () => {
    const result = parseExcellon(ascii(
      'M48',
      'T01C0.8',
      'METRIC',
      '%',
      'X1.0Y2.0',
      'M30',
    ), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({
        type: 'circle',
        center: [1, 2],
        radius: 0.4,
        layer: 'drill',
      }),
    ]);
    expect(result.summary.warningCount).toBe(0);
  });

  it('reconverts a file tool with header millimetres after inch defaults', () => {
    const result = parseExcellon(ascii(
      'M48',
      'T01C0.8',
      'METRIC',
      '%',
      'X1.0Y0.0',
      'M30',
    ), context, {
      defaults: { units: 'inch' },
    });

    expect(result.geometries[0]).toEqual(expect.objectContaining({
      type: 'circle',
      center: [1, 0],
      radius: 0.4,
    }));
  });

  it('fills only missing header fields from defaults', () => {
    const result = parseExcellon(loadFixture('headerless.dr1'), {
      fileName: 'board.dr1',
      layerName: 'drill',
    }, {
      defaults: {
        units: 'mm',
        integerDigits: 4,
        fractionDigits: 2,
        zeroSuppression: 'L',
        tools: new Map([[1, 0.8]]),
      },
    });

    expect(result.summary.errorCount).toBe(0);
    expect(result.geometries[0]).toEqual(expect.objectContaining({
      type: 'circle',
      center: [1, 2],
      radius: 0.4,
      layer: 'drill',
    }));
  });

  it('emits a file-level error and no geometries when units and format are unknown', () => {
    const result = parseExcellon(loadFixture('headerless.dr1'), {
      fileName: 'board.dr1',
      layerName: 'drill',
    });

    expect(result.geometries).toEqual([]);
    expect(result.summary.errorCount).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        fileName: 'board.dr1',
        skippedShapes: 0,
      }),
    ]));
  });

  it('loads the metric fixture as known-diameter holes', () => {
    const result = parseExcellon(loadFixture('metric.drl'), context);
    expect(result.summary.errorCount).toBe(0);
    expect(result.geometries).toEqual([
      expect.objectContaining({ type: 'circle', center: [1, 2], radius: 0.4, layer: 'drill' }),
      expect.objectContaining({ type: 'circle', center: [3, 4], radius: 0.5, layer: 'drill' }),
    ]);
  });

  it('converts the inch fixture to millimetres', () => {
    const result = parseExcellon(loadFixture('inch.drl'), context);
    expect(result.summary.errorCount).toBe(0);
    expect(result.geometries[0]).toEqual(expect.objectContaining({
      type: 'circle',
      center: [25.4, 0],
      radius: 12.7,
    }));
  });
});
