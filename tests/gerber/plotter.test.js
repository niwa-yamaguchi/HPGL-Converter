import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGerberObjects } from '../../src/gerber/parser.js';
import { parseGerber, plotGerber } from '../../src/gerber/index.js';

const ascii = (...lines) => new TextEncoder().encode(lines.join('\n'));
const context = { fileName: 'board.gbr', layerName: 'board' };
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gerber');
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

function containsBounds(outer, inner) {
  return outer.minX < inner.minX && outer.maxX > inner.maxX
    && outer.minY < inner.minY && outer.maxY > inner.maxY;
}

describe('parseGerber', () => {
  const fixture = loadFixture('centerline.gbr');

  it('switches only D01 between outline and centerline', () => {
    const outline = parseGerber(fixture, context, { strokeMode: 'outline' });
    const centerline = parseGerber(fixture, context, { strokeMode: 'centerline' });
    expect(outline.geometries.length).toBeGreaterThan(0);
    expect(outline.geometries.every(item => item.type === 'polyline' && item.closed)).toBe(true);
    expect(centerline.geometries).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'line' }),
      expect.objectContaining({ type: 'arc' }),
      expect.objectContaining({ type: 'polyline', closed: true }),
    ]));
  });

  it('sweeps a circular D01 into a closed outline whose size includes the aperture', () => {
    const bytes = ascii(
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%ADD10C,0.200000*%',
      'D10*',
      'X0Y0D02*',
      'X5000000Y0D01*',
      'M02*',
    );
    const result = parseGerber(bytes, context, { strokeMode: 'outline' });
    const outlines = result.geometries.filter(item => item.type === 'polyline' && item.closed);
    expect(result.summary.errorCount).toBe(0);
    expect(outlines).toHaveLength(1);
    const bounds = polylineBounds(outlines[0]);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(5.2, 1);
    expect(bounds.maxY - bounds.minY).toBeCloseTo(0.2, 1);
  });

  it('unions overlapping dark shapes into one outline', () => {
    const result = parseGerber(loadFixture('outline.gbr'), context, { strokeMode: 'outline' });
    const outlines = result.geometries.filter(item => item.type === 'polyline' && item.closed);
    expect(result.summary.errorCount).toBe(0);
    expect(outlines).toHaveLength(1);
    const bounds = polylineBounds(outlines[0]);
    expect(bounds.maxX - bounds.minX).toBeGreaterThan(2.5);
    expect(bounds.maxY - bounds.minY).toBeGreaterThan(1.5);
  });

  it('creates hole contours for LPC clear polarity', () => {
    const result = parseGerber(loadFixture('macro-region.gbr'), context, { strokeMode: 'outline' });
    const outlines = result.geometries.filter(item => item.type === 'polyline' && item.closed);
    const bounds = outlines.map(polylineBounds);
    expect(result.summary.errorCount).toBe(0);
    expect(outlines.length).toBeGreaterThanOrEqual(2);
    expect(bounds.some((outer, index) => (
      bounds.some((inner, other) => index !== other && containsBounds(outer, inner))
    ))).toBe(true);
  });

  it('joins connected centerline draws into a polyline', () => {
    const result = parseGerber(ascii(
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%ADD10C,0.200000*%',
      'D10*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'X2000000Y1000000D01*',
      'X3000000Y1000000D01*',
      'M02*',
    ), context, { strokeMode: 'centerline' });

    expect(result.summary.errorCount).toBe(0);
    expect(result.geometries).toEqual([
      expect.objectContaining({
        type: 'polyline',
        closed: false,
        points: [[0, 0], [1, 0], [2, 1], [3, 1]],
      }),
    ]);
  });

  it('closes a centerline loop and keeps a pen-up gap as separate lines', () => {
    const result = parseGerber(ascii(
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%ADD10C,0.200000*%',
      'D10*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'X1000000Y1000000D01*',
      'X0Y1000000D01*',
      'X0Y0D01*',
      'X3000000Y0D02*',
      'X4000000Y0D01*',
      'X5000000Y0D02*',
      'X6000000Y0D01*',
      'M02*',
    ), context, { strokeMode: 'centerline' });

    expect(result.geometries).toEqual([
      expect.objectContaining({
        type: 'polyline',
        closed: true,
        points: [[0, 0], [1, 0], [1, 1], [0, 1]],
      }),
      expect.objectContaining({ type: 'line', points: [[3, 0], [4, 0]] }),
      expect.objectContaining({ type: 'line', points: [[5, 0], [6, 0]] }),
    ]);
  });

  it('keeps D03 flashes and regions closed in centerline mode', () => {
    const result = parseGerber(fixture, context, { strokeMode: 'centerline' });
    const closed = result.geometries.filter(item => item.type === 'polyline' && item.closed);
    expect(closed.length).toBeGreaterThanOrEqual(2);
    expect(closed.every(item => item.points.length >= 3)).toBe(true);
    expect(result.geometries.some(item => item.type === 'line')).toBe(true);
    expect(result.geometries.some(item => item.type === 'arc')).toBe(true);
  });

  it('defaults strokeMode to outline and rejects unknown modes', () => {
    const implied = parseGerber(fixture, context);
    expect(implied.geometries.every(item => item.type === 'polyline' && item.closed)).toBe(true);
    expect(() => parseGerber(fixture, context, { strokeMode: 'fill' })).toThrow(RangeError);
    expect(() => parseGerber(fixture, context, { strokeMode: 'fill' })).toThrow(
      'Gerber strokeMode must be outline or centerline',
    );
  });

  it('applies LM, LR, and LS to aperture paths before placement', () => {
    const bytes = ascii(
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%ADD10R,2.000000X1.000000*%',
      'D10*',
      '%LR45.0*%',
      'X0Y0D03*',
      'M02*',
    );
    const result = parseGerber(bytes, context);
    expect(result.geometries).toHaveLength(1);
    const bounds = polylineBounds(result.geometries[0]);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(1.5 * Math.SQRT2, 1);
    expect(bounds.maxY - bounds.minY).toBeCloseTo(1.5 * Math.SQRT2, 1);
  });

  it('unions many sequential dark strokes without per-command hang', () => {
    const commands = ['%FSLAX46Y46*%', '%MOMM*%', '%ADD10C,0.200000*%', 'D10*'];
    for (let index = 0; index < 80; index += 1) {
      const x = index * 300_000;
      commands.push(`X${x}Y0D02*`, `X${x + 200000}Y0D01*`);
    }
    commands.push('M02*');
    const started = Date.now();
    const result = parseGerber(ascii(...commands), context, { strokeMode: 'outline' });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.summary.errorCount).toBe(0);
    const outlines = result.geometries.filter(item => item.type === 'polyline' && item.closed);
    expect(outlines.length).toBeGreaterThan(0);
  });
});

describe('plotGerber', () => {
  it('converts parsed drawing objects into shared geometries', () => {
    const parsed = parseGerberObjects(loadFixture('outline.gbr'), context);
    const plotted = plotGerber(parsed, context, { strokeMode: 'outline' });
    expect(plotted.geometries.every(item => item.type === 'polyline' && item.closed)).toBe(true);
    expect(plotted.summary.geometryCount).toBe(plotted.geometries.length);
    expect(plotted.geometries[0]).toEqual(expect.objectContaining({
      layer: 'board',
      fileName: 'board.gbr',
    }));
  });
});
