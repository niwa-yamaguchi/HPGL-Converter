import { describe, expect, it } from 'vitest';
import { createGerberCoordinateFormat } from '../../src/gerber/coordinates.js';

describe('createGerberCoordinateFormat', () => {
  it('converts leading-zero-suppressed absolute metric coordinates', () => {
    const format = createGerberCoordinateFormat();
    format.applyFs('FSLAX46Y46');
    format.applyMo('MOMM');

    expect(format.parsePoint({ x: '1000000', y: '2000000' })).toEqual([1, 2]);
    expect(format.parseOffset({ i: '500000', j: '0' })).toEqual([0.5, 0]);
  });

  it('reuses omitted modal X and Y and accepts negative values', () => {
    const format = createGerberCoordinateFormat();
    format.applyFs('FSLAX46Y46');
    format.applyMo('MOMM');
    format.parsePoint({ x: '1000000', y: '2000000' });

    expect(format.parsePoint({ x: '3000000' })).toEqual([3, 2]);
    expect(format.parsePoint({ y: '-4000000' })).toEqual([3, -4]);
  });

  it('converts inch coordinates to millimetres', () => {
    const format = createGerberCoordinateFormat();
    format.applyFs('FSLAX26Y26');
    format.applyMo('MOIN');

    expect(format.parsePoint({ x: '1000000', y: '2000000' })).toEqual([25.4, 50.8]);
  });

  it('pads trailing-zero-suppressed coordinates on the right', () => {
    const format = createGerberCoordinateFormat();
    format.applyFs('FSTAX46Y46');
    format.applyMo('MOMM');

    expect(format.parsePoint({ x: '0001', y: '0002' })).toEqual([1, 2]);
  });

  it('honours an explicit decimal point without zero padding', () => {
    const format = createGerberCoordinateFormat();
    format.applyFs('FSLAX46Y46');
    format.applyMo('MOMM');

    expect(format.parsePoint({ x: '1.5', y: '-0.25' })).toEqual([1.5, -0.25]);
  });

  it('applies SF scales before unit conversion', () => {
    const format = createGerberCoordinateFormat();
    format.applyFs('FSLAX26Y26');
    format.applyMo('MOIN');
    format.applySf('SFA2.0B0.5');

    expect(format.parsePoint({ x: '1000000', y: '1000000' })).toEqual([50.8, 12.7]);
    expect(format.parseOffset({ i: '1000000', j: '1000000' })).toEqual([50.8, 12.7]);
  });

  it('does not mutate the format after invalid FS or MO', () => {
    const format = createGerberCoordinateFormat();
    format.applyFs('FSLAX46Y46');
    format.applyMo('MOMM');

    expect(() => format.applyFs('FSLAX99Y46')).toThrow(RangeError);
    expect(() => format.applyMo('MOXX')).toThrow(RangeError);
    expect(format.parsePoint({ x: '1000000', y: '2000000' })).toEqual([1, 2]);
  });

  it('treats omitted I and J as zero and does not remember them', () => {
    const format = createGerberCoordinateFormat();
    format.applyFs('FSLAX46Y46');
    format.applyMo('MOMM');

    expect(format.parseOffset({ i: '1000000' })).toEqual([1, 0]);
    expect(format.parseOffset({})).toEqual([0, 0]);
  });
});
