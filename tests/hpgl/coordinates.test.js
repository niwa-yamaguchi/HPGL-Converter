import { describe, expect, it } from 'vitest';
import { createCoordinateTransform } from '../../src/hpgl/coordinates.js';

describe('createCoordinateTransform', () => {
  it('uses 40 plotter units per millimeter', () => {
    const transform = createCoordinateTransform();

    expect(transform.toMm(80, 40)).toEqual([2, 1]);
    expect(transform.deltaToMm(80, 40)).toEqual([2, 1]);
    expect(transform.radiusToMm(40)).toBe(1);
  });

  it('maps SC user coordinates through explicit IP points', () => {
    const transform = createCoordinateTransform();
    transform.applyIP([0, 0, 4000, 2000]);
    transform.applySC([0, 100, 0, 100]);

    expect(transform.toMm(50, 50)).toEqual([50, 25]);
    expect(transform.deltaToMm(10, 10)).toEqual([10, 5]);
    expect(transform.radiusToMm(10)).toBe(7.5);
  });

  it('applies IR percentages to the explicit IP rectangle', () => {
    const transform = createCoordinateTransform();
    transform.applyIP([0, 0, 4000, 2000]);
    transform.applyIR([25, 25, 75, 75]);

    expect(transform.points()).toEqual({ p1: [1000, 500], p2: [3000, 1500] });
  });

  it('defaults omitted IR P2 percentages and resets IR with no values', () => {
    const transform = createCoordinateTransform();
    transform.applyIP([0, 0, 4000, 2000]);
    transform.applyIR([25, 25]);

    expect(transform.points()).toEqual({ p1: [1000, 500], p2: [4000, 2000] });

    transform.applyIR([]);
    expect(transform.points()).toEqual({ p1: [0, 0], p2: [4000, 2000] });
  });

  it('updates and resets the explicit IP rectangle used as the IR basis', () => {
    const transform = createCoordinateTransform();
    transform.applyIP([0, 0, 4000, 2000]);
    transform.applyIR([25, 25, 75, 75]);
    transform.applyIP([100, 200, 2100, 1200]);
    transform.applyIR([50, 50]);

    expect(transform.points()).toEqual({ p1: [1100, 700], p2: [2100, 1200] });

    transform.reset();
    expect(() => transform.applyIR([])).toThrow(RangeError);
    expect(transform.points()).toEqual({ p1: [0, 0], p2: null });
  });

  it('does not mutate the transform after invalid SC or IR', () => {
    const transform = createCoordinateTransform();
    transform.applyIP([0, 0, 4000, 2000]);
    transform.applySC([0, 100, 0, 100]);

    expect(() => transform.applySC([0, 0, 0, 100])).toThrow(RangeError);
    expect(transform.toMm(50, 50)).toEqual([50, 25]);

    transform.reset();
    transform.applyIP([100, 200]);
    const before = transform.points();
    expect(() => transform.applyIR([25, 25, 75, 75])).toThrow(RangeError);
    expect(transform.points()).toEqual(before);
  });

  it('validates IP values atomically and reset restores defaults', () => {
    const transform = createCoordinateTransform();
    transform.applyIP([100, 200, 500, 600]);

    expect(() => transform.applyIP([0, Number.NaN])).toThrow(TypeError);
    expect(transform.points()).toEqual({ p1: [100, 200], p2: [500, 600] });

    transform.reset();
    expect(transform.points()).toEqual({ p1: [0, 0], p2: null });
    expect(transform.toMm(80, 40)).toEqual([2, 1]);
  });
});
