import { describe, expect, it, vi } from 'vitest';
import { writeValidatedReferenceDxf } from '../../scripts/reference-dxf-output.mjs';

const validResult = {
  buffer: new Uint8Array([1, 2, 3]).buffer,
  totals: {
    fileCount: 8,
    geometryCount: 53842,
    errorCount: 0,
    warningCount: 0,
  },
};

describe('writeValidatedReferenceDxf', () => {
  it.each([
    ['conversion errors', { errorCount: 1 }],
    ['conversion warnings', { warningCount: 1 }],
    ['file count mismatch', { fileCount: 7 }],
    ['geometry count mismatch', { geometryCount: 53841 }],
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
