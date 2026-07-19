# ZIP入力とDXFダウンロード改善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ZIP内のHPGLを既存のプレビューとDXF変換へ安全に取り込み、元ファイル由来の既定名で変換完了時にDXFを自動ダウンロードする。

**Architecture:** 入力を`{ name, blob, size, identity }`へ統一し、ZIP固有処理を`src/files/zip-reader.js`へ閉じ込める。元ファイルの順序と部分成功は投入バッチ層で管理し、Workerは`{ name, blob }`だけを受け取って既存のHPGL解析を再利用する。ダウンロード操作はDOM境界の小さなモジュールへ分離し、自動実行と再実行で共有する。

**Tech Stack:** Vanilla JavaScript、Vite 8、Vitest 4、jsdom、Web Worker、fflate 0.8.3、Blob URL

## Global Constraints

- ZIP本体は50 MiB以下とする。
- 1つのZIPから取り込む対応HPGLは100件以下とする。
- 展開後の1エントリーは20 MiB以下とする。
- 1つのZIPに含まれる対応HPGLの展開後合計は100 MiB以下とする。
- ZIP内ZIPは展開しない。
- PDF出力は実装しない。
- HPGL解析規則、ByLayerのR2000 DXF出力、プレビュー図形、差分判定規則を変更しない。
- 入力データと展開結果を外部へ送信しない。
- 既存のユーザー所有の未追跡ファイルを削除、上書き、または実装対象外のコミットへ含めない。
- 実行用worktreeに`docs/todo.md`または`reference/`が存在しない場合は、元ワークスペースの未追跡ファイルを読み取り専用の入力として個別に持ち込み、ほかの未追跡ファイルには触れない。

---

## ファイル構成

- Create: `src/files/input-records.js`
  - 通常ファイルとZIP内ファイルを共通入力レコードへ変換する。
  - Workerへ渡す`{ name, blob }`を生成する。
- Create: `src/files/zip-reader.js`
  - fflateで1つのZIPを検査、選別、展開する。
  - パス正規化、件数集計、上限、キャンセルを管理する。
- Create: `src/files/upload-expander.js`
  - 複数の元ファイルを順番に処理し、元ファイルごとの成功と失敗を返す。
- Create: `src/files/dxf-download.js`
  - DXF Blob URLを作成し、アンカーをクリックし、必ずURLを破棄する。
- Modify: `src/files/file-policy.js`
  - ZIP名判定と元ファイル名からのDXF既定名生成を追加する。
- Modify: `src/worker/worker-client.js`
  - 入力レコードをWorker用ペイロードへ変換する。
- Modify: `src/worker/converter.worker.js`
  - `{ name, blob }`を読み込む。
- Modify: `src/viewer/preview-client.js`
  - 入力レコードをWorker用ペイロードへ変換する。
- Modify: `src/viewer/preview.worker.js`
  - `{ name, blob }`を読み込む。
- Modify: `src/app.js`
  - ZIP投入状態、既定名の一回設定、部分成功、自動ダウンロードを統合する。
- Modify: `src/styles.css`
  - 展開中の既存状態表示で不足する場合だけ、既存パターンに沿った最小スタイルを追加する。
- Modify: `README.md`
  - ZIP対応、上限、既定名、自動ダウンロードを記載する。
- Modify: `docs/todo.md`
  - 今回の3項目をdoneへ移し、PDF出力をbacklogへ残す。
- Modify: `package.json`
  - `fflate`を実行時依存へ追加する。
- Modify: `package-lock.json`
  - `fflate`のロック情報を追加する。
- Create: `tests/files/input-records.test.js`
- Create: `tests/files/zip-reader.test.js`
- Create: `tests/files/upload-expander.test.js`
- Create: `tests/files/dxf-download.test.js`
- Modify: `tests/files/file-policy.test.js`
- Modify: `tests/worker/worker-client.test.js`
- Modify: `tests/viewer/preview-client.test.js`
- Modify: `tests/ui/app.test.js`

---

### Task 1: ファイル方針と共通入力レコード

**Files:**

- Create: `src/files/input-records.js`
- Modify: `src/files/file-policy.js`
- Create: `tests/files/input-records.test.js`
- Modify: `tests/files/file-policy.test.js`

**Interfaces:**

- Produces: `isZipName(name: string): boolean`
- Produces: `defaultOutputName(sourceName: string): string`
- Produces: `createNativeInputRecord(file: File): InputRecord`
- Produces: `createArchiveInputRecord(sourceFile: File, entryName: string, bytes: Uint8Array): InputRecord`
- Produces: `toWorkerInput(record: InputRecord): { name: string, blob: Blob }`
- `InputRecord` is `{ name: string, blob: Blob, size: number, identity: string }`.

- [ ] **Step 1: ZIP判定と既定名の失敗テストを書く**

`tests/files/file-policy.test.js`のimportへ`defaultOutputName`と`isZipName`を追加し、次のテストを追加する。

```js
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
```

- [ ] **Step 2: ファイル方針テストが失敗することを確認する**

Run: `npm.cmd test -- tests/files/file-policy.test.js`

Expected: FAIL with missing exports `isZipName` and `defaultOutputName`.

- [ ] **Step 3: ZIP判定と既定名を実装する**

`src/files/file-policy.js`を次の契約へ更新する。

```js
const INPUT_PATTERN = /\.(?:hpgl|hpg|plt|h(?:0[1-9]|[1-9]\d))$/i;
const ZIP_PATTERN = /\.zip$/i;

export const isSupportedHpglName = name => INPUT_PATTERN.test(name);
export const isZipName = name => ZIP_PATTERN.test(name);

export const fileIdentity = file => `${file.name}\0${file.size}\0${file.lastModified}`;

export function normalizeOutputName(name) {
  const base = name.trim() || 'converted.dxf';
  return /\.dxf$/i.test(base) ? base : `${base}.dxf`;
}

export function defaultOutputName(sourceName) {
  const leaf = String(sourceName).trim().split(/[\\/]/).pop() ?? '';
  const stem = leaf.replace(/\.[^.]+$/, '');
  return normalizeOutputName(stem);
}
```

- [ ] **Step 4: 共通入力レコードの失敗テストを書く**

`tests/files/input-records.test.js`を作成する。

```js
import { describe, expect, it } from 'vitest';
import {
  createArchiveInputRecord,
  createNativeInputRecord,
  toWorkerInput,
} from '../../src/files/input-records.js';

describe('input records', () => {
  it('wraps a native File without copying its bytes', () => {
    const file = new File(['PA0,0;'], 'drawing.H01', { lastModified: 123 });
    const record = createNativeInputRecord(file);

    expect(record).toMatchObject({
      name: 'drawing.H01',
      blob: file,
      size: file.size,
      identity: `drawing.H01\0${file.size}\0${file.lastModified}`,
    });
  });

  it('keeps an archive relative path outside File.name', async () => {
    const source = new File(['zip'], 'drawings.zip', { lastModified: 456 });
    const bytes = new TextEncoder().encode('PD40,0;PU;');
    const record = createArchiveInputRecord(source, 'parts/A.H01', bytes);

    expect(record.name).toBe('parts/A.H01');
    expect(record.size).toBe(bytes.byteLength);
    expect(record.identity).toBe(
      `drawings.zip\0${source.size}\0${source.lastModified}\0parts/A.H01`,
    );
    expect(new Uint8Array(await record.blob.arrayBuffer())).toEqual(bytes);
  });

  it('creates a structured-cloneable worker payload', () => {
    const file = new File(['PU;'], 'drawing.hpgl');
    const record = createNativeInputRecord(file);

    expect(toWorkerInput(record)).toEqual({ name: 'drawing.hpgl', blob: file });
  });

  it.each([null, {}, { name: 'a', blob: {}, size: 0, identity: 'a' }])(
    'rejects invalid input record %j',
    record => expect(() => toWorkerInput(record)).toThrow(TypeError),
  );
});
```

- [ ] **Step 5: 入力レコードテストが失敗することを確認する**

Run: `npm.cmd test -- tests/files/input-records.test.js`

Expected: FAIL because `src/files/input-records.js` does not exist.

- [ ] **Step 6: 共通入力レコードを実装する**

`src/files/input-records.js`を作成する。

```js
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

export function createArchiveInputRecord(sourceFile, entryName, bytes) {
  if (typeof sourceFile?.name !== 'string' || !Number.isFinite(sourceFile.lastModified)) {
    throw new TypeError('Archive source must be a File');
  }
  if (typeof entryName !== 'string' || entryName.length === 0) {
    throw new TypeError('Archive entry name must be a non-empty string');
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Archive entry bytes must be a Uint8Array');
  }
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  return {
    name: entryName,
    blob,
    size: blob.size,
    identity: `${fileIdentity(sourceFile)}\0${entryName}`,
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
```

- [ ] **Step 7: Task 1のテストを通す**

Run: `npm.cmd test -- tests/files/file-policy.test.js tests/files/input-records.test.js`

Expected: PASS for both test files.

- [ ] **Step 8: Task 1をコミットする**

```powershell
git add -- src/files/file-policy.js src/files/input-records.js tests/files/file-policy.test.js tests/files/input-records.test.js
git commit -m "feat: define archive input records"
```

---

### Task 2: 安全上限付きZIP展開

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/files/zip-reader.js`
- Create: `tests/files/zip-reader.test.js`

**Interfaces:**

- Consumes: `isSupportedHpglName`, `isZipName`, `createArchiveInputRecord`
- Produces: `DEFAULT_ZIP_LIMITS`
- Produces: `ZipInputError`
- Produces: `normalizeZipEntryPath(rawName: string): string | null`
- Produces: `createZipExpansionJob(sourceFile, options?): { promise, cancel }`
- The job resolves to `{ items: InputRecord[], ignored: { directories, unsupported, nestedArchives, unsafePaths } }`.

- [ ] **Step 1: fflateを固定バージョンで追加する**

Run: `npm.cmd install fflate@0.8.3`

Expected: `package.json` gains `"fflate": "^0.8.3"` under `dependencies`, and `package-lock.json` records version `0.8.3`.

- [ ] **Step 2: 正常展開とパス選別の失敗テストを書く**

`tests/files/zip-reader.test.js`を作成する。

```js
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

function mutateZipHeaders(source, { encrypted = false, method } = {}) {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 12; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      if (encrypted) {
        view.setUint16(offset + 6, view.getUint16(offset + 6, true) | 1, true);
      }
      if (method !== undefined) {
        view.setUint16(offset + 8, method, true);
      }
    }
    if (signature === 0x02014b50) {
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
    ['parts\\\\A.H01', 'parts/A.H01'],
    ['./parts//A.H01', 'parts/A.H01'],
    ['parts/./A.H01', 'parts/A.H01'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeZipEntryPath(input)).toBe(expected);
  });

  it.each([
    '../A.H01',
    'parts/../A.H01',
    '/absolute/A.H01',
    'C:\\\\absolute\\\\A.H01',
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
});
```

- [ ] **Step 3: 正常展開テストが失敗することを確認する**

Run: `npm.cmd test -- tests/files/zip-reader.test.js`

Expected: FAIL because `src/files/zip-reader.js` does not exist.

- [ ] **Step 4: パス正規化と非同期展開の中核を実装する**

`src/files/zip-reader.js`へ次の定数、エラー型、パス規則、ジョブ契約を実装する。

```js
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
```

展開処理では`unzip(bytes, { filter }, callback)`を呼び出す。
`filter`内でディレクトリ、パス、拡張子、重複、`originalSize`、件数、合計サイズをこの順に判定する。
上限または重複に達したら`policyError`を保存し、それ以降のエントリーを`false`で除外する。
callbackでは`policyError`をライブラリエラーより先にrejectし、`acceptedNames`順に`createArchiveInputRecord`を呼び出す。

```js
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
              return failPolicy('ZIP_DUPLICATE_PATH', `ZIP内でパスが重複しています: ${name}`);
            }
            if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
              return failPolicy('ZIP_INVALID', `展開後サイズを取得できません: ${name}`);
            }
            if (acceptedNames.length + 1 > limits.maxEntries) {
              return failPolicy('ZIP_ENTRY_LIMIT', '対応HPGLが100件を超えています');
            }
            if (entry.originalSize > limits.maxEntryBytes) {
              return failPolicy('ZIP_ENTRY_TOO_LARGE', `展開後ファイルが20 MiBを超えています: ${name}`);
            }
            if (totalBytes + entry.originalSize > limits.maxTotalBytes) {
              return failPolicy('ZIP_TOTAL_TOO_LARGE', '展開後合計が100 MiBを超えています');
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
```

- [ ] **Step 5: 正常展開テストを通す**

Run: `npm.cmd test -- tests/files/zip-reader.test.js`

Expected: PASS for path normalization, recursive extraction, Unicode path, and ignored counts.

- [ ] **Step 6: 上限、破損、重複、キャンセルの失敗テストを追加する**

同じテストファイルへ、注入可能な`limits`と`unzipImpl`を使う次のケースを追加する。

```js
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
```

- [ ] **Step 7: 上限と異常系テストを通す**

Run: `npm.cmd test -- tests/files/zip-reader.test.js`

Expected: PASS for every limit code, duplicate path, corrupt data, encrypted flag, unsupported method, and cancellation.

- [ ] **Step 8: Task 2をコミットする**

```powershell
git add -- package.json package-lock.json src/files/zip-reader.js tests/files/zip-reader.test.js
git commit -m "feat: safely expand HPGL zip archives"
```

---

### Task 3: 元ファイル順と部分成功を保つ投入バッチ

**Files:**

- Create: `src/files/upload-expander.js`
- Create: `tests/files/upload-expander.test.js`

**Interfaces:**

- Consumes: `isSupportedHpglName`, `isZipName`, `createNativeInputRecord`, `createZipExpansionJob`
- Produces: `createUploadExpansionJob(sources, options?): { promise, cancel }`
- The job resolves to `{ results: SourceResult[] }`.
- `SourceResult` is `{ sourceName, kind, items, ignored, error }`.
- `kind` is `'hpgl'`, `'zip'`, or `'unsupported'`.

- [ ] **Step 1: 順序、部分成功、キャンセルの失敗テストを書く**

`tests/files/upload-expander.test.js`を作成する。

```js
import { describe, expect, it, vi } from 'vitest';
import { createUploadExpansionJob } from '../../src/files/upload-expander.js';

const file = (name, content = 'PU;') => (
  new File([content], name, { lastModified: 123 })
);

describe('createUploadExpansionJob', () => {
  it('preserves source order across HPGL, ZIP, and unsupported files', async () => {
    const zipItem = {
      name: 'parts/A.H01',
      blob: new Blob(['PU;']),
      size: 3,
      identity: 'zip-entry',
    };
    const createZipJob = vi.fn(() => ({
      promise: Promise.resolve({
        items: [zipItem],
        ignored: {
          directories: 0, unsupported: 1, nestedArchives: 0, unsafePaths: 0,
        },
      }),
      cancel: vi.fn(),
    }));

    const result = await createUploadExpansionJob([
      file('first.H01'),
      file('bundle.zip'),
      file('notes.txt'),
      file('last.plt'),
    ], { createZipJob }).promise;

    expect(result.results.map(source => source.kind)).toEqual([
      'hpgl', 'zip', 'unsupported', 'hpgl',
    ]);
    expect(result.results[1].items).toEqual([zipItem]);
    expect(result.results[2].items).toEqual([]);
  });

  it('keeps later sources after one ZIP fails', async () => {
    const createZipJob = vi.fn(() => ({
      promise: Promise.reject(new Error('broken archive')),
      cancel: vi.fn(),
    }));

    const result = await createUploadExpansionJob([
      file('broken.zip'),
      file('good.H01'),
    ], { createZipJob }).promise;

    expect(result.results[0]).toMatchObject({
      sourceName: 'broken.zip', kind: 'zip', items: [], error: expect.any(Error),
    });
    expect(result.results[1]).toMatchObject({
      sourceName: 'good.H01', kind: 'hpgl', items: [expect.any(Object)], error: null,
    });
  });

  it('cancels the active ZIP and rejects with AbortError', async () => {
    const cancel = vi.fn();
    const createZipJob = vi.fn(() => ({
      promise: new Promise(() => {}),
      cancel,
    }));
    const job = createUploadExpansionJob([file('pending.zip')], { createZipJob });
    await Promise.resolve();
    job.cancel();

    await expect(job.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 投入バッチテストが失敗することを確認する**

Run: `npm.cmd test -- tests/files/upload-expander.test.js`

Expected: FAIL because `src/files/upload-expander.js` does not exist.

- [ ] **Step 3: 投入バッチを実装する**

`src/files/upload-expander.js`を作成し、元ファイルを`for...of`で順番に処理する。
ZIPの通常エラーは`SourceResult.error`へ保存して後続へ進み、`AbortError`だけはバッチ全体をrejectする。

```js
import { isSupportedHpglName, isZipName } from './file-policy.js';
import { createNativeInputRecord } from './input-records.js';
import { createZipExpansionJob } from './zip-reader.js';

const emptyIgnored = () => ({
  directories: 0,
  unsupported: 0,
  nestedArchives: 0,
  unsafePaths: 0,
});

const abortError = () => new DOMException('Upload expansion cancelled', 'AbortError');

export function createUploadExpansionJob(sources, options = {}) {
  if (!Array.isArray(sources)) {
    throw new TypeError('Upload sources must be an array');
  }
  const createZipJob = options.createZipJob ?? createZipExpansionJob;
  let currentJob = null;
  let cancelled = false;
  let settled = false;
  let rejectCancellation;
  const cancellation = new Promise((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const work = (async () => {
    const results = [];
    for (const source of sources) {
      if (cancelled) {
        throw abortError();
      }
      if (isSupportedHpglName(source.name)) {
        results.push({
          sourceName: source.name,
          kind: 'hpgl',
          items: [createNativeInputRecord(source)],
          ignored: emptyIgnored(),
          error: null,
        });
        continue;
      }
      if (!isZipName(source.name)) {
        results.push({
          sourceName: source.name,
          kind: 'unsupported',
          items: [],
          ignored: { ...emptyIgnored(), unsupported: 1 },
          error: null,
        });
        continue;
      }
      currentJob = createZipJob(source);
      try {
        const expanded = await currentJob.promise;
        results.push({
          sourceName: source.name,
          kind: 'zip',
          items: expanded.items,
          ignored: expanded.ignored,
          error: null,
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }
        results.push({
          sourceName: source.name,
          kind: 'zip',
          items: [],
          ignored: emptyIgnored(),
          error: error instanceof Error ? error : new Error('ZIP expansion failed'),
        });
      } finally {
        currentJob = null;
      }
    }
    return { results };
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
      currentJob?.cancel();
      rejectCancellation(abortError());
    },
  };
}
```

- [ ] **Step 4: 投入バッチテストを通す**

Run: `npm.cmd test -- tests/files/upload-expander.test.js`

Expected: PASS for stable order, partial success, and cancellation.

- [ ] **Step 5: Task 3をコミットする**

```powershell
git add -- src/files/upload-expander.js tests/files/upload-expander.test.js
git commit -m "feat: expand upload batches in source order"
```

---

### Task 4: Worker境界を入力レコードへ対応させる

**Files:**

- Modify: `src/worker/worker-client.js`
- Modify: `src/worker/converter.worker.js`
- Modify: `src/viewer/preview-client.js`
- Modify: `src/viewer/preview.worker.js`
- Modify: `tests/worker/worker-client.test.js`
- Modify: `tests/viewer/preview-client.test.js`

**Interfaces:**

- Consumes: `toWorkerInput(record)`
- Conversion and preview clients continue to accept `(records, layerNames, options)`.
- Worker messages carry `files: Array<{ name: string, blob: Blob }>` and `layerNames: string[]`.

- [ ] **Step 1: Workerペイロードの失敗テストへ更新する**

両クライアントテストのヘルパーを次へ変更する。

```js
const file = (name, source = '') => {
  const blob = new Blob([source]);
  return { name, blob, size: blob.size, identity: `id:${name}` };
};
```

クライアントが送信したメッセージは元レコードと同一ではなく、次の形になることを検証する。

```js
expect(request).toMatchObject({
  files: [{ name: 'a.hpgl', blob: files[0].blob }],
  layerNames: ['a'],
});
expect(request.files[0]).not.toHaveProperty('identity');
```

Workerプロトコルの入力は次の形へ変更する。

```js
{
  name: 'first.hpgl',
  blob: { arrayBuffer: firstArrayBuffer },
}
```

- [ ] **Step 2: Worker関連テストが失敗することを確認する**

Run: `npm.cmd test -- tests/worker/worker-client.test.js tests/viewer/preview-client.test.js`

Expected: FAIL because clients still post records directly and workers still read `file.arrayBuffer()`.

- [ ] **Step 3: 両クライアントでWorker用ペイロードを作る**

`src/worker/worker-client.js`と`src/viewer/preview-client.js`で`toWorkerInput`をimportする。
引数検証では全レコードへ`toWorkerInput`を適用し、検証済みの配列をWorkerメッセージへ渡す。

```js
const workerFiles = files.map(toWorkerInput);
worker.postMessage({
  type: 'convert',
  requestId,
  files: workerFiles,
  layerNames,
});
```

プレビュー側は`type: 'preview'`を使い、同じ`workerFiles`契約とする。

- [ ] **Step 4: 両WorkerでBlobを読む**

Worker側のファイル検証を次へ変更する。

```js
if (file === null || typeof file !== 'object' || typeof file.name !== 'string'
    || file.blob === null || typeof file.blob !== 'object'
    || typeof file.blob.arrayBuffer !== 'function') {
  throw new TypeError(`Worker file ${index} is invalid`);
}
```

変換WorkerとプレビューWorkerの読み込みを次へ変更する。

```js
const buffer = await file.blob.arrayBuffer();
```

読み込み順、個別失敗、進捗、DXFバッファのtransfer、Workerキャンセルの既存処理は変更しない。

- [ ] **Step 5: Worker関連テストを通す**

Run: `npm.cmd test -- tests/worker/worker-client.test.js tests/viewer/preview-client.test.js`

Expected: PASS for client protocol, sequential reads, individual read failures, completion, protocol errors, and cancellation.

- [ ] **Step 6: Task 4をコミットする**

```powershell
git add -- src/worker/worker-client.js src/worker/converter.worker.js src/viewer/preview-client.js src/viewer/preview.worker.js tests/worker/worker-client.test.js tests/viewer/preview-client.test.js
git commit -m "refactor: pass named blobs to workers"
```

---

### Task 5: ZIP投入状態とDXF既定名をUIへ統合する

**Files:**

- Modify: `src/app.js`
- Modify: `src/styles.css`
- Modify: `tests/ui/app.test.js`

**Interfaces:**

- Consumes: `createUploadExpansionJob`
- Consumes: `createNativeInputRecord`
- Consumes: `defaultOutputName`, `isZipName`
- `mountApp` dependency injection gains `createUploadExpansionJob`.
- `state.files` becomes `InputRecord[]`.

- [ ] **Step 1: ZIP表示、展開中、部分成功の失敗テストを書く**

`tests/ui/app.test.js`へZIP用ヘルパーを追加する。

```js
const zipFile = name => new File(['zip bytes'], name, {
  type: 'application/zip',
  lastModified: 789,
});

const inputRecord = (name, identity = `id:${name}`) => {
  const blob = new Blob(['PU;']);
  return { name, blob, size: blob.size, identity };
};
```

次のUI契約をテストする。

```js
it('accepts ZIP and disables mutable file controls while expanding', async () => {
  const job = deferredJob();
  mount({
    createConversionJob: vi.fn(),
    createUploadExpansionJob: vi.fn(() => job),
  });
  const input = document.querySelector('[data-testid="file-input"]');
  expect(input.accept).toContain('.zip');

  setInputFiles(input, [zipFile('drawings.zip')]);

  expect(document.body.textContent).toContain('ZIPを展開しています');
  expect(input.disabled).toBe(true);
  expect(document.querySelector('[data-testid="drop-zone"]').disabled).toBe(true);
  expect(document.querySelector('[data-testid="convert-button"]').disabled).toBe(true);

  job.resolve({
    results: [{
      sourceName: 'drawings.zip',
      kind: 'zip',
      items: [inputRecord('parts/A.H01')],
      ignored: {
        directories: 1, unsupported: 1, nestedArchives: 1, unsafePaths: 1,
      },
      error: null,
    }],
  });

  await vi.waitFor(() => expect(document.body.textContent).toContain('parts/A.H01'));
  expect(document.querySelector('[data-testid="file-row"]').textContent)
    .toContain('parts_A');
  expect(document.body.textContent).toContain(
    'ディレクトリ 1件、非対応 1件、ZIP内ZIP 1件、不正パス 1件を無視しました',
  );
  expect(input.disabled).toBe(false);
});
```

部分成功は`broken.zip`の`error`と`good.H01`の入力レコードを同じ結果に入れ、エラー文と正常行が同時に残ることを確認する。
対応HPGLが0件のZIPは行を追加せず、「対応HPGLがありません」と警告する。

- [ ] **Step 2: 既定名を一度だけ設定する失敗テストを書く**

通常HPGLとZIPについて次を追加する。

```js
it('seeds the DXF name from the first successfully added source once', async () => {
  const zipJob = deferredJob();
  mount({
    createConversionJob: vi.fn(),
    createUploadExpansionJob: vi.fn(() => zipJob),
  });
  const input = document.querySelector('[data-testid="file-input"]');
  const output = document.querySelector('[data-testid="output-name"]');

  setInputFiles(input, [zipFile('drawings.zip')]);
  zipJob.resolve({
    results: [{
      sourceName: 'drawings.zip',
      kind: 'zip',
      items: [inputRecord('parts/A.H01')],
      ignored: {
        directories: 0, unsupported: 0, nestedArchives: 0, unsafePaths: 0,
      },
      error: null,
    }],
  });
  await vi.waitFor(() => expect(output.value).toBe('drawings.dxf'));

  setInputFiles(input, [hpglFile('later.H02')]);
  expect(output.value).toBe('drawings.dxf');
});

it('does not overwrite a name edited before the first successful upload', () => {
  mount({ createConversionJob: vi.fn() });
  const output = document.querySelector('[data-testid="output-name"]');
  output.value = 'manual.dxf';
  output.dispatchEvent(new Event('input', { bubbles: true }));

  setInputFiles(
    document.querySelector('[data-testid="file-input"]'),
    [hpglFile('drawing.H01')],
  );

  expect(output.value).toBe('manual.dxf');
});
```

最初のZIPが失敗し、同じ結果内の後続元ファイルが成功した場合は後続名を採用する。
全ファイル削除後に新しいファイルを追加しても既定名を変更しない。

- [ ] **Step 3: UIテストが失敗することを確認する**

Run: `npm.cmd test -- tests/ui/app.test.js`

Expected: FAIL because `.zip` is not accepted, upload expansion dependency and importing state do not exist, and output name remains `converted.dxf`.

- [ ] **Step 4: 入力レコードと通常ファイルの同期経路を統合する**

`src/app.js`へ次をimportする。

```js
import {
  defaultOutputName,
  isSupportedHpglName,
  isZipName,
  normalizeOutputName,
} from './files/file-policy.js';
import { createNativeInputRecord } from './files/input-records.js';
import { createUploadExpansionJob as createDefaultUploadExpansionJob } from './files/upload-expander.js';
```

`mountApp`で依存を確定し、stateへ次を追加する。

```js
const createUploadExpansionJob = deps.createUploadExpansionJob
  ?? createDefaultUploadExpansionJob;

const state = {
  files: [],
  importing: false,
  importJob: null,
  importToken: null,
  outputNameSeeded: false,
  outputNameEdited: false,
};
```

既存stateのほかのプロパティは維持する。
通常HPGLだけの投入では、既存UIテストの同期性を保つため`createNativeInputRecord`で直ちに入力レコード化する。
ZIPが1件でも含まれる投入では、元ファイル全体を`createUploadExpansionJob`へ渡す。

- [ ] **Step 5: 元ファイル単位の結果を既存一覧へマージする**

次の責務を持つ関数を`mountApp`内へ追加する。

```js
function seedOutputName(sourceName) {
  if (state.outputNameSeeded) {
    return;
  }
  state.outputNameSeeded = true;
  if (!state.outputNameEdited) {
    nodes.outputName.value = defaultOutputName(sourceName);
  }
}

function mergeSourceResults(results) {
  const known = new Set(state.files.map(file => file.identity));
  const notices = [];
  let added = 0;

  for (const source of results) {
    if (source.error) {
      notices.push(`${source.sourceName} を展開できませんでした: ${source.error.message}`);
      continue;
    }
    let sourceAdded = 0;
    for (const item of source.items) {
      if (known.has(item.identity)) {
        notices.push(`${item.name} はすでに追加されています`);
        continue;
      }
      known.add(item.identity);
      state.files.push(item);
      sourceAdded += 1;
      added += 1;
    }
    if (sourceAdded > 0) {
      seedOutputName(source.sourceName);
    } else if (source.kind === 'zip' && source.items.length === 0) {
      notices.push(`${source.sourceName} に対応HPGLがありません`);
    } else if (source.kind === 'unsupported') {
      notices.push(`${source.sourceName} は対応していない形式です`);
    }
    const ignoredDetails = [
      ['ディレクトリ', source.ignored.directories],
      ['非対応', source.ignored.unsupported],
      ['ZIP内ZIP', source.ignored.nestedArchives],
      ['不正パス', source.ignored.unsafePaths],
    ]
      .filter(([_label, count]) => count > 0)
      .map(([label, count]) => `${label} ${count}件`);
    if (ignoredDetails.length > 0 && source.kind === 'zip') {
      notices.push(
        `${source.sourceName}: ${ignoredDetails.join('、')}を無視しました`,
      );
    }
  }

  return { added, notices };
}
```

マージ後にレイヤー名を再計算し、結果を消去し、一覧を再描画し、プレビューを1回だけ開始する。
通知がある場合はwarning、通知がなく追加がある場合は通常メッセージを表示する。

- [ ] **Step 6: 展開ジョブの状態遷移と破棄処理を実装する**

`startImport(sources)`は`importing`を設定し、トークンを作り、状態文を表示してからジョブを開始する。
完了と失敗ではトークンと`destroyed`を照合する。
`AbortError`は破棄またはキャンセルの通常遷移として扱う。

`renderFiles()`の無効化条件は次にそろえる。

```js
const locked = state.importing || state.converting;
nodes.input.disabled = locked;
nodes.dropZone.disabled = locked;
nodes.outputName.disabled = state.converting;
nodes.convert.disabled = locked || state.files.length === 0;
```

削除ボタンも`locked`で無効化する。
`destroy()`は変換ジョブとプレビュージョブに加えて`state.importJob?.cancel()`を例外から保護して呼び出す。

- [ ] **Step 7: accept、コピー、既定名編集を接続する**

ファイル入力の`accept`末尾へ`,.zip`を追加する。
入力案内を「HPGLまたはZIPファイルをここへドロップ」へ変更し、プライバシーカードへ「ZIPもブラウザ内で展開」と表示する。

出力名のユーザー編集を次で記録する。

```js
listen(nodes.outputName, 'input', () => {
  state.outputNameEdited = true;
});
```

ファイル選択とdropの両方を`handleUploads`へ接続する。
変換、プレビュー、一覧は`InputRecord.name`、`InputRecord.size`、`InputRecord.identity`を使用する。

- [ ] **Step 8: UIテストと既存プレビュー回帰を通す**

Run: `npm.cmd test -- tests/ui/app.test.js tests/viewer/preview-client.test.js tests/worker/worker-client.test.js`

Expected: PASS for ZIP import state, partial success, one-time default name, existing file removal, previews, diffs, conversion progress, and cleanup.

- [ ] **Step 9: Task 5をコミットする**

```powershell
git add -- src/app.js src/styles.css tests/ui/app.test.js
git commit -m "feat: add ZIP uploads to the converter UI"
```

---

### Task 6: 変換完了時の自動ダウンロード

**Files:**

- Create: `src/files/dxf-download.js`
- Create: `tests/files/dxf-download.test.js`
- Modify: `src/app.js`
- Modify: `tests/ui/app.test.js`

**Interfaces:**

- Produces: `triggerDxfDownload(buffer, outputName, deps?): string`
- Consumes: `normalizeOutputName`
- Returns the normalized downloaded file name.

- [ ] **Step 1: DOMダウンロード境界の失敗テストを書く**

`tests/files/dxf-download.test.js`をjsdom環境で作成する。

```js
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { triggerDxfDownload } from '../../src/files/dxf-download.js';

describe('triggerDxfDownload', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('clicks a detached DXF download and revokes its Blob URL', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const urlApi = {
      createObjectURL: vi.fn(() => 'blob:dxf'),
      revokeObjectURL: vi.fn(),
    };

    const name = triggerDxfDownload(
      new Uint8Array([0, 1, 2]).buffer,
      ' production ',
      { documentRef: document, urlApi },
    );

    expect(name).toBe('production.dxf');
    expect(urlApi.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'application/dxf' }),
    );
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0].download).toBe('production.dxf');
    expect(click.mock.instances[0].isConnected).toBe(false);
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:dxf');
  });

  it('revokes the URL when anchor click throws', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => { throw new Error('blocked'); });
    const urlApi = {
      createObjectURL: vi.fn(() => 'blob:blocked'),
      revokeObjectURL: vi.fn(),
    };

    expect(() => triggerDxfDownload(
      new ArrayBuffer(0),
      'drawing.dxf',
      { documentRef: document, urlApi },
    )).toThrow('blocked');
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:blocked');
  });
});
```

- [ ] **Step 2: ダウンロード境界テストが失敗することを確認する**

Run: `npm.cmd test -- tests/files/dxf-download.test.js`

Expected: FAIL because `src/files/dxf-download.js` does not exist.

- [ ] **Step 3: ダウンロード境界を実装する**

`src/files/dxf-download.js`を作成する。

```js
import { normalizeOutputName } from './file-policy.js';

export function triggerDxfDownload(buffer, outputName, deps = {}) {
  const documentRef = deps.documentRef ?? document;
  const urlApi = deps.urlApi ?? URL;
  const blob = new Blob([buffer], { type: 'application/dxf' });
  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  const name = normalizeOutputName(outputName);
  anchor.href = objectUrl;
  anchor.download = name;
  anchor.hidden = true;
  documentRef.body.append(anchor);
  try {
    anchor.click();
    return name;
  } finally {
    anchor.remove();
    urlApi.revokeObjectURL(objectUrl);
  }
}
```

- [ ] **Step 4: ダウンロード境界テストを通す**

Run: `npm.cmd test -- tests/files/dxf-download.test.js`

Expected: PASS for successful click and exceptional cleanup.

- [ ] **Step 5: UI自動ダウンロードの失敗テストを書く**

`tests/ui/app.test.js`の既存ダウンロードテストを、自動実行を前提に更新する。

```js
it('downloads once automatically and keeps the manual download button', async () => {
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  mount({
    createConversionJob: () => ({
      promise: Promise.resolve(result()),
      cancel: vi.fn(),
    }),
  });
  setInputFiles(
    document.querySelector('[data-testid="file-input"]'),
    [hpglFile('sample.hpgl')],
  );
  document.querySelector('[data-testid="convert-button"]').click();

  await vi.waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
  expect(anchorClick.mock.instances[0].download).toBe('sample.dxf');
  expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull();

  document.querySelector('[data-testid="download-button"]').click();
  expect(anchorClick).toHaveBeenCalledTimes(2);
});
```

診断エラーを含む結果でも自動実行することを確認する。
`anchor.click()`が例外を投げる場合は、結果欄と再ダウンロードボタンが残り、「再ダウンロード」案内がstatusへ出ることを確認する。
2回の変換では各結果につき1回、再描画と古い完了通知では追加実行しないことを確認する。

- [ ] **Step 6: UI自動ダウンロードテストが失敗することを確認する**

Run: `npm.cmd test -- tests/ui/app.test.js`

Expected: FAIL because conversion completion does not click the download anchor.

- [ ] **Step 7: 自動ダウンロードと再ダウンロードを統合する**

`src/app.js`で`triggerDxfDownload`をimportする。
stateへ`autoDownloadedResult: null`を追加し、`clearResult()`でnullへ戻す。

```js
function downloadResult() {
  if (!state.result?.buffer) {
    return null;
  }
  const name = triggerDxfDownload(state.result.buffer, nodes.outputName.value);
  announce(`${name} のダウンロードを開始しました。`, 'success');
  return name;
}
```

`finishConversion`では結果表示後に、同じ結果へ一度だけ自動実行する。

```js
renderResults();
if (state.autoDownloadedResult !== conversionResult) {
  state.autoDownloadedResult = conversionResult;
  try {
    downloadResult();
  } catch {
    announce(
      '自動ダウンロードを開始できませんでした。結果欄から再ダウンロードしてください。',
      'warning',
    );
  }
}
```

結果欄のボタンは同じ`downloadResult`を呼ぶ。
変換自体の失敗とダウンロード開始失敗は別の状態として維持する。

- [ ] **Step 8: Task 6のテストを通す**

Run: `npm.cmd test -- tests/files/dxf-download.test.js tests/ui/app.test.js`

Expected: PASS for one automatic download per result, error-bearing DXF, manual retry, blocked click fallback, and URL cleanup.

- [ ] **Step 9: Task 6をコミットする**

```powershell
git add -- src/files/dxf-download.js tests/files/dxf-download.test.js src/app.js tests/ui/app.test.js
git commit -m "feat: download DXF after conversion"
```

---

### Task 7: ドキュメント更新と全体検証

**Files:**

- Modify: `README.md`
- Modify: `docs/todo.md`
- Verify: all changed source and test files

**Interfaces:**

- Consumes the finished ZIP input and automatic download behavior.
- Produces user-facing instructions that match the executable contract.

- [ ] **Step 1: READMEの契約テストを追加する**

`tests/ui/app.test.js`のオフライン構成テストでREADMEも読み込み、次を検証する。

```js
const readme = await readFile(resolve(process.cwd(), 'README.md'), 'utf8');
expect(readme).toContain('ZIP');
expect(readme).toContain('50 MiB');
expect(readme).toContain('自動ダウンロード');
expect(readme).toContain('再ダウンロード');
```

- [ ] **Step 2: README契約テストが失敗することを確認する**

Run: `npm.cmd test -- tests/ui/app.test.js`

Expected: FAIL because README does not describe ZIP limits and automatic download.

- [ ] **Step 3: READMEとtodoを更新する**

READMEの「主な特徴」「対応ファイル」「使い方」へ次を反映する。

```markdown
- 通常HPGLとZIPアーカイブを入力可能
- ZIP内のサブフォルダから対応HPGLだけを抽出
- 最初に追加できた元ファイル名をDXF既定名として使用
- 変換完了時にDXFを自動ダウンロードし、結果欄から再ダウンロード可能
```

ZIP上限として「ZIP本体50 MiB、対応HPGL 100件、1件の展開後20 MiB、展開後合計100 MiB」を明記する。
使い方は、ZIPまたはHPGLを追加し、「DXFに変換」を押すとダウンロードが始まる順序へ変更する。

`docs/todo.md`は次の状態へ更新する。

```markdown
# todo

## bug

## backlog
- PDF出力機能

## done
- ZIPアップロード対応
- DXF変換ボタンでそのままダウンロード実行
- dxfデフォルトのファイル名を最初にアップロードされたファイル名にする
- ビューワー機能
  - ファイル別で色分けレイヤー表示
  - 差分表示機能も付けたい
```

- [ ] **Step 4: 全テストを実行する**

Run: `npm.cmd test`

Expected: all Vitest files and tests PASS with zero failures.

- [ ] **Step 5: プロダクションビルドを実行する**

Run: `npm.cmd run build`

Expected: Vite exits 0 and creates the single-file build under `dist/`.

- [ ] **Step 6: 参照DXFを再生成する**

Run: `npm.cmd run generate:reference-dxf`

Expected: exits 0, processes the reference HPGL corpus, and produces the existing R2000 reference artifact without changing its established geometry fingerprints.

- [ ] **Step 7: 差分と作業ツリーを検査する**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only files from this plan and pre-existing user-owned untracked files are listed.

Run: `git diff -- README.md docs/todo.md package.json src tests`

Expected: no PDF implementation, no HPGL parser semantic change, no entity-level DXF color, and no unrelated refactor.

- [ ] **Step 8: READMEとtodoをコミットする**

```powershell
git add -- README.md docs/todo.md tests/ui/app.test.js
git commit -m "docs: explain ZIP conversion workflow"
```

- [ ] **Step 9: 最終コミット列と状態を確認する**

Run: `git log --oneline -8`

Expected: design and plan commits followed by the seven focused implementation commits in task order.

Run: `git status --short --branch`

Expected: implementation対象の追跡済みファイルに未コミット変更がなく、事前から存在するユーザー所有の未追跡ファイルだけが残る。
