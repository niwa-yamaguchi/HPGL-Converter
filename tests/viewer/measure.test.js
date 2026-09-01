import { describe, expect, it } from 'vitest';
import { pointToGeometryDistance, pickGeometry, minimumDistance } from '../../src/viewer/measure.js';

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

describe('pickGeometry', () => {
  const candidates = [
    { geometry: line([[0, 0], [10, 0]]), label: 'a' },
    { geometry: line([[0, 4], [10, 4]]), label: 'b' },
    { geometry: { type: 'text', point: [5, 1], text: 'A', height: 1, rotation: 0 }, label: 't' },
  ];

  it('returns the nearest candidate inside the tolerance', () => {
    const picked = pickGeometry(candidates, [5, 3], 2);
    expect(picked.index).toBe(1);
    expect(picked.candidate.label).toBe('b');
    expect(picked.distance).toBeCloseTo(1, 9);
  });

  it('returns null when nothing is inside the tolerance', () => {
    expect(pickGeometry(candidates, [5, 2], 0.5)).toBe(null);
  });

  it('never picks text candidates', () => {
    expect(pickGeometry([candidates[2]], [5, 1], 10)).toBe(null);
  });

  it('prefers the earlier candidate when distances tie', () => {
    const tied = [
      { geometry: line([[0, 0], [10, 0]]), label: 'first' },
      { geometry: line([[0, 0], [10, 0]]), label: 'second' },
    ];
    expect(pickGeometry(tied, [5, 1], 2).candidate.label).toBe('first');
  });

  it('returns null for an empty candidate list', () => {
    expect(pickGeometry([], [0, 0], 5)).toBe(null);
  });

  it('rejects invalid arguments', () => {
    expect(() => pickGeometry(null, [0, 0], 1)).toThrow(TypeError);
    expect(() => pickGeometry(candidates, [0, 0], -1)).toThrow(RangeError);
    expect(() => pickGeometry([{}], [0, 0], 1)).toThrow(TypeError);
  });
});

const consistent = result => {
  expect(Math.hypot(result.pointA[0] - result.pointB[0], result.pointA[1] - result.pointB[1]))
    .toBeCloseTo(result.distance, 9);
};

describe('minimumDistance between segments', () => {
  it('measures parallel segments', () => {
    const result = minimumDistance(line([[0, 0], [10, 0]]), line([[0, 3], [10, 3]]));
    expect(result.distance).toBeCloseTo(3, 9);
    consistent(result);
  });

  it('returns zero for crossing segments', () => {
    const result = minimumDistance(line([[0, 0], [10, 10]]), line([[0, 10], [10, 0]]));
    expect(result.distance).toBe(0);
    expect(result.pointA).toEqual(result.pointB);
    expect(result.pointA[0]).toBeCloseTo(5, 9);
    expect(result.pointA[1]).toBeCloseTo(5, 9);
  });

  it('measures collinear segments through their endpoints', () => {
    const result = minimumDistance(line([[0, 0], [1, 0]]), line([[3, 0], [4, 0]]));
    expect(result.distance).toBeCloseTo(2, 9);
    consistent(result);
  });

  it('measures a T shaped gap', () => {
    const result = minimumDistance(line([[0, 0], [10, 0]]), line([[5, 2], [5, 8]]));
    expect(result.distance).toBeCloseTo(2, 9);
    expect(result.pointA[0]).toBeCloseTo(5, 9);
    consistent(result);
  });

  it('finds the closest middle segment of a polyline', () => {
    const result = minimumDistance(
      polyline([[0, 0], [10, 0], [10, 10], [0, 10]]),
      line([[12, 5], [14, 5]]),
    );
    expect(result.distance).toBeCloseTo(2, 9);
    expect(result.pointA).toEqual([10, 5]);
    expect(result.pointB).toEqual([12, 5]);
  });

  it('rejects text geometry', () => {
    const text = { type: 'text', point: [0, 0], text: 'A', height: 1, rotation: 0 };
    expect(() => minimumDistance(text, line([[0, 0], [1, 1]]))).toThrow(TypeError);
    expect(() => minimumDistance(line([[0, 0], [1, 1]]), text)).toThrow(TypeError);
  });
});

describe('minimumDistance with arcs and circles', () => {
  it('measures a segment outside a circle along the radial direction', () => {
    const result = minimumDistance(line([[10, -5], [10, 5]]), circle([0, 0], 5));
    expect(result.distance).toBeCloseTo(5, 9);
    expect(result.pointA).toEqual([10, 0]);
    expect(result.pointB[0]).toBeCloseTo(5, 9);
    expect(result.pointB[1]).toBeCloseTo(0, 9);
  });

  it('measures a segment fully inside a circle from its endpoint', () => {
    const result = minimumDistance(line([[-1, 0], [1, 0]]), circle([0, 0], 5));
    expect(result.distance).toBeCloseTo(4, 9);
    consistent(result);
  });

  it('returns zero when a segment crosses the circle', () => {
    const result = minimumDistance(line([[0, 0], [10, 0]]), circle([0, 0], 5));
    expect(result.distance).toBe(0);
    expect(result.pointA[0]).toBeCloseTo(5, 9);
    expect(result.pointA[1]).toBeCloseTo(0, 9);
  });

  it('does not return zero when the crossing angle is outside the arc sweep', () => {
    const result = minimumDistance(line([[-10, 0], [0, 0]]), arc([0, 0], 5, 0, 90));
    expect(result.distance).toBeCloseTo(5, 9);
    consistent(result);
  });

  it('falls back to arc endpoints when the sweep faces away', () => {
    const result = minimumDistance(line([[0, -10], [10, -10]]), arc([0, 0], 5, 0, 90));
    expect(result.distance).toBeCloseTo(10, 9);
    consistent(result);
  });

  it('measures separated circles along the line of centres', () => {
    const result = minimumDistance(circle([0, 0], 2), circle([10, 0], 3));
    expect(result.distance).toBeCloseTo(5, 9);
    consistent(result);
  });

  it('measures a circle contained in another circle', () => {
    const result = minimumDistance(circle([0, 0], 10), circle([2, 0], 3));
    expect(result.distance).toBeCloseTo(5, 9);
    consistent(result);
  });

  it('measures concentric circles by their radius difference', () => {
    const result = minimumDistance(circle([0, 0], 2), circle([0, 0], 5));
    expect(result.distance).toBeCloseTo(3, 9);
    consistent(result);
  });

  it('returns zero for externally tangent circles', () => {
    const result = minimumDistance(circle([0, 0], 5), circle([10, 0], 5));
    expect(result.distance).toBe(0);
    expect(result.pointA[0]).toBeCloseTo(5, 9);
  });

  it('measures concentric arcs whose sweeps overlap', () => {
    const result = minimumDistance(arc([0, 0], 2, 0, 90), arc([0, 0], 5, 45, 180));
    expect(result.distance).toBeCloseTo(3, 9);
    consistent(result);
  });

  it('uses arc endpoints when concentric sweeps do not overlap', () => {
    const result = minimumDistance(arc([0, 0], 5, 0, 90), arc([0, 0], 5, 180, 270));
    expect(result.distance).toBeCloseTo(5 * Math.SQRT2, 9);
    consistent(result);
  });

  it('measures an arc against a polyline', () => {
    const result = minimumDistance(
      polyline([[0, 0], [10, 0], [10, 10]]),
      arc([10, 20], 5, 180, 360),
    );
    expect(result.distance).toBeCloseTo(5, 9);
    consistent(result);
  });

  it('measures non-concentric arcs whose circles intersect outside both sweeps', () => {
    // Circles centred at (0,0) and (8,0), both radius 5, intersect at (4, ±3).
    // (4, 3) sits inside the first arc's sweep but outside the second's, and
    // (4, -3) is outside the first arc's sweep entirely, so neither crossing
    // counts and the true minimum comes from the second arc's endpoint (8, 5).
    const first = arc([0, 0], 5, 0, 90);
    const second = arc([8, 0], 5, 0, 90);
    const result = minimumDistance(first, second);
    expect(result.distance).toBeCloseTo(Math.sqrt(89) - 5, 9);
    expect(result.pointB).toEqual([8, 5]);
    expect(Math.hypot(result.pointA[0], result.pointA[1])).toBeCloseTo(5, 9);
    consistent(result);
  });
});

describe('minimumDistance performance', () => {
  it('returns the correct distance for a large polyline pair', () => {
    // A straight 400-vertex baseline and a 400-vertex polyline that dips down
    // to touch it at a single vertex; everywhere else the two are ~100 apart,
    // so an incorrect prune would surface as a much larger reported distance.
    const baseline = Array.from({ length: 400 }, (_, index) => [index, 0]);
    const notch = Array.from({ length: 400 }, (_, index) => [index, index === 200 ? 1 : 100]);
    const result = minimumDistance(polyline(baseline), polyline(notch));
    expect(result.distance).toBeCloseTo(1, 9);
    expect(result.pointA).toEqual([200, 0]);
    expect(result.pointB).toEqual([200, 1]);
    consistent(result);
  });
});
