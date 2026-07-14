import { describe, expect, it } from 'vitest';
import { writeDxf } from '../../src/dxf/writer.js';

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
    expect(text).toContain('0\nLTYPE\n2\nCONTINUOUS\n');
    expect(text).toContain('0\nTABLE\n2\nLAYER\n');
    expect(text).toContain('0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n');
    expect(section(text, 'BLOCKS')).toBe('');
    expect(section(text, 'ENTITIES')).toBe('');
    expect(section(text, 'OBJECTS')).toBe('');
    expect(text.endsWith('0\nEOF\n')).toBe(true);
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
});

describe('writeDxf entities', () => {
  it('writes exact entities with direct ACI colors in input order', () => {
    const text = joined({
      layers: ['line', 'poly', 'circle', 'positive', 'negative', 'text'],
      geometries: [
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
      ],
    });

    expect(section(text, 'ENTITIES')).toBe(
      '0\nLINE\n8\nline\n62\n1\n10\n1\n20\n2\n30\n0\n11\n3\n21\n4\n31\n0\n'
      + '0\nLWPOLYLINE\n8\npoly\n62\n2\n90\n3\n70\n0\n10\n5\n20\n6\n10\n7\n20\n8\n10\n9\n20\n10\n'
      + '0\nCIRCLE\n8\ncircle\n62\n3\n10\n11\n20\n12\n30\n0\n40\n13\n'
      + '0\nARC\n8\npositive\n62\n4\n10\n14\n20\n15\n30\n0\n40\n16\n50\n350\n51\n45\n'
      + '0\nARC\n8\nnegative\n62\n5\n10\n17\n20\n18\n30\n0\n40\n19\n50\n350\n51\n45\n'
      + '0\nTEXT\n8\ntext\n62\n6\n10\n20\n20\n21\n30\n0\n40\n5\n1\n\\U+90E8 A\n50\n-90\n',
    );
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
