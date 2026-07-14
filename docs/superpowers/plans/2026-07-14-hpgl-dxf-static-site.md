# HPGL-DXF Static Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 複数のHPGLファイルをブラウザ内で解析し、ファイル別DXFレイヤーとペン由来ACI色を保持したAutoCAD 2000互換DXFを生成する静的サイトを構築する。

**Architecture:** Vanilla JavaScriptの変換コアをDOMから分離し、Viteでビルドする。ファイル解析とDXF生成はインラインWeb Workerで実行し、UIはファイル管理、進捗、診断、ダウンロードだけを担当する。

**Tech Stack:** JavaScript (ES modules)、Vite、Vitest、jsdom、HTML、CSS、Web Worker、Blob/ArrayBuffer

## Global Constraints

- 対応ブラウザは最新のMicrosoft EdgeとGoogle Chrome。
- ビルド成果物は`file://`直接起動と静的Webサーバー配信の両方に対応する。
- HPGLデータ、診断、生成DXFを外部APIへ送信しない。実行時CDN依存も設けない。
- 対応拡張子は`.hpgl`、`.hpg`、`.plt`、`.H01`から`.H99`まで。大文字・小文字は区別しない。
- HPGL座標は既定で40単位＝1mm、DXFはAutoCAD 2000 ASCII、`$INSUNITS=4`。
- 入力ファイルごとに1レイヤー、ペン番号は各図形のACI色、`SP0`はACI 1。
- 対応命令は`IN/DF/SP/PA/PR/PU/PD/CI/AA/AR/PE/IP/IR/SC/LB`。`CT/LT/VS/PG/RO/PS`は警告なしの無処理命令。
- `LB`は現在位置、文字高5mm、回転0度のDXF `TEXT`。
- `IR`は装置固有ハードクリップ範囲を取得できないため、明示済みの`IP`矩形を百分率基準として解釈する。P2未設定時は命令をエラーとして無視する。
- `SC`は参考Python版と同じ4パラメーターの異方性変換を実装する。追加パラメーターは警告して無視する。
- 実装はテスト駆動で進め、各タスク終了時に対象テストと全テストを実行する。

## File Structure

```text
index.html                         画面の静的マークアップ
package.json                       開発、テスト、ビルドのスクリプト
package-lock.json                  依存バージョン固定
vite.config.js                     相対パス出力とVitest設定
src/app.js                         UI状態とイベント制御
src/styles.css                     レスポンシブな1画面UI
src/files/file-policy.js           拡張子、重複、出力名の規則
src/files/layer-names.js           DXFレイヤー名生成
src/hpgl/tokenizer.js              バイト列からHPGL命令へ分割
src/hpgl/coordinates.js            IP/IR/SCとmm変換
src/hpgl/pe-decoder.js             PEのbase64/base32デコード
src/hpgl/parser.js                 HPGL状態機械と共通図形生成
src/dxf/escape.js                  DXF文字列とレイヤー名のエスケープ
src/dxf/writer.js                  R2000 ASCII DXF生成
src/converter.js                   複数ファイル統合と集計
src/worker/converter.worker.js     Workerメッセージ処理
src/worker/worker-client.js        UI側のWorkerラッパー
tests/**/*.test.js                 単体、結合、DOMテスト
docs/bricscad-v24-checklist.md     CADでの手動確認手順
```

---

### Task 1: Tooling, File Policy, and Layer Names

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `vite.config.js`
- Create: `src/files/file-policy.js`
- Create: `src/files/layer-names.js`
- Test: `tests/files/file-policy.test.js`
- Test: `tests/files/layer-names.test.js`

**Interfaces:**
- Produces: `isSupportedHpglName(name: string): boolean`
- Produces: `fileIdentity(file: Pick<File, 'name'|'size'|'lastModified'>): string`
- Produces: `normalizeOutputName(name: string): string`
- Produces: `assignLayerNames(names: string[]): string[]`

- [ ] **Step 1: Create the test/build configuration**

```json
{
  "name": "hpgl-dxf-static-site",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "vite build"
  }
}
```

```js
// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  test: { environment: 'node', coverage: { reporter: ['text', 'html'] } },
});
```

Run: `npm install --save-dev vite vitest jsdom`

Expected: `package-lock.json`が生成され、終了コード0。

- [ ] **Step 2: Write failing policy and layer-name tests**

```js
import { describe, expect, it } from 'vitest';
import { isSupportedHpglName, normalizeOutputName } from '../../src/files/file-policy.js';
import { assignLayerNames } from '../../src/files/layer-names.js';

describe('file policy', () => {
  it.each(['a.hpgl', 'a.HPG', 'a.plt', 'a.H01', 'a.h99'])('accepts %s', name => {
    expect(isSupportedHpglName(name)).toBe(true);
  });
  it.each(['a.H00', 'a.H100', 'a.txt'])('rejects %s', name => {
    expect(isSupportedHpglName(name)).toBe(false);
  });
  it('adds a dxf suffix once', () => expect(normalizeOutputName('drawing')).toBe('drawing.dxf'));
});

it('sanitizes and de-duplicates layer names case-insensitively', () => {
  expect(assignLayerNames(['部品:H01.H01', 'sample.hpgl', 'SAMPLE.plt', '***.hpg']))
    .toEqual(['部品_H01', 'sample', 'SAMPLE_2', '___']);
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run: `npm test -- tests/files`

Expected: FAIL because the two source modules do not exist.

- [ ] **Step 4: Implement the policies and deterministic layer names**

```js
// src/files/file-policy.js
const INPUT_PATTERN = /\.(?:hpgl|hpg|plt|h(?:0[1-9]|[1-9]\d))$/i;

export const isSupportedHpglName = name => INPUT_PATTERN.test(name);
export const fileIdentity = file => `${file.name}\0${file.size}\0${file.lastModified}`;
export function normalizeOutputName(name) {
  const base = name.trim() || 'converted.dxf';
  return /\.dxf$/i.test(base) ? base : `${base}.dxf`;
}
```

```js
// src/files/layer-names.js
const INVALID = /[<>/\\":;?*|=,]/g;
const stripExtension = name => name.replace(/\.[^.]+$/, '');

export function assignLayerNames(names) {
  const used = new Set();
  return names.map(name => {
    const base = stripExtension(name).replace(INVALID, '_') || 'layer';
    let candidate = base;
    for (let suffix = 2; used.has(candidate.toLocaleLowerCase('en-US')); suffix += 1) {
      candidate = `${base}_${suffix}`;
    }
    used.add(candidate.toLocaleLowerCase('en-US'));
    return candidate;
  });
}
```

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- tests/files`

Expected: all file policy and layer-name tests PASS.

```powershell
git add package.json package-lock.json vite.config.js src/files tests/files
git commit -m "chore: set up static converter project"
```

---

### Task 2: Byte-Safe HPGL Tokenizer

**Files:**
- Create: `src/hpgl/tokenizer.js`
- Test: `tests/hpgl/tokenizer.test.js`

**Interfaces:**
- Produces: `tokenizeHpgl(data: Uint8Array): { tokens: HpglToken[], diagnostics: Diagnostic[] }`
- Produces type: `HpglToken = { code: string, params: Uint8Array, offset: number, label?: string }`
- Diagnostic shape: `{ severity: 'error'|'warning', command: string, offset: number, message: string, skippedCommands: number, skippedShapes: number }`

- [ ] **Step 1: Write tokenizer tests for line breaks, concatenated commands, ESC, and labels**

```js
import { expect, it } from 'vitest';
import { tokenizeHpgl } from '../../src/hpgl/tokenizer.js';

const ascii = text => new TextEncoder().encode(text);

it('splits numeric commands across CRLF and concatenated mnemonics', () => {
  const result = tokenizeHpgl(ascii('PA0,0;PDPR40,0;\r\nPU;'));
  expect(result.tokens.map(token => token.code)).toEqual(['PA', 'PD', 'PR', 'PU']);
  expect(new TextDecoder().decode(result.tokens[2].params)).toBe('40,0');
});

it('strips reference-compatible ESC sequences and preserves offsets', () => {
  const result = tokenizeHpgl(ascii('\x1b.Eignored:\nPA40,80;'));
  expect(result.tokens).toMatchObject([{ code: 'PA', offset: 12 }]);
});

it('reads LB through ETX even when the label contains a semicolon', () => {
  const result = tokenizeHpgl(ascii('LBABC;DEF\x03PA0,0;'));
  expect(result.tokens[0]).toMatchObject({ code: 'LB', label: 'ABC;DEF' });
  expect(result.tokens[1].code).toBe('PA');
});
```

- [ ] **Step 2: Run the tokenizer test and verify RED**

Run: `npm test -- tests/hpgl/tokenizer.test.js`

Expected: FAIL because `tokenizeHpgl` does not exist.

- [ ] **Step 3: Implement a byte scanner**

Implement `tokenizeHpgl` as a cursor-based scanner with these exact branches:

```js
const isAlpha = byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
const upperPair = (a, b) => String.fromCharCode(a, b).toUpperCase();

// Scanner rules:
// 1. Skip whitespace, semicolons, and ESC '.' payload through ':' or newline.
// 2. Require two ASCII letters; otherwise emit one warning and advance to ';'.
// 3. For LB, read bytes through ETX (0x03); if absent, recover at ';' or EOF.
// 4. For other commands, stop at ';' or at the next adjacent two-letter mnemonic.
// 5. Keep params as Uint8Array so PE bytes 128-255 are not damaged.
```

Return exact input byte offsets, not decoded-string indexes.

- [ ] **Step 4: Run tokenizer tests and the full suite**

Run: `npm test -- tests/hpgl/tokenizer.test.js`

Expected: tokenizer tests PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/hpgl/tokenizer.js tests/hpgl/tokenizer.test.js
git commit -m "feat: tokenize hpgl byte streams"
```

---

### Task 3: Coordinate Transform and Core Motion Parser

**Files:**
- Create: `src/hpgl/coordinates.js`
- Create: `src/hpgl/parser.js`
- Test: `tests/hpgl/coordinates.test.js`
- Test: `tests/hpgl/parser-motion.test.js`

**Interfaces:**
- Produces: `createCoordinateTransform(): CoordinateTransform`
- `CoordinateTransform` methods: `toMm(x,y)`, `deltaToMm(dx,dy)`, `radiusToMm(radius)`, `applyIP(values)`, `applyIR(values)`, `applySC(values)`, `reset()`
- Produces: `parseHpgl(data: Uint8Array, context: { fileName: string, layerName: string }): ParseResult`
- `ParseResult = { geometries: Geometry[], diagnostics: Diagnostic[], summary: { geometryCount: number, errorCount: number, warningCount: number } }`

- [ ] **Step 1: Write coordinate tests**

```js
it('uses 40 plotter units per millimeter', () => {
  const transform = createCoordinateTransform();
  expect(transform.toMm(80, 40)).toEqual([2, 1]);
});

it('maps SC user coordinates through explicit IP points', () => {
  const transform = createCoordinateTransform();
  transform.applyIP([0, 0, 4000, 2000]);
  transform.applySC([0, 100, 0, 100]);
  expect(transform.toMm(50, 50)).toEqual([50, 25]);
  expect(transform.radiusToMm(10)).toBe(7.5);
});

it('applies IR percentages to the explicit IP rectangle', () => {
  const transform = createCoordinateTransform();
  transform.applyIP([0, 0, 4000, 2000]);
  transform.applyIR([25, 25, 75, 75]);
  expect(transform.points()).toEqual({ p1: [1000, 500], p2: [3000, 1500] });
});
```

- [ ] **Step 2: Write core motion tests**

```js
it('creates LINE and LWPOLYLINE candidates with current ACI and layer', () => {
  const input = new TextEncoder().encode('SP2;PA0,0;PD40,0;PU;PD80,0,80,40;PU;');
  const result = parseHpgl(input, { fileName: 'a.hpgl', layerName: 'a' });
  expect(result.geometries).toEqual([
    expect.objectContaining({ type: 'line', layer: 'a', color: 2, points: [[0, 0], [1, 0]] }),
    expect.objectContaining({ type: 'polyline', layer: 'a', color: 2, points: [[1, 0], [2, 0], [2, 1]] }),
  ]);
});

it('persists PA and PR modes for PU and PD coordinates', () => {
  const input = new TextEncoder().encode('PA40,40;PR;PD40,0,0,40;PU;');
  const result = parseHpgl(input, { fileName: 'a', layerName: 'a' });
  expect(result.geometries[0].points).toEqual([[1, 1], [2, 1], [2, 2]]);
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `npm test -- tests/hpgl/coordinates.test.js tests/hpgl/parser-motion.test.js`

Expected: FAIL because the coordinate transform and parser do not exist.

- [ ] **Step 4: Implement transform and motion state transactionally**

Use this state shape in `parser.js`:

```js
const state = {
  rawPosition: [0, 0],
  positionMm: [0, 0],
  absolute: true,
  penDown: false,
  color: 1,
  polyline: [],
  transform: createCoordinateTransform(),
};
```

Parse numeric parameters strictly: commas and ASCII whitespace are separators; any other byte, non-finite number, or odd coordinate count invalidates the whole command. Validate into temporary points before mutating `state`. `PA/PR` update the plotting mode even without coordinates. `PU/PD` update pen state, then interpret coordinates in the current mode. Flush polylines on pen-up, pen change, independent shapes, `IN`, and EOF. `DF` is an accepted no-op to match the reference converter.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test`

Expected: all tests PASS.

```powershell
git add src/hpgl/coordinates.js src/hpgl/parser.js tests/hpgl
git commit -m "feat: parse hpgl motion and coordinates"
```

---

### Task 4: Pen, Arc, Circle, Text, and Diagnostics

**Files:**
- Modify: `src/hpgl/parser.js`
- Test: `tests/hpgl/parser-shapes.test.js`
- Test: `tests/hpgl/parser-errors.test.js`

**Interfaces:**
- Extends `Geometry` with `circle`, `arc`, and `text` variants.
- Keeps `parseHpgl` signature and `Diagnostic` shape unchanged.

- [ ] **Step 1: Write failing shape tests**

```js
const context = { fileName: 'a.hpgl', layerName: 'a' };

it('maps SP0 to ACI 1 and emits circle, signed arcs, and text', () => {
  const source = 'SP0;PA0,0;CI40;PD;AA40,0,-180;PU;LBNOTE\x03';
  const result = parseHpgl(new TextEncoder().encode(source), { fileName: 'a', layerName: 'a' });
  expect(result.geometries).toEqual([
    expect.objectContaining({ type: 'circle', center: [0, 0], radius: 1, color: 1 }),
    expect.objectContaining({ type: 'arc', center: [1, 0], startAngle: 180, endAngle: 0 }),
    expect.objectContaining({ type: 'text', text: 'NOTE', height: 5, rotation: 0 }),
  ]);
});

it('turns a full AA sweep into a circle and updates the current point', () => {
  const result = parseHpgl(new TextEncoder().encode('PA40,0;PD;AA0,0,360;PD80,0;'), context);
  expect(result.geometries[0]).toMatchObject({ type: 'circle', center: [0, 0], radius: 1 });
  expect(result.geometries[1].points[0]).toEqual([1, 0]);
});
```

- [ ] **Step 2: Write failing recovery and diagnostic tests**

```js
it('keeps valid state after a malformed state-changing command', () => {
  const source = 'PA40,40;SC0,100,broken,100;PD80,40;PU;ZZ1;CT0;';
  const result = parseHpgl(new TextEncoder().encode(source), context);
  expect(result.geometries[0].points).toEqual([[1, 1], [2, 1]]);
  expect(result.diagnostics.map(d => [d.severity, d.command])).toEqual([
    ['error', 'SC'], ['warning', 'ZZ'],
  ]);
});

it('caps details at 100 while preserving totals', () => {
  const source = new TextEncoder().encode('ZZ;'.repeat(150));
  const result = parseHpgl(source, context);
  expect(result.diagnostics).toHaveLength(100);
  expect(result.summary.warningCount).toBe(150);
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm test -- tests/hpgl/parser-shapes.test.js tests/hpgl/parser-errors.test.js`

Expected: FAIL on missing shape handlers and diagnostic counting.

- [ ] **Step 4: Implement independent shapes and atomic recovery**

Implement the following exact behavior:

```text
SP 1..255     flush, then select matching ACI
SP 0          flush, then select ACI 1
invalid SP    flush, count error, select ACI 7
CI r          flush; positive r emits CIRCLE at current point; current point unchanged
AA cx,cy,s    flush; center absolute; if pen down emit ARC/CIRCLE; always update endpoint
AR dx,dy,s    same as AA with center relative to current raw point
LB text       flush; emit TEXT at current mm point, height 5, rotation 0
IN            flush and restore initial parser and transform state
CT/LT/VS/PG/RO/PS  accept without warning
unknown       warning and skip
```

Angles use `atan2` in degrees and preserve signed sweep by storing an unnormalized `endAngle = startAngle + sweep`. A non-zero sweep divisible by 360 emits a circle. Decode labels as UTF-8 with replacement, matching the Python reference's tolerant text reading.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test`

Expected: all tests PASS.

```powershell
git add src/hpgl/parser.js tests/hpgl/parser-shapes.test.js tests/hpgl/parser-errors.test.js
git commit -m "feat: parse hpgl shapes and diagnostics"
```

---

### Task 5: HP-GL/2 PE Decoder

**Files:**
- Create: `src/hpgl/pe-decoder.js`
- Modify: `src/hpgl/parser.js`
- Test: `tests/hpgl/pe-decoder.test.js`
- Test: `tests/hpgl/parser-pe.test.js`

**Interfaces:**
- Produces: `decodePe(data: Uint8Array): { events: PeEvent[], error?: string }`
- `PeEvent = { type: 'move', x: number, y: number, absolute: boolean, penDown: boolean } | { type: 'pen', value: number }`
- `parseHpgl` consumes PE events through the same move and pen helpers used by PA/PR/PU/PD/SP.

- [ ] **Step 1: Write a test-only encoder and failing decoder tests**

```js
function encodeValue(value, base = 64) {
  let n = value >= 0 ? value * 2 : Math.abs(value) * 2 + 1;
  const bytes = [];
  while (n >= base) { bytes.push(63 + (n % base)); n = Math.floor(n / base); }
  bytes.push((base === 64 ? 191 : 95) + n);
  return bytes;
}

it('decodes relative coordinates, one-shot absolute, pen-up, and pen selection', () => {
  const data = Uint8Array.from([
    ...encodeValue(40), ...encodeValue(0),
    '<'.charCodeAt(0), ...encodeValue(0), ...encodeValue(40),
    '='.charCodeAt(0), ...encodeValue(80), ...encodeValue(80),
    ':'.charCodeAt(0), ...encodeValue(3),
  ]);
  expect(decodePe(data).events).toEqual([
    { type: 'move', x: 40, y: 0, absolute: false, penDown: true },
    { type: 'move', x: 0, y: 40, absolute: false, penDown: false },
    { type: 'move', x: 80, y: 80, absolute: true, penDown: true },
    { type: 'pen', value: 3 },
  ]);
});
```

- [ ] **Step 2: Add base32, fractional-bit, truncated-value, and parser integration tests**

Use flags exactly as the HP manual defines: `:` select pen, `<` next coordinate pen-up, `>` next value is fractional-bit count, `=` next coordinate absolute, `7` switches the rest of the command to base32. Assert that truncated encoded values reject the entire PE command without changing parser state.

- [ ] **Step 3: Run PE tests and verify RED**

Run: `npm test -- tests/hpgl/pe-decoder.test.js tests/hpgl/parser-pe.test.js`

Expected: FAIL because `decodePe` and the PE handler do not exist.

- [ ] **Step 4: Implement the decoder and connect it transactionally**

Decode low-order digits first. Base64 non-terminators are bytes 63-126 and terminators 191-254; base32 non-terminators are 63-94 and terminators 95-126. Recover signed values with `value = n % 2 === 0 ? n / 2 : -(n - 1) / 2`, then divide coordinate values by `2 ** fractionalBits`. The absolute flag applies to one coordinate pair; base32 mode persists to PE end; pen-up applies to one coordinate pair; other coordinate pairs are pen-down relative moves.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test`

Expected: all tests PASS.

```powershell
git add src/hpgl/pe-decoder.js src/hpgl/parser.js tests/hpgl
git commit -m "feat: decode hpgl2 compressed polylines"
```

---

### Task 6: AutoCAD 2000 ASCII DXF Writer

**Files:**
- Create: `src/dxf/escape.js`
- Create: `src/dxf/writer.js`
- Test: `tests/dxf/escape.test.js`
- Test: `tests/dxf/writer.test.js`

**Interfaces:**
- Produces: `escapeDxfText(value: string): string`
- Produces: `writeDxf({ layers: string[], geometries: Geometry[] }): string[]`
- Output is an array of complete DXF text chunks; caller joins and UTF-8 encodes it.

- [ ] **Step 1: Write failing escaping and structure tests**

```js
it('escapes UTF-16 code units and dangerous line breaks', () => {
  expect(escapeDxfText('部品\nA')).toBe('\\U+90E8\\U+54C1 A');
});

it('writes R2000 units, layers, entity colors, and EOF', () => {
  const text = writeDxf({
    layers: ['部品'],
    geometries: [
      { type: 'line', layer: '部品', color: 2, points: [[0, 0], [1, 1]] },
      { type: 'text', layer: '部品', color: 3, point: [2, 3], text: 'A', height: 5, rotation: 0 },
    ],
  }).join('');
  expect(text).toContain('9\n$ACADVER\n1\nAC1015\n');
  expect(text).toContain('9\n$INSUNITS\n70\n4\n');
  expect(text).toContain('0\nLINE\n8\n\\U+90E8\\U+54C1\n62\n2\n');
  expect(text.endsWith('0\nEOF\n')).toBe(true);
});
```

- [ ] **Step 2: Add exact entity tests**

Test `LINE`, `LWPOLYLINE`, `CIRCLE`, positive `ARC`, negative `ARC`, and `TEXT`. For negative HPGL sweeps, assert that DXF start/end are swapped so the DXF's counter-clockwise arc traces the same path. Test an empty file with layer table, empty `ENTITIES`, and `EOF`.

- [ ] **Step 3: Run DXF tests and verify RED**

Run: `npm test -- tests/dxf`

Expected: FAIL because writer modules do not exist.

- [ ] **Step 4: Implement group-code helpers and section writers**

Use a `pair(code, value)` helper returning `${code}\n${value}\n`. Write `HEADER`, `TABLES` with `LTYPE` and `LAYER`, `BLOCKS`, `ENTITIES`, and `OBJECTS`, followed by `EOF`. Register layer `0` plus every unique input layer. Emit ACI on every entity with group code62 and elevation Z=0 where applicable.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test`

Expected: all tests PASS.

```powershell
git add src/dxf tests/dxf
git commit -m "feat: write autocad 2000 ascii dxf"
```

---

### Task 7: Multi-File Converter and Inline Worker

**Files:**
- Create: `src/converter.js`
- Create: `src/worker/converter.worker.js`
- Create: `src/worker/worker-client.js`
- Test: `tests/converter.test.js`
- Test: `tests/worker/worker-client.test.js`

**Interfaces:**
- Produces: `convertInputs(inputs, onProgress): Promise<ConversionResult>`
- `inputs = { name: string, layerName: string, data: Uint8Array }[]`
- `ConversionResult = { buffer: ArrayBuffer, files: FileResult[], totals: Summary }`
- Produces: `createConversionJob(files, layerNames): { promise: Promise<ConversionResult>, cancel(): void }`

- [ ] **Step 1: Write failing multi-file conversion tests**

```js
const ascii = text => new TextEncoder().encode(text);

it('combines files in order with separate layers and exact totals', async () => {
  const inputs = [
    { name: 'a.hpgl', layerName: 'a', data: ascii('SP2;PA0,0;PD40,0;PU;') },
    { name: 'b.H01', layerName: 'b', data: ascii('SP3;PA0,0;CI40;') },
  ];
  const progress = [];
  const result = await convertInputs(inputs, event => progress.push(event));
  const dxf = new TextDecoder().decode(result.buffer);
  expect(result.totals).toMatchObject({ fileCount: 2, geometryCount: 2, errorCount: 0 });
  expect(progress.map(event => event.fileName)).toEqual(['a.hpgl', 'b.H01']);
  expect(dxf.indexOf('8\na\n')).toBeLessThan(dxf.indexOf('8\nb\n'));
});
```

- [ ] **Step 2: Write Worker-client tests with a fake Worker**

Assert request IDs, progress forwarding, transferable result handling, rejection on worker error, URL cleanup, and `cancel()` calling `terminate()` with an `AbortError` rejection.

- [ ] **Step 3: Run converter and Worker tests and verify RED**

Run: `npm test -- tests/converter.test.js tests/worker`

Expected: FAIL because converter and Worker modules do not exist.

- [ ] **Step 4: Implement pure orchestration and Worker messages**

`converter.worker.js` receives `{ type:'convert', requestId, files, layerNames }`, reads one `File.arrayBuffer()` at a time, calls the shared converter, posts `{ type:'progress' }`, then posts `{ type:'complete', result }` with `result.buffer` in the transfer list. Import it in `worker-client.js` with:

```js
import ConverterWorker from './converter.worker.js?worker&inline';
```

No `fetch`, `XMLHttpRequest`, `sendBeacon`, or external URL is permitted in source code.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test`

Expected: all tests PASS.

```powershell
git add src/converter.js src/worker tests/converter.test.js tests/worker
git commit -m "feat: convert files in an inline worker"
```

---

### Task 8: One-Page UI and Download Flow

**Files:**
- Create: `index.html`
- Create: `src/styles.css`
- Create: `src/app.js`
- Test: `tests/ui/app.test.js`
- Modify: `vite.config.js`

**Interfaces:**
- Consumes: file policy, layer names, and `createConversionJob`.
- Produces DOM states: empty, ready, converting, completed, completed-with-errors, cancelled, fatal-error.

- [ ] **Step 1: Switch UI tests to jsdom and write the failing interaction test**

Add `// @vitest-environment jsdom` to `tests/ui/app.test.js`. Build a fake worker client and inject it through `mountApp(root, { createConversionJob })`.

```js
it('adds supported files, converts, exposes diagnostics, and downloads', async () => {
  mountApp(document.body, { createConversionJob: fakeSuccessfulJob });
  const input = document.querySelector('[data-testid="file-input"]');
  Object.defineProperty(input, 'files', { value: [new File(['PA0,0;'], 'a.H01')] });
  input.dispatchEvent(new Event('change'));
  expect(document.body.textContent).toContain('a.H01');
  document.querySelector('[data-testid="convert-button"]').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('変換完了'));
  expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull();
});
```

- [ ] **Step 2: Add DOM tests for rejection, duplicates, removal, progress, errors, and cancellation**

Assert `.txt` rejection, drag-and-drop, name/size/lastModified duplicate detection, removal, case-insensitive layer suffixes, output name normalization, disabled controls while converting, file-level counts, first 100 diagnostics with uncapped totals, error-bearing download copy, cancel state restoration, and object URL revocation.

- [ ] **Step 3: Run UI tests and verify RED**

Run: `npm test -- tests/ui/app.test.js`

Expected: FAIL because UI files and `mountApp` do not exist.

- [ ] **Step 4: Implement accessible HTML, CSS, and UI state**

Use one `<main>` with a drop zone, hidden file input plus visible button, `<table>` for file rows, output-name `<input>`, progress `<progress>`, cancel/convert buttons, `<details>` for diagnostics, and download button. Include `aria-live="polite"` for status and error messages. Keep all visible copy in Japanese and display the privacy statement and supported extensions in the header.

On download, create `new Blob([buffer], { type:'application/dxf' })`, click a temporary anchor with `download=normalizeOutputName(value)`, and revoke the object URL after the click.

- [ ] **Step 5: Verify tests, build, and commit**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run build`

Expected: Vite exits 0 and creates `dist/index.html` with relative asset URLs.

```powershell
git add index.html src/app.js src/styles.css tests/ui vite.config.js
git commit -m "feat: add hpgl dxf converter interface"
```

---

### Task 9: Reference Integration, Browser Verification, and BricsCAD Handoff

**Files:**
- Create: `tests/integration/reference-files.test.js`
- Create: `docs/bricscad-v24-checklist.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `reference/*.H??`, `convertInputs`, generated DXF buffer.
- Produces: repeatable reference-file verification and a manual CAD checklist.

- [ ] **Step 1: Write the failing reference integration test**

```js
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { convertInputs } from '../../src/converter.js';
import { assignLayerNames } from '../../src/files/layer-names.js';

it('converts all eight reference files without CT warnings', async () => {
  const paths = (await readdir('reference'))
    .filter(name => /^P-00235B.*\.H\d\d$/i.test(name))
    .sort();
  expect(paths).toHaveLength(8);
  const layerNames = assignLayerNames(paths);
  const inputs = await Promise.all(paths.map(async (name, index) => ({
    name,
    layerName: layerNames[index],
    data: new Uint8Array(await readFile(join('reference', name))),
  })));
  const result = await convertInputs(inputs, () => {});
  expect(result.files.every(file => file.geometryCount > 0)).toBe(true);
  expect(result.files.flatMap(file => file.diagnostics).some(d => d.command === 'CT')).toBe(false);
  expect(result.totals.fileCount).toBe(8);
  expect(result.totals.geometryCount).toBe(result.files.reduce((n, file) => n + file.geometryCount, 0));
});
```

Add assertions that the decoded DXF contains all eight escaped layer names, has exactly the reported number of entities, uses only finite coordinates, includes ACI values from parsed geometry, and has coordinate span greater than zero on both axes.

- [ ] **Step 2: Run the integration test and resolve only real parser gaps**

Run: `npm test -- tests/integration/reference-files.test.js`

Expected: PASS for all eight inputs. If it fails, add a focused failing unit test for the specific command before changing production code, then rerun the focused test and this integration test.

- [ ] **Step 3: Add ignore rules and the BricsCAD checklist**

```gitignore
node_modules/
dist/
coverage/
*.dxf
```

The checklist must record: converter commit, input files, output filename, BricsCAD V24 open result, eight layer names, entity ACI colors, CTB result, a known 40-unit＝1mm measurement, positive and negative arc direction, Japanese layer/text display, and reviewer/date fields.

- [ ] **Step 4: Run the full automated verification**

Run: `npm test`

Expected: all tests PASS with zero unhandled rejections.

Run: `npm run build`

Expected: build exits 0 and `dist/index.html` exists.

Run: `git diff --check`

Expected: no whitespace errors. CRLF conversion warnings alone are not failures.

- [ ] **Step 5: Verify both browser launch modes**

Open `dist/index.html` directly in current Edge and Chrome, convert the eight reference files, cancel one in-progress run, rerun, and download a DXF. Then run `npm run dev -- --host 127.0.0.1` and repeat file selection and download through the served URL. In DevTools Network, verify there are no requests carrying HPGL or DXF content and no external API requests.

- [ ] **Step 6: Commit and hand off BricsCAD verification**

```powershell
git add .gitignore tests/integration/reference-files.test.js docs/bricscad-v24-checklist.md
git commit -m "test: verify reference hpgl conversion"
```

Generate a representative DXF locally without committing it, give it to the user with `docs/bricscad-v24-checklist.md`, and wait for the BricsCAD V24 result before claiming the project meets the final CAD completion condition.

## Primary Protocol References

- Hewlett-Packard, *The HP-GL/2 and HP RTL Reference Guide*, part number 5961-3526, especially IR (Input Relative P1 and P2) and PE (Polyline Encoded): https://www.emoc.org/materiel/plotter_roland_DXY-1200/HPGL2-RTL_ReferenceGuide_5961-3526_540pages_Sep96.pdf
- Existing behavior reference: `reference/hpgl_to_dxf_converter.py`
- Approved product specification: `docs/superpowers/specs/2026-07-14-hpgl-dxf-static-site-design.md`
