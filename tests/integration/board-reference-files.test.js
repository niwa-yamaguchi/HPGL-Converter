import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { convertInputs } from '../../src/converter.js';
import { classifyInputName } from '../../src/files/file-policy.js';
import { combinedBounds } from '../../src/viewer/geometry.js';
import {
  parseDxfTags, recordValues, records, sectionTags, validateRawDxfGraph,
} from '../dxf/dxf-tags.js';

const WORKTREE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KEEP_KINDS = new Set(['gerber', 'excellon', 'gerber-list', 'drill-list']);
const DRAWABLE_KINDS = new Set(['gerber', 'excellon']);
const CENTERLINE_TIMEOUT_MS = 360_000;
const OUTLINE_COMPARE_TIMEOUT_MS = 180_000;
const OUTLINE_COMPARE_FOLDER = 'P-00606-1_fan_ctrl_board';

const BOARDS = [
  {
    folderName: 'P-00620-1-基板作成データ',
    expectedDrawable: 10,
    assertNoUnknownTool: true,
  },
  {
    folderName: OUTLINE_COMPARE_FOLDER,
    expectedDrawable: 13,
    assertNoUnknownTool: false,
  },
  {
    folderName: 'Contact-Monitor-Board',
    expectedDrawable: 9,
    assertNoUnknownTool: false,
  },
];

function resolveBoardDirectory(folderName) {
  const local = path.join(WORKTREE_ROOT, 'reference', folderName);
  if (existsSync(local)) {
    return local;
  }
  return path.join(WORKTREE_ROOT, '..', '..', 'reference', folderName);
}

async function collectManufacturingInputs(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const inputs = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const parent = entry.parentPath ?? entry.path ?? directory;
    const fullPath = path.join(parent, entry.name);
    const relative = path.relative(directory, fullPath).split(path.sep).join('/');
    const kind = classifyInputName(relative);
    if (!KEEP_KINDS.has(kind)) {
      continue;
    }
    inputs.push({
      name: relative,
      path: relative,
      kind,
      layerName: '',
      data: new Uint8Array(await readFile(fullPath)),
    });
  }
  inputs.sort((left, right) => left.name.localeCompare(right.name));
  return inputs;
}

function decode(buffer) {
  return new TextDecoder().decode(buffer);
}

function number(record, code, index = 0) {
  return Number(recordValues(record, code)[index]);
}

function geometriesFromDxf(dxf) {
  return records(sectionTags(parseDxfTags(dxf), 'ENTITIES')).map(record => {
    if (record.type === 'LINE') {
      return {
        type: 'line',
        points: [[number(record, 10), number(record, 20)], [number(record, 11), number(record, 21)]],
      };
    }
    if (record.type === 'LWPOLYLINE') {
      const xs = recordValues(record, 10).map(Number);
      const ys = recordValues(record, 20).map(Number);
      return {
        type: 'polyline',
        closed: (number(record, 70) & 1) === 1,
        points: xs.map((x, index) => [x, ys[index]]),
      };
    }
    if (record.type === 'CIRCLE') {
      return {
        type: 'circle',
        center: [number(record, 10), number(record, 20)],
        radius: number(record, 40),
      };
    }
    if (record.type === 'ARC') {
      return {
        type: 'arc',
        center: [number(record, 10), number(record, 20)],
        radius: number(record, 40),
        startAngle: number(record, 50),
        endAngle: number(record, 51),
      };
    }
    return {
      type: 'text',
      point: [number(record, 10), number(record, 20)],
      text: recordValues(record, 1)[0] ?? '',
      height: number(record, 40),
      rotation: Number(recordValues(record, 50)[0] ?? 0),
    };
  });
}

function countTypes(geometries, types) {
  return geometries.filter(geometry => types.has(geometry.type)).length;
}

function assertCenterlineResult(result, board, drawableNames) {
  expect(result.totals.fileCount).toBe(board.expectedDrawable);
  expect(result.totals.errorCount).toBe(0);
  expect(result.totals.geometryCount).toBeGreaterThan(0);
  expect(result.files).toHaveLength(board.expectedDrawable);
  expect(result.files.map(file => file.name).sort()).toEqual([...drawableNames].sort());
  expect(result.files.every(file => DRAWABLE_KINDS.has(classifyInputName(file.name)))).toBe(true);
  expect(result.files.every(file => file.geometryCount >= 0)).toBe(true);
}

it('ignores generated board-reference output under tmp/', async () => {
  const ignoreFile = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
  const rules = ignoreFile.split(/\r?\n/).filter(Boolean);
  expect(rules).toContain('tmp/');
});

for (const board of BOARDS) {
  const directory = resolveBoardDirectory(board.folderName);
  const exists = existsSync(directory);
  const title = exists
    ? `converts ${board.folderName} manufacturing files in centerline`
    : `skips ${board.folderName} because missing ${directory}`;

  it.skipIf(!exists)(title, async () => {
    const inputs = await collectManufacturingInputs(directory);
    const drawableNames = inputs
      .filter(input => DRAWABLE_KINDS.has(input.kind))
      .map(input => input.name);

    const centerline = await convertInputs(inputs, () => {}, { strokeMode: 'centerline' });
    assertCenterlineResult(centerline, board, drawableNames);

    const centerlineDxf = decode(centerline.buffer);
    const centerlineGeometries = geometriesFromDxf(centerlineDxf);
    const centerlineEntities = records(sectionTags(parseDxfTags(centerlineDxf), 'ENTITIES'));

    expect(Object.values(combinedBounds(centerlineGeometries)).every(Number.isFinite)).toBe(true);
    expect(() => validateRawDxfGraph(parseDxfTags(centerlineDxf))).not.toThrow();
    expect(centerlineGeometries.some(geometry => (
      geometry.type === 'polyline' && geometry.closed === true
    ))).toBe(true);
    expect(centerlineEntities.some(record => (
      record.type === 'LWPOLYLINE' && (Number(recordValues(record, 70)[0]) & 1) === 1
    ))).toBe(true);
    expect(centerlineGeometries.some(geometry => geometry.type === 'circle')).toBe(true);
    expect(centerlineEntities.some(record => record.type === 'CIRCLE')).toBe(true);

    if (board.assertNoUnknownTool) {
      expect(centerline.files.some(file => String(file.layerName).includes('_UNKNOWN_T'))).toBe(false);
      expect(centerlineDxf).not.toContain('_UNKNOWN_T');
      expect(centerline.files.flatMap(file => file.diagnostics).some(diagnostic => (
        /_UNKNOWN_T|diameter is unknown/i.test(`${diagnostic.message} ${diagnostic.command}`)
      ))).toBe(false);
    }
  }, CENTERLINE_TIMEOUT_MS);
}

{
  const directory = resolveBoardDirectory(OUTLINE_COMPARE_FOLDER);
  const exists = existsSync(directory);
  const title = exists
    ? `emits more LINE or ARC in centerline than outline for ${OUTLINE_COMPARE_FOLDER}`
    : `skips ${OUTLINE_COMPARE_FOLDER} outline compare because missing ${directory}`;

  it.skipIf(!exists)(title, async () => {
    const inputs = await collectManufacturingInputs(directory);
    const outline = await convertInputs(inputs, () => {}, { strokeMode: 'outline' });
    const centerline = await convertInputs(inputs, () => {}, { strokeMode: 'centerline' });
    const outlineGeometries = geometriesFromDxf(decode(outline.buffer));
    const centerlineGeometries = geometriesFromDxf(decode(centerline.buffer));
    const outlineLineArc = countTypes(outlineGeometries, new Set(['line', 'arc']));
    const centerlineLineArc = countTypes(centerlineGeometries, new Set(['line', 'arc']));
    expect(outline.totals.errorCount).toBe(0);
    expect(centerline.totals.errorCount).toBe(0);
    expect(centerlineLineArc).toBeGreaterThan(outlineLineArc);
  }, OUTLINE_COMPARE_TIMEOUT_MS);
}
