import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDrillList, parseGerberList } from '../../src/manufacturing/sidecars.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sidecars');
const loadFixture = name => new Uint8Array(readFileSync(join(fixtureDir, name)));

const gerberListBytes = loadFixture('P-00620-1_X-GBLIST.txt');
const drillListBytes = loadFixture('P-00620-1_DRLIST_M.txt');

describe('sidecar lists', () => {
  it('maps G03 and drill T01 from the two P-00620 lists', () => {
    const gerber = parseGerberList(gerberListBytes);
    const drill = parseDrillList(drillListBytes);
    expect(gerber.layers.get('P-00620-1.G03')).toBe('G03_Symbol_Mark_Top');
    expect(drill.fileName).toBe('P-00620-1.dr1');
    expect(drill.defaults).toMatchObject({
      units: 'mm', integerDigits: 4, fractionDigits: 2,
    });
    expect(drill.defaults.tools.get(1)).toBe(0.4);
  });

  it('records board names, leading-zero suppression, and a no-side Gerber label', () => {
    const gerber = parseGerberList(gerberListBytes);
    const drill = parseDrillList(drillListBytes);
    expect(gerber.boardName).toBe('P-00620-1');
    expect(gerber.layers.get('P-00620-1.G09')).toBe('G09_Board_Outline');
    expect(drill.boardName).toBe('P-00620-1');
    expect(drill.defaults.zeroSuppression).toBe('L');
    expect(drill.defaults.tools.get(2)).toBe(0.6);
  });

  it('treats Metric/mm. as millimetres and leaves unspecified zero suppression null', () => {
    const drill = parseDrillList([
      'Board Name  :  sample',
      'Database Format     :  Integers 3 , Fractions 3',
      'Units               :  Metric',
      'File Name   :  sample.drl',
      '     T03  |     1.250  :      Through  :       1  :',
    ].join('\n'));
    expect(drill.defaults).toMatchObject({
      units: 'mm', integerDigits: 3, fractionDigits: 3, zeroSuppression: null,
    });
    expect(drill.defaults.tools.get(3)).toBe(1.25);
  });
});
