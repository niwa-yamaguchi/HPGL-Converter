import { fileIdentity } from './file-policy.js';

function assertBlob(blob, label) {
  if (!(blob instanceof Blob) || typeof blob.arrayBuffer !== 'function') {
    throw new TypeError(`${label} must be a Blob`);
  }
}

export function createNativeInputRecord(file) {
  assertBlob(file, 'Native input');
  if (typeof file.name !== 'string' || !Number.isFinite(file.lastModified)) {
    throw new TypeError('Native input must be a File');
  }
  return {
    name: file.name,
    blob: file,
    size: file.size,
    identity: fileIdentity(file),
  };
}

export function createArchiveInputRecord(
  sourceFile,
  entryName,
  bytes,
  archiveFingerprint,
) {
  if (typeof sourceFile?.name !== 'string' || !Number.isFinite(sourceFile.lastModified)) {
    throw new TypeError('Archive source must be a File');
  }
  if (typeof entryName !== 'string' || entryName.length === 0) {
    throw new TypeError('Archive entry name must be a non-empty string');
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Archive entry bytes must be a Uint8Array');
  }
  if (typeof archiveFingerprint !== 'string' || archiveFingerprint.length === 0) {
    throw new TypeError('Archive fingerprint must be a non-empty string');
  }
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  return {
    name: entryName,
    blob,
    size: blob.size,
    identity: `${fileIdentity(sourceFile)}\0${archiveFingerprint}\0${entryName}`,
  };
}

export function toWorkerInput(record) {
  if (record === null || typeof record !== 'object' || typeof record.name !== 'string'
      || typeof record.identity !== 'string' || !Number.isFinite(record.size)) {
    throw new TypeError('Input record is invalid');
  }
  assertBlob(record.blob, 'Input record blob');
  return { name: record.name, blob: record.blob };
}
