import { readFile, writeFile } from 'node:fs/promises';
import { convertInputs } from '../src/converter.js';
import { assignLayerNames } from '../src/files/layer-names.js';
import { writeValidatedReferenceDxf } from './reference-dxf-output.mjs';

const names = [
  'P-00235BH01.H01',
  'P-00235BH02.H02',
  'P-00235BH03.H03',
  'P-00235BH04.H04',
  'P-00235BH05.H05',
  'P-00235BH06.H06',
  'P-00235BH07.H07',
  'P-00235B_dr1.H01',
].sort();
const layers = assignLayerNames(names);
const inputs = await Promise.all(names.map(async (name, index) => ({
  name,
  layerName: layers[index],
  data: new Uint8Array(await readFile(new URL(`../reference/${name}`, import.meta.url))),
})));
const result = await convertInputs(inputs, () => {});
await writeValidatedReferenceDxf(
  result,
  new URL('../hpgl-dxf-reference-8-files-r2000.dxf', import.meta.url),
  writeFile,
);
console.log(JSON.stringify(result.totals));
