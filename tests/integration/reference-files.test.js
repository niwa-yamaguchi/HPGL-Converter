import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { convertInputs } from '../../src/converter.js';
import { escapeDxfText } from '../../src/dxf/escape.js';
import { assignLayerNames } from '../../src/files/layer-names.js';
import { parseHpgl } from '../../src/hpgl/parser.js';
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

function normalizedAngle(angle) {
  const normalized = ((angle % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function canonicalGeometry(geometry) {
  const common = {
    layer: escapeDxfText(geometry.layer),
    color: geometry.color,
  };
  switch (geometry.type) {
    case 'line':
      return { type: 'LINE', ...common, values: [...geometry.points[0], 0, ...geometry.points[1], 0] };
    case 'polyline':
      return {
        type: 'LWPOLYLINE', ...common,
        values: [geometry.points.length, 0, ...geometry.points.flat()],
      };
    case 'circle':
      return { type: 'CIRCLE', ...common, values: [...geometry.center, 0, geometry.radius] };
    case 'arc': {
      const sweep = geometry.endAngle - geometry.startAngle;
      const start = sweep > 0 ? geometry.startAngle : geometry.endAngle;
      const end = sweep > 0 ? geometry.endAngle : geometry.startAngle;
      return {
        type: 'ARC', ...common,
        values: [
          ...geometry.center, 0, geometry.radius,
          normalizedAngle(start), normalizedAngle(end),
        ],
      };
    }
    case 'text':
      return {
        type: 'TEXT', ...common,
        values: [...geometry.point, 0, geometry.height, escapeDxfText(geometry.text), geometry.rotation],
      };
    default:
      throw new TypeError(`Unknown reference geometry type: ${geometry.type}`);
  }
}

function canonicalEntity(record) {
  const common = {
    layer: recordValues(record, 8)[0],
    color: Number(recordValues(record, 62)[0]),
  };
  const numbers = code => recordValues(record, code).map(Number);
  switch (record.type) {
    case 'LINE':
      return {
        type: record.type, ...common,
        values: [
          ...numbers(10), ...numbers(20), ...numbers(30),
          ...numbers(11), ...numbers(21), ...numbers(31),
        ],
      };
    case 'LWPOLYLINE': {
      const xs = numbers(10);
      const ys = numbers(20);
      return {
        type: record.type, ...common,
        values: [
          ...numbers(90), ...numbers(70),
          ...xs.flatMap((x, index) => [x, ys[index]]),
        ],
      };
    }
    case 'CIRCLE':
      return {
        type: record.type, ...common,
        values: [...numbers(10), ...numbers(20), ...numbers(30), ...numbers(40)],
      };
    case 'ARC':
      return {
        type: record.type, ...common,
        values: [
          ...numbers(10), ...numbers(20), ...numbers(30), ...numbers(40),
          ...numbers(50), ...numbers(51),
        ],
      };
    case 'TEXT':
      return {
        type: record.type, ...common,
        values: [
          ...numbers(10), ...numbers(20), ...numbers(30), ...numbers(40),
          recordValues(record, 1)[0], ...numbers(50),
        ],
      };
    default:
      throw new TypeError(`Unknown DXF entity type: ${record.type}`);
  }
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
  expect(() => validateRawDxfGraph(tags)).not.toThrow();
  expect(entityRecords).toHaveLength(result.totals.geometryCount);
  expect(entityRecords.every(entity => recordValues(entity, 5).length === 1)).toBe(true);
  expect(entityRecords.every(entity => recordValues(entity, 330).length === 1)).toBe(true);
  expect(entityRecords.every(entity => recordValues(entity, 100).includes('AcDbEntity')))
    .toBe(true);
  expect(entityRecords.map(canonicalEntity)).toEqual(expectedGeometries.map(canonicalGeometry));
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
