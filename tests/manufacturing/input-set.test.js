import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareInputSet } from '../../src/manufacturing/input-set.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sidecars');
const loadSidecar = name => new Uint8Array(readFileSync(join(fixtureDir, name)));

const ascii = (...lines) => new TextEncoder().encode(lines.join('\n'));
const gerberListBytes = loadSidecar('P-00620-1_X-GBLIST.txt');
const drillListBytes = loadSidecar('P-00620-1_DRLIST_M.txt');

function record(kind, name, data, path = name) {
  return {
    name,
    path,
    kind,
    data,
    size: typeof data === 'string' ? data.length : data.byteLength,
    identity: `${path}\0${kind}`,
  };
}

function metricBoxGerber(maxX, maxY) {
  const scale = 1_000_000;
  return ascii(
    '%FSLAX46Y46*%',
    '%MOMM*%',
    '%ADD10C,0.002000*%',
    'D10*',
    'X0Y0D03*',
    `X${Math.round(maxX * scale)}Y${Math.round(maxY * scale)}D03*`,
    'M02*',
  );
}

function headerlessDrill(...points) {
  return ascii('T01', ...points, 'M30');
}

function drawable(result, name) {
  return result.drawableInputs.find(item => item.name === name || item.path === name);
}

describe('prepareInputSet', () => {
  it('keeps sidecars in auxiliaryFiles and manufacturing files in drawableInputs', () => {
    const result = prepareInputSet([
      record('gerber', 'P-00620-1.G03', metricBoxGerber(10, 10)),
      record('excellon', 'P-00620-1.dr1', headerlessDrill('X0Y0')),
      record('hpgl', 'drawing.H01', 'SP1;PU;'),
      record('gerber-list', 'P-00620-1_X-GBLIST.txt', gerberListBytes),
      record('drill-list', 'P-00620-1_DRLIST_M.txt', drillListBytes),
    ]);

    expect(result.auxiliaryFiles.map(item => item.kind).sort()).toEqual([
      'drill-list', 'gerber-list',
    ]);
    expect(result.drawableInputs.map(item => item.kind).sort()).toEqual([
      'excellon', 'gerber', 'hpgl',
    ]);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('applies a uniquely matching listed filename before other association rules', () => {
    const result = prepareInputSet([
      record('gerber', 'P-00620-1.G03', metricBoxGerber(10, 10)),
      record('excellon', 'P-00620-1.dr1', headerlessDrill('X0Y0')),
      record('excellon', 'other.drl', headerlessDrill('X0Y0')),
      record('gerber-list', 'P-00620-1_X-GBLIST.txt', gerberListBytes),
      record('drill-list', 'P-00620-1_DRLIST_M.txt', drillListBytes),
    ]);

    const gerber = drawable(result, 'P-00620-1.G03');
    const matched = drawable(result, 'P-00620-1.dr1');
    const other = drawable(result, 'other.drl');

    expect(gerber.effectiveLayerName).toBe('G03_Symbol_Mark_Top');
    expect(matched.parseOptions.defaults).toMatchObject({
      units: 'mm', integerDigits: 4, fractionDigits: 2, zeroSuppression: 'L',
    });
    expect(matched.parseOptions.defaults.tools.get(1)).toBe(0.4);
    expect(other.parseOptions).toEqual({});
  });

  it('does not apply a sidecar when two candidates share the listed file name', () => {
    const result = prepareInputSet([
      record('excellon', 'P-00620-1.dr1', headerlessDrill('X0Y0'), 'left/P-00620-1.dr1'),
      record('excellon', 'P-00620-1.dr1', headerlessDrill('X0Y0'), 'right/P-00620-1.dr1'),
      record('drill-list', 'P-00620-1_DRLIST_M.txt', drillListBytes, 'other/P-00620-1_DRLIST_M.txt'),
    ]);

    expect(result.drawableInputs.every(item => item.parseOptions.defaults == null)).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        fileName: 'P-00620-1_DRLIST_M.txt',
      }),
    ]));
  });

  it('associates by board name and directory when the recorded file name is absent', () => {
    const sidecar = [
      'Board Name  :  P-00620-1',
      'Database Format     :  Integers 4 , Fractions 2',
      'Units               :  mm',
      'Zero Suppression    :  On',
      'File Name   :  missing.dr1',
      '     T01  |     0.400  :      Through  :       1  :',
    ].join('\n');
    const result = prepareInputSet([
      record('excellon', 'P-00620-1.dr1', headerlessDrill('X0Y0'), 'fab/P-00620-1.dr1'),
      record('excellon', 'other.drl', headerlessDrill('X0Y0'), 'other/other.drl'),
      record('drill-list', 'P-00620-1_DRLIST_M.txt', sidecar, 'fab/P-00620-1_DRLIST_M.txt'),
    ]);

    expect(drawable(result, 'fab/P-00620-1.dr1').parseOptions.defaults.tools.get(1)).toBe(0.4);
    expect(drawable(result, 'other/other.drl').parseOptions).toEqual({});
  });

  it('guesses a unique headerless drill format from Gerber bounds with a warning', () => {
    const result = prepareInputSet([
      record('gerber', 'board.gbr', metricBoxGerber(120, 60)),
      record('excellon', 'board.dr1', headerlessDrill('X0Y0', 'X10000Y5000')),
    ]);

    const drill = drawable(result, 'board.dr1');
    expect(drill.parseOptions.defaults).toMatchObject({
      units: 'mm', integerDigits: 4, fractionDigits: 2, zeroSuppression: 'L',
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        fileName: 'board.dr1',
      }),
    ]));
    expect(result.diagnostics.some(item => item.command === 'DRILL_FORMAT_AMBIGUOUS')).toBe(false);
  });

  it('reports DRILL_FORMAT_AMBIGUOUS when two formats still fit the Gerber bounds', () => {
    const result = prepareInputSet([
      record('gerber', 'board.gbr', metricBoxGerber(100, 50)),
      record('excellon', 'board.dr1', headerlessDrill('X0Y0', 'X10000Y5000')),
    ]);

    const drill = drawable(result, 'board.dr1');
    expect(drill.parseOptions.defaults).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        fileName: 'board.dr1',
        command: 'DRILL_FORMAT_AMBIGUOUS',
      }),
    ]));
  });

  it('does not treat TnnC diameters as coordinate format when inferring drill units', () => {
    const result = prepareInputSet([
      record('gerber', 'board.gbr', metricBoxGerber(120, 60)),
      record('excellon', 'board.dr1', ascii('T01C00.00', 'X0Y0', 'X10000Y5000', 'M30')),
    ]);

    const drill = drawable(result, 'board.dr1');
    expect(drill.parseOptions.defaults).toMatchObject({
      units: 'mm', integerDigits: 4, fractionDigits: 2, zeroSuppression: 'L',
    });
    expect(result.diagnostics.some(item => item.command === 'DRILL_FORMAT_AMBIGUOUS')).toBe(false);
  });

  it('fills leading-zero suppression when a DRLIST omits Zero Suppression', () => {
    const sidecar = [
      'Board Name  :  board',
      'Database Format     :  Integers 4 , Fractions 2',
      'Units               :  mm',
      'File Name   :  board.dr1',
      '     T01  |     0.400  :      Through  :       1  :',
    ].join('\n');
    const result = prepareInputSet([
      record('excellon', 'board.dr1', headerlessDrill('X0Y0', 'X10000Y5000')),
      record('drill-list', 'board_DRLIST_M.txt', sidecar),
    ]);

    expect(drawable(result, 'board.dr1').parseOptions.defaults).toMatchObject({
      units: 'mm', integerDigits: 4, fractionDigits: 2, zeroSuppression: 'L',
    });
    expect(drawable(result, 'board.dr1').parseOptions.defaults.tools.get(1)).toBe(0.4);
  });

  it('reports DRILL_FORMAT_AMBIGUOUS when the group has no Gerber geometry', () => {
    const result = prepareInputSet([
      record('excellon', 'board.dr1', headerlessDrill('X0Y0', 'X10000Y5000')),
    ]);

    expect(drawable(result, 'board.dr1').parseOptions).toEqual({});
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        fileName: 'board.dr1',
        command: 'DRILL_FORMAT_AMBIGUOUS',
      }),
    ]));
  });

  it('does not infer digit widths for METRIC drills with decimal XY', () => {
    const result = prepareInputSet([
      record('gerber', 'board.gbr', metricBoxGerber(50, 50)),
      record('excellon', 'board.drl', ascii(
        'M48',
        'METRIC',
        'T1C0.3',
        '%',
        'X1.9Y40.988',
        'X10.0Y20.5',
        'M30',
      )),
    ]);

    const drill = drawable(result, 'board.drl');
    expect(result.diagnostics.some(item => item.command === 'DRILL_FORMAT_AMBIGUOUS')).toBe(false);
    expect(drill.parseOptions.defaults?.integerDigits).toBeUndefined();
    expect(drill.parseOptions.defaults?.fractionDigits).toBeUndefined();
  });

  it('does not report DRILL_FORMAT_AMBIGUOUS for header-only INCH drills with no XY', () => {
    const result = prepareInputSet([
      record('gerber', 'board.gbr', metricBoxGerber(50, 50)),
      record('excellon', 'board.drl', ascii(
        'M48',
        'INCH',
        '%',
        'M30',
      )),
    ]);

    expect(result.diagnostics.some(item => item.command === 'DRILL_FORMAT_AMBIGUOUS')).toBe(false);
  });

  it('keeps distinguishing extensions in default gerber layer names', () => {
    const result = prepareInputSet([
      record('gerber', 'P-00620-1.G01', metricBoxGerber(10, 10)),
      record('gerber', 'P-00620-1.G03', metricBoxGerber(10, 10)),
    ]);

    const first = drawable(result, 'P-00620-1.G01').effectiveLayerName;
    const second = drawable(result, 'P-00620-1.G03').effectiveLayerName;
    expect(first).not.toBe(second);
    expect(first).toMatch(/G01/i);
    expect(second).toMatch(/G03/i);
  });

  it('does not apply a unique DRLIST across directories', () => {
    const sidecar = [
      'Board Name  :  P-00620-1',
      'Database Format     :  Integers 4 , Fractions 2',
      'Units               :  mm',
      'Zero Suppression    :  On',
      'File Name   :  missing.dr1',
      '     T01  |     0.400  :      Through  :       1  :',
    ].join('\n');
    const result = prepareInputSet([
      record('excellon', 'board.dr1', headerlessDrill('X0Y0'), 'other/board.dr1'),
      record('drill-list', 'P-00620-1_DRLIST_M.txt', sidecar, 'fab/P-00620-1_DRLIST_M.txt'),
    ]);

    expect(drawable(result, 'other/board.dr1').parseOptions.defaults).toBeUndefined();
  });

  it('reclassifies a Magic CAD GBS as a gerber list and applies per-file apertures', () => {
    const gbs = loadSidecar('P-00622-1.gbs');
    const rs274d = ascii('*G17*G90*G71*G75*G54D193*G01X0050000Y0250000D03*M00*');
    const result = prepareInputSet([
      record('gerber', 'P-00622-1.G01', rs274d),
      record('gerber', 'P-00622-1.gbs', gbs),
      record('drill-list', 'P-00622-1.drs', loadSidecar('P-00622-1.drs')),
      record('excellon', 'P-00622-1.dr1', ascii('T01', 'G81', 'X022670Y050864', 'G80', 'M02')),
    ]);

    expect(result.auxiliaryFiles.map(item => item.name).sort()).toEqual([
      'P-00622-1.drs', 'P-00622-1.gbs',
    ]);
    expect(result.drawableInputs.map(item => item.name).sort()).toEqual([
      'P-00622-1.G01', 'P-00622-1.dr1',
    ]);
    const gerber = drawable(result, 'P-00622-1.G01');
    expect(gerber.effectiveLayerName).toBe('G01_Top');
    expect(gerber.parseOptions.defaults.apertures.get(193).modifiers[0]).toBe(4.6);
    expect(gerber.parseOptions.defaults).toMatchObject({
      units: 'mm', integerDigits: 3, fractionDigits: 4,
    });
    expect(drawable(result, 'P-00622-1.dr1').parseOptions.defaults).toMatchObject({
      units: 'mm', integerDigits: 3, fractionDigits: 3,
    });
    expect(drawable(result, 'P-00622-1.dr1').parseOptions.defaults.tools.get(1)).toBe(0.3);
  });

  it('applies a Zuken CR-5000 drill log to the recorded Excellon file', () => {
    const log = [
      'OUTPUT FILE:        /CAM/xx50.drl',
      'UNIT:               MM',
      'FORMAT:             3,3,3,3',
      'ZERO SUPP:          LEADING',
      'LOGICAL  PHYSICAL  USED   SIZE',
      '  1        1           63   0.400',
      'TOTAL HOLES         63',
    ].join('\n');
    const result = prepareInputSet([
      record('gerber', 'xx01.phot', metricBoxGerber(10, 10)),
      record('excellon', 'xx50.drl', headerlessDrill('X134200Y46450')),
      record('drill-list', 'drl.log', log),
      record('gerber-list', 'gb.log', 'GERBER:             EXTEND'),
    ]);

    expect(result.auxiliaryFiles.map(item => item.name).sort()).toEqual(['drl.log', 'gb.log']);
    expect(drawable(result, 'xx50.drl').parseOptions.defaults).toMatchObject({
      units: 'mm', integerDigits: 3, fractionDigits: 3, zeroSuppression: 'L',
    });
    expect(drawable(result, 'xx50.drl').parseOptions.defaults.tools.get(1)).toBe(0.4);
  });
});
