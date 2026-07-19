import { unzip } from 'fflate';
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

function validateEntryHeaders(view, centralOffset) {
  if (centralOffset + 46 > view.byteLength
      || view.getUint32(centralOffset, true) !== CENTRAL_HEADER_SIGNATURE) {
    throw zipInvalid('ZIPの中央ディレクトリが破損しています');
  }

  const flags = view.getUint16(centralOffset + 8, true);
  const method = view.getUint16(centralOffset + 10, true);
  const nameBytes = view.getUint16(centralOffset + 28, true);
  const extraBytes = view.getUint16(centralOffset + 30, true);
  const commentBytes = view.getUint16(centralOffset + 32, true);
  const localOffset = view.getUint32(centralOffset + 42, true);
  const nextOffset = centralOffset + 46 + nameBytes + extraBytes + commentBytes;

  if (nextOffset > view.byteLength || localOffset + 30 > view.byteLength
      || view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
    throw zipInvalid('ZIPのエントリーヘッダーが破損しています');
  }

  const localFlags = view.getUint16(localOffset + 6, true);
  const localMethod = view.getUint16(localOffset + 8, true);
  if ((flags & 1) !== 0 || (localFlags & 1) !== 0) {
    throw zipInvalid('暗号化されたZIPは展開できません');
  }
  if (!SUPPORTED_COMPRESSION_METHODS.has(method)
      || !SUPPORTED_COMPRESSION_METHODS.has(localMethod)
      || method !== localMethod) {
    throw zipInvalid('未対応のZIP圧縮方式です');
  }

  return nextOffset;
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

  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    offset = validateEntryHeaders(view, offset);
  }
  if (offset !== centralOffset + centralBytes) {
    throw zipInvalid('ZIPの中央ディレクトリサイズが一致しません');
  }
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
    validateZipHeaders(bytes);

    return new Promise((resolve, reject) => {
      const ignored = {
        directories: 0,
        unsupported: 0,
        nestedArchives: 0,
        unsafePaths: 0,
      };
      const acceptedNames = [];
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
            if (acceptedNames.length + 1 > limits.maxEntries) {
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
            acceptedNames.push(name);
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
          resolve({
            items: acceptedNames.map(name => (
              createArchiveInputRecord(sourceFile, name, files[name])
            )),
            ignored,
          });
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
