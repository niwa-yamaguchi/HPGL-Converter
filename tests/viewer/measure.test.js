import { describe, expect, it } from 'vitest';
import { pointToGeometryDistance } from '../../src/viewer/measure.js';

const line = points => ({ type: 'line', points });
const polyline = points => ({ type: 'polyline', points });
const circle = (center, radius) => ({ type: 'circle', center, radius });
const arc = (center, radius, startAngle, endAngle) => ({
  type: 'arc', center, radius, startAngle, endAngle,
});

describe('pointToGeometryDistance', () => {
  it('projects onto a segment when the foot of the perpendicular is inside', () => {
    expect(pointToGeometryDistance([5, 3], line([[0, 0], [10, 0]]))).toBeCloseTo(3, 9);
  });

  it('clamps to the nearer endpoint when the projection falls outside', () => {
    expect(pointToGeometryDistance([-4, 3], line([[0, 0], [10, 0]]))).toBeCloseTo(5, 9);
  });

  it('measures to the closest segment of a polyline', () => {
    expect(pointToGeometryDistance([12, 5], polyline([[0, 0], [10, 0], [10, 10]])))
      .toBeCloseTo(2, 9);
  });

  it('measures a circle from outside and from inside', () => {
    expect(pointToGeometryDistance([10, 0], circle([0, 0], 4))).toBeCloseTo(6, 9);
    expect(pointToGeometryDistance([1, 0], circle([0, 0], 4))).toBeCloseTo(3, 9);
  });

  it('returns the radius when the point sits on the arc centre', () => {
    expect(pointToGeometryDistance([0, 0], arc([0, 0], 4, 0, 90))).toBeCloseTo(4, 9);
  });

  it('falls back to arc endpoints when the direction is outside the sweep', () => {
    expect(pointToGeometryDistance([-10, 0], arc([0, 0], 4, 0, 90))).toBeCloseTo(Math.sqrt(116), 9);
  });

  it('uses the radial point when the direction is inside the sweep', () => {
    expect(pointToGeometryDistance([10, 0], arc([0, 0], 4, 0, 90))).toBeCloseTo(6, 9);
  });

  it('treats text as unselectable', () => {
    expect(pointToGeometryDistance([0, 0], {
      type: 'text', point: [0, 0], text: 'A', height: 2, rotation: 0,
    })).toBe(Infinity);
  });

  it('rejects invalid points and geometries', () => {
    expect(() => pointToGeometryDistance([0], line([[0, 0], [1, 1]]))).toThrow(TypeError);
    expect(() => pointToGeometryDistance([Number.NaN, 0], line([[0, 0], [1, 1]])))
      .toThrow(RangeError);
    expect(() => pointToGeometryDistance([0, 0], { type: 'spline' })).toThrow(TypeError);
  });
});
