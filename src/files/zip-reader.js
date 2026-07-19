import { AsyncInflate, strFromU8 } from 'fflate';
import { isSupportedHpglName, isZipName } from './file-policy.js';
import { createArchiveInputRecord } from './input-records.js';

const MIB = 1024 * 1024;
const IO_CHUNK_BYTES = 256 * 1024;
// A DEFLATE input byte can encode at most four 258-byte copies.
const DEFLATE_MAX_EXPANSION_RATIO = 1032;

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

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const DRIVE_PATH = /^[A-Za-z]:/;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8]);

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

function normalizeFailure(error) {
  return error?.name === 'AbortError' ? error : invalidZip(error);
}

function zipError(code, message, options) {
  return new ZipInputError(code, message, options);
}

function zipInvalid(message, options) {
  return zipError('ZIP_INVALID', message, options);
}

function formatByteLimit(bytes) {
  if (bytes % MIB === 0) {
    return `${bytes / MIB} MiB`;
  }
  if (bytes > MIB) {
    return `${Number((bytes / MIB).toFixed(2))} MiB`;
  }
  return `${bytes} bytes`;
}

function archiveTooLarge(limits) {
  return zipError(
    'ZIP_TOO_LARGE',
    `ZIP本体が${formatByteLimit(limits.maxArchiveBytes)}を超えています`,
  );
}

function entryLimitExceeded(limits) {
  return zipError(
    'ZIP_ENTRY_LIMIT',
    `対応HPGLが${limits.maxEntries}件を超えています`,
  );
}

function entryTooLarge(name, limits) {
  return zipError(
    'ZIP_ENTRY_TOO_LARGE',
    `展開後ファイルが${formatByteLimit(limits.maxEntryBytes)}を超えています: ${name}`,
  );
}

function totalTooLarge(limits) {
  return zipError(
    'ZIP_TOTAL_TOO_LARGE',
    `展開後合計が${formatByteLimit(limits.maxTotalBytes)}を超えています`,
  );
}

function encryptedZip() {
  return zipError('ZIP_ENCRYPTED', '暗号化されたZIPは展開できません');
}

function unsupportedCompression() {
  return zipError(
    'ZIP_UNSUPPORTED_COMPRESSION',
    '未対応のZIP圧縮方式です',
  );
}

function zip64Unsupported() {
  return zipError('ZIP64_UNSUPPORTED', 'ZIP64には対応していません');
}

function splitZipUnsupported() {
  return zipError('ZIP_SPLIT_UNSUPPORTED', '分割ZIPには対応していません');
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

function containsSignature(view, start, end, signature) {
  for (let offset = start; offset + 4 <= end; offset += 1) {
    if (view.getUint32(offset, true) === signature) {
      return true;
    }
  }
  return false;
}

function decodeEntryName(view, offset, length, utf8) {
  return strFromU8(
    new Uint8Array(
      view.buffer,
      view.byteOffset + offset,
      length,
    ),
    !utf8,
  );
}

function validateExtraFields(view, offset, length) {
  const end = offset + length;
  if (end > view.byteLength) {
    throw zipInvalid('ZIPの拡張フィールドが破損しています');
  }
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) {
      throw zipInvalid('ZIPの拡張フィールドが破損しています');
    }
    const fieldId = view.getUint16(cursor, true);
    const fieldBytes = view.getUint16(cursor + 2, true);
    const next = cursor + 4 + fieldBytes;
    if (next > end) {
      throw zipInvalid('ZIPの拡張フィールドが破損しています');
    }
    if (fieldId === ZIP64_EXTRA_FIELD) {
      throw zip64Unsupported();
    }
    cursor = next;
  }
}

function validateEntryHeaders(
  view,
  headerOffset,
  centralDirectoryOffset,
  centralDirectoryEnd,
) {
  if (headerOffset + 46 > centralDirectoryEnd
      || view.getUint32(headerOffset, true) !== CENTRAL_HEADER_SIGNATURE) {
    throw zipInvalid('ZIPの中央ディレクトリが破損しています');
  }

  const flags = view.getUint16(headerOffset + 8, true);
  const method = view.getUint16(headerOffset + 10, true);
  const crc = view.getUint32(headerOffset + 16, true);
  const compressedSize = view.getUint32(headerOffset + 20, true);
  const originalSize = view.getUint32(headerOffset + 24, true);
  const nameBytes = view.getUint16(headerOffset + 28, true);
  const extraBytes = view.getUint16(headerOffset + 30, true);
  const commentBytes = view.getUint16(headerOffset + 32, true);
  const diskStart = view.getUint16(headerOffset + 34, true);
  const localOffset = view.getUint32(headerOffset + 42, true);
  const extraOffset = headerOffset + 46 + nameBytes;
  const nextOffset = extraOffset + extraBytes + commentBytes;

  if (compressedSize === 0xffffffff || originalSize === 0xffffffff
      || localOffset === 0xffffffff || diskStart === 0xffff) {
    throw zip64Unsupported();
  }
  if (diskStart !== 0) {
    throw splitZipUnsupported();
  }
  if (nextOffset > centralDirectoryEnd) {
    throw zipInvalid('ZIPの中央ディレクトリが破損しています');
  }
  validateExtraFields(view, extraOffset, extraBytes);

  if ((flags & 1) !== 0) {
    throw encryptedZip();
  }
  if (!SUPPORTED_COMPRESSION_METHODS.has(method)) {
    throw unsupportedCompression();
  }

  if (localOffset + 30 > centralDirectoryOffset
      || view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
    throw zipInvalid('ZIPのエントリーヘッダーが破損しています');
  }

  const localFlags = view.getUint16(localOffset + 6, true);
  const localMethod = view.getUint16(localOffset + 8, true);
  const localCrc = view.getUint32(localOffset + 14, true);
  const localCompressedSize = view.getUint32(localOffset + 18, true);
  const localOriginalSize = view.getUint32(localOffset + 22, true);
  const localNameBytes = view.getUint16(localOffset + 26, true);
  const localExtraBytes = view.getUint16(localOffset + 28, true);
  const localNameOffset = localOffset + 30;
  const localExtraOffset = localNameOffset + localNameBytes;
  const dataOffset = localExtraOffset + localExtraBytes;

  if (localCompressedSize === 0xffffffff || localOriginalSize === 0xffffffff) {
    throw zip64Unsupported();
  }
  validateExtraFields(view, localExtraOffset, localExtraBytes);
  if ((localFlags & 1) !== 0) {
    throw encryptedZip();
  }
  if (!SUPPORTED_COMPRESSION_METHODS.has(localMethod)) {
    throw unsupportedCompression();
  }
  if (method !== localMethod) {
    throw zipInvalid('ZIPの圧縮方式がヘッダー間で一致しません');
  }
  if (dataOffset + compressedSize > centralDirectoryOffset) {
    throw zipInvalid('ZIPの圧縮データ範囲が不正です');
  }
  if (method === 0 && compressedSize !== originalSize) {
    throw zipInvalid('無圧縮エントリーのサイズが一致しません');
  }
  if ((localFlags & 8) === 0
      && (localCrc !== crc
        || localCompressedSize !== compressedSize
        || localOriginalSize !== originalSize)) {
    throw zipInvalid('ZIPのローカルヘッダーが中央ディレクトリと一致しません');
  }

  const rawName = decodeEntryName(
    view,
    headerOffset + 46,
    nameBytes,
    (flags & 2048) !== 0,
  );
  const localName = decodeEntryName(
    view,
    localNameOffset,
    localNameBytes,
    (localFlags & 2048) !== 0,
  );
  if (rawName !== localName) {
    throw zipInvalid('ZIPのエントリー名がヘッダー間で一致しません');
  }

  return {
    nextOffset,
    entry: {
      rawName,
      method,
      crc,
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

  if (eocdOffset >= 20
      && view.getUint32(eocdOffset - 20, true) === ZIP64_LOCATOR_SIGNATURE) {
    throw zip64Unsupported();
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber === 0xffff || centralDisk === 0xffff
      || diskEntries === 0xffff || totalEntries === 0xffff
      || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    throw zip64Unsupported();
  }
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw splitZipUnsupported();
  }

  const centralEnd = centralOffset + centralBytes;
  if (centralEnd > eocdOffset) {
    throw zipInvalid('ZIPの中央ディレクトリが不正です');
  }
  if (containsSignature(
    view,
    centralEnd,
    eocdOffset,
    ZIP64_EOCD_SIGNATURE,
  ) || containsSignature(
    view,
    centralEnd,
    eocdOffset,
    ZIP64_LOCATOR_SIGNATURE,
  )) {
    throw zip64Unsupported();
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const parsed = validateEntryHeaders(
      view,
      offset,
      centralOffset,
      centralEnd,
    );
    entries.push(parsed.entry);
    offset = parsed.nextOffset;
  }
  if (offset !== centralEnd) {
    throw zipInvalid('ZIPの中央ディレクトリサイズが一致しません');
  }
  return entries;
}

function selectEntries(entries, limits) {
  const ignored = {
    directories: 0,
    unsupported: 0,
    nestedArchives: 0,
    unsafePaths: 0,
  };
  const accepted = [];
  const seen = new Set();
  let declaredTotal = 0;

  for (const entry of entries) {
    if (entry.rawName.endsWith('/')) {
      ignored.directories += 1;
      continue;
    }
    const name = normalizeZipEntryPath(entry.rawName);
    if (!name) {
      ignored.unsafePaths += 1;
      continue;
    }
    if (isZipName(name)) {
      ignored.nestedArchives += 1;
      continue;
    }
    if (!isSupportedHpglName(name)) {
      ignored.unsupported += 1;
      continue;
    }
    if (seen.has(name)) {
      throw zipError(
        'ZIP_DUPLICATE_PATH',
        `ZIP内でパスが重複しています: ${name}`,
      );
    }
    if (accepted.length + 1 > limits.maxEntries) {
      throw entryLimitExceeded(limits);
    }
    if (entry.originalSize > limits.maxEntryBytes) {
      throw entryTooLarge(name, limits);
    }
    if (declaredTotal + entry.originalSize > limits.maxTotalBytes) {
      throw totalTooLarge(limits);
    }

    seen.add(name);
    declaredTotal += entry.originalSize;
    accepted.push({ ...entry, name });
  }

  return { accepted, ignored };
}

function updateCrc(crc, bytes) {
  let next = crc;
  for (const byte of bytes) {
    next = CRC_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
  }
  return next >>> 0;
}

function joinChunks(chunks, byteLength) {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function createEntryCollector(entry, limits, actualTotal) {
  const chunks = [];
  let byteLength = 0;
  let crc = 0xffffffff;

  return {
    add(chunk) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('Archive entry chunk must be a Uint8Array');
      }
      const nextEntryBytes = byteLength + chunk.byteLength;
      if (nextEntryBytes > limits.maxEntryBytes) {
        throw entryTooLarge(entry.name, limits);
      }
      const nextTotalBytes = actualTotal.value + chunk.byteLength;
      if (nextTotalBytes > limits.maxTotalBytes) {
        throw totalTooLarge(limits);
      }
      chunks.push(chunk);
      byteLength = nextEntryBytes;
      actualTotal.value = nextTotalBytes;
      crc = updateCrc(crc, chunk);
    },
    finish() {
      if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
        throw zipInvalid(`CRC-32が一致しません: ${entry.name}`);
      }
      return {
        bytes: joinChunks(chunks, byteLength),
        sizeMismatch: byteLength !== entry.originalSize,
      };
    },
  };
}

function defaultScheduleTask(callback) {
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

function expandStoredEntry({
  archiveBytes,
  entry,
  limits,
  actualTotal,
  scheduleTask,
  isCancelled,
  installActiveCancel,
}) {
  return new Promise((resolve, reject) => {
    const collector = createEntryCollector(entry, limits, actualTotal);
    const endOffset = entry.dataOffset + entry.compressedSize;
    let offset = entry.dataOffset;
    let done = false;
    let cancelScheduled = () => {};
    let clearActiveCancel = () => {};

    const fail = error => {
      if (done) {
        return;
      }
      done = true;
      cancelScheduled();
      clearActiveCancel();
      reject(normalizeFailure(error));
    };
    const cancel = () => fail(abortError());
    clearActiveCancel = installActiveCancel(cancel);

    const step = () => {
      cancelScheduled = () => {};
      if (isCancelled()) {
        cancel();
        return;
      }
      try {
        const nextOffset = Math.min(offset + IO_CHUNK_BYTES, endOffset);
        collector.add(archiveBytes.subarray(offset, nextOffset));
        offset = nextOffset;
        if (offset === endOffset) {
          const result = collector.finish();
          done = true;
          clearActiveCancel();
          resolve(result);
          return;
        }
        cancelScheduled = scheduleTask(step);
      } catch (error) {
        fail(error);
      }
    };

    try {
      cancelScheduled = scheduleTask(step);
    } catch (error) {
      fail(error);
    }
  });
}

function deflateInputChunkBytes(limits) {
  return Math.max(
    1,
    Math.min(
      IO_CHUNK_BYTES,
      Math.floor(limits.maxEntryBytes / DEFLATE_MAX_EXPANSION_RATIO),
    ),
  );
}

function expandDeflatedEntry({
  archiveBytes,
  entry,
  limits,
  actualTotal,
  createInflater,
  scheduleTask,
  isCancelled,
  installActiveCancel,
}) {
  return new Promise((resolve, reject) => {
    const collector = createEntryCollector(entry, limits, actualTotal);
    const endOffset = entry.dataOffset + entry.compressedSize;
    const chunkBytes = deflateInputChunkBytes(limits);
    let offset = entry.dataOffset;
    let done = false;
    let inflater = null;
    let cancelScheduled = () => {};
    let clearActiveCancel = () => {};

    const fail = error => {
      if (done) {
        return;
      }
      done = true;
      cancelScheduled();
      try {
        inflater?.terminate();
      } catch {
        // Preserve the expansion failure that triggered termination.
      }
      clearActiveCancel();
      reject(normalizeFailure(error));
    };
    const cancel = () => fail(abortError());

    const ondata = (error, chunk, final) => {
      if (done) {
        return;
      }
      if (error) {
        fail(error);
        return;
      }
      try {
        collector.add(chunk);
        if (final) {
          const result = collector.finish();
          done = true;
          cancelScheduled();
          clearActiveCancel();
          resolve(result);
        }
      } catch (callbackError) {
        fail(callbackError);
      }
    };

    const scheduleFeed = () => {
      if (done) {
        return;
      }
      try {
        cancelScheduled = scheduleTask(feed);
      } catch (error) {
        fail(error);
      }
    };

    const feed = () => {
      cancelScheduled = () => {};
      if (isCancelled()) {
        cancel();
        return;
      }
      const nextOffset = Math.min(offset + chunkBytes, endOffset);
      const final = nextOffset === endOffset;
      const chunk = archiveBytes.slice(offset, nextOffset);
      offset = nextOffset;
      if (!final) {
        inflater.ondrain = () => {
          inflater.ondrain = null;
          scheduleFeed();
        };
      }
      try {
        inflater.push(chunk, final);
      } catch (error) {
        fail(error);
      }
    };

    try {
      inflater = createInflater(ondata);
      if (typeof inflater?.push !== 'function'
          || typeof inflater?.terminate !== 'function') {
        throw new TypeError('Async ZIP inflater is invalid');
      }
      clearActiveCancel = installActiveCancel(cancel);
      scheduleFeed();
    } catch (error) {
      fail(error);
    }
  });
}

async function expandEntries({
  archiveBytes,
  entries,
  limits,
  createInflater,
  scheduleTask,
  isCancelled,
  installActiveCancel,
}) {
  const actualTotal = { value: 0 };
  const expanded = [];
  let sizeMismatchName = null;

  for (const entry of entries) {
    if (isCancelled()) {
      throw abortError();
    }
    const params = {
      archiveBytes,
      entry,
      limits,
      actualTotal,
      scheduleTask,
      isCancelled,
      installActiveCancel,
    };
    const result = entry.method === 0
      ? await expandStoredEntry(params)
      : await expandDeflatedEntry({ ...params, createInflater });
    if (result.sizeMismatch) {
      sizeMismatchName ??= entry.name;
    }
    expanded.push({ entry, bytes: result.bytes });
  }
  if (sizeMismatchName !== null) {
    throw zipInvalid(`展開後サイズが申告値と一致しません: ${sizeMismatchName}`);
  }

  return expanded;
}

async function fingerprintArchive(bytes, digestImpl) {
  const digest = digestImpl ?? (async data => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error('Web Crypto SHA-256 is unavailable');
    }
    return subtle.digest('SHA-256', data);
  });
  if (typeof digest !== 'function') {
    throw new TypeError('ZIP digest implementation must be a function');
  }
  const result = await digest(bytes);
  const hash = result instanceof ArrayBuffer
    ? new Uint8Array(result)
    : ArrayBuffer.isView(result)
      ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
      : null;
  if (hash?.byteLength !== 32) {
    throw new TypeError('ZIP SHA-256 digest must contain 32 bytes');
  }
  return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createZipExpansionJob(sourceFile, options = {}) {
  const limits = limitsWith(options.limits);
  const createInflater = options.createInflater
    ?? (ondata => new AsyncInflate(ondata));
  const scheduleTask = options.scheduleTask ?? defaultScheduleTask;
  let activeCancel = () => {};
  let cancelled = false;
  let settled = false;
  let rejectCancellation;

  const cancellation = new Promise((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const installActiveCancel = cancel => {
    activeCancel = cancel;
    return () => {
      if (activeCancel === cancel) {
        activeCancel = () => {};
      }
    };
  };

  const work = (async () => {
    if (sourceFile.size > limits.maxArchiveBytes) {
      throw archiveTooLarge(limits);
    }
    const archiveBytes = new Uint8Array(await sourceFile.arrayBuffer());
    if (cancelled) {
      throw abortError();
    }

    const entries = validateZipHeaders(archiveBytes);
    const { accepted, ignored } = selectEntries(entries, limits);
    if (cancelled) {
      throw abortError();
    }
    if (accepted.length === 0) {
      return { items: [], ignored };
    }

    const archiveFingerprint = await fingerprintArchive(
      archiveBytes,
      options.digestImpl,
    );
    if (cancelled) {
      throw abortError();
    }

    const expanded = await expandEntries({
      archiveBytes,
      entries: accepted,
      limits,
      createInflater,
      scheduleTask,
      isCancelled: () => cancelled,
      installActiveCancel,
    });
    if (cancelled) {
      throw abortError();
    }

    return {
      items: expanded.map(({ entry, bytes }) => createArchiveInputRecord(
        sourceFile,
        entry.name,
        bytes,
        archiveFingerprint,
      )),
      ignored,
    };
  })().catch(error => {
    throw normalizeFailure(error);
  });

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
      activeCancel();
      rejectCancellation(abortError());
    },
  };
}
