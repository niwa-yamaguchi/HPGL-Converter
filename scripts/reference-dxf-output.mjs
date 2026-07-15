import { writeFile } from 'node:fs/promises';

export const REFERENCE_TOTALS = Object.freeze({
  fileCount: 8,
  geometryCount: 53842,
  errorCount: 0,
  warningCount: 0,
});

export async function writeValidatedReferenceDxf(result, output, write = writeFile) {
  const mismatches = Object.entries(REFERENCE_TOTALS)
    .filter(([key, expected]) => result?.totals?.[key] !== expected)
    .map(([key, expected]) => `${key}: expected ${expected}, got ${result?.totals?.[key]}`);
  if (mismatches.length > 0) {
    throw new RangeError(`Reference contract mismatch: ${mismatches.join('; ')}`);
  }
  await write(output, new Uint8Array(result.buffer));
}
