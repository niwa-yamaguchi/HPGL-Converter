import { describe, expect, it } from 'vitest';
import { instantiateAperture } from '../../src/gerber/apertures.js';
import { parseGerberObjects } from '../../src/gerber/parser.js';

const ascii = (...lines) => new TextEncoder().encode(lines.join('\n'));
const context = { fileName: 'board.gbr' };

const metricHeader = [
  '%FSLAX46Y46*%',
  '%MOMM*%',
  '%ADD10C,0.200000*%',
  'D10*',
];

describe('parseGerberObjects', () => {
  it('parses an absolute metric draw with source offsets', () => {
    const bytes = ascii(
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%ADD10C,0.200000*%',
      'D10*',
      'X1000000Y2000000D02*',
      'X3000000Y2000000D01*',
      'M02*',
    );

    const result = parseGerberObjects(bytes, context);

    expect(result.summary.errorCount).toBe(0);
    expect(result.objects).toEqual([expect.objectContaining({
      kind: 'draw', interpolation: 'linear', start: [1, 2], end: [3, 2],
      apertureCode: 10, polarity: 'dark', offset: expect.any(Number),
    })]);
  });

  it('reuses omitted coordinates and accepts negative values', () => {
    const result = parseGerberObjects(ascii(
      ...metricHeader,
      'X1000000Y2000000D02*',
      'X-3000000D01*',
      'Y-4000000D01*',
      'M02*',
    ), context);

    expect(result.objects).toEqual([
      expect.objectContaining({ kind: 'draw', start: [1, 2], end: [-3, 2] }),
      expect.objectContaining({ kind: 'draw', start: [-3, 2], end: [-3, -4] }),
    ]);
  });

  it('converts inch coordinates to millimetres', () => {
    const result = parseGerberObjects(ascii(
      '%FSLAX26Y26*%',
      '%MOIN*%',
      '%ADD10C,0.1*%',
      'D10*',
      'X1000000Y0D02*',
      'X2000000Y0D01*',
      'M02*',
    ), context);

    expect(result.objects[0]).toEqual(expect.objectContaining({
      kind: 'draw', start: [25.4, 0], end: [50.8, 0],
    }));
  });

  it('stores G02 and G03 center offsets from I and J', () => {
    const result = parseGerberObjects(ascii(
      ...metricHeader,
      'G75*',
      'X1000000Y0D02*',
      'G02X0Y-1000000I-1000000J0D01*',
      'G03X1000000Y0I0J1000000D01*',
      'M02*',
    ), context);

    expect(result.objects).toEqual([
      expect.objectContaining({
        kind: 'draw',
        interpolation: 'clockwise',
        start: [1, 0],
        end: [0, -1],
        centerOffset: [-1, 0],
        apertureCode: 10,
      }),
      expect.objectContaining({
        kind: 'draw',
        interpolation: 'counterclockwise',
        start: [0, -1],
        end: [1, 0],
        centerOffset: [0, 1],
      }),
    ]);
  });

  it('collects G36/G37 multi-contour regions instead of draw objects', () => {
    const result = parseGerberObjects(ascii(
      ...metricHeader,
      'G36*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'X1000000Y1000000D01*',
      'X0Y1000000D01*',
      'X0Y0D01*',
      'X200000Y200000D02*',
      'X400000Y200000D01*',
      'X400000Y400000D01*',
      'X200000Y400000D01*',
      'X200000Y200000D01*',
      'G37*',
      'M02*',
    ), context);

    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]).toEqual(expect.objectContaining({
      kind: 'region',
      polarity: 'dark',
      contours: [
        [
          expect.objectContaining({ interpolation: 'linear', start: [0, 0], end: [1, 0] }),
          expect.objectContaining({ interpolation: 'linear', start: [1, 0], end: [1, 1] }),
          expect.objectContaining({ interpolation: 'linear', start: [1, 1], end: [0, 1] }),
          expect.objectContaining({ interpolation: 'linear', start: [0, 1], end: [0, 0] }),
        ],
        [
          expect.objectContaining({ interpolation: 'linear', start: [0.2, 0.2], end: [0.4, 0.2] }),
          expect.objectContaining({ interpolation: 'linear', start: [0.4, 0.2], end: [0.4, 0.4] }),
          expect.objectContaining({ interpolation: 'linear', start: [0.4, 0.4], end: [0.2, 0.4] }),
          expect.objectContaining({ interpolation: 'linear', start: [0.2, 0.4], end: [0.2, 0.2] }),
        ],
      ],
    }));
  });

  it('applies LPD and LPC polarity to flashes', () => {
    const result = parseGerberObjects(ascii(
      ...metricHeader,
      '%LPC*%',
      'X1000000Y2000000D03*',
      '%LPD*%',
      'X3000000Y2000000D03*',
      'M02*',
    ), context);

    expect(result.objects).toEqual([
      expect.objectContaining({
        kind: 'flash', point: [1, 2], apertureCode: 10, polarity: 'clear',
      }),
      expect.objectContaining({
        kind: 'flash', point: [3, 2], apertureCode: 10, polarity: 'dark',
      }),
    ]);
  });

  it('snapshots LM, LR, and LS onto drawing objects', () => {
    const result = parseGerberObjects(ascii(
      ...metricHeader,
      '%LMX*%',
      '%LR45.0*%',
      '%LS0.5*%',
      'X1000000Y2000000D03*',
      'M02*',
    ), context);

    expect(result.objects[0]).toEqual(expect.objectContaining({
      kind: 'flash',
      transform: { mirror: 'X', rotation: 45, scale: 0.5 },
    }));
  });

  it('accepts ASAXBY and keeps prior axes for any other AS value', () => {
    const accepted = parseGerberObjects(ascii(
      '%ASAXBY*%',
      ...metricHeader,
      'X1000000Y2000000D03*',
      'M02*',
    ), context);
    const rejected = parseGerberObjects(ascii(
      ...metricHeader,
      '%ASAYBX*%',
      'X1000000Y2000000D03*',
      'M02*',
    ), context);

    expect(accepted.summary.errorCount).toBe(0);
    expect(rejected.objects[0]).toEqual(expect.objectContaining({ point: [1, 2] }));
    expect(rejected.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        command: 'AS',
        fileName: 'board.gbr',
        skippedCommands: 1,
        skippedShapes: 0,
      }),
    ]);
  });

  it('applies SF scales to coordinate conversion', () => {
    const result = parseGerberObjects(ascii(
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%SFA2.0B0.5*%',
      '%ADD10C,0.200000*%',
      'D10*',
      'X1000000Y2000000D02*',
      'X1000000Y2000000D03*',
      'M02*',
    ), context);

    expect(result.objects[0]).toEqual(expect.objectContaining({
      kind: 'flash', point: [2, 1],
    }));
  });

  it('keeps IN as metadata without moving geometry', () => {
    const result = parseGerberObjects(ascii(
      '%INBoardName*%',
      ...metricHeader,
      'X1000000Y2000000D03*',
      'M02*',
    ), context);

    expect(result.attributes.imageName).toBe('BoardName');
    expect(result.objects[0]).toEqual(expect.objectContaining({ point: [1, 2] }));
    expect(result.summary.errorCount).toBe(0);
  });

  it('parses TF, TA, TO, and TD without changing drawing objects', () => {
    const result = parseGerberObjects(ascii(
      '%TF.FileFunction,Copper,L1,Top*%',
      '%TA.AperFunction,ComponentPad*%',
      ...metricHeader,
      '%TO.P,R1,1*%',
      'X1000000Y2000000D03*',
      '%TD.FileFunction*%',
      'M02*',
    ), context);

    expect(result.objects).toEqual([
      expect.objectContaining({ kind: 'flash', point: [1, 2], polarity: 'dark' }),
    ]);
    expect(result.attributes.file['.FileFunction']).toBeUndefined();
    expect(result.attributes.file['.AperFunction']).toBeUndefined();
    expect(result.attributes.aperture['.AperFunction']).toEqual(['ComponentPad']);
    expect(result.attributes.object['.P']).toEqual(['R1', '1']);
  });

  it('stops at M02 and M00 and ignores later commands', () => {
    const m02 = parseGerberObjects(ascii(
      ...metricHeader,
      'X0Y0D03*',
      'M02*',
      'X1000000Y0D03*',
    ), context);
    const m00 = parseGerberObjects(ascii(
      ...metricHeader,
      'X0Y0D03*',
      'M00*',
      'X1000000Y0D03*',
    ), context);

    expect(m02.objects).toHaveLength(1);
    expect(m00.objects).toHaveLength(1);
    expect(m02.objects[0].point).toEqual([0, 0]);
    expect(m00.objects[0].point).toEqual([0, 0]);
  });

  it('stores AD and AM as structured definitions without instantiating geometry', () => {
    const result = parseGerberObjects(ascii(
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%AMDonut*',
      '1,1,$1,0,0*',
      '1,0,$2,0,0*',
      '%',
      '%ADD10Donut,1.5X0.5*%',
      '%ADD11C,0.200000*%',
      'D11*',
      'X0Y0D03*',
      'M02*',
    ), context);

    expect(result.macros.get('Donut')).toEqual(expect.objectContaining({
      name: 'Donut',
      primitives: ['1,1,$1,0,0', '1,0,$2,0,0'],
    }));
    expect(result.apertures.get(10)).toEqual(expect.objectContaining({
      code: 10,
      template: 'Donut',
      modifiers: [1.5, 0.5],
    }));
    expect(result.apertures.get(11)).toEqual(expect.objectContaining({
      code: 11,
      template: 'C',
      modifiers: [0.2],
    }));
    expect(result.objects).toEqual([
      expect.objectContaining({ kind: 'flash', apertureCode: 11 }),
    ]);
    expect(result.apertures.get(10).kind).toBe('macro');
    expect(result.apertures.get(11).kind).toBe('circle');
    const paths = instantiateAperture(result.apertures.get(11), { chordToleranceMm: 0.01 });
    expect(paths).toHaveLength(1);
    expect(paths[0].exposure).toBe('dark');
    expect(paths[0].path.length).toBeGreaterThanOrEqual(3);
  });

  it('converts inch AD modifiers to millimetres when storing aperture definitions', () => {
    const result = parseGerberObjects(ascii(
      '%FSLAX26Y26*%',
      '%MOIN*%',
      '%ADD10C,0.1*%',
      'D10*',
      'X0Y0D03*',
      'M02*',
    ), context);

    expect(result.apertures.get(10).modifiers[0]).toBeCloseTo(2.54);
    const paths = instantiateAperture(result.apertures.get(10), { chordToleranceMm: 0.01 });
    expect(Math.max(...paths[0].path.map(point => Math.hypot(point.x, point.y))))
      .toBeCloseTo(1.27, 5);
  });

  it('keeps previous state and records a diagnostic when a command fails', () => {
    const result = parseGerberObjects(ascii(
      ...metricHeader,
      'X1000000Y2000000D02*',
      'XNOTANUMBERY0D01*',
      'X3000000Y2000000D01*',
      'M02*',
    ), context);

    expect(result.objects).toEqual([
      expect.objectContaining({ kind: 'draw', start: [1, 2], end: [3, 2] }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        fileName: 'board.gbr',
        skippedCommands: 1,
        skippedShapes: 0,
      }),
    ]);
    expect(result.summary.errorCount).toBe(1);
  });

  it('does not leak modal X or functionCode from a failed aperture-less draw', () => {
    const result = parseGerberObjects(ascii(
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%ADD10C,0.200000*%',
      'X1000000Y2000000D02*',
      'X3000000Y2000000D01*',
      'D10*',
      'Y0*',
      'Y2000000D01*',
      'M02*',
    ), context);

    expect(result.objects).toEqual([
      expect.objectContaining({ kind: 'draw', start: [1, 0], end: [1, 2] }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        command: 'D01',
        fileName: 'board.gbr',
        skippedCommands: 1,
      }),
    ]);
    expect(result.summary.errorCount).toBe(1);
  });

  it('emits an error for an unclosed G36 at end of file', () => {
    const result = parseGerberObjects(ascii(
      ...metricHeader,
      'G36*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'X1000000Y1000000D01*',
      'X0Y1000000D01*',
      'X0Y0D01*',
    ), context);

    expect(result.objects).toEqual([
      expect.objectContaining({
        kind: 'region',
        contours: [[
          expect.objectContaining({ interpolation: 'linear', start: [0, 0], end: [1, 0] }),
          expect.objectContaining({ interpolation: 'linear', start: [1, 0], end: [1, 1] }),
          expect.objectContaining({ interpolation: 'linear', start: [1, 1], end: [0, 1] }),
          expect.objectContaining({ interpolation: 'linear', start: [0, 1], end: [0, 0] }),
        ]],
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        command: 'G36',
        fileName: 'board.gbr',
      }),
    ]);
    expect(result.summary.errorCount).toBe(1);
  });

  it('does not collect unknown extended commands as AM primitives', () => {
    const result = parseGerberObjects(ascii(
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%AMDonut*',
      '1,1,$1,0,0*',
      '%',
      '%SRX1Y1I0J0*%',
      '%ADD10C,0.200000*%',
      'D10*',
      'X0Y0D03*',
      'M02*',
    ), context);

    expect(result.macros.get('Donut')).toEqual(expect.objectContaining({
      name: 'Donut',
      primitives: ['1,1,$1,0,0'],
    }));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        command: 'SR',
        fileName: 'board.gbr',
      }),
    ]);
    expect(result.objects).toEqual([
      expect.objectContaining({ kind: 'flash', apertureCode: 10 }),
    ]);
  });

  it('emits an error for an unclosed G36 ended by M02', () => {
    const result = parseGerberObjects(ascii(
      ...metricHeader,
      'G36*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'X1000000Y1000000D01*',
      'X0Y1000000D01*',
      'X0Y0D01*',
      'M02*',
    ), context);

    expect(result.objects).toEqual([
      expect.objectContaining({
        kind: 'region',
        contours: [[
          expect.objectContaining({ interpolation: 'linear', start: [0, 0], end: [1, 0] }),
          expect.objectContaining({ interpolation: 'linear', start: [1, 0], end: [1, 1] }),
          expect.objectContaining({ interpolation: 'linear', start: [1, 1], end: [0, 1] }),
          expect.objectContaining({ interpolation: 'linear', start: [0, 1], end: [0, 0] }),
        ]],
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        command: 'G36',
        fileName: 'board.gbr',
      }),
    ]);
    expect(result.summary.errorCount).toBe(1);
  });
});
