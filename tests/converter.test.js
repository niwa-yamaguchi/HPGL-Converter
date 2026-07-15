import { describe, expect, it, vi } from 'vitest';
import * as parserModule from '../src/hpgl/parser.js';
import { convertInputs } from '../src/converter.js';
import { parseDxfTags, recordValues, records, sectionTags } from './dxf/dxf-tags.js';

const ascii = text => new TextEncoder().encode(text);
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
    expect(entityRecords.map(record => recordValues(record, 62)[0])).toEqual(['2', '3']);
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
    expect(section(decode(result.buffer), 'ENTITIES')).toContain('62\n4\n');
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
    const entities = section(decode(result.buffer), 'ENTITIES');
    expect(entities).toContain('8\ndamaged\n62\n6\n');
    expect(entities).toContain('8\ngood\n62\n5\n');
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
      expect(section(decode(result.buffer), 'ENTITIES')).toContain('8\ngood\n62\n5\n');
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
});
