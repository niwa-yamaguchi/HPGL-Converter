import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { convertInputs } from '../../src/converter.js';
import { escapeDxfText } from '../../src/dxf/escape.js';
import { assignLayerNames } from '../../src/files/layer-names.js';
import { parseHpgl } from '../../src/hpgl/parser.js';
import {
  parseDxfTags, recordValues, records, sectionTags, validateHandleGraph,
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

const missingReferences = await referenceAvailability();
const testName = missingReferences.length === 0
  ? 'converts all eight reference files into a finite, colored, layered DXF'
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
  const expectedGeometries = inputs.flatMap(input => parseHpgl(input.data, {
    fileName: input.name,
    layerName: input.layerName,
  }).geometries);

  const result = await convertInputs(inputs, () => {});
  const dxf = new TextDecoder().decode(result.buffer);
  const tags = parseDxfTags(dxf);
  const entityRecords = records(sectionTags(tags, 'ENTITIES'));
  const tableRecords = records(sectionTags(tags, 'TABLES'));
  const pairs = entityPairs(dxf);
  const entityTypes = pairs.filter(pair => pair.code === 0).map(pair => pair.value);
  const entityColors = pairs.filter(pair => pair.code === 62).map(pair => Number(pair.value));
  const xCoordinates = pairs
    .filter(pair => pair.code >= 10 && pair.code <= 18)
    .map(pair => Number(pair.value));
  const yCoordinates = pairs
    .filter(pair => pair.code >= 20 && pair.code <= 28)
    .map(pair => Number(pair.value));
  const numericEntityValues = pairs
    .filter(pair => (pair.code >= 10 && pair.code <= 59) || pair.code === 62)
    .map(pair => Number(pair.value));

  expect(result.totals.fileCount).toBe(8);
  expect(result.totals.geometryCount).toBe(53842);
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
  expect(() => validateHandleGraph(tags)).not.toThrow();
  expect(entityRecords).toHaveLength(result.totals.geometryCount);
  expect(entityRecords.every(entity => recordValues(entity, 5).length === 1)).toBe(true);
  expect(entityRecords.every(entity => recordValues(entity, 330).length === 1)).toBe(true);
  expect(entityRecords.every(entity => recordValues(entity, 100).includes('AcDbEntity')))
    .toBe(true);
  expect(entityColors).toEqual(expectedGeometries.map(geometry => geometry.color));
  expect(entityColors.every(color => Number.isInteger(color) && color >= 1 && color <= 255))
    .toBe(true);

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
