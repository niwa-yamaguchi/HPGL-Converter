import {
  deflateSync,
  strToU8,
  Zip,
  ZipPassThrough,
  zipSync,
} from 'fflate';
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

const MIB = 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function findSignature(bytes, signature, start = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset <= bytes.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) {
      return offset;
    }
  }
  throw new Error(`ZIP signature ${signature.toString(16)} was not found`);
}

function buildSingleEntryZip({
  name = 'A.H01',
  data,
  method = 8,
} = {}) {
  const nameBytes = strToU8(name);
  const compressed = method === 8
    ? deflateSync(data, { level: 0 })
    : data;
  const localBytes = 30 + nameBytes.byteLength + compressed.byteLength;
  const centralBytes = 46 + nameBytes.byteLength;
  const bytes = new Uint8Array(localBytes + centralBytes + 22);
  const view = new DataView(bytes.buffer);
  const checksum = crc32(data);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, method, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, compressed.byteLength, true);
  view.setUint32(22, data.byteLength, true);
  view.setUint16(26, nameBytes.byteLength, true);
  bytes.set(nameBytes, 30);
  bytes.set(compressed, 30 + nameBytes.byteLength);

  const centralOffset = localBytes;
  view.setUint32(centralOffset, 0x02014b50, true);
  view.setUint16(centralOffset + 4, 20, true);
  view.setUint16(centralOffset + 6, 20, true);
  view.setUint16(centralOffset + 8, 0, true);
  view.setUint16(centralOffset + 10, method, true);
  view.setUint32(centralOffset + 16, checksum, true);
  view.setUint32(centralOffset + 20, compressed.byteLength, true);
  view.setUint32(centralOffset + 24, data.byteLength, true);
  view.setUint16(centralOffset + 28, nameBytes.byteLength, true);
  bytes.set(nameBytes, centralOffset + 46);

  const eocdOffset = centralOffset + centralBytes;
  view.setUint32(eocdOffset, 0x06054b50, true);
  view.setUint16(eocdOffset + 8, 1, true);
  view.setUint16(eocdOffset + 10, 1, true);
  view.setUint32(eocdOffset + 12, centralBytes, true);
  view.setUint32(eocdOffset + 16, centralOffset, true);
  return bytes;
}

function mutateEntryData(source, dataByteOffset) {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const localOffset = findSignature(bytes, 0x04034b50);
  const nameBytes = view.getUint16(localOffset + 26, true);
  const extraBytes = view.getUint16(localOffset + 28, true);
  const dataOffset = localOffset + 30 + nameBytes + extraBytes;
  bytes[dataOffset + dataByteOffset] ^= 1;
  return bytes;
}

function addZip64Structures(source) {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findSignature(bytes, 0x06054b50);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const zip64 = new Uint8Array(56);
  const zip64View = new DataView(zip64.buffer);
  zip64View.setUint32(0, 0x06064b50, true);
  zip64View.setBigUint64(4, 44n, true);
  zip64View.setUint16(12, 45, true);
  zip64View.setUint16(14, 45, true);
  zip64View.setBigUint64(24, BigInt(totalEntries), true);
  zip64View.setBigUint64(32, BigInt(totalEntries), true);
  zip64View.setBigUint64(40, BigInt(centralBytes), true);
  zip64View.setBigUint64(48, BigInt(centralOffset), true);
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, BigInt(eocdOffset), true);
  locatorView.setUint32(16, 1, true);
  const result = new Uint8Array(bytes.byteLength + zip64.byteLength + locator.byteLength);
  result.set(bytes.subarray(0, eocdOffset));
  result.set(zip64, eocdOffset);
  result.set(locator, eocdOffset + zip64.byteLength);
  result.set(bytes.subarray(eocdOffset), eocdOffset + zip64.byteLength + locator.byteLength);
  return result;
}

function addCentralZip64Extra(source) {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findSignature(bytes, 0x06054b50);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const nameBytes = view.getUint16(centralOffset + 28, true);
  const extraBytes = view.getUint16(centralOffset + 30, true);
  const insertOffset = centralOffset + 46 + nameBytes + extraBytes;
  const result = new Uint8Array(bytes.byteLength + 4);
  result.set(bytes.subarray(0, insertOffset));
  result.set(new Uint8Array([1, 0, 0, 0]), insertOffset);
  result.set(bytes.subarray(insertOffset), insertOffset + 4);
  const resultView = new DataView(result.buffer);
  resultView.setUint16(centralOffset + 30, extraBytes + 4, true);
  resultView.setUint32(eocdOffset + 4 + 12, view.getUint32(eocdOffset + 12, true) + 4, true);
  return result;
}

function mutateCentralDiskStart(source, diskNumber) {
  const bytes = source.slice();
  const centralOffset = findSignature(bytes, 0x02014b50);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint16(centralOffset + 34, diskNumber, true);
  return bytes;
}

function mutateEocdDisk(source, diskNumber) {
  const bytes = source.slice();
  const eocdOffset = findSignature(bytes, 0x06054b50);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint16(eocdOffset + 4, diskNumber, true);
  return bytes;
}

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

function mutateZipOriginalSizes(source, originalSize) {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 28; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      view.setUint32(offset + 22, originalSize, true);
    }
    if (signature === 0x02014b50) {
      view.setUint32(offset + 24, originalSize, true);
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
    'C:relative.H01',
    'bad\u0000name.H01',
    'bad\u001fname.H01',
    'bad\u007fname.H01',
    'bad\u0085name.H01',
    'bad\u009fname.H01',
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

  it('reads bytes by the original ZIP name and exposes the normalized path', async () => {
    const source = zipFile({
      'parts\\A.H01': strToU8('PD40,0;PU;'),
    });

    const result = await createZipExpansionJob(source).promise;

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('parts/A.H01');
    expect(new Uint8Array(await result.items[0].blob.arrayBuffer()))
      .toEqual(strToU8('PD40,0;PU;'));
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

  it('uses archive content in ZIP entry identities', async () => {
    const mtime = new Date('2020-01-01T00:00:00Z');
    const firstBytes = zipSync({
      'A.H01': [strToU8('PU;'), { level: 0, mtime }],
    });
    const secondBytes = zipSync({
      'A.H01': [strToU8('PD;'), { level: 0, mtime }],
    });
    expect(firstBytes.byteLength).toBe(secondBytes.byteLength);
    const first = new File([firstBytes], 'same.zip', { lastModified: 123 });
    const second = new File([secondBytes], 'same.zip', { lastModified: 123 });

    const [firstResult, secondResult] = await Promise.all([
      createZipExpansionJob(first).promise,
      createZipExpansionJob(second).promise,
    ]);

    expect(firstResult.items[0].identity).not.toBe(secondResult.items[0].identity);
  });

  it('keeps ZIP entry identities stable for identical archive bytes', async () => {
    const bytes = zipSync({ 'A.H01': [strToU8('PU;'), { level: 0 }] });
    const first = new File([bytes], 'same.zip', { lastModified: 123 });
    const second = new File([bytes], 'same.zip', { lastModified: 123 });

    const [firstResult, secondResult] = await Promise.all([
      createZipExpansionJob(first).promise,
      createZipExpansionJob(second).promise,
    ]);

    expect(firstResult.items[0].identity).toBe(secondResult.items[0].identity);
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

  it.each([
    [
      'ZIP_TOO_LARGE',
      new File([new Uint8Array(MIB + 1)], 'large.zip'),
      { maxArchiveBytes: MIB },
      '1 MiB',
    ],
    [
      'ZIP_ENTRY_LIMIT',
      zipFile({ 'A.H01': strToU8('PU;'), 'B.H02': strToU8('PU;') }),
      { maxEntries: 1 },
      '1件',
    ],
    [
      'ZIP_ENTRY_TOO_LARGE',
      zipFile({ 'A.H01': [new Uint8Array(2 * MIB + 1), { level: 0 }] }),
      { maxEntryBytes: 2 * MIB },
      '2 MiB',
    ],
    [
      'ZIP_TOTAL_TOO_LARGE',
      zipFile({
        'A.H01': [new Uint8Array(2 * MIB), { level: 0 }],
        'B.H02': [new Uint8Array(2 * MIB), { level: 0 }],
      }),
      { maxEntryBytes: 3 * MIB, maxTotalBytes: 3 * MIB },
      '3 MiB',
    ],
  ])('uses injected limits in the %s message', async (code, source, limit, text) => {
    const job = createZipExpansionJob(source, {
      limits: {
        maxArchiveBytes: 10 * MIB,
        maxEntries: 100,
        maxEntryBytes: 10 * MIB,
        maxTotalBytes: 10 * MIB,
        ...limit,
      },
    });

    await expect(job.promise).rejects.toMatchObject({
      code,
      message: expect.stringContaining(text),
    });
  });

  it('rejects a stored entry whose compressed and expanded sizes disagree', async () => {
    const valid = zipSync({
      'A.H01': [strToU8('PU;'), { level: 0 }],
    });
    const source = new File(
      [mutateZipOriginalSizes(valid, 1)],
      'stored-size-lie.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it('rejects stored data whose CRC-32 does not match the central directory', async () => {
    const valid = buildSingleEntryZip({
      data: strToU8('PU;'),
      method: 0,
    });
    const source = new File(
      [mutateEntryData(valid, 0)],
      'stored-crc.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it('rejects DEFLATE data whose CRC-32 does not match the central directory', async () => {
    const valid = buildSingleEntryZip({
      data: strToU8('PU;'),
      method: 8,
    });
    const source = new File(
      [mutateEntryData(valid, 5)],
      'deflate-crc.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it('rejects a DEFLATE size lie that exceeds the per-entry limit', async () => {
    const valid = zipSync({
      'A.H01': [strToU8('PU;'), { level: 9 }],
    });
    const source = new File(
      [mutateZipOriginalSizes(valid, 1)],
      'deflate-entry-size-lie.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source, {
      limits: {
        maxArchiveBytes: 1_000_000,
        maxEntries: 100,
        maxEntryBytes: 2,
        maxTotalBytes: 1_000_000,
      },
    }).promise).rejects.toMatchObject({ code: 'ZIP_ENTRY_TOO_LARGE' });
  });

  it('rejects DEFLATE size lies that exceed the actual total limit', async () => {
    const valid = zipSync({
      'A.H01': [strToU8('PU;'), { level: 9 }],
      'B.H02': [strToU8('PU;'), { level: 9 }],
    });
    const source = new File(
      [mutateZipOriginalSizes(valid, 1)],
      'deflate-total-size-lie.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source, {
      limits: {
        maxArchiveBytes: 1_000_000,
        maxEntries: 100,
        maxEntryBytes: 10,
        maxTotalBytes: 4,
      },
    }).promise).rejects.toMatchObject({ code: 'ZIP_TOTAL_TOO_LARGE' });
  });

  it('rejects a DEFLATE bomb from actual streamed bytes', async () => {
    const valid = zipSync({
      'A.H01': [new Uint8Array(2 * 1024 * 1024), { level: 9 }],
    });
    const source = new File(
      [mutateZipOriginalSizes(valid, 1)],
      'deflate-bomb.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source, {
      limits: {
        maxArchiveBytes: 1_000_000,
        maxEntries: 100,
        maxEntryBytes: 1024 * 1024,
        maxTotalBytes: 10 * 1024 * 1024,
      },
    }).promise).rejects.toMatchObject({ code: 'ZIP_ENTRY_TOO_LARGE' });
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
    ['encrypted flag', { encrypted: true }, 'ZIP_ENCRYPTED'],
    ['unsupported compression method', { method: 99 }, 'ZIP_UNSUPPORTED_COMPRESSION'],
  ])('rejects %s with a stable error code', async (_label, mutation, code) => {
    const valid = zipSync({ 'A.H01': strToU8('PU;') });
    const source = new File(
      [mutateZipHeaders(valid, mutation)],
      'unsupported.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code });
  });

  it.each([
    ['encrypted local header', { encrypted: true, scope: 'local' }, 'ZIP_ENCRYPTED'],
    [
      'unsupported local compression method',
      { method: 99, scope: 'local' },
      'ZIP_UNSUPPORTED_COMPRESSION',
    ],
  ])('rejects %s with a stable error code', async (_label, mutation, code) => {
    const valid = zipSync({ 'A.H01': strToU8('PU;') });
    const source = new File(
      [mutateZipHeaders(valid, mutation)],
      'mismatch.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code });
  });

  it.each([
    ['ZIP64 EOCD and locator', addZip64Structures, 'ZIP64_UNSUPPORTED'],
    ['central ZIP64 extra field', addCentralZip64Extra, 'ZIP64_UNSUPPORTED'],
    [
      'non-zero central disk start',
      source => mutateCentralDiskStart(source, 1),
      'ZIP_SPLIT_UNSUPPORTED',
    ],
    [
      'non-zero EOCD disk number',
      source => mutateEocdDisk(source, 1),
      'ZIP_SPLIT_UNSUPPORTED',
    ],
  ])('rejects %s with a stable error code', async (_label, mutate, code) => {
    const valid = zipSync({ 'A.H01': strToU8('PU;') });
    const source = new File(
      [mutate(valid)],
      'unsupported-structure.zip',
      { lastModified: 123 },
    );

    await expect(createZipExpansionJob(source).promise)
      .rejects.toMatchObject({ code });
  });

  it('uses a cancellable async inflater and yields before feeding it', async () => {
    const terminate = vi.fn();
    const createInflater = vi.fn(() => ({
      push: vi.fn(),
      terminate,
      ondrain: null,
    }));
    const scheduled = [];
    const cancelScheduled = vi.fn();
    const scheduleTask = vi.fn(callback => {
      scheduled.push(callback);
      return cancelScheduled;
    });
    const source = zipFile({
      'A.H01': [strToU8('PU;'), { level: 9 }],
    });
    const job = createZipExpansionJob(source, {
      createInflater,
      scheduleTask,
    });
    await vi.waitFor(() => expect(createInflater).toHaveBeenCalledOnce());
    expect(scheduleTask).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);

    job.cancel();
    job.cancel();

    await expect(job.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminate).toHaveBeenCalledOnce();
    expect(cancelScheduled).toHaveBeenCalledOnce();
  });

});
