# Gerber／ExcellonからDXFへの変換実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RS-274X GerberとExcellonドリルをブラウザー内で解析し、通常の外形輪郭または全レイヤー共通の線幅なしモードで、一つのDXFへ変換できるようにする。

**Architecture:** 入力ファイルを名前で分類し、補助リストを同じ入力集合の製造ファイルへ関連付ける。Gerberは命令解析とポリゴン描画を分離し、Excellonは工具表と座標状態を解析して、どちらも既存の共通図形へ変換する。プレビューとDXF変換は同じ入力集合パーサーを使い、ワーカーへ`strokeMode`を渡す。

**Tech Stack:** JavaScript ES modules、Vite 8、Vitest 4、`clipper2-ts@2.0.1-18`、Canvas、DXF R2000

**Spec:** `docs/superpowers/specs/2026-09-20-gerber-excellon-dxf-design.md`

## Global Constraints

- Node.js 22.12以上を使用する。
- 入力データを外部APIへ送信せず、ブラウザー内だけで処理する。
- 既存HPGLの`40 HPGL単位 = 1 mm`と既存テスト結果を変更しない。
- 通常モードはGerberのD01、D03、G36／G37を閉じた外形輪郭へ変換する。
- 線幅なしモードは全レイヤーのD01だけを中心線化し、D03とG36／G37は外形輪郭を維持する。
- 円と円弧をポリゴン化するときの最大弦誤差は`0.01 mm`とする。
- 工具径だけが不明な穴は、全幅`1.0 mm`の十字マーカーと警告へ変換する。
- 単位または座標書式を一意に確定できないドリルは、誤寸法で出力せずファイル単位のエラーにする。
- 現在のZIP容量、エントリー数、展開後容量、キャンセル処理を維持する。
- `reference/`は利用者所有の未追跡データとして扱い、コミット対象にしない。
- 無関係な未追跡ファイル`docs/HPGL-DXF静的サイト設計書.md`へ変更を加えない。

---

## ファイル構成

作成するファイルの責務を次のように固定する。

- `src/gerber/tokenizer.js`：拡張命令と通常命令をオフセット付きトークンへ分割する。
- `src/gerber/coordinates.js`：FS、MO、ゼロ抑制、絶対座標をミリメートルへ変換する。
- `src/gerber/apertures.js`：標準アパーチャとアパーチャマクロを輪郭プリミティブへ展開する。
- `src/gerber/parser.js`：Gerber状態機械を実行し、描画オブジェクト列を作る。
- `src/gerber/plotter.js`：描画オブジェクトを外形輪郭または中心線の共通図形へ変換する。
- `src/excellon/parser.js`：Excellonヘッダー、工具、穴、スロットを共通図形へ変換する。
- `src/manufacturing/sidecars.js`：`DRLIST_M`と`X-GBLIST`を解析する。
- `src/manufacturing/input-set.js`：補助情報の関連付け、ドリル書式推定、パーサー振り分けを行う。
- `tests/fixtures/gerber/`：小さなRS-274X回帰入力を保持する。
- `tests/fixtures/excellon/`：小さなExcellon回帰入力を保持する。
- `tests/fixtures/sidecars/`：小さな補助リスト回帰入力を保持する。
- `scripts/generate-board-reference-dxf.mjs`：利用者の三組の実データから受け入れ確認用DXFを生成する。

既存ファイルの役割は変えない。
`src/converter.js`は全入力の変換とDXF生成、二つのワーカーはBlob読込と進捗通知、`src/app.js`は画面状態を担当する。

---

### Task 1: 製造ファイルの分類と入力レコード

**Files:**
- Modify: `src/files/file-policy.js`
- Modify: `src/files/input-records.js`
- Modify: `src/files/upload-expander.js`
- Modify: `src/files/zip-reader.js`
- Test: `tests/files/file-policy.test.js`
- Test: `tests/files/input-records.test.js`
- Test: `tests/files/upload-expander.test.js`
- Test: `tests/files/zip-reader.test.js`

**Interfaces:**
- Produces: `classifyInputName(name): 'hpgl' | 'gerber' | 'excellon' | 'gerber-list' | 'drill-list' | 'zip' | 'unsupported'`
- Produces: `isSupportedInputName(name): boolean`
- Produces: 入力レコード`{ name, path, kind, blob, size, identity }`
- Consumes: 既存の`isZipName`、`fileIdentity`、ZIP制限値

- [ ] **Step 1: 拡張子と補助ファイルの失敗テストを書く**

```js
it.each([
  ['board.gtl', 'gerber'], ['board.G09', 'gerber'], ['board.gbr', 'gerber'],
  ['board.drl', 'excellon'], ['board.dr1', 'excellon'],
  ['P-00620-1_X-GBLIST.txt', 'gerber-list'],
  ['P-00620-1_DRLIST_M.txt', 'drill-list'],
  ['drawing.H01', 'hpgl'], ['bundle.zip', 'zip'], ['board.pdf', 'unsupported'],
])('classifies %s as %s', (name, expected) => {
  expect(classifyInputName(name)).toBe(expected);
});
```

ZIPテストへ、`fab/board.gtl`、`fab/board.drl`、`fab/board_DRLIST_M.txt`が展開され、PDFと`.gbrjob`だけが`ignored.unsupported`へ加算されるケースを追加する。

- [ ] **Step 2: 対象テストを実行して失敗を確認する**

Run: `npm test -- tests/files/file-policy.test.js tests/files/input-records.test.js tests/files/upload-expander.test.js tests/files/zip-reader.test.js`

Expected: `classifyInputName`が未定義で失敗する。

- [ ] **Step 3: 一元化した分類とレコードの種類を実装する**

```js
const HPGL_PATTERN = /\.(?:hpgl|hpg|hgl|pltl?(?:[1-9]|[1-9]\d)?|h(?:0[1-9]|[1-9]\d))$/i;
const GERBER_PATTERN = /\.(?:gbr|ger|pho|art|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gm1|g(?:0?[1-9]|[1-9]\d))$/i;
const EXCELLON_PATTERN = /\.(?:drl|xnc|dr(?:0?[1-9]|[1-9]\d))$/i;
const GERBER_LIST_PATTERN = /(?:^|[_-])X-GBLIST\.txt$/i;
const DRILL_LIST_PATTERN = /(?:^|[_-])DRLIST(?:_M)?\.txt$/i;

export function classifyInputName(name) {
  const leaf = String(name).split(/[\\/]/).pop() ?? '';
  if (/\.zip$/i.test(leaf)) return 'zip';
  if (GERBER_LIST_PATTERN.test(leaf)) return 'gerber-list';
  if (DRILL_LIST_PATTERN.test(leaf)) return 'drill-list';
  if (HPGL_PATTERN.test(leaf)) return 'hpgl';
  if (GERBER_PATTERN.test(leaf)) return 'gerber';
  if (EXCELLON_PATTERN.test(leaf)) return 'excellon';
  return 'unsupported';
}
```

`createNativeInputRecord`と`createArchiveInputRecord`は`kind`と正規化済み`path`を保存する。
`upload-expander.js`と`zip-reader.js`は`isSupportedHpglName`ではなく`isSupportedInputName`を使う。

- [ ] **Step 4: 対象テストを再実行する**

Run: `npm test -- tests/files/file-policy.test.js tests/files/input-records.test.js tests/files/upload-expander.test.js tests/files/zip-reader.test.js`

Expected: PASS。

- [ ] **Step 5: 変更をコミットする**

```bash
git add src/files/file-policy.js src/files/input-records.js src/files/upload-expander.js src/files/zip-reader.js tests/files/file-policy.test.js tests/files/input-records.test.js tests/files/upload-expander.test.js tests/files/zip-reader.test.js
git commit -m "feat: recognize Gerber and drill inputs"
```

---

### Task 2: 閉じたポリラインのDXF、表示、計測

**Files:**
- Modify: `src/dxf/writer.js`
- Modify: `src/viewer/geometry.js`
- Modify: `src/viewer/canvas-renderer.js`
- Modify: `src/viewer/measure.js`
- Test: `tests/dxf/writer.test.js`
- Test: `tests/viewer/geometry.test.js`
- Test: `tests/viewer/canvas-renderer.test.js`
- Test: `tests/viewer/measure.test.js`

**Interfaces:**
- Produces: 共通図形`{ type: 'polyline', points: number[][], closed?: boolean, layer, fileName, offset }`
- Produces: `writeDxf`が図形自身の`layer`もLAYERテーブルへ含める動作
- Consumes: 既存の`line`、`circle`、`arc`、`text`図形

- [ ] **Step 1: 閉鎖辺を要求する失敗テストを書く**

```js
it('writes a closed LWPOLYLINE and declares its derived layer', () => {
  const dxf = joined({
    layers: ['board'],
    geometries: [{
      type: 'polyline', layer: 'board_UNKNOWN_T01', closed: true,
      points: [[0, 0], [2, 0], [2, 1]],
    }],
  });
  expect(dxf).toContain('0\nLWPOLYLINE\n');
  expect(dxf).toContain('70\n1\n');
  expect(dxf).toContain('2\nboard_UNKNOWN_T01\n');
});
```

Canvasテストは最後の点から最初の点への`lineTo`を、計測テストは閉鎖辺への距離を検証する。

- [ ] **Step 2: 対象テストを実行して失敗を確認する**

Run: `npm test -- tests/dxf/writer.test.js tests/viewer/geometry.test.js tests/viewer/canvas-renderer.test.js tests/viewer/measure.test.js`

Expected: DXFフラグが`0`のままで、描画と計測に閉鎖辺がないため失敗する。

- [ ] **Step 3: `closed`を共通図形全体へ通す**

```js
const polylineFlags = geometry.closed === true ? 1 : 0;
// LWPOLYLINE group code 70
[70, polylineFlags]
```

`assertViewerGeometry`は`closed`が存在する場合にbooleanだけを受け付ける。
Canvasは`closed === true`のとき`closePath()`を呼び、計測の`toElements`は`{ a: points.at(-1), b: points[0] }`を末尾へ加える。
DXFのレイヤー一覧は、引数の`layers`と`geometries.map(item => item.layer)`の和集合から作る。

- [ ] **Step 4: 対象テストと既存DXFテストを実行する**

Run: `npm test -- tests/dxf tests/viewer`

Expected: PASS。

- [ ] **Step 5: 変更をコミットする**

```bash
git add src/dxf/writer.js src/viewer/geometry.js src/viewer/canvas-renderer.js src/viewer/measure.js tests/dxf/writer.test.js tests/viewer/geometry.test.js tests/viewer/canvas-renderer.test.js tests/viewer/measure.test.js
git commit -m "feat: support closed contour geometry"
```

---

### Task 3: Gerberのトークン化、座標、状態機械

**Files:**
- Create: `src/gerber/tokenizer.js`
- Create: `src/gerber/coordinates.js`
- Create: `src/gerber/parser.js`
- Create: `tests/gerber/tokenizer.test.js`
- Create: `tests/gerber/coordinates.test.js`
- Create: `tests/gerber/parser.test.js`

**Interfaces:**
- Produces: `tokenizeGerber(data): { tokens, diagnostics }`
- Produces: `createGerberCoordinateFormat(): { applyFs(command), applyMo(command), parsePoint(fields), parseOffset(fields) }`
- Produces: `parseGerberObjects(data, context): { objects, apertures, macros, attributes, diagnostics, summary }`
- Produces: 描画オブジェクト`draw | flash | region`と`polarity: 'dark' | 'clear'`

- [ ] **Step 1: 小さなX2入力を解析する失敗テストを書く**

```js
const bytes = new TextEncoder().encode([
  '%FSLAX46Y46*%', '%MOMM*%', '%ADD10C,0.200000*%', 'D10*',
  'X1000000Y2000000D02*', 'X3000000Y2000000D01*', 'M02*',
].join('\n'));

it('parses an absolute metric draw with source offsets', () => {
  const result = parseGerberObjects(bytes, { fileName: 'board.gbr' });
  expect(result.summary.errorCount).toBe(0);
  expect(result.objects).toEqual([expect.objectContaining({
    kind: 'draw', interpolation: 'linear', start: [1, 2], end: [3, 2],
    apertureCode: 10, polarity: 'dark', offset: expect.any(Number),
  })]);
});
```

別テストで省略座標、負座標、inch、G02／G03のI/J、G36／G37の複数輪郭、LPD／LPC、LM／LR／LS、AS、SF、IN、属性、M00／M02終端を検証する。

- [ ] **Step 2: Gerber単体テストを実行して失敗を確認する**

Run: `npm test -- tests/gerber`

Expected: Gerberモジュールが存在しないため失敗する。

- [ ] **Step 3: トークナイザーと座標変換を実装する**

`tokenizer.js`は`%...%`ブロック内も`*`で命令を分け、各トークンを次の形にする。

```js
{ kind: 'extended' | 'standard', code: 'FS' | 'MO' | 'D01', raw: string, offset: number }
```

`coordinates.js`はFSの整数桁、小数桁、ゼロ抑制、絶対指定と、MOの単位を保持する。
座標値は読み取り時にmmへ変換し、inchは`25.4`を掛ける。

- [ ] **Step 4: Gerber状態機械を実装する**

`parser.js`は現在位置、現在アパーチャ、補間、極性、領域状態、アパーチャのミラー、回転、倍率を保持する。
ASは`AXBY`を受理し、SFはXとYの倍率を座標変換へ適用し、INは診断用メタデータとして保持する。
各描画オブジェクトは作成時点のLM、LR、LSを`transform`として保持し、後続のplotterがアパーチャへ適用する。
命令ごとの状態更新に失敗した場合は直前状態を保持し、診断を追加する。

```js
{
  kind: 'draw', interpolation: 'clockwise', start, end,
  centerOffset: [i, j], apertureCode, polarity, offset,
}
```

G36／G37内ではD01を図形へせず、`region.contours`へ線分または円弧セグメントとして追加する。

- [ ] **Step 5: Gerber単体テストを再実行する**

Run: `npm test -- tests/gerber`

Expected: PASS。

- [ ] **Step 6: 変更をコミットする**

```bash
git add src/gerber/tokenizer.js src/gerber/coordinates.js src/gerber/parser.js tests/gerber/tokenizer.test.js tests/gerber/coordinates.test.js tests/gerber/parser.test.js
git commit -m "feat: parse Gerber drawing commands"
```

---

### Task 4: 標準アパーチャとアパーチャマクロ

**Files:**
- Create: `src/gerber/apertures.js`
- Create: `tests/gerber/apertures.test.js`
- Modify: `src/gerber/parser.js`
- Modify: `tests/gerber/parser.test.js`

**Interfaces:**
- Produces: `parseApertureDefinition(command, macros): ApertureDefinition`
- Produces: `instantiateAperture(definition, options): Array<{ exposure: 'dark' | 'clear', path: Array<{x, y}> }>`
- Consumes: `AM`トークン列と`AD`トークン

- [ ] **Step 1: 標準形状とKiCadマクロの失敗テストを書く**

```js
it.each([
  ['C,1.0', 1], ['R,2.0X1.0', 1], ['O,2.0X1.0', 1], ['P,2.0X6X30', 1],
])('materializes %s as a closed path', (body, pathCount) => {
  const aperture = parseApertureDefinition(`ADD10${body}`, new Map());
  const paths = instantiateAperture(aperture, { chordToleranceMm: 0.01 });
  expect(paths).toHaveLength(pathCount);
  expect(paths[0].path.length).toBeGreaterThanOrEqual(3);
});
```

標準アパーチャの追加テストは`C,1.0X0.4`などの丸穴と矩形穴をクリアpathとして検証する。
マクロテストは変数代入、`x`乗算、括弧、プリミティブ`1`、`4`、`5`、`6`、`7`、`20`、`21`、`22`、暗露光とクリア露光を個別に検証する。

- [ ] **Step 2: アパーチャテストを実行して失敗を確認する**

Run: `npm test -- tests/gerber/apertures.test.js tests/gerber/parser.test.js`

Expected: `apertures.js`が存在しないため失敗する。

- [ ] **Step 3: 式評価と標準アパーチャを実装する**

式評価器は数値、`$1`形式の変数、単項符号、`+ - x /`、括弧だけを受理する再帰下降パーサーとする。
`eval`と`Function`は使用しない。

```js
export function instantiateAperture(definition, options) {
  const tolerance = options.chordToleranceMm ?? 0.01;
  // definition.kindごとに原点中心の閉じたpath列を返す。
}
```

円分割数は半径と最大弦誤差から計算し、最小12分割、最大4096分割に制限する。

- [ ] **Step 4: 標準マクロプリミティブを実装する**

各プリミティブを原点中心の閉じたpathへ変換し、回転はプリミティブ生成後に適用する。
標準アパーチャの穴指定は同じ原点に`clear` pathを生成する。
露光`0`は`clear`、露光`1`は`dark`として保持する。
定義されていない変数、ゼロ除算、非有限値、頂点上限超過は、元のAMまたはADオフセットを持つ診断へ変換できるエラーを投げる。

- [ ] **Step 5: 対象テストを再実行する**

Run: `npm test -- tests/gerber/apertures.test.js tests/gerber/parser.test.js`

Expected: PASS。

- [ ] **Step 6: 変更をコミットする**

```bash
git add src/gerber/apertures.js src/gerber/parser.js tests/gerber/apertures.test.js tests/gerber/parser.test.js
git commit -m "feat: expand Gerber apertures and macros"
```

---

### Task 5: Gerberポリゴン描画と線幅なしモード

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/gerber/plotter.js`
- Create: `src/gerber/index.js`
- Create: `tests/gerber/plotter.test.js`
- Create: `tests/gerber/integration.test.js`
- Create: `tests/fixtures/gerber/outline.gbr`
- Create: `tests/fixtures/gerber/centerline.gbr`
- Create: `tests/fixtures/gerber/macro-region.gbr`

**Interfaces:**
- Produces: `plotGerber(parsed, context, { strokeMode, chordToleranceMm, limits }): ParseResult`
- Produces: `parseGerber(data, context, options): { geometries, diagnostics, summary, attributes }`
- Consumes: Task 3の描画オブジェクトとTask 4のアパーチャpath

- [ ] **Step 1: 外形、中心線、極性の失敗テストを書く**

```js
it('switches only D01 between outline and centerline', () => {
  const outline = parseGerber(fixture, context, { strokeMode: 'outline' });
  const centerline = parseGerber(fixture, context, { strokeMode: 'centerline' });
  expect(outline.geometries.every(item => item.type === 'polyline' && item.closed)).toBe(true);
  expect(centerline.geometries).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'line' }),
    expect.objectContaining({ type: 'arc' }),
    expect.objectContaining({ type: 'polyline', closed: true }),
  ]));
});
```

別テストで、重なる暗図形が一つの外形になること、LPCが穴輪郭を作ること、D03と領域が中心線モードでも閉輪郭になることを検証する。

- [ ] **Step 2: ポリゴンテストを実行して失敗を確認する**

Run: `npm test -- tests/gerber/plotter.test.js tests/gerber/integration.test.js`

Expected: `plotter.js`と`index.js`が存在しないため失敗する。

- [ ] **Step 3: 固定バージョンのポリゴン演算依存を追加する**

Run: `npm install --save-exact clipper2-ts@2.0.1-18`

Expected: `package.json`と`package-lock.json`へ`clipper2-ts`が追加される。

- [ ] **Step 4: パス掃引と極性演算を実装する**

`plotter.js`はmmを`1_000_000`倍した安全な整数へ変換する。
円アパーチャの描画は`inflatePaths`、非円形アパーチャは`minkowskiSum`、暗部の合成は`union`、クリア部の除去は`difference`を使う。
円弧中心線は最大弦誤差`0.01 mm`で点列へ変換してから掃引する。
描画オブジェクトのLM、LR、LSは、アパーチャpathを掃引または配置する前に適用する。

```js
const DEFAULT_LIMITS = Object.freeze({ maxPolygons: 200_000, maxVertices: 2_000_000 });

export function plotGerber(parsed, context, options = {}) {
  const strokeMode = options.strokeMode ?? 'outline';
  if (!['outline', 'centerline'].includes(strokeMode)) {
    throw new RangeError('Gerber strokeMode must be outline or centerline');
  }
  // オブジェクト順に暗部の和とクリア部の差を適用して共通図形へ変換する。
}
```

中心線モードではD01を`line`または`arc`へ直接変換し、D03と領域だけをポリゴン演算へ送る。

- [ ] **Step 5: Gerberテストとビルドを実行する**

Run: `npm test -- tests/gerber`

Expected: PASS。

Run: `npm run build`

Expected: 単一HTMLのビルドが成功し、Node専用APIの混入がない。

- [ ] **Step 6: 変更をコミットする**

```bash
git add package.json package-lock.json src/gerber tests/gerber tests/fixtures/gerber
git commit -m "feat: convert Gerber artwork to DXF contours"
```

---

### Task 6: Excellonの工具、穴、スロット

**Files:**
- Create: `src/excellon/parser.js`
- Create: `tests/excellon/parser.test.js`
- Create: `tests/fixtures/excellon/metric.drl`
- Create: `tests/fixtures/excellon/inch.drl`
- Create: `tests/fixtures/excellon/headerless.dr1`

**Interfaces:**
- Produces: `parseExcellon(data, context, { defaults, unknownToolMarkerMm }): ParseResult`
- Consumes: `defaults`の`{ units, integerDigits, fractionDigits, zeroSuppression, tools: Map<number, number> }`
- Produces: 既知径の`circle`、既知幅スロットの閉じた`polyline`、未知径の`line`二本

- [ ] **Step 1: mm、inch、未知工具、スロットの失敗テストを書く**

```js
it('emits circles for known tools and crosses for unknown diameters', () => {
  const result = parseExcellon(bytes, { fileName: 'board.drl', layerName: 'drill' }, {
    unknownToolMarkerMm: 1,
  });
  expect(result.geometries).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'circle', radius: 0.4, layer: 'drill' }),
    expect.objectContaining({ type: 'line', layer: 'drill_UNKNOWN_T02' }),
  ]));
  expect(result.summary.warningCount).toBe(1);
});
```

小数座標、整数座標、G90／G91、M71／M72、G85、M15／M16、M00／M02／M30を個別に検証する。

- [ ] **Step 2: Excellonテストを実行して失敗を確認する**

Run: `npm test -- tests/excellon`

Expected: Excellonモジュールが存在しないため失敗する。

- [ ] **Step 3: ヘッダーと座標状態を実装する**

```js
export function parseExcellon(data, context, options = {}) {
  const defaults = options.defaults ?? null;
  const marker = options.unknownToolMarkerMm ?? 1;
  // M48から工具表と書式を読み、defaultsは不足項目だけを補う。
}
```

工具定義`TnnCdiameter`は単位変換後の直径をMapへ保存する。
工具径不明の十字は中心から上下左右へ`marker / 2`だけ伸ばした二本の`line`とする。

- [ ] **Step 4: スロットを実装する**

既知幅のスロットは中心経路の両側を半径`diameter / 2`でオフセットし、丸い端部を持つ閉じたpolylineにする。
工具径不明のスロットは中心経路のlineと警告にする。

- [ ] **Step 5: Excellonテストを再実行する**

Run: `npm test -- tests/excellon`

Expected: PASS。

- [ ] **Step 6: 変更をコミットする**

```bash
git add src/excellon/parser.js tests/excellon tests/fixtures/excellon
git commit -m "feat: parse Excellon holes and slots"
```

---

### Task 7: DRLIST、GBLIST、ドリル書式推定

**Files:**
- Create: `src/manufacturing/sidecars.js`
- Create: `src/manufacturing/input-set.js`
- Create: `tests/manufacturing/sidecars.test.js`
- Create: `tests/manufacturing/input-set.test.js`
- Create: `tests/fixtures/sidecars/P-00620-1_DRLIST_M.txt`
- Create: `tests/fixtures/sidecars/P-00620-1_X-GBLIST.txt`

**Interfaces:**
- Produces: `parseDrillList(data): { boardName, fileName, defaults }`
- Produces: `parseGerberList(data): { boardName, layers: Map<string, string> }`
- Produces: `prepareInputSet(inputs, options): { drawableInputs, auxiliaryFiles, diagnostics }`
- Produces: 各drawable inputの`effectiveLayerName`と`parseOptions`
- Consumes: Task 1の`kind`と`path`、Gerberから得たbounds

- [ ] **Step 1: 実データ形式を縮小した補助リストの失敗テストを書く**

```js
it('maps G03 and drill T01 from the two P-00620 lists', () => {
  const gerber = parseGerberList(gerberListBytes);
  const drill = parseDrillList(drillListBytes);
  expect(gerber.layers.get('P-00620-1.G03')).toBe('G03_Symbol_Mark_Top');
  expect(drill.fileName).toBe('P-00620-1.dr1');
  expect(drill.defaults).toMatchObject({
    units: 'mm', integerDigits: 4, fractionDigits: 2,
  });
  expect(drill.defaults.tools.get(1)).toBe(0.4);
});
```

関連付けテストは対象ファイル名一致を最優先し、曖昧な二候補では適用しないことを検証する。

- [ ] **Step 2: 補助リストテストを実行して失敗を確認する**

Run: `npm test -- tests/manufacturing`

Expected: 補助リストモジュールが存在しないため失敗する。

- [ ] **Step 3: 補助リスト解析と関連付けを実装する**

`DRLIST_M`は`File Name`、整数桁、小数桁、単位、`Tnn`と直径を読み取る。
`X-GBLIST`はファイル名、用途、面を読み取り、DXF禁止文字をアンダースコアへ置換した候補名を作る。

```js
const layerLabel = (code, purpose, side) => [code, purpose, side]
  .filter(Boolean).join('_').replace(/[^A-Za-z0-9_-]+/g, '_');
```

- [ ] **Step 4: 一意なドリル書式推定を実装する**

候補は単位`mm | inch`と桁`2.4 | 3.3 | 3.4 | 4.2 | 4.3`の直積とする。
候補座標の全点がGerber boundsを`2 mm`広げた範囲内に入り、ドリル点群の非ゼロ軸スパンが対応するGerber軸スパンの`25%`以上`105%`以下に入る候補だけを残す。
候補が一つなら警告付きで採用し、それ以外は`DRILL_FORMAT_AMBIGUOUS`診断を返す。

- [ ] **Step 5: 補助リストテストを再実行する**

Run: `npm test -- tests/manufacturing`

Expected: PASS。

- [ ] **Step 6: 変更をコミットする**

```bash
git add src/manufacturing tests/manufacturing tests/fixtures/sidecars
git commit -m "feat: apply Gerber and drill sidecar metadata"
```

---

### Task 8: 共通変換、プレビュー、ワーカープロトコル

**Files:**
- Modify: `src/converter.js`
- Modify: `src/worker/worker-client.js`
- Modify: `src/worker/converter.worker.js`
- Modify: `src/viewer/preview-client.js`
- Modify: `src/viewer/preview.worker.js`
- Test: `tests/converter.test.js`
- Test: `tests/worker/worker-client.test.js`
- Test: `tests/viewer/preview-client.test.js`

**Interfaces:**
- Produces: `parseInputs(inputs, { strokeMode, onProgress }): { files, geometries, layers, totals }`
- Preserves: `convertInputs(inputs, onProgress, options = {}): Promise<{ buffer, files, totals }>`
- Produces: worker messageの`options: { strokeMode: 'outline' | 'centerline' }`
- Consumes: Task 7の`prepareInputSet`、三種類のパーサー

- [ ] **Step 1: 混在入力とワーカーオプションの失敗テストを書く**

```js
it('dispatches HPGL, Gerber, Excellon and skips sidecars as layers', async () => {
  const result = await convertInputs(inputs, () => {}, { strokeMode: 'centerline' });
  expect(result.totals.fileCount).toBe(3);
  expect(result.files.map(file => file.name)).toEqual([
    'drawing.H01', 'board.gtl', 'board.drl',
  ]);
});
```

クライアントテストは`postMessage`に`options: { strokeMode: 'centerline' }`が含まれることを検証する。
プレビューワーカーと変換ワーカーが同じ入力に対して同じファイル別図形数と診断数を返すことも検証する。

- [ ] **Step 2: 変換とワーカーテストを実行して失敗を確認する**

Run: `npm test -- tests/converter.test.js tests/worker/worker-client.test.js tests/viewer/preview-client.test.js`

Expected: 製造形式の振り分けと`strokeMode`転送がないため失敗する。

- [ ] **Step 3: 共通の`parseInputs`を実装する**

```js
export function parseInputs(inputs, options = {}) {
  const strokeMode = options.strokeMode ?? 'outline';
  const prepared = prepareInputSet(inputs);
  // kindごとにparseHpgl、parseGerber、parseExcellonへ振り分ける。
  // auxiliaryFilesはfiles、fileCount、layersへ含めない。
}

export async function convertInputs(inputs, onProgress, options = {}) {
  const parsed = parseInputs(inputs, { ...options, onProgress });
  const text = writeDxf({ layers: parsed.layers, geometries: parsed.geometries }).join('');
  // 既存と同じArrayBufferを返す。
}
```

HPGL入力に`kind`がない既存テストは、名前から分類して互換動作させる。

- [ ] **Step 4: 二つのワーカーを共通パーサーへ接続する**

ワーカーは全Blobを読み込んで`kind`と`path`を保持した入力へ変換する。
プレビューワーカーは`parseInputs`のファイル結果を返し、変換ワーカーは`convertInputs`を呼ぶ。
クライアントは`strokeMode`を検証してワーカーメッセージへ含める。

- [ ] **Step 5: 対象テストと既存HPGLテストを実行する**

Run: `npm test -- tests/converter.test.js tests/worker tests/viewer/preview-client.test.js tests/hpgl`

Expected: PASS。

- [ ] **Step 6: 変更をコミットする**

```bash
git add src/converter.js src/worker src/viewer/preview-client.js src/viewer/preview.worker.js tests/converter.test.js tests/worker/worker-client.test.js tests/viewer/preview-client.test.js
git commit -m "feat: route manufacturing inputs through workers"
```

---

### Task 9: 入力一覧、線幅なし設定、画面文言

**Files:**
- Modify: `src/app.js`
- Modify: `src/styles.css`
- Modify: `index.html`
- Modify: `tests/ui/app.test.js`

**Interfaces:**
- Consumes: `kind`付き入力レコード、`createPreviewJob`と`createConversionJob`の`strokeMode`
- Produces: `data-testid="centerline-mode"`のcheckbox
- Produces: 補助ファイル行の「補助」表示と、補助ファイルを除いた変換可否判定

- [ ] **Step 1: UIの失敗テストを書く**

```js
it('passes the global centerline setting to preview and conversion', async () => {
  const checkbox = document.querySelector('[data-testid="centerline-mode"]');
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  expect(createPreviewJob).toHaveBeenLastCalledWith(
    expect.any(Array), expect.any(Array),
    expect.objectContaining({ strokeMode: 'centerline' }),
  );
  document.querySelector('[data-testid="convert-button"]').click();
  expect(createConversionJob).toHaveBeenCalledWith(
    expect.any(Array), expect.any(Array),
    expect.objectContaining({ strokeMode: 'centerline' }),
  );
});
```

別テストで、補助ファイルだけでは変換ボタンが無効、補助行に「補助」、入力acceptに`.gbr`と`.drl`と`.txt`が含まれることを検証する。

- [ ] **Step 2: UIテストを実行して失敗を確認する**

Run: `npm test -- tests/ui/app.test.js`

Expected: checkboxと製造形式の文言が存在しないため失敗する。

- [ ] **Step 3: 画面と状態を実装する**

```html
<label class="setting-check">
  <input data-testid="centerline-mode" type="checkbox">
  <span>描画線を幅なしで出力</span>
</label>
```

`state.strokeMode`の初期値は`outline`とする。
checkbox変更時は進行中でなければ結果を消去し、プレビューを`centerline`で再開する。
変換開始時は同じ`strokeMode`を渡す。

入力説明、aria-label、タイトル、meta descriptionを「HPGL／Gerber／Excellon → DXF」に更新する。
固定スケール表示は「HPGL: 40単位 = 1 mm／基板データ: ファイル指定単位」に変更する。

- [ ] **Step 4: 補助ファイル表示と変換可否を実装する**

補助入力のレイヤー欄は編集可能な名前ではなく「補助」と表示する。
変換ボタンは`hpgl | gerber | excellon`が一件以上ある場合だけ有効にする。
プレビューのファイル表示には補助入力を含めない。

- [ ] **Step 5: UIテストを再実行する**

Run: `npm test -- tests/ui/app.test.js`

Expected: PASS。

- [ ] **Step 6: 変更をコミットする**

```bash
git add src/app.js src/styles.css index.html tests/ui/app.test.js
git commit -m "feat: add manufacturing conversion controls"
```

---

### Task 10: 実データ受け入れ、README、全体検証

**Files:**
- Create: `scripts/generate-board-reference-dxf.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Create: `tests/integration/board-reference-files.test.js`

**Interfaces:**
- Produces: `npm run generate:board-reference-dxf`
- Produces: `tmp/board-reference-dxf/<folder>-outline.dxf`と`<folder>-centerline.dxf`
- Consumes: 利用者所有の`reference`三フォルダー

- [ ] **Step 1: 実データ統合テストを書く**

三フォルダーが存在する場合だけ実行し、ない環境では`it.skipIf`の理由へ不足パスを含める。

```js
expect(result.totals.fileCount).toBe(expectedDrawableFiles);
expect(result.totals.errorCount).toBe(0);
expect(result.totals.geometryCount).toBeGreaterThan(0);
expect(result.files).toHaveLength(expectedDrawableFiles);
expect(Object.values(combinedBounds(geometries)).every(Number.isFinite)).toBe(true);
expect(() => validateRawDxfGraph(parseDxfTags(dxf))).not.toThrow();
```

期待する製造ファイル数はP-00620-1が10件、P-00606-1が13件、Contact-Monitor-Boardが9件とする。
空の製造レイヤーは`geometryCount === 0`を許容するが、ファイル別結果から欠落させない。
通常モードでは閉じたpolylineが存在すること、線幅なしモードではLINEまたはARCが増えること、既知径ドリルではCIRCLEが存在すること、P-00620-1の補助リスト適用後に未知工具警告がないことを検証する。

- [ ] **Step 2: 実データ統合テストを実行して失敗を確認する**

Run: `npm test -- tests/integration/board-reference-files.test.js`

Expected: 新しい三フォルダーを変換する統合経路が未完成の箇所で失敗する。

- [ ] **Step 3: 受け入れ用生成スクリプトを実装する**

スクリプトは三フォルダーを再帰走査し、Task 1の分類で対応入力だけを読み込む。
各フォルダーを`outline`と`centerline`で変換し、リポジトリ内の`tmp/board-reference-dxf`へ六つのDXFとJSON診断概要を生成する。
`tmp/`は成果物ではないため`.gitignore`へ追加する。

- [ ] **Step 4: READMEを現行動作へ更新する**

対応拡張子、補助リスト、二つの描画モード、工具径不明時の十字、ヘッダーなしドリルをスキップする条件を記載する。
「すべての処理がブラウザー内で完結する」という既存の説明は維持する。

- [ ] **Step 5: 実データと全自動テストを実行する**

Run: `npm run generate:board-reference-dxf`

Expected: 六つのDXFと診断JSONが生成され、三フォルダーの各製造入力がファイル別結果へ現れる。

Run: `npm test`

Expected: 全テストPASS。参照データがある現在の環境ではHPGLと基板データの統合テストもPASS。

Run: `npm run build`

Expected: `dist/index.html`を生成し、ビルドが成功する。

- [ ] **Step 6: 実ブラウザーで通常モードを確認する**

Run: `npm run dev -- --host 127.0.0.1`

ブラウザーで各フォルダーまたはZIPを追加し、通常モードのプレビューで基板外形、銅箔、シルク、穴位置が同じ座標系へ重なることを確認する。
変換後の診断一覧とDXFダウンロードを確認する。

- [ ] **Step 7: 実ブラウザーで線幅なしモードを確認する**

「描画線を幅なしで出力」を選び、全レイヤーのD01が中心線表示へ変わり、パッドと領域の外形が残ることを確認する。
設定変更後のプレビューとダウンロードDXFが同じモードになることを確認する。

- [ ] **Step 8: 作業ツリーと生成物を確認してコミットする**

Run: `git status --short`

Expected: `tmp/`、`dist/`、生成DXFは表示されず、利用者所有の`reference/`と既存の未追跡設計書は未変更のまま残る。

```bash
git add .gitignore package.json README.md scripts/generate-board-reference-dxf.mjs tests/integration/board-reference-files.test.js
git commit -m "test: verify board manufacturing references"
```

---

## 最終確認

- [ ] `git diff --check`が警告なしで終了する。
- [ ] `npm test`が全件成功する。
- [ ] `npm run build`が成功する。
- [ ] 三組の実データについて通常モードと線幅なしモードのDXFを生成できる。
- [ ] 実ブラウザーで入力、プレビュー、設定変更、変換、ダウンロードを確認できる。
- [ ] `git status --short`に意図したソース、テスト、文書以外の新規変更がない。
