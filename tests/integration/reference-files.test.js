import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { convertInputs } from '../../src/converter.js';
import { escapeDxfText } from '../../src/dxf/escape.js';
import { assignLayerNames } from '../../src/files/layer-names.js';
import {
  parseDxfTags, recordValues, records, sectionTags, validateRawDxfGraph,
} from '../dxf/dxf-tags.js';

const REFERENCE_DIRECTORY = fileURLToPath(new URL('../../reference/', import.meta.url));
const REFERENCE_FILES = [
  'P-00235BH01.H01',
  'P-00235BH02.H02',
  'P-00235BH03.H03',
  'P-00235BH04.H04',
  'P-00235BH05.H05',
  'P-00235BH06.H06',
  'P-00235BH07.H07',
  'P-00235B_dr1.H01',
];

const REFERENCE_FINGERPRINTS = {
  'P-00235BH01.H01': '218eaa89f572ae1df89e2f7cfe5a82e285b46ff27c31d6d1aab64baad377899d',
  'P-00235BH02.H02': 'ad5863f0202603ff9a933762294be5c5a747a0b6b6c332e6933e331741e20493',
  'P-00235BH03.H03': '048bbee39fce0fca356bc2d7f6d8e19d019da5b5cbc6eb6f174563ef313b8249',
  'P-00235BH04.H04': 'a7963b2209638f9515404ebfdf2e3c3c63db815df50ed50b3c8ef623877108d3',
  'P-00235BH05.H05': '51477664b9a4b4514465ae1517eef03bc4594b424f4dd598d608bf8bcf866ef4',
  'P-00235BH06.H06': 'b37d6c56effe3f2371f76c1ebf52ef8da98d266c39f5aad625a1ecfec473941a',
  'P-00235BH07.H07': '9dd581fcf2ea93eb1dee9bf1eee80867af0aee75174f002be8ec4b14eab4f041',
  'P-00235B_dr1.H01': '9dd22266ac3abca9836bef1e5c313edd048a829b505d04cc83407a8e4b1c7010',
};

async function referenceAvailability() {
  try {
    const names = new Set(await readdir(REFERENCE_DIRECTORY));
    return REFERENCE_FILES.filter(name => !names.has(name));
  } catch {
    return [...REFERENCE_FILES];
  }
}

function entityPairs(dxf) {
  const marker = '0\nSECTION\n2\nENTITIES\n';
  const start = dxf.indexOf(marker);
  const end = dxf.indexOf('0\nENDSEC\n', start + marker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  const lines = dxf.slice(start + marker.length, end).split('\n');
  const pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    pairs.push({ code: Number(lines[index]), value: lines[index + 1] });
  }
  return pairs;
}

function normalizedPrimitives(record) {
  const numbers = code => recordValues(record, code).map(Number);
  switch (record.type) {
    case 'LINE':
      return [{
        type: 'segment',
        start: [numbers(10)[0], numbers(20)[0]],
        end: [numbers(11)[0], numbers(21)[0]],
      }];
    case 'LWPOLYLINE': {
      const xs = numbers(10);
      const ys = numbers(20);
      const points = xs.map((x, index) => [x, ys[index]]);
      const segments = points.slice(1).map((end, index) => ({
        type: 'segment', start: points[index], end,
      }));
      if ((numbers(70)[0] & 1) !== 0) {
        segments.push({ type: 'segment', start: points.at(-1), end: points[0] });
      }
      return segments;
    }
    case 'CIRCLE':
      return [{
        type: 'circle',
        center: [numbers(10)[0], numbers(20)[0]],
        radius: numbers(40)[0],
      }];
    case 'ARC':
      return [{
        type: 'arc',
        center: [numbers(10)[0], numbers(20)[0]],
        radius: numbers(40)[0],
        startAngle: numbers(50)[0],
        endAngle: numbers(51)[0],
      }];
    case 'TEXT':
      return [{
        type: 'text',
        point: [numbers(10)[0], numbers(20)[0]],
        text: recordValues(record, 1)[0],
        height: numbers(40)[0],
        rotation: numbers(50)[0],
      }];
    default:
      throw new TypeError(`Unknown DXF entity type: ${record.type}`);
  }
}

function fingerprintLayer(entityRecords, layerName) {
  const primitives = entityRecords
    .filter(record => recordValues(record, 8)[0] === escapeDxfText(layerName))
    .flatMap(normalizedPrimitives);
  return createHash('sha256').update(JSON.stringify(primitives)).digest('hex');
}

const missingReferences = await referenceAvailability();
const testName = missingReferences.length === 0
  ? 'converts all eight reference files into a finite, ByLayer, layered DXF'
  : `skips reference integration because these user files are unavailable: ${missingReferences.join(', ')}`;

it('ignores local build artifacts while retaining the worktree rules', async () => {
  const ignoreFile = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
  const rules = ignoreFile.split(/\r?\n/).filter(Boolean);

  expect(rules).toEqual(expect.arrayContaining([
    '.worktrees/',
    '.superpowers/',
    'node_modules/',
    'dist/',
    'coverage/',
    '*.dxf',
  ]));
});

it.skipIf(missingReferences.length > 0)(testName, async () => {
  const discovered = (await readdir(REFERENCE_DIRECTORY))
    .filter(name => REFERENCE_FILES.includes(name))
    .sort();
  expect(discovered).toHaveLength(8);
  expect(discovered).toEqual([...REFERENCE_FILES].sort());

  const layerNames = assignLayerNames(discovered);
  const inputs = await Promise.all(discovered.map(async (name, index) => ({
    name,
    layerName: layerNames[index],
    data: new Uint8Array(await readFile(new URL(`../../reference/${name}`, import.meta.url))),
  })));
  const result = await convertInputs(inputs, () => {});
  const dxf = new TextDecoder().decode(result.buffer);
  const tags = parseDxfTags(dxf);
  const entityRecords = records(sectionTags(tags, 'ENTITIES'));
  const tableRecords = records(sectionTags(tags, 'TABLES'));
  const pairs = entityPairs(dxf);
  const entityTypes = pairs.filter(pair => pair.code === 0).map(pair => pair.value);
  const entityColorTags = pairs.filter(pair => pair.code === 62);
  const xCoordinates = pairs
    .filter(pair => pair.code >= 10 && pair.code <= 18)
    .map(pair => Number(pair.value));
  const yCoordinates = pairs
    .filter(pair => pair.code >= 20 && pair.code <= 28)
    .map(pair => Number(pair.value));
  const numericEntityValues = pairs
    .filter(pair => pair.code >= 10 && pair.code <= 59)
    .map(pair => Number(pair.value));

  expect(result.totals.fileCount).toBe(8);
  expect(result.totals.errorCount).toBe(0);
  expect(result.totals.warningCount).toBe(0);
  expect(result.files).toHaveLength(8);
  expect(result.files.every(file => file.geometryCount > 0)).toBe(true);
  expect(result.files.flatMap(file => file.diagnostics).some(diagnostic => (
    diagnostic.command === 'CT'
  ))).toBe(false);
  expect(result.totals.geometryCount).toBe(
    result.files.reduce((total, file) => total + file.geometryCount, 0),
  );
  expect(entityTypes).toHaveLength(result.totals.geometryCount);
  expect(() => validateRawDxfGraph(tags)).not.toThrow();
  expect(entityRecords).toHaveLength(result.totals.geometryCount);
  expect(entityRecords.every(entity => recordValues(entity, 5).length === 1)).toBe(true);
  expect(entityRecords.every(entity => recordValues(entity, 330).length === 1)).toBe(true);
  expect(entityRecords.every(entity => recordValues(entity, 100).includes('AcDbEntity')))
    .toBe(true);
  expect(entityColorTags).toEqual([]);
  expect(Object.fromEntries(discovered.map((name, index) => [
    name,
    fingerprintLayer(entityRecords, layerNames[index]),
  ]))).toEqual(REFERENCE_FINGERPRINTS);

  const dxfLayerNames = tableRecords
    .filter(record => record.type === 'LAYER')
    .map(record => recordValues(record, 2)[0]);
  expect(dxfLayerNames).toEqual(['0', ...layerNames.map(escapeDxfText)]);
  expect(dxfLayerNames.slice(1)).toHaveLength(8);
  for (const layerName of layerNames) {
    const escaped = escapeDxfText(layerName);
    expect(dxf).toContain(`2\n${escaped}\n`);
    expect(dxf).toContain(`8\n${escaped}\n`);
  }

  expect(numericEntityValues.length).toBeGreaterThan(0);
  expect(numericEntityValues.every(Number.isFinite)).toBe(true);
  expect(Math.max(...xCoordinates) - Math.min(...xCoordinates)).toBeGreaterThan(0);
  expect(Math.max(...yCoordinates) - Math.min(...yCoordinates)).toBeGreaterThan(0);

  const firstEntity = entityRecords[0];
  expect(firstEntity.type).toBe('LINE');
  expect(Number(recordValues(firstEntity, 10)[0])).toBeCloseTo(2367 / 40, 12);
  expect(Number(recordValues(firstEntity, 20)[0])).toBeCloseTo(4553 / 40, 12);
  expect(Number(recordValues(firstEntity, 11)[0])).toBeCloseTo(2367 / 40, 12);
  expect(Number(recordValues(firstEntity, 21)[0])).toBeCloseTo(4590 / 40, 12);
});
