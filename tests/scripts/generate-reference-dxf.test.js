import { describe, expect, it, vi } from 'vitest';
import { writeValidatedReferenceDxf } from '../../scripts/reference-dxf-output.mjs';

const validResult = {
  buffer: new Uint8Array([1, 2, 3]).buffer,
  totals: {
    fileCount: 8,
    geometryCount: 1,
    errorCount: 0,
    warningCount: 0,
  },
};

describe('writeValidatedReferenceDxf', () => {
  it('writes when geometry count is a positive finite integer without requiring a fixed count', async () => {
    const write = vi.fn();
    const result = {
      ...validResult,
      totals: { ...validResult.totals, geometryCount: 53841 },
    };

    await writeValidatedReferenceDxf(result, 'output.dxf', write);

    expect(write).toHaveBeenCalledWith('output.dxf', new Uint8Array(result.buffer));
  });

  it.each([
    ['conversion errors', { errorCount: 1 }],
    ['conversion warnings', { warningCount: 1 }],
    ['file count mismatch', { fileCount: 7 }],
    ['zero geometries', { geometryCount: 0 }],
    ['negative geometry count', { geometryCount: -1 }],
    ['fractional geometry count', { geometryCount: 1.5 }],
    ['non-finite geometry count', { geometryCount: Number.POSITIVE_INFINITY }],
  ])('refuses to write when totals contain %s', async (_label, totals) => {
    const write = vi.fn();
    const result = {
      ...validResult,
      totals: { ...validResult.totals, ...totals },
    };

    await expect(writeValidatedReferenceDxf(result, 'output.dxf', write))
      .rejects.toThrow(/reference contract/i);
    expect(write).not.toHaveBeenCalled();
  });
});
