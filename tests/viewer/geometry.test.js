import { describe, expect, it } from 'vitest';
import {
  angleInSweep, assertViewerGeometry, combinedBounds, fitViewport, geometryBounds,
  panViewport, zoomViewport,
} from '../../src/viewer/geometry.js';

const line = (points, extra = {}) => ({ type: 'line', points, ...extra });

describe('viewer geometry', () => {
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

  it('fits a positive sub-millimeter span to the available area', () => {
    const fitted = fitViewport({ minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 }, 100, 100, 10);

    expect(fitted.scale).toBe(800);
  });

  it('rejects invalid geometry arrays, types, coordinates, and sizes', () => {
    expect(() => geometryBounds(null)).toThrow(TypeError);
    expect(() => geometryBounds({ type: 'circle', center: [0, 0], radius: Infinity })).toThrow(RangeError);
    expect(() => geometryBounds({ type: 'unknown' })).toThrow(TypeError);
    expect(() => combinedBounds('not an array')).toThrow(TypeError);
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

describe('angleInSweep', () => {
  it('accepts angles inside a positive sweep and rejects the rest', () => {
    expect(angleInSweep(45, 0, 90)).toBe(true);
    expect(angleInSweep(0, 0, 90)).toBe(true);
    expect(angleInSweep(90, 0, 90)).toBe(true);
    expect(angleInSweep(180, 0, 90)).toBe(false);
  });

  it('accepts angles inside a negative sweep', () => {
    expect(angleInSweep(350, 0, -90)).toBe(true);
    expect(angleInSweep(180, 0, -90)).toBe(false);
  });
});

describe('assertViewerGeometry', () => {
  it('accepts every supported geometry type', () => {
    expect(() => assertViewerGeometry({ type: 'line', points: [[0, 0], [1, 1]] })).not.toThrow();
    expect(() => assertViewerGeometry({ type: 'circle', center: [0, 0], radius: 2 })).not.toThrow();
  });

  it('rejects unknown types and non-finite values', () => {
    expect(() => assertViewerGeometry({ type: 'spline' })).toThrow(TypeError);
    expect(() => assertViewerGeometry({ type: 'circle', center: [0, 0], radius: Number.NaN }))
      .toThrow(RangeError);
  });
});
