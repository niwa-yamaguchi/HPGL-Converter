import { Inflate, strFromU8, unzip } from 'fflate';
import { isSupportedHpglName, isZipName } from './file-policy.js';
import { createArchiveInputRecord } from './input-records.js';

const MIB = 1024 * 1024;

export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 50 * MIB,
  maxEntries: 100,
  maxEntryBytes: 20 * MIB,
  maxTotalBytes: 100 * MIB,
});

export class ZipInputError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ZipInputError';
    this.code = code;
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8]);
const DEFLATE_PREFLIGHT_CHUNK_BYTES = 1024;
// One input byte can encode at most four 258-byte length/distance copies.
const DEFLATE_MAX_EXPANSION_RATIO = 1032;

export function normalizeZipEntryPath(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0
      || CONTROL_CHARS.test(rawName) || /^[\\/]/.test(rawName)
      || DRIVE_PATH.test(rawName)) {
    return null;
  }
  const parts = rawName.replaceAll('\\', '/').split('/');
  if (parts.includes('..')) {
    return null;
  }
  const normalized = parts.filter(part => part !== '' && part !== '.').join('/');
  return normalized || null;
}

function abortError() {
  return new DOMException('ZIP expansion cancelled', 'AbortError');
}

function limitsWith(overrides = {}) {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`ZIP limit ${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function invalidZip(error) {
  return error instanceof ZipInputError
    ? error
    : new ZipInputError('ZIP_INVALID', 'ZIPを展開できませんでした', { cause: error });
}

function zipInvalid(message) {
  return new ZipInputError('ZIP_INVALID', message);
}

function findEndOfCentralDirectory(view) {
  const minimumOffset = Math.max(0, view.byteLength - 22 - MAX_ZIP_COMMENT_BYTES);
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) {
      continue;
    }
    const commentBytes = view.getUint16(offset + 20, true);
    if (offset + 22 + commentBytes === view.byteLength) {
      return offset;
    }
  }
  throw zipInvalid('ZIPの中央ディレクトリを取得できません');
}

function validateEntryHeaders(view, headerOffset, centralDirectoryOffset) {
  if (headerOffset + 46 > view.byteLength
      || view.getUint32(headerOffset, true) !== CENTRAL_HEADER_SIGNATURE) {
    throw zipInvalid('ZIPの中央ディレクトリが破損しています');
  }

  const flags = view.getUint16(headerOffset + 8, true);
  const method = view.getUint16(headerOffset + 10, true);
  const compressedSize = view.getUint32(headerOffset + 20, true);
  const originalSize = view.getUint32(headerOffset + 24, true);
  const nameBytes = view.getUint16(headerOffset + 28, true);
  const extraBytes = view.getUint16(headerOffset + 30, true);
  const commentBytes = view.getUint16(headerOffset + 32, true);
  const localOffset = view.getUint32(headerOffset + 42, true);
  const nextOffset = headerOffset + 46 + nameBytes + extraBytes + commentBytes;

  if (nextOffset > view.byteLength || localOffset + 30 > view.byteLength
      || view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
    throw zipInvalid('ZIPのエントリーヘッダーが破損しています');
  }

  const localFlags = view.getUint16(localOffset + 6, true);
  const localMethod = view.getUint16(localOffset + 8, true);
  const localNameBytes = view.getUint16(localOffset + 26, true);
  const localExtraBytes = view.getUint16(localOffset + 28, true);
  const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
  if ((flags & 1) !== 0 || (localFlags & 1) !== 0) {
    throw zipInvalid('暗号化されたZIPは展開できません');
  }
  if (!SUPPORTED_COMPRESSION_METHODS.has(method)
      || !SUPPORTED_COMPRESSION_METHODS.has(localMethod)
      || method !== localMethod) {
    throw zipInvalid('未対応のZIP圧縮方式です');
  }
  if (dataOffset + compressedSize > centralDirectoryOffset) {
    throw zipInvalid('ZIPの圧縮データ範囲が不正です');
  }
  if (method === 0 && compressedSize !== originalSize) {
    throw zipInvalid('無圧縮エントリーのサイズが一致しません');
  }

  const rawName = strFromU8(
    new Uint8Array(
      view.buffer,
      view.byteOffset + headerOffset + 46,
      nameBytes,
    ),
    (flags & 2048) === 0,
  );
  return {
    nextOffset,
    entry: {
      rawName,
      method,
      compressedSize,
      originalSize,
      dataOffset,
    },
  };
}

function validateZipHeaders(bytes) {
  if (bytes.byteLength < 22) {
    throw zipInvalid('ZIPが破損しています');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
      || totalEntries === 0xffff || centralBytes === 0xffffffff
      || centralOffset === 0xffffffff
      || centralOffset + centralBytes > eocdOffset) {
    throw zipInvalid('ZIPの中央ディレクトリが不正です');
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const parsed = validateEntryHeaders(view, offset, centralOffset);
    entries.push(parsed.entry);
    offset = parsed.nextOffset;
  }
  if (offset !== centralOffset + centralBytes) {
    throw zipInvalid('ZIPの中央ディレクトリサイズが一致しません');
  }
  return entries;
}

function entryTooLarge(name) {
  return new ZipInputError(
    'ZIP_ENTRY_TOO_LARGE',
    `展開後ファイルが20 MiBを超えています: ${name}`,
  );
}

function totalTooLarge() {
  return new ZipInputError(
    'ZIP_TOTAL_TOO_LARGE',
    '展開後合計が100 MiBを超えています',
  );
}

function measureDeflatedEntry(bytes, entry, name, limits, previousTotal) {
  let expandedBytes = 0;
  const compressedChunkBytes = Math.max(
    1,
    Math.min(
      DEFLATE_PREFLIGHT_CHUNK_BYTES,
      Math.floor(limits.maxEntryBytes / DEFLATE_MAX_EXPANSION_RATIO),
    ),
  );
  const inflater = new Inflate(chunk => {
    expandedBytes += chunk.byteLength;
    if (expandedBytes > limits.maxEntryBytes) {
      throw entryTooLarge(name);
    }
    if (previousTotal + expandedBytes > limits.maxTotalBytes) {
      throw totalTooLarge();
    }
  });
  const endOffset = entry.dataOffset + entry.compressedSize;

  try {
    if (entry.dataOffset === endOffset) {
      inflater.push(new Uint8Array(), true);
    }
    for (
      let offset = entry.dataOffset;
      offset < endOffset;
      offset += compressedChunkBytes
    ) {
      const nextOffset = Math.min(
        offset + compressedChunkBytes,
        endOffset,
      );
      inflater.push(
        bytes.subarray(offset, nextOffset),
        nextOffset === endOffset,
      );
    }
  } catch (error) {
    throw invalidZip(error);
  }

  return expandedBytes;
}

function preflightExpandedSizes(bytes, entries, limits) {
  const measuredSizes = new Map();
  const seen = new Set();
  let acceptedCount = 0;
  let declaredTotal = 0;
  let actualTotal = 0;
  let sizeMismatchName = null;

  for (const entry of entries) {
    if (entry.rawName.endsWith('/')) {
      continue;
    }
    const name = normalizeZipEntryPath(entry.rawName);
    if (!name || isZipName(name) || !isSupportedHpglName(name)) {
      continue;
    }
    if (seen.has(name)) {
      throw new ZipInputError(
        'ZIP_DUPLICATE_PATH',
        `ZIP内でパスが重複しています: ${name}`,
      );
    }
    if (acceptedCount + 1 > limits.maxEntries) {
      throw new ZipInputError(
        'ZIP_ENTRY_LIMIT',
        '対応HPGLが100件を超えています',
      );
    }
    if (entry.originalSize > limits.maxEntryBytes) {
      throw entryTooLarge(name);
    }
    if (declaredTotal + entry.originalSize > limits.maxTotalBytes) {
      throw totalTooLarge();
    }

    const actualSize = entry.method === 0
      ? entry.compressedSize
      : measureDeflatedEntry(bytes, entry, name, limits, actualTotal);
    if (actualSize > limits.maxEntryBytes) {
      throw entryTooLarge(name);
    }
    if (actualTotal + actualSize > limits.maxTotalBytes) {
      throw totalTooLarge();
    }
    if (actualSize !== entry.originalSize) {
      sizeMismatchName ??= name;
    }

    seen.add(name);
    acceptedCount += 1;
    declaredTotal += entry.originalSize;
    actualTotal += actualSize;
    measuredSizes.set(entry.rawName, actualSize);
  }

  if (sizeMismatchName !== null) {
    throw zipInvalid(`展開後サイズが申告値と一致しません: ${sizeMismatchName}`);
  }
  return measuredSizes;
}

export function createZipExpansionJob(sourceFile, options = {}) {
  const limits = limitsWith(options.limits);
  const unzipImpl = options.unzipImpl ?? unzip;
  let terminate = () => {};
  let cancelled = false;
  let settled = false;
  let rejectCancellation;

  const cancellation = new Promise((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const work = (async () => {
    if (sourceFile.size > limits.maxArchiveBytes) {
      throw new ZipInputError('ZIP_TOO_LARGE', 'ZIP本体が50 MiBを超えています');
    }
    const bytes = new Uint8Array(await sourceFile.arrayBuffer());
    if (cancelled) {
      throw abortError();
    }
    let measuredSizes;
    try {
      const entries = validateZipHeaders(bytes);
      measuredSizes = preflightExpandedSizes(bytes, entries, limits);
    } catch (error) {
      throw invalidZip(error);
    }
    if (cancelled) {
      throw abortError();
    }

    return new Promise((resolve, reject) => {
      const ignored = {
        directories: 0,
        unsupported: 0,
        nestedArchives: 0,
        unsafePaths: 0,
      };
      const acceptedEntries = [];
      const seen = new Set();
      let totalBytes = 0;
      let policyError = null;

      const failPolicy = (code, message) => {
        policyError ??= new ZipInputError(code, message);
        return false;
      };

      try {
        terminate = unzipImpl(bytes, {
          filter(entry) {
            if (policyError) {
              return false;
            }
            if (entry.name.endsWith('/')) {
              ignored.directories += 1;
              return false;
            }
            const name = normalizeZipEntryPath(entry.name);
            if (!name) {
              ignored.unsafePaths += 1;
              return false;
            }
            if (isZipName(name)) {
              ignored.nestedArchives += 1;
              return false;
            }
            if (!isSupportedHpglName(name)) {
              ignored.unsupported += 1;
              return false;
            }
            if (seen.has(name)) {
              return failPolicy(
                'ZIP_DUPLICATE_PATH',
                `ZIP内でパスが重複しています: ${name}`,
              );
            }
            if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
              return failPolicy('ZIP_INVALID', `展開後サイズを取得できません: ${name}`);
            }
            if (acceptedEntries.length + 1 > limits.maxEntries) {
              return failPolicy('ZIP_ENTRY_LIMIT', '対応HPGLが100件を超えています');
            }
            if (entry.originalSize > limits.maxEntryBytes) {
              return failPolicy(
                'ZIP_ENTRY_TOO_LARGE',
                `展開後ファイルが20 MiBを超えています: ${name}`,
              );
            }
            if (totalBytes + entry.originalSize > limits.maxTotalBytes) {
              return failPolicy(
                'ZIP_TOTAL_TOO_LARGE',
                '展開後合計が100 MiBを超えています',
              );
            }
            seen.add(name);
            acceptedEntries.push({ rawName: entry.name, name });
            totalBytes += entry.originalSize;
            return true;
          },
        }, (error, files) => {
          if (cancelled) {
            reject(abortError());
            return;
          }
          if (policyError) {
            reject(policyError);
            return;
          }
          if (error) {
            reject(invalidZip(error));
            return;
          }
          try {
            let actualTotal = 0;
            let sizeMismatchName = null;
            const extractedEntries = acceptedEntries.map(({ rawName, name }) => {
              const entryBytes = files[rawName];
              if (!(entryBytes instanceof Uint8Array)) {
                throw new TypeError('Archive entry bytes must be a Uint8Array');
              }
              if (entryBytes.byteLength > limits.maxEntryBytes) {
                throw entryTooLarge(name);
              }
              actualTotal += entryBytes.byteLength;
              if (actualTotal > limits.maxTotalBytes) {
                throw totalTooLarge();
              }
              if (entryBytes.byteLength !== measuredSizes.get(rawName)) {
                sizeMismatchName ??= name;
              }
              return { entryBytes, name };
            });
            if (sizeMismatchName !== null) {
              throw zipInvalid(
                `展開後サイズが事前検証値と一致しません: ${sizeMismatchName}`,
              );
            }
            resolve({
              items: extractedEntries.map(({ entryBytes, name }) => (
                createArchiveInputRecord(sourceFile, name, entryBytes)
              )),
              ignored,
            });
          } catch (recordError) {
            reject(invalidZip(recordError));
          }
        });
      } catch (error) {
        reject(invalidZip(error));
      }
    });
  })();

  const promise = Promise.race([work, cancellation]).finally(() => {
    settled = true;
  });

  return {
    promise,
    cancel() {
      if (settled || cancelled) {
        return;
      }
      cancelled = true;
      terminate();
      rejectCancellation(abortError());
    },
  };
}
