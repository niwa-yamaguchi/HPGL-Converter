# HPGL Viewer and Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ファイル追加直後にHPGLを自動解析し、ファイル別色分けCanvas表示と任意の2ファイルの図形差分表示を提供する。

**Architecture:** 既存の`parseHpgl`を専用インラインWorkerから呼び、ファイル単位の共通図形データをUIへ返す。比較・範囲・ビューポート計算は純粋関数、描画はCanvas 2D、状態遷移は既存`mountApp`へ閉じ込め、DXF変換ジョブとは独立させる。

**Tech Stack:** Vanilla JavaScript ES Modules、Canvas 2D、Web Worker、Vite 8、Vitest 4、jsdom

## Global Constraints

- HPGLと解析結果を外部へ送信せず、実行時依存、CDN、外部APIを追加しない。
- 対応ブラウザは最新のMicrosoft EdgeとGoogle Chromeとし、Viteの単一HTMLビルドを維持する。
- 比較精度は`0.001 mm`、レイヤー名・ファイル名・命令位置は図形同一性から除外する。
- 差分は異なる2ファイル間の多重集合比較とし、共通、Aのみ、Bのみの個数を保持する。
- DXF変換、ByLayer、AutoCAD 2000互換構造、診断、ダウンロードの既存契約を変更しない。
- プレビュー失敗またはキャンセル時もDXF変換操作を利用可能にする。
- ユーザーの未追跡`docs/HPGL-DXF静的サイト設計書.md`、`docs/todo.md`、`reference/`は編集またはコミットしない。

## File Structure

- Create: `src/viewer/geometry.js` — 図形比較、範囲、全体表示、ズーム、パンの純粋関数。
- Create: `src/viewer/canvas-renderer.js` — 共通図形データをCanvas 2Dへ描画する関数。
- Create: `src/viewer/preview-client.js` — インラインプレビューWorkerのジョブAPI。
- Create: `src/viewer/preview.worker.js` — ファイル読み込みと`parseHpgl`実行のWorkerプロトコル。
- Modify: `src/app.js` — プレビューパネル、状態、操作、ジョブのライフサイクル。
- Modify: `src/styles.css` — プレビュー、凡例、差分、Canvas、レスポンシブ表示。
- Create: `tests/viewer/geometry.test.js` — 比較、範囲、ビューポートの単体テスト。
- Create: `tests/viewer/canvas-renderer.test.js` — Canvas変換と図形描画の単体テスト。
- Create: `tests/viewer/preview-client.test.js` — WorkerクライアントとWorker処理のテスト。
- Modify: `tests/ui/app.test.js` — 自動解析、通常表示、差分表示、キャンセル、破棄のUIテスト。
- Modify: `tests/integration/reference-files.test.js` — 実ファイル図形が有限な表示範囲を作る回帰テスト。

---

### Task 1: 図形比較・範囲・ビューポート

**Files:**
- Create: `src/viewer/geometry.js`
- Create: `tests/viewer/geometry.test.js`

**Interfaces:**
- Consumes: `parseHpgl`が返す`line | polyline | circle | arc | text`図形。
- Produces: `geometryKey(geometry): string`、`compareGeometrySets(a, b): { onlyA, common, onlyB }`、`geometryBounds(geometry): Bounds`、`combinedBounds(geometries): Bounds | null`、`fitViewport(bounds, width, height, padding): Viewport`、`zoomViewport(viewport, screenPoint, deltaY): Viewport`、`panViewport(viewport, dx, dy): Viewport`。
- `Bounds`は`{ minX, minY, maxX, maxY }`、`Viewport`は`{ centerX, centerY, scale, width, height }`とする。

- [ ] **Step 1: 比較と範囲の失敗テストを書く**

`tests/viewer/geometry.test.js`へ次のケースを作成する。

```js
import { describe, expect, it } from 'vitest';
import {
  combinedBounds, compareGeometrySets, fitViewport, geometryKey,
  panViewport, zoomViewport,
} from '../../src/viewer/geometry.js';

const line = (points, extra = {}) => ({ type: 'line', points, ...extra });

describe('viewer geometry', () => {
  it('matches reversed lines within 0.001 mm and ignores metadata', () => {
    const a = line([[0, 1], [2, 3]], { layer: 'A', fileName: 'a', offset: 1 });
    const b = line([[2.0004, 3], [-0, 1]], { layer: 'B', fileName: 'b', offset: 99 });
    expect(geometryKey(a)).toBe(geometryKey(b));
  });

  it('compares duplicate geometries as a multiset', () => {
    const common = line([[0, 0], [1, 1]]);
    const onlyA = { type: 'circle', center: [3, 4], radius: 2 };
    const onlyB = { type: 'text', point: [5, 6], text: 'B', height: 5, rotation: 0 };
    const result = compareGeometrySets([common, common, onlyA], [common, onlyB]);
    expect(result.common).toEqual([common]);
    expect(result.onlyA).toEqual([common, onlyA]);
    expect(result.onlyB).toEqual([onlyB]);
  });

  it('treats reversed polylines as equal but preserves arc direction', () => {
    const forward = { type: 'polyline', points: [[0, 0], [1, 2], [3, 4]] };
    const reverse = { type: 'polyline', points: [[3, 4], [1, 2], [0, 0]] };
    expect(geometryKey(forward)).toBe(geometryKey(reverse));
    expect(geometryKey({ type: 'arc', center: [0, 0], radius: 2, startAngle: 0, endAngle: 90 }))
      .not.toBe(geometryKey({ type: 'arc', center: [0, 0], radius: 2, startAngle: 90, endAngle: 0 }));
  });

  it('includes circle and swept arc extrema in finite combined bounds', () => {
    const bounds = combinedBounds([
      { type: 'circle', center: [10, 10], radius: 2 },
      { type: 'arc', center: [0, 0], radius: 5, startAngle: 0, endAngle: 180 },
    ]);
    expect(bounds).toEqual({ minX: -5, minY: 0, maxX: 12, maxY: 12 });
  });

  it('fits degenerate bounds and keeps zoom and pan finite', () => {
    const fitted = fitViewport({ minX: 2, minY: 3, maxX: 2, maxY: 3 }, 800, 480, 12);
    const zoomed = zoomViewport(fitted, { x: 400, y: 240 }, -100);
    const panned = panViewport(zoomed, 20, -10);
    expect(Object.values(panned).every(Number.isFinite)).toBe(true);
    expect(zoomed.scale).toBeGreaterThan(fitted.scale);
    expect(panned.centerX).not.toBe(zoomed.centerX);
  });
});
```

- [ ] **Step 2: 対象テストがモジュール未作成で失敗することを確認する**

Run: `npm.cmd test -- tests/viewer/geometry.test.js`

Expected: FAIL。`src/viewer/geometry.js`を解決できないことが原因である。

- [ ] **Step 3: 最小実装を書く**

`src/viewer/geometry.js`へ以下を実装する。

```js
const PRECISION = 1000;
const rounded = value => {
  const result = Math.round(Number(value) * PRECISION) / PRECISION;
  return Object.is(result, -0) ? 0 : result;
};
const pointKey = point => `${rounded(point[0])},${rounded(point[1])}`;
const angle = value => {
  const result = rounded(((Number(value) % 360) + 360) % 360);
  return result === 360 ? 0 : result;
};

export function geometryKey(geometry) {
  switch (geometry.type) {
    case 'line': {
      const points = geometry.points.map(pointKey).sort();
      return `line|${points.join('|')}`;
    }
    case 'polyline': {
      const forward = geometry.points.map(pointKey).join('|');
      const reverse = [...geometry.points].reverse().map(pointKey).join('|');
      return `polyline|${forward < reverse ? forward : reverse}`;
    }
    case 'circle':
      return `circle|${pointKey(geometry.center)}|${rounded(geometry.radius)}`;
    case 'arc':
      return `arc|${pointKey(geometry.center)}|${rounded(geometry.radius)}|${angle(geometry.startAngle)}|${rounded(geometry.endAngle - geometry.startAngle)}`;
    case 'text':
      return `text|${pointKey(geometry.point)}|${JSON.stringify(geometry.text)}|${rounded(geometry.height)}|${angle(geometry.rotation)}`;
    default:
      throw new TypeError(`Unknown viewer geometry type: ${String(geometry.type)}`);
  }
}

export function compareGeometrySets(a, b) {
  const available = new Map();
  b.forEach((geometry, index) => {
    const key = geometryKey(geometry);
    const queue = available.get(key) ?? [];
    queue.push(index);
    available.set(key, queue);
  });
  const common = [];
  const onlyA = [];
  const matchedB = new Set();
  a.forEach(geometry => {
    const queue = available.get(geometryKey(geometry));
    if (queue?.length) {
      matchedB.add(queue.shift());
      common.push(geometry);
    } else {
      onlyA.push(geometry);
    }
  });
  const onlyB = b.filter((_geometry, index) => !matchedB.has(index));
  return { onlyA, common, onlyB };
}

const positiveMod = value => ((value % 360) + 360) % 360;
const pointAt = (center, radius, degrees) => {
  const radians = degrees * Math.PI / 180;
  return [center[0] + radius * Math.cos(radians), center[1] + radius * Math.sin(radians)];
};
const inSweep = (candidate, start, end) => {
  const sweep = end - start;
  return sweep > 0
    ? positiveMod(candidate - start) <= sweep + 1e-9
    : positiveMod(start - candidate) <= -sweep + 1e-9;
};
const boundsOfPoints = points => ({
  minX: Math.min(...points.map(point => point[0])),
  minY: Math.min(...points.map(point => point[1])),
  maxX: Math.max(...points.map(point => point[0])),
  maxY: Math.max(...points.map(point => point[1])),
});

export function geometryBounds(geometry) {
  if (geometry.type === 'line' || geometry.type === 'polyline') {
    return boundsOfPoints(geometry.points);
  }
  if (geometry.type === 'circle') {
    return {
      minX: geometry.center[0] - geometry.radius,
      minY: geometry.center[1] - geometry.radius,
      maxX: geometry.center[0] + geometry.radius,
      maxY: geometry.center[1] + geometry.radius,
    };
  }
  if (geometry.type === 'arc') {
    const angles = [geometry.startAngle, geometry.endAngle,
      ...[0, 90, 180, 270].filter(value => inSweep(value, geometry.startAngle, geometry.endAngle))];
    return boundsOfPoints(angles.map(value => pointAt(geometry.center, geometry.radius, value)));
  }
  if (geometry.type === 'text') {
    const margin = Math.abs(geometry.height);
    return {
      minX: geometry.point[0] - margin,
      minY: geometry.point[1] - margin,
      maxX: geometry.point[0] + margin,
      maxY: geometry.point[1] + margin,
    };
  }
  throw new TypeError(`Unknown viewer geometry type: ${String(geometry.type)}`);
}

export function combinedBounds(geometries) {
  if (geometries.length === 0) return null;
  return geometries.map(geometryBounds).reduce((result, bounds) => ({
    minX: Math.min(result.minX, bounds.minX), minY: Math.min(result.minY, bounds.minY),
    maxX: Math.max(result.maxX, bounds.maxX), maxY: Math.max(result.maxY, bounds.maxY),
  }));
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function fitViewport(bounds, width, height, padding = 12) {
  if (!bounds) return { centerX: 0, centerY: 0, scale: 1, width, height };
  const scale = clamp(Math.min(
    Math.max(1, width - 2 * padding) / Math.max(1e-9, bounds.maxX - bounds.minX),
    Math.max(1, height - 2 * padding) / Math.max(1e-9, bounds.maxY - bounds.minY),
  ), 1e-6, 1e6);
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    scale, width, height,
  };
}

export function zoomViewport(viewport, screenPoint, deltaY) {
  const scale = clamp(viewport.scale * clamp(Math.exp(-deltaY * 0.0015), 0.1, 10), 1e-6, 1e6);
  const worldX = viewport.centerX + (screenPoint.x - viewport.width / 2) / viewport.scale;
  const worldY = viewport.centerY - (screenPoint.y - viewport.height / 2) / viewport.scale;
  return { ...viewport, scale,
    centerX: worldX - (screenPoint.x - viewport.width / 2) / scale,
    centerY: worldY + (screenPoint.y - viewport.height / 2) / scale };
}

export function panViewport(viewport, dx, dy) {
  return { ...viewport,
    centerX: viewport.centerX - dx / viewport.scale,
    centerY: viewport.centerY + dy / viewport.scale };
}
```

すべての公開関数で配列、図形種別、座標、サイズが有限値であることを検査し、不正値は`TypeError`または`RangeError`にする。上記の比較順序と戻り配列順序は変更しない。

- [ ] **Step 4: 対象テストを通す**

Run: `npm.cmd test -- tests/viewer/geometry.test.js`

Expected: PASS。5テスト、失敗0件。

- [ ] **Step 5: コミットする**

```powershell
git add -- src/viewer/geometry.js tests/viewer/geometry.test.js
git commit -m "feat: add viewer geometry comparison"
```

---

### Task 2: Canvas描画

**Files:**
- Create: `src/viewer/canvas-renderer.js`
- Create: `tests/viewer/canvas-renderer.test.js`

**Interfaces:**
- Consumes: `Viewport`と`groups: Array<{ color: string, opacity?: number, geometries: Geometry[] }>`。
- Produces: `renderViewer(canvas, groups, viewport, { devicePixelRatio? }): void`。

- [ ] **Step 1: Canvas座標変換と描画命令の失敗テストを書く**

偽Canvas contextに`setTransform`、`clearRect`、`beginPath`、`moveTo`、`lineTo`、`arc`、`stroke`、`save`、`restore`、`translate`、`rotate`、`fillText`を`vi.fn()`で実装する。`tests/viewer/canvas-renderer.test.js`で次を検証する。

```js
it('sizes for DPR and flips world Y while drawing every supported shape', () => {
  const { canvas, context } = fakeCanvas(400, 240);
  renderViewer(canvas, [{ color: '#146fae', geometries: [
    { type: 'line', points: [[0, 0], [10, 10]] },
    { type: 'polyline', points: [[0, 0], [2, 3], [4, 5]] },
    { type: 'circle', center: [5, 5], radius: 2 },
    { type: 'arc', center: [8, 8], radius: 3, startAngle: 0, endAngle: 90 },
    { type: 'text', point: [1, 2], text: 'A', height: 5, rotation: 30 },
  ] }], { centerX: 5, centerY: 5, scale: 10, width: 400, height: 240 }, { devicePixelRatio: 2 });

  expect(canvas.width).toBe(800);
  expect(canvas.height).toBe(480);
  expect(context.lineTo).toHaveBeenCalledWith(250, 70);
  expect(context.arc).toHaveBeenCalled();
  expect(context.fillText).toHaveBeenCalledWith('A', 0, 0);
});
```

円弧はHPGLの符号付き角度を維持し、CanvasのY反転を考慮した開始・終了角と`counterclockwise`を検証する。空グループでは`clearRect`だけが呼ばれることも検証する。

- [ ] **Step 2: 対象テストがモジュール未作成で失敗することを確認する**

Run: `npm.cmd test -- tests/viewer/canvas-renderer.test.js`

Expected: FAIL。`src/viewer/canvas-renderer.js`を解決できないことが原因である。

- [ ] **Step 3: Canvasレンダラーを実装する**

`renderViewer`はCSS座標で描画し、先頭で次を実行する。

```js
const ratio = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
const rect = canvas.getBoundingClientRect();
canvas.width = Math.max(1, Math.round(rect.width * ratio));
canvas.height = Math.max(1, Math.round(rect.height * ratio));
const context = canvas.getContext('2d');
context.setTransform(ratio, 0, 0, ratio, 0, 0);
context.clearRect(0, 0, rect.width, rect.height);
const screenPoint = ([x, y]) => [
  rect.width / 2 + (x - viewport.centerX) * viewport.scale,
  rect.height / 2 - (y - viewport.centerY) * viewport.scale,
];
```

グループごとに`strokeStyle`、`fillStyle`、`globalAlpha`を設定し、線幅は`1.25` CSS pxとする。文字は`save()`後に挿入点へ移動し、`rotate(-rotation * Math.PI / 180)`、`font = `${Math.max(8, height * scale)}px sans-serif``、`scale(1, -1)`を使わず画面座標で正立描画する。

- [ ] **Step 4: 対象テストを通す**

Run: `npm.cmd test -- tests/viewer/canvas-renderer.test.js`

Expected: PASS。Canvasサイズ、全図形、空表示、円弧方向が成功する。

- [ ] **Step 5: コミットする**

```powershell
git add -- src/viewer/canvas-renderer.js tests/viewer/canvas-renderer.test.js
git commit -m "feat: render HPGL geometry on canvas"
```

---

### Task 3: 自動プレビューWorker

**Files:**
- Create: `src/viewer/preview-client.js`
- Create: `src/viewer/preview.worker.js`
- Create: `tests/viewer/preview-client.test.js`

**Interfaces:**
- Consumes: `createPreviewJob(files, layerNames, { onProgress?, workerFactory? })`。
- Produces: `{ promise: Promise<{ files: PreviewFile[] }>, cancel(): void }`。
- Worker request: `{ type: 'preview', requestId, files, layerNames }`。
- Worker progress: `{ type: 'progress', requestId, event: { phase, fileName, index, total } }`。
- Worker completion: `{ type: 'complete', requestId, result: { files } }`。

- [ ] **Step 1: クライアントとWorkerプロトコルの失敗テストを書く**

`tests/viewer/preview-client.test.js`へ既存`tests/worker/worker-client.test.js`の`FakeWorker`を局所的に複製し、次を検証する。

```js
it('posts a preview request, forwards progress, completes, and terminates', async () => {
  const worker = new FakeWorker();
  const onProgress = vi.fn();
  const job = createPreviewJob([file('a.hpgl')], ['a'], {
    onProgress, workerFactory: () => worker,
  });
  const request = worker.messages[0];
  expect(request).toMatchObject({ type: 'preview', files: [expect.any(Object)], layerNames: ['a'] });
  worker.emit({ type: 'progress', requestId: request.requestId, event: { index: 1, total: 1 } });
  worker.emit({ type: 'complete', requestId: request.requestId, result: { files: [] } });
  await expect(job.promise).resolves.toEqual({ files: [] });
  expect(onProgress).toHaveBeenCalledWith({ index: 1, total: 1 });
  expect(worker.terminateCount).toBe(1);
});
```

さらに、`cancel()`が`AbortError`で1回だけrejectすること、native errorとmessage error、引数不正を検証する。`handlePreviewMessage`へ読み込み失敗ファイルと正常HPGLを渡し、失敗側が`geometryCount: 0, errorCount: 1`、正常側が図形を保持し、後続処理が続くことを検証する。

- [ ] **Step 2: 対象テストがモジュール未作成で失敗することを確認する**

Run: `npm.cmd test -- tests/viewer/preview-client.test.js`

Expected: FAIL。preview clientまたはworkerを解決できないことが原因である。

- [ ] **Step 3: Workerとクライアントを実装する**

`preview-client.js`は次のインラインimportを使用する。

```js
import PreviewWorker from './preview.worker.js?worker&inline';
```

既存`createConversionJob`と同じsettle-once構造で、request typeとエラーメッセージだけをプレビュー用にする。`preview.worker.js`は各ファイルを順番に読み、成功時に次を返す。

```js
const parsed = parseHpgl(new Uint8Array(await file.arrayBuffer()), {
  fileName: file.name,
  layerName,
});
return {
  name: file.name,
  layerName,
  geometries: parsed.geometries,
  geometryCount: parsed.summary.geometryCount,
  errorCount: parsed.summary.errorCount,
  warningCount: parsed.summary.warningCount,
  diagnostics: parsed.diagnostics,
};
```

読み込みまたは予期しない解析失敗は`command: 'FILE'`、`offset: 0`、`severity: 'error'`の診断1件と空図形へ変換する。各ファイルの読み込み前を`phase: 'reading'`、解析後を`phase: 'parsed'`として通知する。

- [ ] **Step 4: 対象テストを通す**

Run: `npm.cmd test -- tests/viewer/preview-client.test.js`

Expected: PASS。クライアント、Worker、キャンセル、失敗分離、オフラインソース検査が成功する。

- [ ] **Step 5: コミットする**

```powershell
git add -- src/viewer/preview-client.js src/viewer/preview.worker.js tests/viewer/preview-client.test.js
git commit -m "feat: parse viewer files in a worker"
```

---

### Task 4: ビューワーUIと状態遷移

**Files:**
- Modify: `src/app.js:1-529`
- Modify: `src/styles.css:22-553`
- Modify: `tests/ui/app.test.js:1-319`

**Interfaces:**
- Consumes: Task 1の比較・ビューポート関数、Task 2の`renderViewer`、Task 3の`createPreviewJob`。
- Produces: `mountApp(root, { createConversionJob?, createPreviewJob?, renderViewer? })`。
- DOM test IDs: `viewer-status`、`viewer-canvas`、`viewer-fit`、`viewer-mode-normal`、`viewer-mode-diff`、`viewer-layer-toggle`、`viewer-compare-a`、`viewer-compare-b`、`viewer-diff-counts`。

- [ ] **Step 1: 自動解析と通常表示の失敗テストを書く**

`tests/ui/app.test.js`の`mountApp`呼び出しで既定のプレビューWorkerが起動しないよう、`beforeEach`用の`createPreviewJob: vi.fn()`ではなく、各テスト用の即時完了ジョブを渡すヘルパーを追加する。

```js
const emptyPreviewJob = vi.fn(() => ({
  promise: Promise.resolve({ files: [] }),
  cancel: vi.fn(),
}));

function previewResult(files) {
  return { files: files.map((file, index) => ({
    name: file.name,
    layerName: file.name.replace(/\.[^.]+$/, ''),
    geometries: [line([[index, 0], [index + 1, 1]])],
    geometryCount: 1,
    errorCount: 0,
    warningCount: 0,
    diagnostics: [],
  })) };
}
```

新規テストで、ファイル追加直後に`createPreviewJob(files, layers, { onProgress })`が呼ばれ、完了後にファイル名、色見本、図形数、Canvas描画グループが表示されることを検証する。チェックボックスをOFFにすると対応グループが次の描画から消えることも検証する。

- [ ] **Step 2: 差分とライフサイクルの失敗テストを書く**

2ファイル完了後に差分モードを選び、A/B selectが異なる値を持ち、`viewer-diff-counts`が`Aのみ 1 / 共通 1 / Bのみ 1`を表示するケースを追加する。ファイルを追加し直したとき前ジョブの`cancel()`が呼ばれ、古いPromise完了が新しい結果を上書きしないこと、`destroy()`で実行中preview jobをcancelすることも検証する。

- [ ] **Step 3: UIテストが要素未実装で失敗することを確認する**

Run: `npm.cmd test -- tests/ui/app.test.js`

Expected: FAIL。`viewer-canvas`または`viewer-mode-diff`が存在せず、自動プレビュージョブが呼ばれないことが原因である。既存テストはプレビュー依存注入を追加した状態でPASSを維持する。

- [ ] **Step 4: マークアップと状態を追加する**

`src/app.js`のファイルパネル直後に次の構造を追加する。

```html
<section class="panel viewer-panel" aria-labelledby="viewer-heading">
  <div class="section-heading viewer-heading-row">
    <div><p class="step-label">PREVIEW</p><h2 id="viewer-heading">プレビュー</h2></div>
    <div class="viewer-actions">
      <label><input type="radio" name="viewer-mode" value="normal" data-testid="viewer-mode-normal" checked>通常表示</label>
      <label><input type="radio" name="viewer-mode" value="diff" data-testid="viewer-mode-diff" disabled>差分表示</label>
      <button type="button" class="icon-button" data-testid="viewer-fit">全体表示</button>
    </div>
  </div>
  <p class="viewer-status" data-testid="viewer-status" aria-live="polite">ファイルを追加すると自動表示します。</p>
  <div class="viewer-controls" data-testid="viewer-controls"></div>
  <div class="viewer-stage">
    <canvas data-testid="viewer-canvas" aria-label="HPGL図面プレビュー"></canvas>
    <p class="viewer-empty" data-testid="viewer-empty">表示できる図形がありません。</p>
  </div>
</section>
```

stateへ`previewJob`、`previewToken`、`previewStatus`、`previewFiles`、`visiblePreviewFiles`、`viewerMode`、`compareA`、`compareB`、`viewport`、`frameRequest`を追加する。`addFiles`と`removeFile`の`renderFiles()`後に`startPreview()`を呼ぶ。`startPreview()`は前ジョブをcancelし、結果をクリアして新しいSymbol tokenを作成し、完了・失敗ハンドラではtokenと`destroyed`を検査する。

- [ ] **Step 5: 通常・差分コントロールと描画を実装する**

通常モードのグループは次で構築する。

```js
const groups = state.previewFiles
  .filter((_, index) => state.visiblePreviewFiles.has(index))
  .map((file, index) => ({
    color: VIEWER_COLORS[index % VIEWER_COLORS.length],
    opacity: 0.82,
    geometries: file.geometries,
  }));
```

差分モードでは`compareGeometrySets(a.geometries, b.geometries)`を呼び、`#2574a9`のAのみ、`#98a2ad`の共通、`#d97706`のBのみの3グループを作る。表示対象変更時は`combinedBounds(groups.flatMap(group => group.geometries))`から`fitViewport`を再計算する。wheelでは`preventDefault()`して`zoomViewport`、pointerdown/move/upではpointer captureと`panViewport`、全体表示ボタンでは再フィットする。描画は`requestAnimationFrame`内の`renderViewer`へまとめる。

- [ ] **Step 6: スタイルを追加する**

`select`を既存のinputと同じフォント・focus-visible規則へ追加し、次のクラスを定義する。

```css
.viewer-actions, .viewer-legend, .viewer-diff-controls { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.viewer-controls { display: grid; gap: 12px; margin-bottom: 14px; }
.viewer-stage { position: relative; min-height: 480px; overflow: hidden; border: 1px solid #b9c9d5; border-radius: 10px; background: #0c1724; }
.viewer-stage canvas { display: block; width: 100%; height: 480px; cursor: grab; touch-action: none; }
.viewer-stage canvas.is-panning { cursor: grabbing; }
.viewer-empty { position: absolute; inset: 50% auto auto 50%; margin: 0; color: #d7e1e8; transform: translate(-50%, -50%); pointer-events: none; }
.viewer-swatch { width: 0.85rem; height: 0.85rem; border: 1px solid rgba(0, 0, 0, 0.35); border-radius: 50%; }
.viewer-status { color: #4a6076; }
.viewer-diff-counts { margin: 0; font-variant-numeric: tabular-nums; font-weight: 700; }
```

`max-width: 820px`では見出しと操作を縦積みにし、Canvas高さを360pxへ下げる。`max-width: 520px`ではCanvas高さを280pxへ下げ、A/B selectを幅100%にする。

- [ ] **Step 7: UIテストを通す**

Run: `npm.cmd test -- tests/ui/app.test.js`

Expected: PASS。既存10テストと新規の自動表示、差分、キャンセル、破棄テストが失敗0件。

- [ ] **Step 8: コミットする**

```powershell
git add -- src/app.js src/styles.css tests/ui/app.test.js
git commit -m "feat: add automatic HPGL viewer UI"
```

---

### Task 5: 参照ファイル回帰と全体検証

**Files:**
- Modify: `tests/integration/reference-files.test.js:1-196`

**Interfaces:**
- Consumes: 既存8参照ファイル、`parseHpgl`由来の`result.files`、Task 1の`combinedBounds`と`fitViewport`。
- Produces: すべての参照図形が有限の範囲とビューポートを作る回帰保証。

- [ ] **Step 1: 参照図形の表示範囲テストを追加する**

既存参照テストへ`parseHpgl`、`combinedBounds`、`fitViewport`をimportし、DXF検証前に次を追加する。

```js
const previewFiles = inputs.map(input => parseHpgl(input.data, {
  fileName: input.name,
  layerName: input.layerName,
}));
const previewGeometries = previewFiles.flatMap(file => file.geometries);
const previewBounds = combinedBounds(previewGeometries);
const previewViewport = fitViewport(previewBounds, 1200, 720, 12);
expect(previewGeometries).toHaveLength(result.totals.geometryCount);
expect(Object.values(previewBounds).every(Number.isFinite)).toBe(true);
expect(Object.values(previewViewport).every(Number.isFinite)).toBe(true);
expect(previewViewport.scale).toBeGreaterThan(0);
```

- [ ] **Step 2: 対象回帰テストを通す**

Run: `npm.cmd test -- tests/integration/reference-files.test.js`

Expected: 参照8ファイルが存在する現在の作業環境でPASS。表示範囲とscaleが有限で正となる。

- [ ] **Step 3: 全テストを実行する**

Run: `npm.cmd test`

Expected: 全テストPASS、失敗0件、未処理例外0件。

- [ ] **Step 4: 単一HTMLをビルドする**

Run: `npm.cmd run build`

Expected: exit code 0。Viteが`dist/index.html`を生成し、プレビューWorkerも単一HTMLへインライン化される。

- [ ] **Step 5: DXF参照生成が退行していないことを確認する**

Run: `npm.cmd run generate:reference-dxf`

Expected: exit code 0。`hpgl-dxf-reference-8-files-r2000.dxf`をエラー・警告なしで生成する。

- [ ] **Step 6: 差分と作業ツリーを検査する**

```powershell
git diff --check
git status --short
```

Expected: `git diff --check`はexit code 0。statusには今回の参照テスト変更と、開始前から存在する未追跡`docs/HPGL-DXF静的サイト設計書.md`、`docs/todo.md`、`reference/`だけが意図どおり表示される。

- [ ] **Step 7: 参照回帰をコミットする**

```powershell
git add -- tests/integration/reference-files.test.js
git commit -m "test: cover viewer reference geometry"
```

- [ ] **Step 8: ブラウザ目視確認を依頼する**

`npm.cmd run dev`で起動したURLまたは`dist/index.html`をEdge/Chromeで開き、次を確認する。

1. 2件以上のHPGL追加直後に色分けプレビューが表示される。
2. ファイル表示チェックで対応図形だけが消える。
3. ホイール拡大縮小、ドラッグ移動、全体表示が動作する。
4. 差分表示でA/Bを選択でき、共通、Aのみ、Bのみの色と件数が表示される。
5. DXF変換とダウンロードが従来どおり動作する。
