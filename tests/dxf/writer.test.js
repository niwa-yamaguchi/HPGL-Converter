import { describe, expect, it } from 'vitest';
import { writeDxf } from '../../src/dxf/writer.js';
import { parseDxfTags, recordValues, records, sectionTags } from './dxf-tags.js';

function joined(input) {
  return writeDxf(input).join('');
}

function section(text, name) {
  const startMarker = `0\nSECTION\n2\n${name}\n`;
  const start = text.indexOf(startMarker);
  const end = text.indexOf('0\nENDSEC\n', start);
  return text.slice(start + startMarker.length, end);
}

describe('writeDxf structure', () => {
  it('writes AutoCAD 2000 millimeter header, all required sections, and exact EOF', () => {
    const chunks = writeDxf({ layers: [], geometries: [] });
    const text = chunks.join('');

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(chunk => chunk.endsWith('\n'))).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).toContain('9\n$ACADVER\n1\nAC1015\n');
    expect(text).toContain('9\n$INSUNITS\n70\n4\n');
    expect(text).toContain('0\nTABLE\n2\nLTYPE\n');
    expect(text).toContain('0\nTABLE\n2\nLAYER\n');
    const tableRecords = records(sectionTags(parseDxfTags(text), 'TABLES'));
    expect(tableRecords.some(record => (
      record.type === 'LTYPE' && recordValues(record, 2)[0] === 'CONTINUOUS'
    ))).toBe(true);
    const layer0 = tableRecords.find(record => (
      record.type === 'LAYER' && recordValues(record, 2)[0] === '0'
    ));
    expect(recordValues(layer0, 70)).toEqual(['0']);
    expect(recordValues(layer0, 62)).toEqual(['7']);
    expect(recordValues(layer0, 6)).toEqual(['CONTINUOUS']);
    expect(section(text, 'ENTITIES')).toBe('');
    expect(text.endsWith('0\nEOF\n')).toBe(true);
  });

  it('writes the required R2000 tables, spaces, viewport, and dictionaries', () => {
    const text = joined({ layers: [], geometries: [] });
    const tags = parseDxfTags(text);
    const sectionNames = [];
    for (let index = 0; index + 1 < tags.length; index += 1) {
      if (tags[index].code === 0 && tags[index].value === 'SECTION'
        && tags[index + 1].code === 2) {
        sectionNames.push(tags[index + 1].value);
      }
    }
    expect(sectionNames).toEqual(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']);

    const tableRecords = records(sectionTags(tags, 'TABLES'));
    const tableNames = tableRecords
      .filter(record => record.type === 'TABLE')
      .map(record => recordValues(record, 2)[0]);
    expect(tableNames).toEqual([
      'VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD',
    ]);
    expect(tableRecords.some(record => (
      record.type === 'VPORT' && recordValues(record, 2)[0] === '*ACTIVE'
    ))).toBe(true);
    expect(tableRecords.filter(record => record.type === 'BLOCK_RECORD')
      .map(record => recordValues(record, 2)[0])).toEqual(['*Model_Space', '*Paper_Space']);
    expect(tableRecords.filter(record => record.type === 'DIMSTYLE')).toEqual([]);

    const blockRecords = records(sectionTags(tags, 'BLOCKS'));
    expect(blockRecords.map(record => record.type)).toEqual(['BLOCK', 'ENDBLK', 'BLOCK', 'ENDBLK']);
    expect(records(sectionTags(tags, 'ENTITIES'))).toEqual([]);
    expect(records(sectionTags(tags, 'OBJECTS')).map(record => record.type))
      .toEqual(['DICTIONARY', 'DICTIONARY']);
  });

  it('registers layer 0 and unique input layers in order and escapes Unicode', () => {
    const text = joined({
      layers: ['部品', 'outline', '部品', '0'],
      geometries: [
        { type: 'line', layer: '部品', color: 2, points: [[0, 0], [1, 1]] },
      ],
    });
    const tables = section(text, 'TABLES');
    const escapedLayer = '\\U+90E8\\U+54C1';

    expect(tables.match(/0\nLAYER\n/g)).toHaveLength(3);
    expect(tables.indexOf('2\n0\n')).toBeLessThan(tables.indexOf(`2\n${escapedLayer}\n`));
    expect(tables.indexOf(`2\n${escapedLayer}\n`)).toBeLessThan(tables.indexOf('2\noutline\n'));
    expect(tables.split(`2\n${escapedLayer}\n`)).toHaveLength(2);
    expect(section(text, 'ENTITIES')).toContain(`8\n${escapedLayer}\n`);
  });

  it('deduplicates layers by their final escaped group 2 value', () => {
    const text = joined({
      layers: ['control\nname', 'control\rname', 'control name'],
      geometries: [
        { type: 'line', layer: 'control\nname', color: 2, points: [[0, 0], [1, 1]] },
      ],
    });
    const tables = section(text, 'TABLES');
    const layerNames = records(sectionTags(parseDxfTags(text), 'TABLES'))
      .filter(record => record.type === 'LAYER')
      .map(record => recordValues(record, 2)[0]);

    expect(tables.match(/0\nLAYER\n/g)).toHaveLength(2);
    expect(layerNames).toEqual(['0', 'control name']);
    expect(section(text, 'ENTITIES')).toContain('8\ncontrol name\n');
  });
});

describe('writeDxf entities', () => {
  it('writes owned R2000 entities with direct ACI colors in input order', () => {
    const layers = ['line', 'poly', 'circle', 'positive', 'negative', 'text'];
    const geometries = [
      { type: 'line', layer: 'line', color: 1, points: [[1, 2], [3, 4]] },
      { type: 'polyline', layer: 'poly', color: 2, points: [[5, 6], [7, 8], [9, 10]] },
      { type: 'circle', layer: 'circle', color: 3, center: [11, 12], radius: 13 },
      {
        type: 'arc', layer: 'positive', color: 4, center: [14, 15], radius: 16,
        startAngle: -10, endAngle: 45,
      },
      {
        type: 'arc', layer: 'negative', color: 5, center: [17, 18], radius: 19,
        startAngle: 45, endAngle: -10,
      },
      {
        type: 'text', layer: 'text', color: 6, point: [20, 21],
        text: '部\nA', height: 5, rotation: -90,
      },
    ];
    const text = joined({ layers, geometries });
    const tags = parseDxfTags(text);
    const entityRecords = records(sectionTags(tags, 'ENTITIES'));

    expect(entityRecords.map(record => record.type))
      .toEqual(['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'ARC', 'TEXT']);

    const expectedSubclasses = {
      LINE: ['AcDbEntity', 'AcDbLine'],
      LWPOLYLINE: ['AcDbEntity', 'AcDbPolyline'],
      CIRCLE: ['AcDbEntity', 'AcDbCircle'],
      ARC: ['AcDbEntity', 'AcDbCircle', 'AcDbArc'],
      TEXT: ['AcDbEntity', 'AcDbText', 'AcDbText'],
    };
    const modelSpace = records(sectionTags(tags, 'TABLES')).find(record => (
      record.type === 'BLOCK_RECORD' && recordValues(record, 2)[0] === '*Model_Space'
    ));
    const modelSpaceHandle = recordValues(modelSpace, 5)[0];
    for (const record of entityRecords) {
      expect(recordValues(record, 5)).toHaveLength(1);
      expect(recordValues(record, 330)).toEqual([modelSpaceHandle]);
      expect(recordValues(record, 100)).toEqual(expectedSubclasses[record.type]);
      expect(recordValues(record, 8)).toHaveLength(1);
      expect(recordValues(record, 62)).toHaveLength(1);
    }
    expect(new Set(entityRecords.flatMap(record => recordValues(record, 5))).size)
      .toBe(entityRecords.length);
    expect(entityRecords.map(record => recordValues(record, 8)[0])).toEqual(layers);
    expect(entityRecords.map(record => recordValues(record, 62)[0]))
      .toEqual(['1', '2', '3', '4', '5', '6']);

    const [line, polyline, circle, positiveArc, negativeArc, textEntity] = entityRecords;
    expect(recordValues(line, 10)).toEqual(['1']);
    expect(recordValues(line, 20)).toEqual(['2']);
    expect(recordValues(line, 11)).toEqual(['3']);
    expect(recordValues(line, 21)).toEqual(['4']);
    expect(recordValues(polyline, 90)).toEqual(['3']);
    expect(recordValues(polyline, 10)).toEqual(['5', '7', '9']);
    expect(recordValues(polyline, 20)).toEqual(['6', '8', '10']);
    expect(recordValues(circle, 10)).toEqual(['11']);
    expect(recordValues(circle, 20)).toEqual(['12']);
    expect(recordValues(circle, 40)).toEqual(['13']);
    expect(recordValues(positiveArc, 50)).toEqual(['350']);
    expect(recordValues(positiveArc, 51)).toEqual(['45']);
    expect(recordValues(negativeArc, 50)).toEqual(['350']);
    expect(recordValues(negativeArc, 51)).toEqual(['45']);
    expect(recordValues(textEntity, 10)).toEqual(['20']);
    expect(recordValues(textEntity, 20)).toEqual(['21']);
    expect(recordValues(textEntity, 40)).toEqual(['5']);
    expect(recordValues(textEntity, 1)).toEqual(['\\U+90E8 A']);
    expect(recordValues(textEntity, 50)).toEqual(['-90']);

    const positiveArcTags = positiveArc.tags.map(tag => [tag.code, tag.value]);
    expect(positiveArcTags.indexOf(positiveArcTags.find(tag => tag[1] === 'AcDbCircle')))
      .toBeLessThan(positiveArcTags.findIndex(tag => tag[0] === 10));
    expect(positiveArcTags.indexOf(positiveArcTags.find(tag => tag[1] === 'AcDbArc')))
      .toBeLessThan(positiveArcTags.findIndex(tag => tag[0] === 50));
    const textTags = textEntity.tags.map(tag => [tag.code, tag.value]);
    expect(textTags.at(-1)).toEqual([100, 'AcDbText']);
  });

  it('swaps negative-sweep arc angles before normalization', () => {
    const text = joined({
      layers: ['clockwise'],
      geometries: [{
        type: 'arc', layer: 'clockwise', color: 7, center: [0, 0], radius: 1,
        startAngle: 90, endAngle: -180,
      }],
    });

    expect(section(text, 'ENTITIES')).toContain('50\n180\n51\n90\n');
  });
});

describe('writeDxf validation', () => {
  const validLine = { type: 'line', layer: 'a', color: 1, points: [[0, 0], [1, 1]] };

  it.each([
    ['non-array layers', { layers: 'a', geometries: [] }, /layers.*array/i],
    ['non-string layer', { layers: [42], geometries: [] }, /layer.*string/i],
    ['non-array geometries', { layers: [], geometries: null }, /geometries.*array/i],
    ['non-finite LINE coordinate', { layers: ['a'], geometries: [{ ...validLine, points: [[0, 0], [Infinity, 1]] }] }, /coordinate.*finite/i],
    ['wrong LINE point count', { layers: ['a'], geometries: [{ ...validLine, points: [[0, 0]] }] }, /LINE.*2 points/i],
    ['short LWPOLYLINE', { layers: ['a'], geometries: [{ ...validLine, type: 'polyline' }] }, /LWPOLYLINE.*3 points/i],
    ['non-positive CIRCLE radius', { layers: ['a'], geometries: [{ type: 'circle', layer: 'a', color: 1, center: [0, 0], radius: 0 }] }, /radius.*positive/i],
    ['non-finite ARC radius', { layers: ['a'], geometries: [{ type: 'arc', layer: 'a', color: 1, center: [0, 0], radius: NaN, startAngle: 0, endAngle: 90 }] }, /radius.*finite/i],
    ['zero ARC sweep', { layers: ['a'], geometries: [{ type: 'arc', layer: 'a', color: 1, center: [0, 0], radius: 1, startAngle: 10, endAngle: 10 }] }, /sweep.*non-zero/i],
    ['full ARC sweep', { layers: ['a'], geometries: [{ type: 'arc', layer: 'a', color: 1, center: [0, 0], radius: 1, startAngle: 10, endAngle: 370 }] }, /sweep.*less than 360/i],
    ['non-positive TEXT height', { layers: ['a'], geometries: [{ type: 'text', layer: 'a', color: 1, point: [0, 0], text: 'A', height: 0, rotation: 0 }] }, /height.*positive/i],
    ['non-finite TEXT rotation', { layers: ['a'], geometries: [{ type: 'text', layer: 'a', color: 1, point: [0, 0], text: 'A', height: 1, rotation: NaN }] }, /rotation.*finite/i],
    ['ACI below range', { layers: ['a'], geometries: [{ ...validLine, color: 0 }] }, /color.*1.*255/i],
    ['ACI above range', { layers: ['a'], geometries: [{ ...validLine, color: 256 }] }, /color.*1.*255/i],
    ['fractional ACI', { layers: ['a'], geometries: [{ ...validLine, color: 1.5 }] }, /color.*integer/i],
    ['unknown geometry', { layers: ['a'], geometries: [{ type: 'spline' }] }, /unknown geometry type.*spline/i],
  ])('rejects %s', (_label, input, message) => {
    expect(() => writeDxf(input)).toThrow(message);
  });
});
