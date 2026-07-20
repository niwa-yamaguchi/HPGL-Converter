import { describe, expect, it } from 'vitest';
import {
  defaultOutputName,
  fileIdentity,
  isZipName,
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
    'drawing.plt1',
    'drawing.PLT1',
    'drawing.plt9',
    'drawing.plt10',
    'drawing.plt99',
    'drawing.PLT99',
    'drawing.pltl1',
    'drawing.PLTL1',
    'drawing.pltl9',
    'drawing.pltl10',
    'drawing.pltl99',
    'drawing.PLTL99',
  ])('accepts supported HPGL name %s case-insensitively', name => {
    expect(isSupportedHpglName(name)).toBe(true);
  });

  it.each([
    'drawing.H00',
    'drawing.H100',
    'drawing.txt',
    'drawing.plt0',
    'drawing.plt100',
    'drawing.pltl0',
    'drawing.pltl100',
  ])(
    'rejects unsupported name %s',
    name => {
      expect(isSupportedHpglName(name)).toBe(false);
    },
  );
});

describe('isZipName', () => {
  it.each(['drawings.zip', 'DRAWINGS.ZIP'])('accepts ZIP name %s', name => {
    expect(isZipName(name)).toBe(true);
  });

  it.each(['drawings.zip.txt', 'drawings.7z'])('rejects non-ZIP name %s', name => {
    expect(isZipName(name)).toBe(false);
  });
});

describe('defaultOutputName', () => {
  it.each([
    ['A.H01', 'A.dxf'],
    ['drawings.zip', 'drawings.dxf'],
    ['archive.part.ZIP', 'archive.part.dxf'],
    ['folder/drawing.hpgl', 'drawing.dxf'],
  ])('maps %s to %s', (sourceName, expected) => {
    expect(defaultOutputName(sourceName)).toBe(expected);
  });

  it('falls back for a name without a usable stem', () => {
    expect(defaultOutputName('.zip')).toBe('converted.dxf');
  });
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
