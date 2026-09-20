import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertInputs } from '../src/converter.js';
import { classifyInputName } from '../src/files/file-policy.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEEP_KINDS = new Set(['gerber', 'excellon', 'gerber-list', 'drill-list']);
const STROKE_MODES = ['outline', 'centerline'];
const BOARD_FOLDERS = [
  'P-00620-1-基板作成データ',
  'P-00606-1_fan_ctrl_board',
  'Contact-Monitor-Board',
];

function resolveBoardDirectory(folderName) {
  const local = path.join(ROOT, 'reference', folderName);
  if (existsSync(local)) {
    return local;
  }
  return path.join(ROOT, '..', '..', 'reference', folderName);
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

async function convertBoard(directory, folderLeaf, strokeMode, outputDir) {
  const inputs = await collectManufacturingInputs(directory);
  const started = Date.now();
  const result = await convertInputs(inputs, event => {
    console.log(JSON.stringify({
      folder: folderLeaf,
      strokeMode,
      fileName: event.fileName,
      index: event.index,
      total: event.total,
      geometryCount: event.geometryCount,
      errorCount: event.errorCount,
    }));
  }, { strokeMode });
  const stem = `${folderLeaf}-${strokeMode}`;
  await writeFile(path.join(outputDir, `${stem}.dxf`), new Uint8Array(result.buffer));
  await writeFile(
    path.join(outputDir, `${stem}.json`),
    `${JSON.stringify({
      folder: folderLeaf,
      strokeMode,
      elapsedMs: Date.now() - started,
      totals: result.totals,
      files: result.files,
    }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ stem, totals: result.totals, elapsedMs: Date.now() - started }));
}

const outputDir = path.join(ROOT, 'tmp', 'board-reference-dxf');
await mkdir(outputDir, { recursive: true });

let missing = false;
for (const folderName of BOARD_FOLDERS) {
  const directory = resolveBoardDirectory(folderName);
  if (!existsSync(directory)) {
    console.error(`missing ${directory}`);
    missing = true;
    continue;
  }
  const folderLeaf = path.basename(directory);
  for (const strokeMode of STROKE_MODES) {
    await convertBoard(directory, folderLeaf, strokeMode, outputDir);
  }
}

if (missing) {
  process.exitCode = 1;
}
