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
