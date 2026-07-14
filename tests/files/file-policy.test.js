import { describe, expect, it } from 'vitest';
import {
  fileIdentity,
  isSupportedHpglName,
  normalizeOutputName,
} from '../../src/files/file-policy.js';

describe('isSupportedHpglName', () => {
  it.each([
    'drawing.hpgl',
    'drawing.HPGL',
    'drawing.hpg',
    'drawing.HPG',
    'drawing.plt',
    'drawing.PLT',
    'drawing.H01',
    'drawing.h01',
    'drawing.H99',
    'drawing.h99',
  ])('accepts supported HPGL name %s case-insensitively', name => {
    expect(isSupportedHpglName(name)).toBe(true);
  });

  it.each(['drawing.H00', 'drawing.H100', 'drawing.txt'])(
    'rejects unsupported name %s',
    name => {
      expect(isSupportedHpglName(name)).toBe(false);
    },
  );
});

describe('normalizeOutputName', () => {
  it('adds a missing DXF suffix exactly once', () => {
    expect(normalizeOutputName('drawing')).toBe('drawing.dxf');
    expect(normalizeOutputName('drawing.DXF')).toBe('drawing.DXF');
  });

  it('uses converted.dxf for a blank output name', () => {
    expect(normalizeOutputName('   ')).toBe('converted.dxf');
  });
});

describe('fileIdentity', () => {
  it('combines name, size, and lastModified deterministically', () => {
    const file = { name: 'drawing.H01', size: 1234, lastModified: 5678 };

    expect(fileIdentity(file)).toBe('drawing.H01\0' + '1234\0' + '5678');
    expect(fileIdentity(file)).toBe(fileIdentity({ ...file }));
  });
});
