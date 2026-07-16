import { describe, expect, it } from 'vitest';
import {
  combinedBounds, compareGeometrySets, fitViewport, geometryBounds, geometryKey,
  panViewport, zoomViewport,
} from '../../src/viewer/geometry.js';

const line = (points, extra = {}) => ({ type: 'line', points, ...extra });

describe('viewer geometry', () => {
  it('matches reversed lines within 0.001 mm and ignores metadata', () => {
    const a = line([[0, 1], [2, 3]], { layer: 'A', fileName: 'a', offset: 1 });
    const b = line([[2.0004, 3], [-0, 1]], { layer: 'B', fileName: 'b', offset: 99 });
    expect(geometryKey(a)).toBe(geometryKey(b));
  });

  it('compares duplicate geometries as a multiset', () => {
    const common = line([[0, 0], [1, 1]]);
    const onlyA = { type: 'circle', center: [3, 4], radius: 2 };
    const onlyB = { type: 'text', point: [5, 6], text: 'B', height: 5, rotation: 0 };
    const result = compareGeometrySets([common, common, onlyA], [common, onlyB]);
    expect(result.common).toEqual([common]);
    expect(result.onlyA).toEqual([common, onlyA]);
    expect(result.onlyB).toEqual([onlyB]);
  });

  it('treats reversed polylines as equal but preserves arc direction', () => {
    const forward = { type: 'polyline', points: [[0, 0], [1, 2], [3, 4]] };
    const reverse = { type: 'polyline', points: [[3, 4], [1, 2], [0, 0]] };
    expect(geometryKey(forward)).toBe(geometryKey(reverse));
    expect(geometryKey({ type: 'arc', center: [0, 0], radius: 2, startAngle: 0, endAngle: 90 }))
      .not.toBe(geometryKey({ type: 'arc', center: [0, 0], radius: 2, startAngle: 90, endAngle: 0 }));
  });

  it('includes circle and swept arc extrema in finite combined bounds', () => {
    const bounds = combinedBounds([
      { type: 'circle', center: [10, 10], radius: 2 },
      { type: 'arc', center: [0, 0], radius: 5, startAngle: 0, endAngle: 180 },
    ]);
    expect(bounds).toEqual({ minX: -5, minY: 0, maxX: 12, maxY: 12 });
  });

  it('fits degenerate bounds and keeps zoom and pan finite', () => {
    const fitted = fitViewport({ minX: 2, minY: 3, maxX: 2, maxY: 3 }, 800, 480, 12);
    const zoomed = zoomViewport(fitted, { x: 400, y: 240 }, -100);
    const panned = panViewport(zoomed, 20, -10);
    expect(Object.values(panned).every(Number.isFinite)).toBe(true);
    expect(zoomed.scale).toBeGreaterThan(fitted.scale);
    expect(panned.centerX).not.toBe(zoomed.centerX);
  });

  it('rejects invalid geometry arrays, types, coordinates, and sizes', () => {
    expect(() => geometryKey(null)).toThrow(TypeError);
    expect(() => geometryKey(line([[0, 0], [Number.NaN, 1]]))).toThrow(RangeError);
    expect(() => geometryBounds({ type: 'circle', center: [0, 0], radius: Infinity })).toThrow(RangeError);
    expect(() => geometryBounds({ type: 'unknown' })).toThrow(TypeError);
    expect(() => compareGeometrySets('not an array', [])).toThrow(TypeError);
    expect(() => combinedBounds([line([[0, 0], [1]])])).toThrow(TypeError);
  });

  it('rejects non-finite viewport inputs', () => {
    const viewport = { centerX: 0, centerY: 0, scale: 1, width: 800, height: 480 };
    expect(() => fitViewport(null, Infinity, 480, 12)).toThrow(RangeError);
    expect(() => zoomViewport(viewport, { x: 0, y: Number.NaN }, 1)).toThrow(RangeError);
    expect(() => zoomViewport({ ...viewport, scale: 0 }, { x: 0, y: 0 }, 1)).toThrow(RangeError);
    expect(() => panViewport(viewport, 1, Infinity)).toThrow(RangeError);
  });
});
