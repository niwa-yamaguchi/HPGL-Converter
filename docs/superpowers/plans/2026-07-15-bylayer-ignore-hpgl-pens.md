# HPGL Pen Ignore and DXF ByLayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HPGLの`SP`および`PE`内のペン変更を完全に無視し、生成する全DXF entityのColorを`ByLayer`にする。

**Architecture:** HPGLパーサーからペン色状態を除去し、共通図形データをレイヤーと図形情報だけにする。実装済みのR2000 handle・owner・subclass object graphは維持し、DXF entityの共通tagからgroup code 62だけを省略する。LAYER tableのACI 7、線種`CONTINUOUS`、ファイル別レイヤーは維持する。

**Tech Stack:** JavaScript ES modules、Vitest 4、Vite 8、AutoCAD 2000 ASCII DXF（AC1015）、BricsCAD V24

## Global Constraints

- `SP`の引数は解析・検証せず、線分割、状態変更、診断を発生させないこと。
- `PE`内の解読可能なペンイベントは値にかかわらず読み飛ばし、線分割や診断を発生させないこと。
- 構造的に解読不能な`PE`は従来どおりエラーとして回復処理を行うこと。
- 共通図形データに`color`を持たせないこと。
- entity固有のgroup code 62を出力せず、Colorを`ByLayer`にすること。
- LAYER tableの既定色ACI 7、線種`CONTINUOUS`、ファイル別レイヤーを維持すること。
- 座標、頂点順、レイヤー、AutoCAD 2000互換構造、UIとWorkerの公開契約を変更しないこと。
- ペン境界の統合によるentity数と`LINE`／`LWPOLYLINE`構成の変化だけを許容すること。
- 新規依存、CDN、外部APIを追加せず、HPGLおよびDXFを外部送信しないこと。
- 既存の未追跡`reference/`を編集またはコミットしないこと。
- 作業開始時に既存差分を再確認し、未追跡`docs/HPGL-DXF静的サイト設計書.md`と変更済み`docs/bricscad-v24-checklist.md`は内容を保持したまま追記・置換すること。この2ファイルはユーザーの既存変更を含むため自動コミットしないこと。

## Execution Baseline

- R2000互換化はPR #1、merge commit `fb9e888`で実装済みであり、`origin/main`の`7e0c40c`に含まれる。
- 現在のローカル`main`は`origin/main`のR2000・faviconマージ前から分岐している。実装開始前にローカル作業branchへ`origin/main`を取り込むか、`origin/main`を基点とする隔離worktreeへByLayerの設計・計画commitを適用する。
- `src/dxf/handles.js`、`tests/dxf/dxf-tags.js`、handle graph検証、Model/Paper Space、dictionary、`$HANDSEED`を削除または簡略化しない。

---

### Task 1: HPGLパーサーからペン状態を除去する

**Files:**
- Modify: `tests/hpgl/parser-errors.test.js:7-32,114-125`
- Modify: `tests/hpgl/parser-motion.test.js:7-31,153-162`
- Modify: `tests/hpgl/parser-pe.test.js:25-132`
- Modify: `tests/hpgl/parser-shapes.test.js:7-47`
- Modify: `src/hpgl/parser.js:91-139,205-253,406-420`

**Interfaces:**
- Consumes: `parseHpgl(data: Uint8Array, context: { fileName: string, layerName: string })`
- Produces: `{ geometries: GeometryWithoutColor[], diagnostics: Diagnostic[], summary: Summary }`
- `GeometryWithoutColor`は既存図形から`color`だけを除き、`type`、`layer`、`fileName`、`offset`および図形固有データを維持する。

- [ ] **Step 1: `SP`完全無視の失敗テストを書く**

`tests/hpgl/parser-errors.test.js`のペン色選択テスト2件を次のテストへ置換する。

```js
it.each(['SP255', 'SP0', 'SP256', 'SP1.5', 'SP', 'SPx'])(
  'ignores %s without splitting geometry or adding diagnostics',
  command => {
    const result = parseHpgl(
      ascii(`PD40,0;${command};PD80,0;PU;`),
      context,
    );

    expect(result.geometries).toEqual([expect.objectContaining({
      type: 'polyline',
      points: [[0, 0], [1, 0], [2, 0]],
    })]);
    expect(result.geometries[0]).not.toHaveProperty('color');
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toEqual({
      geometryCount: 1, errorCount: 0, warningCount: 0,
    });
  },
);
```

- [ ] **Step 2: `PE`内ペン変更無視の失敗テストを書く**

`tests/hpgl/parser-pe.test.js`の「flushes embedded pen changes」と「maps embedded pen zero」のテストを次のテストへ置換する。既存の`encodeValue`と`hpgl` helperを使用する。

```js
it('ignores embedded pen changes without splitting a polyline', () => {
  const pe = [
    ...encodeValue(40), ...encodeValue(0),
    flag(':'), ...encodeValue(3),
    ...encodeValue(40), ...encodeValue(0),
    flag(':'), ...encodeValue(256),
    ...encodeValue(40), ...encodeValue(0),
  ];

  const result = parseHpgl(hpgl('PA0,0;', 'PE', pe, ';PU;'), context);

  expect(result.geometries).toEqual([expect.objectContaining({
    type: 'polyline',
    offset: 6,
    points: [[0, 0], [1, 0], [2, 0], [3, 0]],
  })]);
  expect(result.geometries[0]).not.toHaveProperty('color');
  expect(result.diagnostics).toEqual([]);
  expect(result.summary).toEqual({ geometryCount: 1, errorCount: 0, warningCount: 0 });
});
```

- [ ] **Step 3: 新しいパーサーテストが現行実装で失敗することを確認する**

Run:

```powershell
npm.cmd test -- tests/hpgl/parser-errors.test.js tests/hpgl/parser-pe.test.js
```

Expected: FAIL。`SP`と`PE`のペン変更でgeometryが分割され、`color`が残り、不正値の診断が発生する。

- [ ] **Step 4: パーサーのペン色状態を削除する**

`src/hpgl/parser.js`の`state`から`color`を削除し、共通メタデータと連続線生成を次の形にする。

```js
const state = {
  rawPosition: [0, 0],
  positionMm: [0, 0],
  absolute: true,
  penDown: false,
  polyline: [],
  polylineOffset: null,
  transform: createCoordinateTransform(),
};

function shapeMetadata(token) {
  return {
    layer: context.layerName,
    fileName: context.fileName,
    offset: token.offset,
  };
}

function flushPolyline() {
  if (state.polyline.length >= 2) {
    geometries.push({
      type: state.polyline.length === 2 ? 'line' : 'polyline',
      layer: context.layerName,
      fileName: context.fileName,
      offset: state.polylineOffset,
      points: state.polyline.map(point => [...point]),
    });
  }
  state.polyline = [];
  state.polylineOffset = null;
}
```

`selectPen`と`handlePen`を削除する。token loopの`SP`分岐は引数に触れず読み飛ばす。

```js
if (token.code === 'SP') {
  continue;
}
```

`handlePe`のmove以外のイベントは、flush、値検証、状態変更、診断を行わず読み飛ばす。

```js
for (const event of decoded.events) {
  if (event.type === 'move') {
    const destinations = prepareDestinations([event.x, event.y], event.absolute);
    state.penDown = event.penDown;
    if (!event.penDown) {
      flushPolyline();
    }
    move(destinations, token.offset);
    continue;
  }
  // decode済みのpenイベントは意図的に無視する。
}
```

`IN`分岐から`state.color = 1`も削除する。`decodePe()`自体は圧縮構造の検証に必要なので変更しない。

- [ ] **Step 5: 既存パーサーテストを色なし契約へ更新する**

次の変更を行う。

```js
// tests/hpgl/parser-motion.test.js
// 最初のexact geometry 2件から color: 2 を削除する。
// SP0テスト名を変更し、次のassertionを使用する。
expect(result.geometries[0]).not.toHaveProperty('color');

// tests/hpgl/parser-shapes.test.js
// 最初のテスト名を「ignores SP0 and emits a circle, signed arc, and text」に変更し、
// circle、arc、textの期待値から color: 1 を削除する。

// tests/hpgl/parser-pe.test.js
// 全geometry期待値から colorを削除する。
// 壊れたPEのテスト名から「and color」を削除し、座標と診断だけを検査する。

// tests/hpgl/parser-errors.test.js
// INリセットテストの2つのobjectContainingからcolorを削除し、
// IN前後の座標とgeometry数が維持されることを検査する。
```

- [ ] **Step 6: 全パーサーテストを通す**

Run:

```powershell
npm.cmd test -- tests/hpgl
```

Expected: `tests/hpgl`配下の全テストがPASSし、SP由来診断は0件、壊れたPEの回復テストは従来どおりPASSする。

- [ ] **Step 7: パーサー変更をコミットする**

```powershell
git add -- src/hpgl/parser.js tests/hpgl/parser-errors.test.js tests/hpgl/parser-motion.test.js tests/hpgl/parser-pe.test.js tests/hpgl/parser-shapes.test.js
git commit -m "feat: ignore HPGL pen selections"
```

---

### Task 2: DXF entityをByLayerにする

**Files:**
- Modify: `tests/dxf/writer.test.js`（`origin/main`版のhandle graph、entity、validationテスト）
- Modify: `src/dxf/writer.js`（`origin/main`版の`validateColor`、`validateCommonGeometry`、`commonPairs`）

**Interfaces:**
- Consumes: `writeDxf({ layers: string[], geometries: GeometryWithoutColor[] }): string[]`
- Produces: R2000 handle・owner・subclass構造を維持し、LAYER tableにはgroup code 62のACI 7を保持し、ENTITIES sectionにはgroup code 62を持たないASCII DXF

- [ ] **Step 1: R2000 entityを維持したByLayer失敗テストを書く**

`origin/main`の`tests/dxf/writer.test.js`にある「writes owned R2000 entities with direct ACI colors」を、色なしgeometryと次のsemantic検査へ変更する。既存の`parseDxfTags`、`records`、`recordValues`、`sectionTags`を使用する。

```js
it('writes owned R2000 entities with ByLayer colors in input order', () => {
  const layers = ['line', 'poly', 'circle', 'positive', 'negative', 'text'];
  const geometries = [
    { type: 'line', layer: 'line', points: [[1, 2], [3, 4]] },
    { type: 'polyline', layer: 'poly', points: [[5, 6], [7, 8], [9, 10]] },
    { type: 'circle', layer: 'circle', center: [11, 12], radius: 13 },
    {
      type: 'arc', layer: 'positive', center: [14, 15], radius: 16,
      startAngle: -10, endAngle: 45,
    },
    {
      type: 'arc', layer: 'negative', center: [17, 18], radius: 19,
      startAngle: 45, endAngle: -10,
    },
    {
      type: 'text', layer: 'text', point: [20, 21],
      text: '部\nA', height: 5, rotation: -90,
    },
  ];
  const tags = parseDxfTags(joined({ layers, geometries }));
  const entityRecords = records(sectionTags(tags, 'ENTITIES'));
  const tableRecords = records(sectionTags(tags, 'TABLES'));
  const modelSpaceHandle = tableRecords.find(record => (
    record.type === 'BLOCK_RECORD'
      && recordValues(record, 2)[0] === '*Model_Space'
  )).tags.find(tag => tag.code === 5).value;

  expect(() => validateRawDxfGraph(tags)).not.toThrow();
  expect(entityRecords.map(record => record.type))
    .toEqual(['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'ARC', 'TEXT']);
  for (const record of entityRecords) {
    expect(recordValues(record, 5)).toHaveLength(1);
    expect(recordValues(record, 330)).toEqual([modelSpaceHandle]);
    expect(recordValues(record, 100)).toContain('AcDbEntity');
    expect(recordValues(record, 8)).toHaveLength(1);
    expect(recordValues(record, 62)).toEqual([]);
  }
  expect(entityRecords.map(record => recordValues(record, 8)[0])).toEqual(layers);
});
```

同テスト内にある図形固有の座標、ARC角度、TEXT、subclass markerのassertionは維持する。構造テストのLAYER recordについては`recordValues(layerRecord, 62)`が`['7']`であることを維持する。

- [ ] **Step 2: R2000 writerテストがcolor検証で失敗することを確認する**

Run:

```powershell
npm.cmd test -- tests/dxf/writer.test.js
```

Expected: FAIL。`origin/main`の`validateColor`が色なしgeometryを拒否する。

- [ ] **Step 3: writerからentity色を削除する**

`src/dxf/writer.js`から`validateColor`を削除し、共通geometry検証と共通tagを次の形にする。

```js
function validateCommonGeometry(geometry) {
  if (geometry === null || typeof geometry !== 'object' || Array.isArray(geometry)) {
    throw new TypeError('Geometry must be an object');
  }
  if (typeof geometry.layer !== 'string') {
    throw new TypeError('Geometry layer must be a string');
  }
  return {
    layer: escapeDxfText(geometry.layer),
  };
}

function commonPairs(type, common, handle, owner) {
  return [
    [0, type], [5, handle], [330, owner], [100, 'AcDbEntity'],
    [8, common.layer],
  ];
}
```

R2000のhandle、owner、`AcDbEntity`と図形固有subclass markerを変更しない。LAYER recordの次の色・線種tagも変更しない。

```js
[0, 'LAYER'], [2, layer], [70, 0],
[62, 7], [6, 'CONTINUOUS'],
```

- [ ] **Step 4: writer fixtureとvalidation表を色なし契約へ更新する**

`origin/main`版`tests/dxf/writer.test.js`の全geometry fixtureから`color`を削除する。handle graphテストのgeometryも色なしにする。`validLine`は次の値にし、ACI below/above/fractionalの3 validation caseを削除する。

```js
const validLine = { type: 'line', layer: 'a', points: [[0, 0], [1, 1]] };
```

座標、半径、角度、文字、未知図形、レイヤーのvalidation caseは維持する。

- [ ] **Step 5: writerテストを通す**

Run:

```powershell
npm.cmd test -- tests/dxf/writer.test.js
```

Expected: 全writerテストがPASSする。`validateRawDxfGraph`はhandle・owner参照を正常と判定し、LAYER recordだけにACI 7があり、全entityにgroup code 62がない。

- [ ] **Step 6: writer変更をコミットする**

```powershell
git add -- src/dxf/writer.js tests/dxf/writer.test.js
git commit -m "feat: emit DXF entity colors ByLayer"
```

---

### Task 3: 変換全体の回帰テストと文書をByLayer仕様へ揃える

**Files:**
- Modify: `tests/converter.test.js:15-165`
- Modify: `tests/integration/reference-files.test.js:35-122`
- Modify: `docs/HPGL-DXF静的サイト設計書.md`
- Modify: `docs/bricscad-v24-checklist.md:28-57`
- Modify: `docs/superpowers/specs/2026-07-15-r2000-dxf-compatibility-design.md`

**Interfaces:**
- Consumes: Task 1の`GeometryWithoutColor[]`とTask 2のByLayer DXF writer
- Produces: converter出力、R2000 handle graphを含むreference回帰テスト、現行設計書、R2000設計書、BricsCADチェックリストの一貫したByLayer仕様

- [ ] **Step 1: converterテストをByLayer期待値へ変更する**

`origin/main`版の最初のconverterテストはR2000 semantic record検査を維持し、色の期待値だけをgroup code 62不在へ変更する。

```js
const entityRecords = records(sectionTags(parseDxfTags(dxf), 'ENTITIES'));
expect(entityRecords.map(record => record.type)).toEqual(['LINE', 'LINE']);
expect(entityRecords.map(record => recordValues(record, 8)[0])).toEqual(['first', 'second']);
expect(entityRecords.every(record => recordValues(record, 62).length === 0)).toBe(true);
expect(entityRecords.map(record => ({
  start: [recordValues(record, 10)[0], recordValues(record, 20)[0]],
  end: [recordValues(record, 11)[0], recordValues(record, 21)[0]],
}))).toEqual([
  { start: ['0', '0'], end: ['1', '0'] },
  { start: ['0', '0'], end: ['0', '1'] },
]);
```

エラー回復テストではraw文字列の隣接順に依存せず、次の形でレイヤー保持とByLayerを検査する。

```js
const entityRecords = records(sectionTags(
  parseDxfTags(decode(result.buffer)),
  'ENTITIES',
));
expect(entityRecords.map(record => recordValues(record, 8)[0]))
  .toEqual(['damaged', 'good']);
expect(entityRecords.every(record => recordValues(record, 62).length === 0)).toBe(true);
```

- [ ] **Step 2: reference結合テストをByLayer期待値へ変更する**

テスト名を`converts all eight reference files into a finite, ByLayer, layered DXF`へ変更する。`origin/main`版の`canonicalGeometry`と`canonicalEntity`では、`common`をレイヤーだけにして既存の図形固有`values`とhandle graph検証を維持する。

```js
function canonicalGeometry(geometry) {
  const common = { layer: escapeDxfText(geometry.layer) };
  switch (geometry.type) {
    case 'line':
      return { type: 'LINE', ...common, values: [...geometry.points[0], 0, ...geometry.points[1], 0] };
    case 'polyline':
      return {
        type: 'LWPOLYLINE', ...common,
        values: [geometry.points.length, 0, ...geometry.points.flat()],
      };
    case 'circle':
      return { type: 'CIRCLE', ...common, values: [...geometry.center, 0, geometry.radius] };
    case 'arc': {
      const sweep = geometry.endAngle - geometry.startAngle;
      const start = sweep > 0 ? geometry.startAngle : geometry.endAngle;
      const end = sweep > 0 ? geometry.endAngle : geometry.startAngle;
      return {
        type: 'ARC', ...common,
        values: [
          ...geometry.center, 0, geometry.radius,
          normalizedAngle(start), normalizedAngle(end),
        ],
      };
    }
    case 'text':
      return {
        type: 'TEXT', ...common,
        values: [...geometry.point, 0, geometry.height, escapeDxfText(geometry.text), geometry.rotation],
      };
    default:
      throw new TypeError(`Unknown reference geometry type: ${geometry.type}`);
  }
}

function canonicalEntity(record) {
  const common = { layer: recordValues(record, 8)[0] };
  const numbers = code => recordValues(record, code).map(Number);
  switch (record.type) {
    case 'LINE':
      return {
        type: record.type, ...common,
        values: [
          ...numbers(10), ...numbers(20), ...numbers(30),
          ...numbers(11), ...numbers(21), ...numbers(31),
        ],
      };
    case 'LWPOLYLINE': {
      const xs = numbers(10);
      const ys = numbers(20);
      return {
        type: record.type, ...common,
        values: [
          ...numbers(90), ...numbers(70),
          ...xs.flatMap((x, index) => [x, ys[index]]),
        ],
      };
    }
    case 'CIRCLE':
      return {
        type: record.type, ...common,
        values: [...numbers(10), ...numbers(20), ...numbers(30), ...numbers(40)],
      };
    case 'ARC':
      return {
        type: record.type, ...common,
        values: [
          ...numbers(10), ...numbers(20), ...numbers(30), ...numbers(40),
          ...numbers(50), ...numbers(51),
        ],
      };
    case 'TEXT':
      return {
        type: record.type, ...common,
        values: [
          ...numbers(10), ...numbers(20), ...numbers(30), ...numbers(40),
          recordValues(record, 1)[0], ...numbers(50),
        ],
      };
    default:
      throw new TypeError(`Unknown DXF entity type: ${record.type}`);
  }
}
```

`entityColors`と`expectedGeometries.map(geometry => geometry.color)`の検査を削除し、次を追加する。

```js
const entityColorTags = pairs.filter(pair => pair.code === 62);
expect(entityColorTags).toEqual([]);
expect(expectedGeometries.every(geometry => !Object.hasOwn(geometry, 'color'))).toBe(true);
expect(() => validateRawDxfGraph(tags)).not.toThrow();
expect(result.totals.geometryCount).toBe(expectedGeometries.length);
expect(entityRecords).toHaveLength(expectedGeometries.length);
```

ペン境界の統合でentity数が意図的に変わるため、旧固定値`53842`のassertionは削除する。geometry/entityの同数性と全canonical geometry一致を回帰条件にする。

有限値検査はentityのgroup code 10から59だけを対象にする。

```js
const numericEntityValues = pairs
  .filter(pair => pair.code >= 10 && pair.code <= 59)
  .map(pair => Number(pair.value));
```

- [ ] **Step 3: converterとreferenceテストを通す**

Run:

```powershell
npm.cmd test -- tests/converter.test.js tests/integration/reference-files.test.js
```

Expected: 両テストファイルがPASSする。`reference/`の8ファイルが存在する現在の環境ではreferenceテストはskipされず、8ファイル、0 error、0 warningを確認する。

- [ ] **Step 4: 現行静的サイト設計書を更新する**

`docs/HPGL-DXF静的サイト設計書.md`のペン色仕様を次の内容へ統一する。

```markdown
生成したDXFはBricsCAD V24で利用する。HPGLのペン設定は無視し、各DXF図形の色、線種、線幅はByLayerとする。CAD側ではファイル別レイヤーのプロパティを変更して所属図形を一括制御する。

- 入力ファイルごとにDXFレイヤーを1つ作る。
- HPGLの`SP`および`PE`内のペン変更は、図形、診断、DXF出力へ影響させない。

`SP`は引数を解析しないno-op命令として扱う。`PE`内の解読可能なペン変更イベントも読み飛ばし、ペン変更では連続線を分割しない。構造的に解読不能な`PE`だけは従来どおりエラーとして扱う。

- レイヤー自身の既定色はACI 7、既定線種は`CONTINUOUS`とする。
- 各entityでは色のgroup code 62、線種のgroup code 6、線幅のgroup code 370を省略し、ByLayerを使用する。
```

共通図形データ、テスト方針、BricsCAD確認、完了条件からペン由来ACIを削除し、レイヤー名、描画座標、頂点順、ByLayer継承を確認する記述へ置換する。

- [ ] **Step 5: R2000設計書を現在のByLayer仕様へ更新する**

`docs/superpowers/specs/2026-07-15-r2000-dxf-compatibility-design.md`では次を明記する。

```markdown
- HPGLのペン設定を無視し、各DXF entityのColorをByLayerにする。
- group 8: ファイル別レイヤー
- group 62: 出力しない。entity色はByLayerとする。
```

ACI検証を維持する記述、ACI列のreference検査、`SP0 -> ACI 1`、entity ACIのBricsCAD確認を削除し、LAYER tableのACI 7とentity group code 62不在の検査へ置換する。

完了済み作業の記録である`docs/superpowers/plans/2026-07-15-r2000-dxf-compatibility.md`は変更しない。

- [ ] **Step 6: BricsCAD確認項目を更新する**

`docs/bricscad-v24-checklist.md`のentity ACIとCTB確認2項目を次へ置換し、変更後DXFで未確認のためチェックを外す。最終PASSも未チェックへ戻す。

```markdown
- [ ] 全図形の Color が `ByLayer` として表示される。
  - 確認した entity 種別／レイヤー: ________________________________
- [ ] レイヤーの色、線種、線幅を変更すると、所属図形の表示・印刷設定が追従する。
  - 変更したレイヤー／確認結果: ________________________________
```

- [ ] **Step 7: 自動コミット可能な結合テストとR2000文書をコミットする**

既存ユーザー変更を含む`docs/HPGL-DXF静的サイト設計書.md`と`docs/bricscad-v24-checklist.md`はstageしない。

```powershell
git add -- tests/converter.test.js tests/integration/reference-files.test.js docs/superpowers/specs/2026-07-15-r2000-dxf-compatibility-design.md
git commit -m "test: cover ByLayer conversion output"
```

---

### Task 4: 全体検証とBricsCAD引き渡し

**Files:**
- Verify: `src/hpgl/parser.js`
- Verify: `src/dxf/writer.js`
- Verify: `tests/`
- Verify: `dist/`
- Verify: `docs/HPGL-DXF静的サイト設計書.md`
- Verify: `docs/bricscad-v24-checklist.md`

**Interfaces:**
- Consumes: Tasks 1-3の実装と文書
- Produces: テスト済みsingle-file buildと、BricsCAD V24で手動確認するByLayerチェックリスト

- [ ] **Step 1: R2000実装を含むbaselineであることを確認する**

Run:

```powershell
git merge-base --is-ancestor fb9e888 HEAD
Test-Path -LiteralPath 'src\dxf\handles.js'
Test-Path -LiteralPath 'tests\dxf\dxf-tags.js'
```

Expected: `git merge-base` exit 0、両方の`Test-Path`が`True`。失敗する場合はByLayer実装を進めず、Execution Baselineに従って`origin/main`を取り込む。

- [ ] **Step 2: staleなペン色契約がコードとテストに残っていないことを確認する**

Run:

```powershell
rg -n "state\.color|geometry\.color|common\.color|color:" src/hpgl/parser.js src/dxf/writer.js tests/hpgl tests/dxf tests/converter.test.js tests/integration/reference-files.test.js
```

Expected: exit 1、該当なし。LAYER tableの`[62, 7]`はこの検索対象外の表現であり、意図的に残る。

- [ ] **Step 3: fresh verificationを実行する**

Run:

```powershell
npm.cmd test
npm.cmd run build
git diff --check
```

Expected: 全VitestがPASS、Vite build成功、`git diff --check` exit 0。PowerShell上のCRLF変換warningだけは失敗として扱わない。

- [ ] **Step 4: 作業ツリーのスコープを確認する**

Run:

```powershell
git status --short
git diff -- src/hpgl/parser.js src/dxf/writer.js tests docs/superpowers
```

Expected: コード・テスト・追跡済みR2000文書の変更は各タスクでコミット済み。`reference/`は未追跡のまま無変更。`docs/HPGL-DXF静的サイト設計書.md`と`docs/bricscad-v24-checklist.md`にはByLayer文書変更と既存ユーザー変更が残り、自動コミットされていない。

- [ ] **Step 5: ユーザーへBricsCAD確認を依頼する**

次を報告する。

```text
自動検証: Vitest全件成功、Vite本番ビルド成功。
DXF entityのColorはgroup code 62省略によりByLayerです。
BricsCAD V24で docs/bricscad-v24-checklist.md の未チェック2項目を確認してください。
既存変更を含む docs/HPGL-DXF静的サイト設計書.md と docs/bricscad-v24-checklist.md は未コミットのまま保持しています。
```
