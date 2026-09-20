import { describe, expect, it, vi } from 'vitest';
import * as parserModule from '../src/hpgl/parser.js';
import { convertInputs, parseInputs } from '../src/converter.js';
import { parseDxfTags, recordValues, records, sectionTags } from './dxf/dxf-tags.js';

const ascii = (...lines) => new TextEncoder().encode(lines.join('\n'));
const decode = buffer => new TextDecoder().decode(buffer);

function section(text, name) {
  const marker = `0\nSECTION\n2\n${name}\n`;
  const start = text.indexOf(marker);
  const end = text.indexOf('0\nENDSEC\n', start);
  return text.slice(start + marker.length, end);
}

describe('convertInputs', () => {
  it('combines files, layers, and geometries in input order with exact totals and progress', async () => {
    const progress = [];
    const result = await convertInputs([
      { name: 'a.hpgl', layerName: 'first', data: ascii('SP2;PA0,0;PD40,0;PU;') },
      { name: 'b.H01', layerName: 'second', data: ascii('SP3;PA0,0;PD0,40;PU;') },
    ], event => progress.push(event));

    expect(result.totals).toEqual({
      fileCount: 2,
      geometryCount: 2,
      errorCount: 0,
      warningCount: 0,
    });
    expect(result.files).toEqual([
      {
        name: 'a.hpgl', layerName: 'first', geometryCount: 1,
        errorCount: 0, warningCount: 0, diagnostics: [],
      },
      {
        name: 'b.H01', layerName: 'second', geometryCount: 1,
        errorCount: 0, warningCount: 0, diagnostics: [],
      },
    ]);
    expect(progress).toEqual([
      {
        fileName: 'a.hpgl', index: 1, total: 2,
        geometryCount: 1, errorCount: 0, warningCount: 0,
      },
      {
        fileName: 'b.H01', index: 2, total: 2,
        geometryCount: 1, errorCount: 0, warningCount: 0,
      },
    ]);

    expect(result.buffer).toBeInstanceOf(ArrayBuffer);
    const dxf = decode(result.buffer);
    const tables = section(dxf, 'TABLES');
    expect(tables.indexOf('2\nfirst\n')).toBeLessThan(tables.indexOf('2\nsecond\n'));
    const entityRecords = records(sectionTags(parseDxfTags(dxf), 'ENTITIES'));
    expect(entityRecords.map(record => record.type)).toEqual(['LINE', 'LINE']);
    expect(entityRecords.map(record => recordValues(record, 8)[0])).toEqual(['first', 'second']);
    expect(entityRecords.every(record => recordValues(record, 62).length === 0)).toBe(true);
    expect(entityRecords.map(record => ({
      start: [recordValues(record, 10)[0], recordValues(record, 20)[0]],
      end: [recordValues(record, 11)[0], recordValues(record, 21)[0]],
    }))).toEqual([
      { start: ['0', '0'], end: ['1', '0'] },
      { start: ['0', '0'], end: ['0', '1'] },
    ]);
  });

  it('keeps valid geometry and reports malformed HPGL commands', async () => {
    const result = await convertInputs([{
      name: 'damaged.hpgl',
      layerName: 'damaged',
      data: ascii('SP4;PD40,0;CI;PD80,0;PU;'),
    }], () => {});

    expect(result.files[0]).toMatchObject({
      geometryCount: 1,
      errorCount: 1,
      warningCount: 0,
    });
    expect(result.files[0].diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error', fileName: 'damaged.hpgl', command: 'CI',
      }),
    ]);
    expect(result.totals).toEqual({
      fileCount: 1, geometryCount: 1, errorCount: 1, warningCount: 0,
    });
    const entityRecords = records(sectionTags(
      parseDxfTags(decode(result.buffer)),
      'ENTITIES',
    ));
    expect(entityRecords.map(record => recordValues(record, 8)[0])).toEqual(['damaged']);
    expect(entityRecords.every(record => recordValues(record, 62).length === 0)).toBe(true);
  });

  it.each([
    ['a 450 degree arc', 'PA40,0;PD;AA0,0,450;PU;IN;SP6;PD40,0;PU;', 'AA'],
    ['a zero-radius transformed circle', 'IP0,0,0,0;SC0,100,0,100;CI40;IN;SP6;PD40,0;PU;', 'CI'],
    [
      'non-finite transformed coordinates',
      `IP0,0,4000,4000;SC0,100,0,100;PR;PD${`1${'0'.repeat(308)}`},0,`
        + `${`1${'0'.repeat(308)}`},0;PU;IN;SP6;PD40,0;PU;`,
      'PD',
    ],
  ])('diagnoses and isolates %s while retaining later geometry and files', async (
    _label,
    damagedHpgl,
    command,
  ) => {
    const result = await convertInputs([
      { name: 'damaged.hpgl', layerName: 'damaged', data: ascii(damagedHpgl) },
      { name: 'good.hpgl', layerName: 'good', data: ascii('SP5;PD0,40;PU;') },
    ], () => {});

    expect(result.files[0]).toMatchObject({
      geometryCount: 1,
      errorCount: 1,
      warningCount: 0,
      diagnostics: [expect.objectContaining({
        severity: 'error', fileName: 'damaged.hpgl', command,
      })],
    });
    expect(result.files[1]).toMatchObject({
      geometryCount: 1, errorCount: 0, warningCount: 0,
    });
    expect(result.totals).toEqual({
      fileCount: 2, geometryCount: 2, errorCount: 1, warningCount: 0,
    });
    const entityRecords = records(sectionTags(
      parseDxfTags(decode(result.buffer)),
      'ENTITIES',
    ));
    expect(entityRecords.map(record => recordValues(record, 8)[0]))
      .toEqual(['damaged', 'good']);
    expect(entityRecords.every(record => recordValues(record, 62).length === 0)).toBe(true);
  });

  it('produces a complete decodable DXF for no inputs', async () => {
    const progress = vi.fn();
    const result = await convertInputs([], progress);

    expect(result.files).toEqual([]);
    expect(result.totals).toEqual({
      fileCount: 0, geometryCount: 0, errorCount: 0, warningCount: 0,
    });
    expect(progress).not.toHaveBeenCalled();
    const text = decode(result.buffer);
    expect(text).toContain('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n');
    expect(text.endsWith('0\nEOF\n')).toBe(true);
  });

  it('isolates an unexpected parser failure and continues later files', async () => {
    const originalParse = parserModule.parseHpgl;
    const parse = vi.spyOn(parserModule, 'parseHpgl')
      .mockImplementationOnce(() => { throw new Error('parser exploded'); })
      .mockImplementation(originalParse);

    try {
      const result = await convertInputs([
        { name: 'bad.hpgl', layerName: 'bad', data: ascii('PD40,0;') },
        { name: 'good.hpgl', layerName: 'good', data: ascii('SP5;PD40,0;PU;') },
      ], () => {});

      expect(result.files[0]).toMatchObject({
        geometryCount: 0, errorCount: 1, warningCount: 0,
      });
      expect(result.files[0].diagnostics).toEqual([{
        severity: 'error',
        fileName: 'bad.hpgl',
        command: 'FILE',
        offset: 0,
        message: 'parser exploded',
        skippedCommands: 0,
        skippedShapes: 0,
      }]);
      expect(Object.keys(result.files[0].diagnostics[0])).toHaveLength(7);
      expect(result.files[1]).toMatchObject({ geometryCount: 1, errorCount: 0 });
      expect(result.totals).toEqual({
        fileCount: 2, geometryCount: 1, errorCount: 1, warningCount: 0,
      });
      const entityRecords = records(sectionTags(
        parseDxfTags(decode(result.buffer)),
        'ENTITIES',
      ));
      expect(entityRecords.map(record => recordValues(record, 8)[0])).toEqual(['good']);
      expect(entityRecords.every(record => recordValues(record, 62).length === 0)).toBe(true);
    } finally {
      parse.mockRestore();
    }
  });

  it('turns the internal read-failure sentinel into one file-level diagnostic', async () => {
    const progress = [];
    const result = await convertInputs([
      { name: 'unreadable.hpgl', layerName: 'unreadable', data: null, readError: 'read failed' },
      { name: 'ok.hpgl', layerName: 'ok', data: ascii('PD40,0;PU;') },
    ], event => progress.push(event));

    expect(result.files[0].diagnostics).toEqual([{
      severity: 'error',
      fileName: 'unreadable.hpgl',
      command: 'FILE',
      offset: 0,
      message: 'read failed',
      skippedCommands: 0,
      skippedShapes: 0,
    }]);
    expect(result.files[0].geometryCount).toBe(0);
    expect(result.files[1].geometryCount).toBe(1);
    expect(progress).toHaveLength(2);
  });

  it.each([
    ['non-array inputs', null, () => {}, /inputs.*array/i],
    ['non-function progress', [], null, /progress.*function/i],
    ['missing name', [{ layerName: 'a', data: new Uint8Array() }], () => {}, /name.*string/i],
    ['missing layer', [{ name: 'a', data: new Uint8Array() }], () => {}, /layerName.*string/i],
    ['wrong data', [{ name: 'a', layerName: 'a', data: new ArrayBuffer(0) }], () => {}, /data.*Uint8Array/i],
    ['fake sentinel', [{ name: 'a', layerName: 'a', data: null }], () => {}, /data.*Uint8Array/i],
  ])('rejects %s before conversion', async (_label, inputs, progress, message) => {
    await expect(convertInputs(inputs, progress)).rejects.toThrow(message);
  });

  it('rejects an unknown Gerber strokeMode', async () => {
    await expect(convertInputs([], () => {}, { strokeMode: 'fill' })).rejects.toThrow(RangeError);
    await expect(convertInputs([], () => {}, { strokeMode: 'fill' })).rejects.toThrow(
      'Gerber strokeMode must be outline or centerline',
    );
    expect(() => parseInputs([], { strokeMode: 'fill' })).toThrow(RangeError);
  });
});

describe('manufacturing conversion', () => {
  const gerber = ascii(
    '%FSLAX46Y46*%',
    '%MOMM*%',
    '%ADD10C,0.200000*%',
    'D10*',
    'X0Y0D02*',
    'X5000000Y0D01*',
    'M02*',
  );
  const excellon = ascii(
    'M48',
    'METRIC',
    'T01C0.800',
    '%',
    'G90',
    'T01',
    'X1.0Y2.0',
    'M30',
  );
  const sidecar = ascii(
    'Board Name : demo',
    'other.G01  :  Copper      [Top Side]',
  );

  const mixedInputs = [
    { name: 'drawing.H01', layerName: 'hpgl', data: ascii('SP2;PA0,0;PD40,0;PU;') },
    { name: 'board.gtl', layerName: 'gtl', data: gerber, kind: 'gerber', path: 'board.gtl' },
    { name: 'board.drl', layerName: 'drill', data: excellon, kind: 'excellon', path: 'board.drl' },
    {
      name: 'board_X-GBLIST.txt',
      layerName: 'list',
      data: sidecar,
      kind: 'gerber-list',
      path: 'board_X-GBLIST.txt',
    },
  ];

  it('dispatches HPGL, Gerber, Excellon and skips sidecars as layers', async () => {
    const progress = [];
    const result = await convertInputs(mixedInputs, event => progress.push(event), {
      strokeMode: 'centerline',
    });
    expect(result.totals.fileCount).toBe(3);
    expect(result.files.map(file => file.name)).toEqual([
      'drawing.H01', 'board.gtl', 'board.drl',
    ]);
    expect(progress.map(event => event.fileName)).toEqual([
      'drawing.H01', 'board.gtl', 'board.drl',
    ]);
    expect(progress.every(event => event.total === 3)).toBe(true);
    expect(result.files.every(file => file.geometryCount > 0)).toBe(true);

    const dxf = decode(result.buffer);
    const tables = section(dxf, 'TABLES');
    expect(tables).toContain('2\nhpgl\n');
    expect(tables).toContain('2\ngtl\n');
    expect(tables).toContain('2\ndrill\n');
    expect(tables).not.toContain('2\nlist\n');
  });

  it('uses effectiveLayerName when layerName is empty', async () => {
    const result = await convertInputs([
      { name: 'drawing.H01', layerName: '', data: ascii('PD40,0;PU;') },
    ], () => {});
    expect(result.files[0].layerName).toBe('drawing');
  });

  it('merges unmatched sidecar diagnostics into totals only', async () => {
    const result = await convertInputs([
      {
        name: 'left/P-00620-1.dr1',
        path: 'left/P-00620-1.dr1',
        kind: 'excellon',
        layerName: 'left',
        data: ascii('T01', 'X0Y0', 'M30'),
      },
      {
        name: 'right/P-00620-1.dr1',
        path: 'right/P-00620-1.dr1',
        kind: 'excellon',
        layerName: 'right',
        data: ascii('T01', 'X0Y0', 'M30'),
      },
      {
        name: 'other/P-00620-1_DRLIST_M.txt',
        path: 'other/P-00620-1_DRLIST_M.txt',
        kind: 'drill-list',
        layerName: 'list',
        data: ascii(
          'Board Name : P-00620-1',
          'File Name : P-00620-1.dr1',
          'Integers 4 , Fractions 2',
          'Units : mm.',
        ),
      },
    ], () => {});

    expect(result.files.map(file => file.name)).toEqual([
      'left/P-00620-1.dr1', 'right/P-00620-1.dr1',
    ]);
    expect(result.files.some(file => file.name.includes('DRLIST'))).toBe(false);
    expect(result.totals.fileCount).toBe(2);
    expect(result.totals.warningCount).toBeGreaterThan(0);
    expect(result.files.every(file => (
      file.diagnostics.every(diagnostic => diagnostic.fileName !== 'P-00620-1_DRLIST_M.txt')
    ))).toBe(true);
  });
});
