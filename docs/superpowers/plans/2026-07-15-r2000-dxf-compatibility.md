# R2000 DXF Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BricsCAD V24が警告やクラッシュなしに開ける、所有関係とsubclass markerが正しいAutoCAD 2000 ASCII DXFを生成する。

**Architecture:** `writeDxf({ layers, geometries })`の公開契約と共通図形モデルを維持し、決定的なhandle allocatorと2段階のR2000 object graph生成を追加する。最初に全table、record、block、dictionary、entityのhandleとownerを確定し、その後HEADERからOBJECTSまでを直列化する。

**Tech Stack:** JavaScript ES modules、Vitest 4、Vite 8、AutoCAD 2000 ASCII DXF（AC1015）、ローカル検証用ezdxf

## Global Constraints

- `reference`の8ファイルを1つのDXFへ変換し、BricsCAD V24で警告、修復要求、クラッシュなしに開けること。
- 8つのファイル別レイヤー、図形ごとのACI色、40 HPGL単位 = 1 mmを維持すること。
- `LINE`、`LWPOLYLINE`、`CIRCLE`、`ARC`、`TEXT`の座標と順序を変更しないこと。
- `writeDxf({ layers: string[], geometries: Geometry[] }): string[]`を変更しないこと。
- HPGLおよびDXFを外部APIへ送信しないこと。
- 新規ランタイム依存、CDN、外部APIを追加しないこと。
- 既存の未追跡`reference/`と`docs/HPGL-DXF静的サイト設計書.md`をコミットしないこと。

---

### Task 1: 決定的なDXF handle allocator

**Files:**
- Create: `src/dxf/handles.js`
- Create: `tests/dxf/handles.test.js`

**Interfaces:**
- Consumes: 正の整数`start`
- Produces: `createHandleAllocator(start): { next(): string, peek(): string }`

- [ ] **Step 1: allocatorの失敗テストを書く**

```js
import { describe, expect, it } from 'vitest';
import { createHandleAllocator } from '../../src/dxf/handles.js';

describe('createHandleAllocator', () => {
  it('allocates deterministic uppercase hexadecimal handles', () => {
    const handles = createHandleAllocator(9);
    expect(handles.peek()).toBe('9');
    expect(handles.next()).toBe('9');
    expect(handles.next()).toBe('A');
    expect(handles.peek()).toBe('B');
  });

  it.each([0, -1, 1.5, NaN])('rejects invalid start %s', start => {
    expect(() => createHandleAllocator(start)).toThrow(/positive integer/i);
  });
});
```

- [ ] **Step 2: テストがmodule not foundで失敗することを確認する**

Run: `npm.cmd test -- tests/dxf/handles.test.js`

Expected: FAIL because `src/dxf/handles.js` does not exist.

- [ ] **Step 3: 最小実装を追加する**

```js
export function createHandleAllocator(start = 1) {
  if (!Number.isInteger(start) || start < 1) {
    throw new RangeError('DXF handle start must be a positive integer');
  }
  let current = start;
  return {
    next() {
      const handle = current.toString(16).toUpperCase();
      current += 1;
      return handle;
    },
    peek() {
      return current.toString(16).toUpperCase();
    },
  };
}
```

- [ ] **Step 4: allocatorテストを通す**

Run: `npm.cmd test -- tests/dxf/handles.test.js`

Expected: 2 tests PASS.

- [ ] **Step 5: コミットする**

```powershell
git add -- src/dxf/handles.js tests/dxf/handles.test.js
git commit -m "test: add deterministic DXF handles"
```

---

### Task 2: DXF tag readerとR2000 document skeleton

**Files:**
- Create: `tests/dxf/dxf-tags.js`
- Modify: `tests/dxf/writer.test.js`
- Modify: `src/dxf/writer.js`

**Interfaces:**
- Consumes: `writeDxf()`が生成したASCII DXF文字列
- Produces: `parseDxfTags(text)`, `sectionTags(tags, name)`, `records(tags)`, `recordValues(record, code)`
- Produces: HEADER、CLASSES、TABLES、BLOCKS、空ENTITIES、OBJECTSを持つAC1015 DXF

- [ ] **Step 1: テスト用tag readerを追加する**

```js
export function parseDxfTags(text) {
  if (typeof text !== 'string' || !text.endsWith('\n')) {
    throw new TypeError('DXF text must be a newline-terminated string');
  }
  const lines = text.split('\n');
  lines.pop();
  if (lines.length % 2 !== 0) {
    throw new RangeError('DXF must contain complete group code/value pairs');
  }
  const tags = [];
  for (let index = 0; index < lines.length; index += 2) {
    const code = Number(lines[index].trim());
    if (!Number.isInteger(code)) {
      throw new TypeError(`Invalid DXF group code at line ${index + 1}`);
    }
    tags.push({ code, value: lines[index + 1] });
  }
  return tags;
}

export function sectionTags(tags, name) {
  for (let index = 0; index + 1 < tags.length; index += 1) {
    if (tags[index].code === 0 && tags[index].value === 'SECTION'
      && tags[index + 1].code === 2 && tags[index + 1].value === name) {
      const end = tags.findIndex((tag, candidate) => (
        candidate > index + 1 && tag.code === 0 && tag.value === 'ENDSEC'
      ));
      if (end < 0) {
        throw new RangeError(`DXF section ${name} has no ENDSEC`);
      }
      return tags.slice(index + 2, end);
    }
  }
  throw new RangeError(`DXF section ${name} was not found`);
}

export function records(tags) {
  const result = [];
  let current = null;
  for (const tag of tags) {
    if (tag.code === 0) {
      current = { type: tag.value, tags: [] };
      result.push(current);
    } else if (current) {
      current.tags.push(tag);
    }
  }
  return result;
}

export function recordValues(record, code) {
  return record.tags.filter(tag => tag.code === code).map(tag => tag.value);
}
```

- [ ] **Step 2: 空DXFのR2000構造について失敗テストを書く**

`tests/dxf/writer.test.js`へ次を追加する。

```js
import { parseDxfTags, recordValues, records, sectionTags } from './dxf-tags.js';

it('writes the required R2000 tables, spaces, viewport, and dictionaries', () => {
  const text = joined({ layers: [], geometries: [] });
  const tags = parseDxfTags(text);
  const sectionNames = [];
  for (let index = 0; index + 1 < tags.length; index += 1) {
    if (tags[index].code === 0 && tags[index].value === 'SECTION'
      && tags[index + 1].code === 2) {
      sectionNames.push(tags[index + 1].value);
    }
  }
  expect(sectionNames).toEqual(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']);

  const tableRecords = records(sectionTags(tags, 'TABLES'));
  const tableNames = tableRecords
    .filter(record => record.type === 'TABLE')
    .map(record => recordValues(record, 2)[0]);
  expect(tableNames).toEqual([
    'VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD',
  ]);
  expect(tableRecords.some(record => (
    record.type === 'VPORT' && recordValues(record, 2)[0] === '*ACTIVE'
  ))).toBe(true);
  expect(tableRecords.filter(record => record.type === 'BLOCK_RECORD')
    .map(record => recordValues(record, 2)[0])).toEqual(['*Model_Space', '*Paper_Space']);

  const blockRecords = records(sectionTags(tags, 'BLOCKS'));
  expect(blockRecords.map(record => record.type)).toEqual(['BLOCK', 'ENDBLK', 'BLOCK', 'ENDBLK']);
  expect(records(sectionTags(tags, 'ENTITIES'))).toEqual([]);
  expect(records(sectionTags(tags, 'OBJECTS')).map(record => record.type))
    .toEqual(['DICTIONARY', 'DICTIONARY']);
});
```

- [ ] **Step 3: 現行ライターで失敗を確認する**

Run: `npm.cmd test -- tests/dxf/writer.test.js`

Expected: FAIL because CLASSES and standard R2000 tables/records are missing.

- [ ] **Step 4: 2段階object graphとR2000 skeletonを実装する**

`src/dxf/writer.js`で`createHandleAllocator`をimportし、次のデータ構造を生成してから直列化する。

```js
const TABLE_DEFINITIONS = [
  ['VPORT', 'AcDbViewportTableRecord'],
  ['LTYPE', 'AcDbLinetypeTableRecord'],
  ['LAYER', 'AcDbLayerTableRecord'],
  ['STYLE', 'AcDbTextStyleTableRecord'],
  ['VIEW', 'AcDbViewTableRecord'],
  ['UCS', 'AcDbUCSTableRecord'],
  ['APPID', 'AcDbRegAppTableRecord'],
  ['DIMSTYLE', 'AcDbDimStyleTableRecord'],
  ['BLOCK_RECORD', 'AcDbBlockTableRecord'],
];

function allocateDocumentGraph(layers, geometryCount) {
  const allocator = createHandleAllocator();
  const tables = Object.fromEntries(TABLE_DEFINITIONS.map(([name]) => [name, allocator.next()]));
  const records = {
    activeViewport: allocator.next(),
    byBlock: allocator.next(),
    byLayer: allocator.next(),
    continuous: allocator.next(),
    layer0: allocator.next(),
    layers: layers.slice(1).map(() => allocator.next()),
    standardStyle: allocator.next(),
    acadApp: allocator.next(),
    modelSpace: allocator.next(),
    paperSpace: allocator.next(),
  };
  const blocks = {
    modelBegin: allocator.next(), modelEnd: allocator.next(),
    paperBegin: allocator.next(), paperEnd: allocator.next(),
  };
  const objects = { rootDictionary: allocator.next(), acadGroup: allocator.next() };
  const entities = Array.from({ length: geometryCount }, () => allocator.next());
  return { tables, records, blocks, objects, entities, handseed: allocator.peek() };
}
```

各recordは設計書どおりhandle、owner、`AcDbSymbolTable`、`AcDbSymbolTableRecord`、record固有subclassを持たせる。`VPORT/*ACTIVE`にはview center、view direction、view target、height、aspect ratio、snap/grid flagsを有限値で出力する。`BLOCK_RECORD`と`BLOCK/ENDBLK`を相互に同じModel/Paper Spaceへ接続し、OBJECTSはroot dictionaryから`ACAD_GROUP`子dictionaryへgroup 350で接続する。HEADERの`$HANDSEED`には`graph.handseed`を使用する。

- [ ] **Step 5: skeletonテストと既存writerテストを通す**

Run: `npm.cmd test -- tests/dxf/writer.test.js tests/dxf/handles.test.js`

Expected: all selected tests PASS. Task 2ではentity serializationを変更しないため、既存のentity assertionsもPASSする。

- [ ] **Step 6: コミットする**

```powershell
git add -- src/dxf/writer.js tests/dxf/dxf-tags.js tests/dxf/writer.test.js
git commit -m "fix: emit complete R2000 document structure"
```

---

### Task 3: entity handle、owner、subclass marker

**Files:**
- Modify: `src/dxf/writer.js`
- Modify: `tests/dxf/writer.test.js`

**Interfaces:**
- Consumes: Task 2の`graph.records.modelSpace`と`graph.entities[index]`
- Produces: 全entityにhandle、Model Space owner、`AcDbEntity`、固有subclassを持つDXF

- [ ] **Step 1: entity構造について失敗テストを書く**

既存の図形一式を生成するテストで、exact string比較を次のsemantic検査へ置換する。

```js
const text = joined({ layers: ['line', 'poly', 'circle', 'positive', 'negative', 'text'], geometries });
const entityRecords = records(sectionTags(parseDxfTags(text), 'ENTITIES'));
expect(entityRecords.map(record => record.type))
  .toEqual(['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'ARC', 'TEXT']);

const expectedSubclasses = {
  LINE: ['AcDbEntity', 'AcDbLine'],
  LWPOLYLINE: ['AcDbEntity', 'AcDbPolyline'],
  CIRCLE: ['AcDbEntity', 'AcDbCircle'],
  ARC: ['AcDbEntity', 'AcDbCircle', 'AcDbArc'],
  TEXT: ['AcDbEntity', 'AcDbText', 'AcDbText'],
};
for (const record of entityRecords) {
  expect(recordValues(record, 5)).toHaveLength(1);
  expect(recordValues(record, 330)).toHaveLength(1);
  expect(recordValues(record, 100)).toEqual(expectedSubclasses[record.type]);
  expect(recordValues(record, 8)).toHaveLength(1);
  expect(recordValues(record, 62)).toHaveLength(1);
}
expect(new Set(entityRecords.flatMap(record => recordValues(record, 5))).size)
  .toBe(entityRecords.length);
```

ARCのgroup 50/51、TEXTのgroup 1/40/50、LWPOLYLINEのgroup 90と10/20列について、現在の期待値も`recordValues()`で維持する。

- [ ] **Step 2: 現行entity serializationで失敗を確認する**

Run: `npm.cmd test -- tests/dxf/writer.test.js`

Expected: FAIL because group 5, 330, 100 are absent from entities.

- [ ] **Step 3: 共通tagと固有subclassを実装する**

`commonPairs`を次の契約へ変更し、entity indexに対応するhandleを渡す。

```js
function commonPairs(type, common, handle, owner) {
  return [
    [0, type], [5, handle], [330, owner], [100, 'AcDbEntity'],
    [8, common.layer], [62, common.color],
  ];
}
```

各serializerは共通tag直後に次を追加する。

```js
const ENTITY_SUBCLASSES = {
  LINE: ['AcDbLine'],
  LWPOLYLINE: ['AcDbPolyline'],
  CIRCLE: ['AcDbCircle'],
  ARC: ['AcDbCircle', 'AcDbArc'],
  TEXT: ['AcDbText'],
};
```

ARCはcenter/radiusの前に`AcDbCircle`、angleの前に`AcDbArc`を置く。TEXTは挿入点・文字高・文字列・回転の前に最初の`AcDbText`を置き、末尾に2番目の`100/AcDbText`を置く。既存のvalidation、negative sweep angle交換、Unicode escapeは変更しない。

- [ ] **Step 4: entityとvalidationテストを通す**

Run: `npm.cmd test -- tests/dxf/writer.test.js`

Expected: all writer tests PASS.

- [ ] **Step 5: コミットする**

```powershell
git add -- src/dxf/writer.js tests/dxf/writer.test.js
git commit -m "fix: add R2000 entity ownership"
```

---

### Task 4: object graph整合性とreference回帰

**Files:**
- Modify: `tests/dxf/dxf-tags.js`
- Modify: `tests/dxf/writer.test.js`
- Modify: `tests/integration/reference-files.test.js`
- Create: `scripts/generate-reference-dxf.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: 全sectionのDXF tagsと`reference`の8ファイル
- Produces: `validateHandleGraph(tags): { handles: Set<string>, references: string[] }`
- Produces: `hpgl-dxf-reference-8-files-r2000.dxf`

- [ ] **Step 1: handle graph validatorを追加する**

```js
export function validateHandleGraph(tags) {
  const handles = tags.filter(tag => tag.code === 5 || tag.code === 105).map(tag => tag.value);
  const unique = new Set(handles);
  if (unique.size !== handles.length) {
    throw new RangeError('DXF contains duplicate handles');
  }
  const references = tags
    .filter(tag => [330, 340, 350, 360].includes(tag.code))
    .map(tag => tag.value)
    .filter(value => value !== '0');
  const missing = references.filter(reference => !unique.has(reference));
  if (missing.length > 0) {
    throw new RangeError(`DXF contains missing handle references: ${missing.join(', ')}`);
  }
  return { handles: unique, references };
}
```

- [ ] **Step 2: 空DXFと全図形DXFの参照整合テストを書く**

```js
for (const input of [
  { layers: [], geometries: [] },
  { layers: ['a'], geometries: [{ type: 'line', layer: 'a', color: 1, points: [[0, 0], [1, 1]] }] },
]) {
  const tags = parseDxfTags(joined(input));
  expect(() => validateHandleGraph(tags)).not.toThrow();
}
```

- [ ] **Step 3: reference結合テストへhandle/subclass検査を追加する**

`tests/integration/reference-files.test.js`で全DXFを`parseDxfTags()`し、`validateHandleGraph()`が成功すること、全entityがgroup 5/330/100を持つこと、8レイヤーとACI列が既存期待値と一致することを検査する。

- [ ] **Step 4: 代表DXF生成スクリプトを追加する**

```js
import { readFile, writeFile } from 'node:fs/promises';
import { convertInputs } from '../src/converter.js';
import { assignLayerNames } from '../src/files/layer-names.js';

const names = [
  'P-00235BH01.H01', 'P-00235BH02.H02', 'P-00235BH03.H03', 'P-00235BH04.H04',
  'P-00235BH05.H05', 'P-00235BH06.H06', 'P-00235BH07.H07', 'P-00235B_dr1.H01',
].sort();
const layers = assignLayerNames(names);
const inputs = await Promise.all(names.map(async (name, index) => ({
  name,
  layerName: layers[index],
  data: new Uint8Array(await readFile(new URL(`../reference/${name}`, import.meta.url))),
})));
const result = await convertInputs(inputs, () => {});
await writeFile(new URL('../hpgl-dxf-reference-8-files-r2000.dxf', import.meta.url), new Uint8Array(result.buffer));
console.log(JSON.stringify(result.totals));
```

`package.json`へ次を追加する。

```json
"generate:reference-dxf": "node scripts/generate-reference-dxf.mjs"
```

- [ ] **Step 5: 全テストを通す**

Run: `npm.cmd test`

Expected: all 15 existing test files plus new handle tests PASS; reference filesが存在する環境ではreference testもskipされない。

- [ ] **Step 6: 代表DXFを生成してezdxf監査を通す**

Run:

```powershell
npm.cmd run generate:reference-dxf
python -m ezdxf audit hpgl-dxf-reference-8-files-r2000.dxf
```

Expected: totals show 8 files and 0 errors/0 warnings; ezdxf prints `No errors found.`

- [ ] **Step 7: コミットする**

```powershell
git add -- package.json scripts/generate-reference-dxf.mjs tests/dxf/dxf-tags.js tests/dxf/writer.test.js tests/integration/reference-files.test.js
git commit -m "test: audit reference R2000 DXF"
```

生成DXFは`.gitignore`の`*.dxf`によりコミットしない。

---

### Task 5: 最終検証とBricsCAD引き渡し

**Files:**
- Modify: `docs/bricscad-v24-checklist.md`

**Interfaces:**
- Consumes: Task 4の代表DXFと最終commit hash
- Produces: BricsCAD V24で再確認できるartifact情報とチェックリスト

- [ ] **Step 1: チェックリストの対象情報を更新する**

`docs/bricscad-v24-checklist.md`の出力ファイル名と絶対パスを`hpgl-dxf-reference-8-files-r2000.dxf`へ更新し、Converter commitへ`git rev-parse HEAD`の40桁hashを記録する。手動確認欄は未チェックのまま維持する。

- [ ] **Step 2: fresh verificationを実行する**

Run:

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run generate:reference-dxf
python -m ezdxf audit hpgl-dxf-reference-8-files-r2000.dxf
git diff --check
```

Expected: 全Vitest成功、Vite build成功、8 files/0 errors/0 warnings、`No errors found.`、`git diff --check` exit 0。

- [ ] **Step 3: チェックリスト更新をコミットする**

```powershell
git add -- docs/bricscad-v24-checklist.md
git commit -m "docs: prepare BricsCAD R2000 verification"
```

- [ ] **Step 4: ユーザーへBricsCAD確認を依頼する**

次を報告する。

```text
生成DXF: hpgl-dxf-reference-8-files-r2000.dxf
自動監査: ezdxf audit - No errors found.
BricsCAD V24で docs/bricscad-v24-checklist.md の未チェック項目を確認してください。
```
