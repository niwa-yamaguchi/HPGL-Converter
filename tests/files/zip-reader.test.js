import { strToU8, Zip, ZipPassThrough, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  createZipExpansionJob,
  normalizeZipEntryPath,
} from '../../src/files/zip-reader.js';

const zipFile = (entries, name = 'drawings.zip') => new File(
  [zipSync(entries)],
  name,
  { type: 'application/zip', lastModified: 123 },
);

function duplicatePathZip() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = new Zip((error, chunk, final) => {
      if (error) {
        reject(error);
        return;
      }
      chunks.push(chunk);
      if (final) {
        resolve(new File(chunks, 'duplicate.zip', { lastModified: 123 }));
      }
    });
    for (const source of ['PU;', 'PD40,0;PU;']) {
      const entry = new ZipPassThrough('same.H01');
      archive.add(entry);
      entry.push(strToU8(source), true);
    }
    archive.end();
  });
}

function mutateZipHeaders(source, {
  encrypted = false,
  method,
  scope = 'both',
} = {}) {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 12; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50 && scope !== 'central') {
      if (encrypted) {
        view.setUint16(offset + 6, view.getUint16(offset + 6, true) | 1, true);
      }
      if (method !== undefined) {
        view.setUint16(offset + 8, method, true);
      }
    }
    if (signature === 0x02014b50 && scope !== 'local') {
      if (encrypted) {
        view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 1, true);
      }
      if (method !== undefined) {
        view.setUint16(offset + 10, method, true);
      }
    }
  }
  return bytes;
}

describe('normalizeZipEntryPath', () => {
  it.each([
    ['parts\\A.H01', 'parts/A.H01'],
    ['./parts//A.H01', 'parts/A.H01'],
    ['parts/./A.H01', 'parts/A.H01'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeZipEntryPath(input)).toBe(expected);
  });

  it.each([
    '../A.H01',
    'parts/../A.H01',
    '/absolute/A.H01',
    'C:\\absolute\\A.H01',
    'bad\u0000name.H01',
    'bad\u001fname.H01',
  ])('rejects unsafe path %s', input => {
    expect(normalizeZipEntryPath(input)).toBeNull();
  });
});

describe('createZipExpansionJob', () => {
  it('recursively extracts supported HPGL in archive order', async () => {
    const source = zipFile({
      'root.H01': strToU8('PD40,0;PU;'),
      'parts/A.hpgl': strToU8('PD0,40;PU;'),
      'parts/B.PLT': strToU8('PU;'),
    });

    const result = await createZipExpansionJob(source).promise;

    expect(result.items.map(item => item.name)).toEqual([
      'root.H01',
      'parts/A.hpgl',
      'parts/B.PLT',
    ]);
    expect(result.items.map(item => item.identity)).toEqual([
      expect.stringContaining('\0root.H01'),
      expect.stringContaining('\0parts/A.hpgl'),
      expect.stringContaining('\0parts/B.PLT'),
    ]);
  });

  it('keeps Japanese paths and counts ignored entry classes', async () => {
    const source = zipFile({
      '部品/図面.H01': strToU8('PU;'),
      'nested.zip': strToU8('not a nested archive'),
      'notes.txt': strToU8('memo'),
      '../unsafe.H01': strToU8('PU;'),
      'empty/': new Uint8Array(),
    });

    const result = await createZipExpansionJob(source).promise;

    expect(result.items.map(item => item.name)).toEqual(['部品/図面.H01']);
    expect(result.ignored).toEqual({
      directories: 1,
      unsupported: 1,
      nestedArchives: 1,
      unsafePaths: 1,
    });
  });

  it.each([
    ['ZIP_TOO_LARGE', { maxArchiveBytes: 1 }],
    ['ZIP_ENTRY_LIMIT', { maxEntries: 1 }],
    ['ZIP_ENTRY_TOO_LARGE', { maxEntryBytes: 2 }],
    ['ZIP_TOTAL_TOO_LARGE', { maxTotalBytes: 3 }],
  ])('rejects policy limit %s', async (code, limit) => {
    const source = zipFile({
      'A.H01': strToU8('PU;'),
      'B.H02': strToU8('PU;'),
    });
    const job = createZipExpansionJob(source, {
      limits: {
        maxArchiveBytes: 1_000_000,
        maxEntries: 100,
        maxEntryBytes: 1_000_000,
        maxTotalBytes: 1_000_000,
        ...limit,
      },
    });

    await expect(job.promise).rejects.toMatchObject({ code });
  });

  it('rejects corrupt data as ZIP_INVALID', async () => {
    const source = new File([new Uint8Array([1, 2, 3])], 'broken.zip');
    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it('rejects duplicate paths before one entry can overwrite another', async () => {
    const source = await duplicatePathZip();
    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code: 'ZIP_DUPLICATE_PATH' });
  });

  it.each([
    ['encrypted flag', { encrypted: true }],
    ['unsupported compression method', { method: 99 }],
  ])('rejects %s as ZIP_INVALID', async (_label, mutation) => {
    const valid = zipSync({ 'A.H01': strToU8('PU;') });
    const source = new File(
      [mutateZipHeaders(valid, mutation)],
      'unsupported.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it.each([
    ['encrypted local header', { encrypted: true, scope: 'local' }],
    ['unsupported local compression method', { method: 99, scope: 'local' }],
  ])('rejects %s as ZIP_INVALID', async (_label, mutation) => {
    const valid = zipSync({ 'A.H01': strToU8('PU;') });
    const source = new File(
      [mutateZipHeaders(valid, mutation)],
      'mismatch.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it('cancels once with AbortError', async () => {
    const terminate = vi.fn();
    const unzipImpl = vi.fn(() => terminate);
    const source = zipFile({ 'A.H01': strToU8('PU;') });
    const job = createZipExpansionJob(source, {
      unzipImpl,
    });
    await vi.waitFor(() => expect(unzipImpl).toHaveBeenCalledOnce());
    job.cancel();
    job.cancel();

    await expect(job.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminate).toHaveBeenCalledOnce();
  });
});
