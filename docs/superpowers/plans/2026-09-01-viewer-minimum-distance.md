# ビューワー・2図形間最小距離計測 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** プレビュー上で図形を2つクリックすると、その2図形の最小距離をmm単位で表示し、最接近点を結ぶ線を描画する。

**Architecture:** 幾何計算は新規の純粋関数モジュール `src/viewer/measure.js` に閉じ込め、メインスレッドで同期実行する。`src/app.js` がクリック判定・選択状態・文言を担い、`src/viewer/canvas-renderer.js` が選択ハイライトと最短線を描く。円は掃引360度の円弧として扱い、掃引判定は既存の `src/viewer/geometry.js` から公開して共有する。

**Tech Stack:** バニラJavaScript（ESM）、Vite 8、Vitest 4、jsdom。実行時依存は追加しない。

**Spec:** `docs/superpowers/specs/2026-09-01-viewer-minimum-distance-design.md`

## Global Constraints

- 実行時依存、CDN、外部通信を追加しない。`package.json` の依存は変更しない。
- 距離の単位はmm固定、表示は小数3桁。
- 角度は度で保持し、掃引判定の許容誤差は `1e-9`。
- 文字図形（`type: 'text'`）は選択・計測の対象外。
- 既存のパン、ズーム、全体表示、通常表示、差分表示、DXF変換の動作を変更しない。
- 既存モジュールの検証方針にそろえ、型違反は `TypeError`、値域違反は `RangeError` を投げる。
- コメントは既存コードと同じ密度に保つ。既存コードに日本語コメントはないため、コメントは必要な箇所だけ英語で書く。
- テストは `npm.cmd test`、ビルドは `npm.cmd run build` で確認する。

---

### Task 1: 掃引判定と図形検証を `geometry.js` から公開する

`measure.js` が既存の掃引判定規則と図形検証を再実装せずに済むよう、既存の内部関数を公開する。挙動は変えない。

**Files:**
- Modify: `src/viewer/geometry.js`
- Test: `tests/viewer/geometry.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `angleInSweep(candidate: number, startAngle: number, endAngle: number) -> boolean`
  - `assertViewerGeometry(geometry: object) -> void`

- [ ] **Step 1: 失敗するテストを書く**

`tests/viewer/geometry.test.js` の末尾へ追加する（ファイル冒頭の `import` へ `angleInSweep` と `assertViewerGeometry` を追加すること）。

```js
describe('angleInSweep', () => {
  it('accepts angles inside a positive sweep and rejects the rest', () => {
    expect(angleInSweep(45, 0, 90)).toBe(true);
    expect(angleInSweep(0, 0, 90)).toBe(true);
    expect(angleInSweep(90, 0, 90)).toBe(true);
    expect(angleInSweep(180, 0, 90)).toBe(false);
  });

  it('accepts angles inside a negative sweep', () => {
    expect(angleInSweep(350, 0, -90)).toBe(true);
    expect(angleInSweep(180, 0, -90)).toBe(false);
  });
});

describe('assertViewerGeometry', () => {
  it('accepts every supported geometry type', () => {
    expect(() => assertViewerGeometry({ type: 'line', points: [[0, 0], [1, 1]] })).not.toThrow();
    expect(() => assertViewerGeometry({ type: 'circle', center: [0, 0], radius: 2 })).not.toThrow();
  });

  it('rejects unknown types and non-finite values', () => {
    expect(() => assertViewerGeometry({ type: 'spline' })).toThrow(TypeError);
    expect(() => assertViewerGeometry({ type: 'circle', center: [0, 0], radius: Number.NaN }))
      .toThrow(RangeError);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm.cmd test -- tests/viewer/geometry.test.js`
Expected: FAIL（`angleInSweep is not a function` / `assertViewerGeometry is not a function`）

- [ ] **Step 3: 最小限の実装を書く**

`src/viewer/geometry.js` の `const assertGeometry = geometry => {` を次へ置き換える。

```js
export const assertViewerGeometry = geometry => {
```

同ファイル内の `assertGeometry(` の呼び出しをすべて `assertViewerGeometry(` へ置き換える（`geometryKey` と `geometryBounds` の先頭にある）。

`const inSweep = (candidate, start, end) => {` を次へ置き換える。

```js
export const angleInSweep = (candidate, start, end) => {
```

同ファイル内の `inSweep(` の呼び出しを `angleInSweep(` へ置き換える（`geometryBounds` の円弧分岐にある）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm.cmd test -- tests/viewer/geometry.test.js`
Expected: PASS（既存テストも全件PASS）

- [ ] **Step 5: コミット**

```bash
git add src/viewer/geometry.js tests/viewer/geometry.test.js
git commit -m "refactor: export sweep check and geometry assertion from viewer geometry"
```

---

### Task 2: 点と図形の距離（`pointToGeometryDistance`）

図形を線分と円弧の要素へ展開し、点からの最小距離を返す。ヒットテストの土台になる。

**Files:**
- Create: `src/viewer/measure.js`
- Test: `tests/viewer/measure.test.js`

**Interfaces:**
- Consumes: `angleInSweep`, `assertViewerGeometry`（Task 1）
- Produces:
  - `pointToGeometryDistance(point: [number, number], geometry: object) -> number`
  - 内部: `toElements(geometry) -> Array<{ kind: 'segment', a, b } | { kind: 'arc', center, radius, startAngle, endAngle }>`
  - 内部: `pointSegment(point, segment) -> { distance: number, point: [number, number] }`
  - 内部: `pointArc(point, arc) -> { distance: number, point: [number, number] }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/viewer/measure.test.js` を新規作成する。

```js
import { describe, expect, it } from 'vitest';
import { pointToGeometryDistance } from '../../src/viewer/measure.js';

const line = points => ({ type: 'line', points });
const polyline = points => ({ type: 'polyline', points });
const circle = (center, radius) => ({ type: 'circle', center, radius });
const arc = (center, radius, startAngle, endAngle) => ({
  type: 'arc', center, radius, startAngle, endAngle,
});

describe('pointToGeometryDistance', () => {
  it('projects onto a segment when the foot of the perpendicular is inside', () => {
    expect(pointToGeometryDistance([5, 3], line([[0, 0], [10, 0]]))).toBeCloseTo(3, 9);
  });

  it('clamps to the nearer endpoint when the projection falls outside', () => {
    expect(pointToGeometryDistance([-4, 3], line([[0, 0], [10, 0]]))).toBeCloseTo(5, 9);
  });

  it('measures to the closest segment of a polyline', () => {
    expect(pointToGeometryDistance([12, 5], polyline([[0, 0], [10, 0], [10, 10]])))
      .toBeCloseTo(2, 9);
  });

  it('measures a circle from outside and from inside', () => {
    expect(pointToGeometryDistance([10, 0], circle([0, 0], 4))).toBeCloseTo(6, 9);
    expect(pointToGeometryDistance([1, 0], circle([0, 0], 4))).toBeCloseTo(3, 9);
  });

  it('returns the radius when the point sits on the arc centre', () => {
    expect(pointToGeometryDistance([0, 0], arc([0, 0], 4, 0, 90))).toBeCloseTo(4, 9);
  });

  it('falls back to arc endpoints when the direction is outside the sweep', () => {
    expect(pointToGeometryDistance([-10, 0], arc([0, 0], 4, 0, 90))).toBeCloseTo(14, 9);
  });

  it('uses the radial point when the direction is inside the sweep', () => {
    expect(pointToGeometryDistance([10, 0], arc([0, 0], 4, 0, 90))).toBeCloseTo(6, 9);
  });

  it('treats text as unselectable', () => {
    expect(pointToGeometryDistance([0, 0], {
      type: 'text', point: [0, 0], text: 'A', height: 2, rotation: 0,
    })).toBe(Infinity);
  });

  it('rejects invalid points and geometries', () => {
    expect(() => pointToGeometryDistance([0], line([[0, 0], [1, 1]]))).toThrow(TypeError);
    expect(() => pointToGeometryDistance([Number.NaN, 0], line([[0, 0], [1, 1]])))
      .toThrow(RangeError);
    expect(() => pointToGeometryDistance([0, 0], { type: 'spline' })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm.cmd test -- tests/viewer/measure.test.js`
Expected: FAIL（`Failed to resolve import "../../src/viewer/measure.js"`）

- [ ] **Step 3: 最小限の実装を書く**

`src/viewer/measure.js` を新規作成する。

```js
import { angleInSweep, assertViewerGeometry } from './geometry.js';

const EPSILON = 1e-9;
const DEGREES_PER_RADIAN = 180 / Math.PI;

const assertPoint = (point, label) => {
  if (!Array.isArray(point) || point.length !== 2) {
    throw new TypeError(`${label} must contain two coordinates`);
  }
  point.forEach((value, index) => {
    if (typeof value !== 'number') {
      throw new TypeError(`${label}[${index}] must be a number`);
    }
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label}[${index}] must be finite`);
    }
  });
};

const distanceBetween = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const normalizedDegrees = value => ((value % 360) + 360) % 360;

const arcPointAt = (arc, degrees) => {
  const radians = degrees / DEGREES_PER_RADIAN;
  return [
    arc.center[0] + arc.radius * Math.cos(radians),
    arc.center[1] + arc.radius * Math.sin(radians),
  ];
};

const directionAngle = (from, to) => normalizedDegrees(
  Math.atan2(to[1] - from[1], to[0] - from[0]) * DEGREES_PER_RADIAN,
);

function toElements(geometry) {
  assertViewerGeometry(geometry);
  if (geometry.type === 'text') {
    throw new TypeError('Text geometry cannot be measured');
  }
  if (geometry.type === 'line' || geometry.type === 'polyline') {
    if (geometry.points.length === 1) {
      return [{ kind: 'segment', a: geometry.points[0], b: geometry.points[0] }];
    }
    return geometry.points.slice(1).map((point, index) => ({
      kind: 'segment', a: geometry.points[index], b: point,
    }));
  }
  if (geometry.type === 'circle') {
    return [{
      kind: 'arc',
      center: geometry.center,
      radius: geometry.radius,
      startAngle: 0,
      endAngle: 360,
    }];
  }
  return [{
    kind: 'arc',
    center: geometry.center,
    radius: geometry.radius,
    startAngle: geometry.startAngle,
    endAngle: geometry.endAngle,
  }];
}

function pointSegment(point, segment) {
  const dx = segment.b[0] - segment.a[0];
  const dy = segment.b[1] - segment.a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) {
    return { distance: distanceBetween(point, segment.a), point: [...segment.a] };
  }
  const raw = ((point[0] - segment.a[0]) * dx + (point[1] - segment.a[1]) * dy) / lengthSquared;
  const t = Math.min(1, Math.max(0, raw));
  const closest = [segment.a[0] + dx * t, segment.a[1] + dy * t];
  return { distance: distanceBetween(point, closest), point: closest };
}

function pointArc(point, arc) {
  const distanceToCentre = distanceBetween(point, arc.center);
  if (distanceToCentre <= EPSILON) {
    return { distance: arc.radius, point: arcPointAt(arc, arc.startAngle) };
  }
  if (angleInSweep(directionAngle(arc.center, point), arc.startAngle, arc.endAngle)) {
    const ratio = arc.radius / distanceToCentre;
    const closest = [
      arc.center[0] + (point[0] - arc.center[0]) * ratio,
      arc.center[1] + (point[1] - arc.center[1]) * ratio,
    ];
    return { distance: Math.abs(distanceToCentre - arc.radius), point: closest };
  }
  return [arc.startAngle, arc.endAngle]
    .map(degrees => arcPointAt(arc, degrees))
    .map(candidate => ({ distance: distanceBetween(point, candidate), point: candidate }))
    .reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best));
}

const pointToElement = (point, element) => (element.kind === 'segment'
  ? pointSegment(point, element)
  : pointArc(point, element));

export function pointToGeometryDistance(point, geometry) {
  assertPoint(point, 'point');
  assertViewerGeometry(geometry);
  if (geometry.type === 'text') {
    return Infinity;
  }
  return toElements(geometry)
    .reduce((best, element) => Math.min(best, pointToElement(point, element).distance), Infinity);
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm.cmd test -- tests/viewer/measure.test.js`
Expected: PASS（9件）

- [ ] **Step 5: コミット**

```bash
git add src/viewer/measure.js tests/viewer/measure.test.js
git commit -m "feat: add point to geometry distance for the viewer"
```

---

### Task 3: ヒットテスト（`pickGeometry`）

許容半径内で最も近い候補を1つ返す。同距離なら配列の先頭に近い候補を優先する。

**Files:**
- Modify: `src/viewer/measure.js`
- Test: `tests/viewer/measure.test.js`

**Interfaces:**
- Consumes: `pointToGeometryDistance`（Task 2）
- Produces: `pickGeometry(candidates: Array<{ geometry: object }>, worldPoint: [number, number], tolerance: number) -> { index: number, candidate: object, distance: number } | null`

- [ ] **Step 1: 失敗するテストを書く**

`tests/viewer/measure.test.js` の `import` へ `pickGeometry` を追加し、末尾へ追加する。

```js
describe('pickGeometry', () => {
  const candidates = [
    { geometry: line([[0, 0], [10, 0]]), label: 'a' },
    { geometry: line([[0, 4], [10, 4]]), label: 'b' },
    { geometry: { type: 'text', point: [5, 1], text: 'A', height: 1, rotation: 0 }, label: 't' },
  ];

  it('returns the nearest candidate inside the tolerance', () => {
    const picked = pickGeometry(candidates, [5, 3], 2);
    expect(picked.index).toBe(1);
    expect(picked.candidate.label).toBe('b');
    expect(picked.distance).toBeCloseTo(1, 9);
  });

  it('returns null when nothing is inside the tolerance', () => {
    expect(pickGeometry(candidates, [5, 2], 0.5)).toBe(null);
  });

  it('never picks text candidates', () => {
    expect(pickGeometry([candidates[2]], [5, 1], 10)).toBe(null);
  });

  it('prefers the earlier candidate when distances tie', () => {
    const tied = [
      { geometry: line([[0, 0], [10, 0]]), label: 'first' },
      { geometry: line([[0, 0], [10, 0]]), label: 'second' },
    ];
    expect(pickGeometry(tied, [5, 1], 2).candidate.label).toBe('first');
  });

  it('returns null for an empty candidate list', () => {
    expect(pickGeometry([], [0, 0], 5)).toBe(null);
  });

  it('rejects invalid arguments', () => {
    expect(() => pickGeometry(null, [0, 0], 1)).toThrow(TypeError);
    expect(() => pickGeometry(candidates, [0, 0], -1)).toThrow(RangeError);
    expect(() => pickGeometry([{}], [0, 0], 1)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm.cmd test -- tests/viewer/measure.test.js`
Expected: FAIL（`pickGeometry is not a function`）

- [ ] **Step 3: 最小限の実装を書く**

`src/viewer/measure.js` の末尾へ追加する。

```js
export function pickGeometry(candidates, worldPoint, tolerance) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('candidates must be an array');
  }
  assertPoint(worldPoint, 'worldPoint');
  if (typeof tolerance !== 'number') {
    throw new TypeError('tolerance must be a number');
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('tolerance must be a finite non-negative number');
  }

  let best = null;
  candidates.forEach((candidate, index) => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new TypeError(`candidates[${index}] must be an object`);
    }
    const distance = pointToGeometryDistance(worldPoint, candidate.geometry);
    if (distance <= tolerance && (best === null || distance < best.distance)) {
      best = { index, candidate, distance };
    }
  });
  return best;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm.cmd test -- tests/viewer/measure.test.js`
Expected: PASS（15件）

- [ ] **Step 5: コミット**

```bash
git add src/viewer/measure.js tests/viewer/measure.test.js
git commit -m "feat: add viewer hit testing for geometry picking"
```

---

### Task 4: 線分どうしの最小距離と `minimumDistance` の骨格

線分だけを扱う `minimumDistance` を先に完成させる。円弧はTask 5で足す。

**Files:**
- Modify: `src/viewer/measure.js`
- Test: `tests/viewer/measure.test.js`

**Interfaces:**
- Consumes: `toElements`, `pointSegment`（Task 2）
- Produces:
  - `minimumDistance(a: object, b: object) -> { distance: number, pointA: [number, number], pointB: [number, number] }`
  - 内部: `segmentSegment(first, second) -> { distance, pointA, pointB }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/viewer/measure.test.js` の `import` へ `minimumDistance` を追加し、末尾へ追加する。

```js
const consistent = result => {
  expect(Math.hypot(result.pointA[0] - result.pointB[0], result.pointA[1] - result.pointB[1]))
    .toBeCloseTo(result.distance, 9);
};

describe('minimumDistance between segments', () => {
  it('measures parallel segments', () => {
    const result = minimumDistance(line([[0, 0], [10, 0]]), line([[0, 3], [10, 3]]));
    expect(result.distance).toBeCloseTo(3, 9);
    consistent(result);
  });

  it('returns zero for crossing segments', () => {
    const result = minimumDistance(line([[0, 0], [10, 10]]), line([[0, 10], [10, 0]]));
    expect(result.distance).toBe(0);
    expect(result.pointA).toEqual(result.pointB);
    expect(result.pointA[0]).toBeCloseTo(5, 9);
    expect(result.pointA[1]).toBeCloseTo(5, 9);
  });

  it('measures collinear segments through their endpoints', () => {
    const result = minimumDistance(line([[0, 0], [1, 0]]), line([[3, 0], [4, 0]]));
    expect(result.distance).toBeCloseTo(2, 9);
    consistent(result);
  });

  it('measures a T shaped gap', () => {
    const result = minimumDistance(line([[0, 0], [10, 0]]), line([[5, 2], [5, 8]]));
    expect(result.distance).toBeCloseTo(2, 9);
    expect(result.pointA[0]).toBeCloseTo(5, 9);
    consistent(result);
  });

  it('finds the closest middle segment of a polyline', () => {
    const result = minimumDistance(
      polyline([[0, 0], [10, 0], [10, 10], [0, 10]]),
      line([[12, 5], [14, 5]]),
    );
    expect(result.distance).toBeCloseTo(2, 9);
    expect(result.pointA).toEqual([10, 5]);
    expect(result.pointB).toEqual([12, 5]);
  });

  it('rejects text geometry', () => {
    const text = { type: 'text', point: [0, 0], text: 'A', height: 1, rotation: 0 };
    expect(() => minimumDistance(text, line([[0, 0], [1, 1]]))).toThrow(TypeError);
    expect(() => minimumDistance(line([[0, 0], [1, 1]]), text)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm.cmd test -- tests/viewer/measure.test.js`
Expected: FAIL（`minimumDistance is not a function`）

- [ ] **Step 3: 最小限の実装を書く**

`src/viewer/measure.js` の末尾へ追加する。

```js
const cross = (ax, ay, bx, by) => ax * by - ay * bx;

const better = (best, candidate) => (best === null || candidate.distance < best.distance
  ? candidate
  : best);

function segmentSegment(first, second) {
  const d1x = first.b[0] - first.a[0];
  const d1y = first.b[1] - first.a[1];
  const d2x = second.b[0] - second.a[0];
  const d2y = second.b[1] - second.a[1];
  const denominator = cross(d1x, d1y, d2x, d2y);
  if (Math.abs(denominator) > EPSILON) {
    const gapX = second.a[0] - first.a[0];
    const gapY = second.a[1] - first.a[1];
    const t = cross(gapX, gapY, d2x, d2y) / denominator;
    const u = cross(gapX, gapY, d1x, d1y) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const point = [first.a[0] + d1x * t, first.a[1] + d1y * t];
      return { distance: 0, pointA: point, pointB: [...point] };
    }
  }

  let best = null;
  [first.a, first.b].forEach(point => {
    const found = pointSegment(point, second);
    best = better(best, { distance: found.distance, pointA: [...point], pointB: found.point });
  });
  [second.a, second.b].forEach(point => {
    const found = pointSegment(point, first);
    best = better(best, { distance: found.distance, pointA: found.point, pointB: [...point] });
  });
  return best;
}

const elementDistance = (first, second) => {
  if (first.kind === 'segment' && second.kind === 'segment') {
    return segmentSegment(first, second);
  }
  throw new TypeError('Unsupported element combination');
};

export function minimumDistance(a, b) {
  const elementsA = toElements(a);
  const elementsB = toElements(b);
  let best = null;
  for (const first of elementsA) {
    for (const second of elementsB) {
      best = better(best, elementDistance(first, second));
      if (best.distance === 0) {
        return best;
      }
    }
  }
  return best;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm.cmd test -- tests/viewer/measure.test.js`
Expected: PASS（21件）

- [ ] **Step 5: コミット**

```bash
git add src/viewer/measure.js tests/viewer/measure.test.js
git commit -m "feat: add minimum distance between viewer segments"
```

---

### Task 5: 円弧を含む最小距離

`elementDistance` の残り3通り（線分↔弧、弧↔線分、弧↔弧）を実装する。

**Files:**
- Modify: `src/viewer/measure.js`
- Test: `tests/viewer/measure.test.js`

**Interfaces:**
- Consumes: `pointArc`, `pointSegment`, `better`, `arcPointAt`, `directionAngle`（Task 2、Task 4）
- Produces:
  - 内部: `segmentArc(segment, arc) -> { distance, pointA, pointB }`（`pointA` は線分上、`pointB` は弧上）
  - 内部: `arcArc(first, second) -> { distance, pointA, pointB }`
  - 内部: `overlappingAngle(first, second) -> number | null`

- [ ] **Step 1: 失敗するテストを書く**

`tests/viewer/measure.test.js` の末尾へ追加する。

```js
describe('minimumDistance with arcs and circles', () => {
  it('measures a segment outside a circle along the radial direction', () => {
    const result = minimumDistance(line([[10, -5], [10, 5]]), circle([0, 0], 5));
    expect(result.distance).toBeCloseTo(5, 9);
    expect(result.pointA).toEqual([10, 0]);
    expect(result.pointB[0]).toBeCloseTo(5, 9);
    expect(result.pointB[1]).toBeCloseTo(0, 9);
  });

  it('measures a segment fully inside a circle from its endpoint', () => {
    const result = minimumDistance(line([[-1, 0], [1, 0]]), circle([0, 0], 5));
    expect(result.distance).toBeCloseTo(4, 9);
    consistent(result);
  });

  it('returns zero when a segment crosses the circle', () => {
    const result = minimumDistance(line([[0, 0], [10, 0]]), circle([0, 0], 5));
    expect(result.distance).toBe(0);
    expect(result.pointA[0]).toBeCloseTo(5, 9);
    expect(result.pointA[1]).toBeCloseTo(0, 9);
  });

  it('does not return zero when the crossing angle is outside the arc sweep', () => {
    const result = minimumDistance(line([[-10, 0], [0, 0]]), arc([0, 0], 5, 0, 90));
    expect(result.distance).toBeCloseTo(5, 9);
    consistent(result);
  });

  it('falls back to arc endpoints when the sweep faces away', () => {
    const result = minimumDistance(line([[0, -10], [10, -10]]), arc([0, 0], 5, 0, 90));
    expect(result.distance).toBeCloseTo(10, 9);
    consistent(result);
  });

  it('measures separated circles along the line of centres', () => {
    const result = minimumDistance(circle([0, 0], 2), circle([10, 0], 3));
    expect(result.distance).toBeCloseTo(5, 9);
    consistent(result);
  });

  it('measures a circle contained in another circle', () => {
    const result = minimumDistance(circle([0, 0], 10), circle([2, 0], 3));
    expect(result.distance).toBeCloseTo(5, 9);
    consistent(result);
  });

  it('measures concentric circles by their radius difference', () => {
    const result = minimumDistance(circle([0, 0], 2), circle([0, 0], 5));
    expect(result.distance).toBeCloseTo(3, 9);
    consistent(result);
  });

  it('returns zero for externally tangent circles', () => {
    const result = minimumDistance(circle([0, 0], 5), circle([10, 0], 5));
    expect(result.distance).toBe(0);
    expect(result.pointA[0]).toBeCloseTo(5, 9);
  });

  it('measures concentric arcs whose sweeps overlap', () => {
    const result = minimumDistance(arc([0, 0], 2, 0, 90), arc([0, 0], 5, 45, 180));
    expect(result.distance).toBeCloseTo(3, 9);
    consistent(result);
  });

  it('uses arc endpoints when concentric sweeps do not overlap', () => {
    const result = minimumDistance(arc([0, 0], 5, 0, 90), arc([0, 0], 5, 180, 270));
    expect(result.distance).toBeCloseTo(5 * Math.SQRT2, 9);
    consistent(result);
  });

  it('measures an arc against a polyline', () => {
    const result = minimumDistance(
      polyline([[0, 0], [10, 0], [10, 10]]),
      arc([10, 20], 5, 180, 360),
    );
    expect(result.distance).toBeCloseTo(5, 9);
    consistent(result);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm.cmd test -- tests/viewer/measure.test.js`
Expected: FAIL（`Unsupported element combination`）

- [ ] **Step 3: 最小限の実装を書く**

`src/viewer/measure.js` の `elementDistance` の直前へ追加する。

```js
function segmentArc(segment, arc) {
  const dx = segment.b[0] - segment.a[0];
  const dy = segment.b[1] - segment.a[1];
  const quadraticA = dx * dx + dy * dy;
  if (quadraticA > EPSILON) {
    const offsetX = segment.a[0] - arc.center[0];
    const offsetY = segment.a[1] - arc.center[1];
    const quadraticB = 2 * (dx * offsetX + dy * offsetY);
    const quadraticC = offsetX * offsetX + offsetY * offsetY - arc.radius * arc.radius;
    const discriminant = quadraticB * quadraticB - 4 * quadraticA * quadraticC;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const crossings = [
        (-quadraticB - root) / (2 * quadraticA),
        (-quadraticB + root) / (2 * quadraticA),
      ].filter(t => t >= 0 && t <= 1);
      for (const t of crossings) {
        const point = [segment.a[0] + dx * t, segment.a[1] + dy * t];
        if (angleInSweep(directionAngle(arc.center, point), arc.startAngle, arc.endAngle)) {
          return { distance: 0, pointA: point, pointB: [...point] };
        }
      }
    }
  }

  let best = null;
  [segment.a, segment.b].forEach(point => {
    const found = pointArc(point, arc);
    best = better(best, { distance: found.distance, pointA: [...point], pointB: found.point });
  });
  [arc.startAngle, arc.endAngle].forEach(degrees => {
    const point = arcPointAt(arc, degrees);
    const found = pointSegment(point, segment);
    best = better(best, { distance: found.distance, pointA: found.point, pointB: point });
  });

  const radial = pointSegment(arc.center, segment).point;
  const radialDistance = distanceBetween(radial, arc.center);
  if (radialDistance > EPSILON
    && angleInSweep(directionAngle(arc.center, radial), arc.startAngle, arc.endAngle)) {
    const ratio = arc.radius / radialDistance;
    const onArc = [
      arc.center[0] + (radial[0] - arc.center[0]) * ratio,
      arc.center[1] + (radial[1] - arc.center[1]) * ratio,
    ];
    best = better(best, {
      distance: Math.abs(radialDistance - arc.radius),
      pointA: radial,
      pointB: onArc,
    });
  }
  return best;
}

function overlappingAngle(first, second) {
  const candidates = [first.startAngle, first.endAngle, second.startAngle, second.endAngle];
  for (const candidate of candidates) {
    const normalized = normalizedDegrees(candidate);
    if (angleInSweep(normalized, first.startAngle, first.endAngle)
      && angleInSweep(normalized, second.startAngle, second.endAngle)) {
      return normalized;
    }
  }
  return null;
}

function arcArc(first, second) {
  const centreDistance = distanceBetween(first.center, second.center);
  if (centreDistance > EPSILON) {
    const unitX = (second.center[0] - first.center[0]) / centreDistance;
    const unitY = (second.center[1] - first.center[1]) / centreDistance;
    const along = (centreDistance * centreDistance
      + first.radius * first.radius - second.radius * second.radius) / (2 * centreDistance);
    const heightSquared = first.radius * first.radius - along * along;
    if (heightSquared >= 0) {
      const height = Math.sqrt(heightSquared);
      const baseX = first.center[0] + along * unitX;
      const baseY = first.center[1] + along * unitY;
      for (const sign of [1, -1]) {
        const point = [baseX - sign * height * unitY, baseY + sign * height * unitX];
        if (angleInSweep(directionAngle(first.center, point), first.startAngle, first.endAngle)
          && angleInSweep(
            directionAngle(second.center, point), second.startAngle, second.endAngle,
          )) {
          return { distance: 0, pointA: point, pointB: [...point] };
        }
      }
    }
  }

  let best = null;
  [first.startAngle, first.endAngle].forEach(degrees => {
    const point = arcPointAt(first, degrees);
    const found = pointArc(point, second);
    best = better(best, { distance: found.distance, pointA: point, pointB: found.point });
  });
  [second.startAngle, second.endAngle].forEach(degrees => {
    const point = arcPointAt(second, degrees);
    const found = pointArc(point, first);
    best = better(best, { distance: found.distance, pointA: found.point, pointB: point });
  });

  if (centreDistance > EPSILON) {
    const unitX = (second.center[0] - first.center[0]) / centreDistance;
    const unitY = (second.center[1] - first.center[1]) / centreDistance;
    for (const signA of [1, -1]) {
      for (const signB of [1, -1]) {
        const pointA = [
          first.center[0] + signA * first.radius * unitX,
          first.center[1] + signA * first.radius * unitY,
        ];
        const pointB = [
          second.center[0] + signB * second.radius * unitX,
          second.center[1] + signB * second.radius * unitY,
        ];
        if (angleInSweep(directionAngle(first.center, pointA), first.startAngle, first.endAngle)
          && angleInSweep(
            directionAngle(second.center, pointB), second.startAngle, second.endAngle,
          )) {
          best = better(best, { distance: distanceBetween(pointA, pointB), pointA, pointB });
        }
      }
    }
    return best;
  }

  const shared = overlappingAngle(first, second);
  if (shared !== null) {
    best = better(best, {
      distance: Math.abs(first.radius - second.radius),
      pointA: arcPointAt(first, shared),
      pointB: arcPointAt(second, shared),
    });
  }
  return best;
}
```

`elementDistance` を次へ置き換える。

```js
const elementDistance = (first, second) => {
  if (first.kind === 'segment' && second.kind === 'segment') {
    return segmentSegment(first, second);
  }
  if (first.kind === 'segment') {
    return segmentArc(first, second);
  }
  if (second.kind === 'segment') {
    const flipped = segmentArc(second, first);
    return { distance: flipped.distance, pointA: flipped.pointB, pointB: flipped.pointA };
  }
  return arcArc(first, second);
};
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm.cmd test -- tests/viewer/measure.test.js`
Expected: PASS（33件）

- [ ] **Step 5: 全テストとビルドを確認する**

Run: `npm.cmd test`
Expected: PASS（既存テストを含め全件）

- [ ] **Step 6: コミット**

```bash
git add src/viewer/measure.js tests/viewer/measure.test.js
git commit -m "feat: add minimum distance for viewer arcs and circles"
```

---

### Task 6: 選択ハイライトと最短線の描画

`renderViewer` の第4引数へ `overlay` を受け取り、選択図形と最接近点を描く。

**Files:**
- Modify: `src/viewer/canvas-renderer.js`
- Test: `tests/viewer/canvas-renderer.test.js`

**Interfaces:**
- Consumes: なし
- Produces: `renderViewer(canvas, groups, viewport, options)` の `options.overlay` が `{ highlights: Array<geometry>, segment: [[number, number], [number, number]] | null } | null` を受け付ける

- [ ] **Step 1: 失敗するテストを書く**

`tests/viewer/canvas-renderer.test.js` の `fakeCanvas` の `context` へ次の2行を追加する。

```js
    setLineDash: vi.fn(),
    fill: vi.fn(),
```

同ファイルの末尾へ追加する。

```js
describe('measurement overlay', () => {
  const overlayGroups = [{
    color: '#146fae',
    geometries: [{ type: 'line', points: [[0, 0], [10, 0]] }],
  }];

  it('draws highlights and a dashed segment with round markers', () => {
    const { canvas, context } = fakeCanvas(400, 240);
    renderViewer(canvas, overlayGroups, viewport, {
      devicePixelRatio: 1,
      overlay: {
        highlights: [{ type: 'line', points: [[0, 0], [10, 0]] }],
        segment: [[0, 0], [0, 4]],
      },
    });

    expect(context.setLineDash).toHaveBeenCalledWith([6, 4]);
    expect(context.setLineDash).toHaveBeenLastCalledWith([]);
    expect(context.strokeStyle).toBe('#111827');
    expect(context.arc).toHaveBeenNthCalledWith(1, 150, 170, 3.5, 0, Math.PI * 2);
    expect(context.arc).toHaveBeenNthCalledWith(2, 150, 130, 3.5, 0, Math.PI * 2);
    expect(context.fill).toHaveBeenCalledTimes(2);
  });

  it('draws a single marker and no dashes when both points coincide', () => {
    const { canvas, context } = fakeCanvas(400, 240);
    renderViewer(canvas, overlayGroups, viewport, {
      devicePixelRatio: 1,
      overlay: { highlights: [], segment: [[2, 2], [2, 2]] },
    });

    expect(context.setLineDash).not.toHaveBeenCalledWith([6, 4]);
    expect(context.fill).toHaveBeenCalledTimes(1);
  });

  it('leaves rendering unchanged when no overlay is given', () => {
    const { canvas, context } = fakeCanvas(400, 240);
    renderViewer(canvas, overlayGroups, viewport, { devicePixelRatio: 1, overlay: null });

    expect(context.setLineDash).not.toHaveBeenCalled();
    expect(context.fill).not.toHaveBeenCalled();
    expect(context.lineWidth).toBe(1.25);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm.cmd test -- tests/viewer/canvas-renderer.test.js`
Expected: FAIL（`setLineDash` が呼ばれない、`strokeStyle` が `#146fae` のまま）

- [ ] **Step 3: 最小限の実装を書く**

`src/viewer/canvas-renderer.js` の `renderGeometry` の後ろへ追加する。

```js
const HIGHLIGHT_COLOR = '#111827';
const MARKER_RADIUS = 3.5;

const renderOverlay = (context, overlay, viewport, screenPoint) => {
  if (!overlay) {
    return;
  }
  context.globalAlpha = 1;
  context.strokeStyle = HIGHLIGHT_COLOR;
  context.fillStyle = HIGHLIGHT_COLOR;
  context.lineWidth = 3.5;
  (overlay.highlights ?? []).forEach(
    geometry => renderGeometry(context, geometry, viewport, screenPoint),
  );

  if (!overlay.segment) {
    return;
  }
  const from = screenPoint(overlay.segment[0]);
  const to = screenPoint(overlay.segment[1]);
  const coincident = Math.hypot(to[0] - from[0], to[1] - from[1]) < 0.5;
  if (!coincident) {
    context.lineWidth = 1.5;
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(...from);
    context.lineTo(...to);
    context.stroke();
    context.setLineDash([]);
  }
  (coincident ? [from] : [from, to]).forEach(point => {
    context.beginPath();
    context.arc(point[0], point[1], MARKER_RADIUS, 0, Math.PI * 2);
    context.fill();
  });
};
```

`renderViewer` の末尾、`groups.forEach(...)` の直後へ追加する。

```js
  renderOverlay(context, options.overlay ?? null, viewport, screenPoint);
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm.cmd test -- tests/viewer/canvas-renderer.test.js`
Expected: PASS（既存テストも全件）

- [ ] **Step 5: コミット**

```bash
git add src/viewer/canvas-renderer.js tests/viewer/canvas-renderer.test.js
git commit -m "feat: draw measurement overlay in the viewer canvas"
```

---

### Task 7: 計測結果の行を追加し、`renderViewer` へ `overlay` を渡す

DOMと描画の受け口を先に用意する。この時点では選択は常に空で、`overlay` は `null`。

**Files:**
- Modify: `src/app.js`
- Test: `tests/ui/app.test.js`

**Interfaces:**
- Consumes: Task 6の `options.overlay`
- Produces:
  - DOM: `<p class="viewer-measure" data-testid="viewer-measure" aria-live="polite">`
  - `state.selection: Array<{ geometry, label }>`、`state.measurement: { distance, pointA, pointB } | null`
  - `renderViewer` は常に4引数で呼ばれる（第4引数は `{ overlay }`）

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/app.test.js` の `describe('mountApp', ...)` 内へ追加する。

```js
  it('shows the measurement hint before anything is selected', () => {
    mount({ createConversionJob: vi.fn() });

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
    expect(document.querySelector('[data-testid="viewer-canvas"]').getAttribute('tabindex'))
      .toBe('0');
  });

  it('passes an overlay slot to the renderer', async () => {
    const renderViewer = vi.fn();
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(files => ({
        promise: Promise.resolve(previewResult(files)),
        cancel: vi.fn(),
      })),
      renderViewer,
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('a.hpgl')]);

    await vi.waitFor(() => expect(renderViewer.mock.lastCall[1]).toHaveLength(1));
    expect(renderViewer.mock.lastCall[3]).toEqual({ overlay: null });
  });
```

さらに、既存テスト `clears the canvas while a replacement preview is pending` のアサーションを、第4引数を含む形へ更新する。

```js
    await vi.waitFor(() => expect(renderViewer).toHaveBeenCalledWith(
      document.querySelector('[data-testid="viewer-canvas"]'),
      [],
      expect.any(Object),
      expect.any(Object),
    ));
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm.cmd test -- tests/ui/app.test.js`
Expected: FAIL（`viewer-measure` が `null`、`lastCall[3]` が `undefined`）

- [ ] **Step 3: 最小限の実装を書く**

`src/app.js` のテンプレートで、`viewer-status` の `<p>` の直後へ次の行を追加する。

```html
        <p class="viewer-measure" data-testid="viewer-measure" aria-live="polite"></p>
```

同テンプレートの `<canvas data-testid="viewer-canvas" aria-label="HPGL図面プレビュー"></canvas>` を次へ置き換える。

```html
          <canvas data-testid="viewer-canvas" aria-label="HPGL図面プレビュー" tabindex="0"></canvas>
```

`nodes` へ追加する。

```js
    viewerMeasure: root.querySelector('[data-testid="viewer-measure"]'),
```

`state` へ追加する。

```js
    selection: [],
    measurement: null,
```

`src/app.js` の先頭付近へ定数を追加する。

```js
const MEASURE_HINT = '図形をクリックすると2つの図形の最小距離を表示します。';
```

`scheduleViewerRender` の `renderViewer(nodes.viewerCanvas, groups, state.viewport);` を次へ置き換える。

```js
      renderViewer(nodes.viewerCanvas, groups, state.viewport, { overlay: measureOverlay() });
```

`scheduleViewerRender` の直前へ追加する。

```js
  function measureOverlay() {
    if (state.selection.length === 0) {
      return null;
    }
    return {
      highlights: state.selection.map(item => item.geometry),
      segment: state.measurement
        ? [state.measurement.pointA, state.measurement.pointB]
        : null,
    };
  }

  function renderMeasure() {
    nodes.viewerMeasure.textContent = MEASURE_HINT;
  }
```

初期化部（末尾の `renderFiles();` の直前）へ追加する。

```js
  renderMeasure();
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm.cmd test -- tests/ui/app.test.js`
Expected: PASS（既存テストも全件）

- [ ] **Step 5: コミット**

```bash
git add src/app.js tests/ui/app.test.js
git commit -m "feat: add measurement row and overlay slot to the viewer panel"
```

---

### Task 8: クリックによる選択と距離表示

ドラッグと区別したクリック判定、ヒットテスト、選択遷移、文言表示を実装する。

**Files:**
- Modify: `src/app.js`
- Test: `tests/ui/app.test.js`

**Interfaces:**
- Consumes: `pickGeometry`, `minimumDistance`（Task 3、Task 5）、`measureOverlay`, `renderMeasure`（Task 7）
- Produces:
  - 内部: `measureCandidates() -> Array<{ geometry, label }>`
  - 内部: `handleViewerClick(clientX, clientY) -> void`

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/app.test.js` の `describe('mountApp', ...)` 内へ追加する。ヘルパーもこのブロックの先頭へ置く。

```js
  function stubCanvasRect(width = 400, height = 240) {
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {},
    }));
  }

  function clickCanvas(canvas, clientX, clientY) {
    canvas.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true, button: 0, clientX, clientY,
    }));
    canvas.dispatchEvent(new MouseEvent('pointerup', {
      bubbles: true, button: 0, clientX, clientY,
    }));
  }

  function twoLinePreview() {
    return {
      files: [
        {
          name: 'a.hpgl',
          layerName: 'a',
          geometries: [line([[-5, 0], [5, 0]])],
          geometryCount: 1,
          errorCount: 0,
          warningCount: 0,
          diagnostics: [],
        },
        {
          name: 'b.hpgl',
          layerName: 'b',
          geometries: [line([[-5, 3], [5, 3]])],
          geometryCount: 1,
          errorCount: 0,
          warningCount: 0,
          diagnostics: [],
        },
      ],
    };
  }

  async function mountWithTwoLines(extra = {}) {
    stubCanvasRect();
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(() => ({
        promise: Promise.resolve(twoLinePreview()),
        cancel: vi.fn(),
      })),
      ...extra,
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [
      hpglFile('a.hpgl'),
      hpglFile('b.hpgl', 'PU;', { lastModified: 456 }),
    ]);
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="viewer-controls"]').textContent,
    ).toContain('b.hpgl'));
    return document.querySelector('[data-testid="viewer-canvas"]');
  }
```

`twoLinePreview` の2本は `x` が `-5`〜`5`、`y` が `0` と `3` の水平線である。全体表示は`fitViewport` により中心 `(0, 1.5)`、`scale = min((400 - 24) / 10, (240 - 24) / 3) = 37.6` になる。Canvas中心は `(200, 120)` なので、`y = 0` の線は画面上の `y = 120 + 1.5 * 37.6 = 176.4`、`y = 3` の線は `y = 120 - 1.5 * 37.6 = 63.6` に描かれる。ヒットの許容半径は `8 / 37.6 ≒ 0.213 mm` である。

```js
  it('measures the distance between two clicked geometries', async () => {
    const canvas = await mountWithTwoLines();

    clickCanvas(canvas, 200, 176);
    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('1つ目を選択しました（a.hpgl の線分）。もう1つクリックしてください。');

    clickCanvas(canvas, 200, 64);
    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('最小距離 3.000 mm ／ A: a.hpgl の線分 ／ B: b.hpgl の線分');
  });

  it('does not select while dragging to pan', async () => {
    const canvas = await mountWithTwoLines();

    canvas.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true, button: 0, clientX: 200, clientY: 176,
    }));
    canvas.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true, clientX: 240, clientY: 176,
    }));
    canvas.dispatchEvent(new MouseEvent('pointerup', {
      bubbles: true, button: 0, clientX: 240, clientY: 176,
    }));

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
  });

  it('deselects when the same geometry is clicked again', async () => {
    const canvas = await mountWithTwoLines();

    clickCanvas(canvas, 200, 176);
    clickCanvas(canvas, 210, 176);

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
  });

  it('restarts the selection on the third click', async () => {
    const canvas = await mountWithTwoLines();

    clickCanvas(canvas, 200, 176);
    clickCanvas(canvas, 200, 64);
    clickCanvas(canvas, 200, 176);

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('1つ目を選択しました（a.hpgl の線分）。もう1つクリックしてください。');
  });

  it('clears the selection when empty space is clicked', async () => {
    const canvas = await mountWithTwoLines();

    clickCanvas(canvas, 200, 176);
    clickCanvas(canvas, 200, 120);

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
  });

  it('sends the selected geometries and the closest points to the renderer', async () => {
    const renderViewer = vi.fn();
    const canvas = await mountWithTwoLines({ renderViewer });

    clickCanvas(canvas, 200, 176);
    clickCanvas(canvas, 200, 64);

    await vi.waitFor(() => expect(renderViewer.mock.lastCall[3].overlay).not.toBe(null));
    const { overlay } = renderViewer.mock.lastCall[3];
    expect(overlay.highlights).toHaveLength(2);
    expect(overlay.segment[0][1]).toBeCloseTo(0, 9);
    expect(overlay.segment[1][1]).toBeCloseTo(3, 9);
  });

  it('ignores geometries of files that are hidden', async () => {
    const canvas = await mountWithTwoLines();
    const toggles = document.querySelectorAll('[data-testid="viewer-layer-toggle"]');
    toggles[0].click();

    clickCanvas(canvas, 200, 176);

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
  });

  async function mountWithGeometries(geometries) {
    stubCanvasRect();
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(() => ({
        promise: Promise.resolve({
          files: [{
            name: 'x.hpgl',
            layerName: 'x',
            geometries,
            geometryCount: geometries.length,
            errorCount: 0,
            warningCount: 0,
            diagnostics: [],
          }],
        }),
        cancel: vi.fn(),
      })),
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('x.hpgl')]);
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="viewer-controls"]').textContent,
    ).toContain('x.hpgl'));
    return document.querySelector('[data-testid="viewer-canvas"]');
  }

  it('reports crossing geometries as a zero distance', async () => {
    // Bounds -5..5 on both axes give scale 21.6 and a canvas centre of (200, 120).
    const canvas = await mountWithGeometries([
      line([[-5, -5], [5, 5]]),
      line([[-5, 5], [5, -5]]),
    ]);

    clickCanvas(canvas, 243, 77);
    clickCanvas(canvas, 157, 77);

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('最小距離 0.000 mm（接触または交差） ／ A: x.hpgl の線分 ／ B: x.hpgl の線分');
  });

  it('never selects text geometry', async () => {
    const canvas = await mountWithGeometries([
      { type: 'text', point: [0, 0], text: 'A', height: 2, rotation: 0 },
    ]);

    clickCanvas(canvas, 200, 120);

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm.cmd test -- tests/ui/app.test.js`
Expected: FAIL（クリックしても文言が変わらない）

- [ ] **Step 3: 最小限の実装を書く**

`src/app.js` の `import` へ追加する。

```js
import { minimumDistance, pickGeometry } from './viewer/measure.js';
```

先頭付近の定数へ追加する。

```js
const CLICK_MOVE_LIMIT = 4;
const PICK_RADIUS = 8;
const GEOMETRY_LABELS = {
  line: '線分',
  polyline: '連続線',
  circle: '円',
  arc: '円弧',
};
```

`measureOverlay` の直前へ追加する。

```js
  function measureCandidates() {
    if (state.viewerMode === 'diff' && state.previewFiles.length >= 2) {
      const comparison = currentDiffComparison();
      if (!comparison) {
        return [];
      }
      const { a, b, difference } = comparison;
      return [
        { geometries: difference.onlyA, source: `Aのみ（${a.name}）` },
        { geometries: difference.common, source: `共通（${a.name} と ${b.name}）` },
        { geometries: difference.onlyB, source: `Bのみ（${b.name}）` },
      ].flatMap(({ geometries, source }) => geometries
        .filter(geometry => geometry.type !== 'text')
        .map(geometry => ({ geometry, label: `${source}の${GEOMETRY_LABELS[geometry.type]}` })));
    }
    return state.previewFiles
      .flatMap((file, index) => (state.visiblePreviewFiles.has(index)
        ? file.geometries
          .filter(geometry => geometry.type !== 'text')
          .map(geometry => ({
            geometry,
            label: `${file.name} の${GEOMETRY_LABELS[geometry.type]}`,
          }))
        : []));
  }
```

`renderMeasure` を次へ置き換える。

```js
  function renderMeasure() {
    if (state.selection.length === 0) {
      nodes.viewerMeasure.textContent = MEASURE_HINT;
      return;
    }
    if (state.selection.length === 1) {
      nodes.viewerMeasure.textContent
        = `1つ目を選択しました（${state.selection[0].label}）。もう1つクリックしてください。`;
      return;
    }
    const [first, second] = state.selection;
    const distance = state.measurement.distance.toFixed(3);
    const contact = state.measurement.distance === 0 ? '（接触または交差）' : '';
    nodes.viewerMeasure.textContent
      = `最小距離 ${distance} mm${contact} ／ A: ${first.label} ／ B: ${second.label}`;
  }
```

`renderMeasure` の直後へ追加する。

```js
  function clearSelection() {
    if (state.selection.length === 0 && state.measurement === null) {
      return;
    }
    state.selection = [];
    state.measurement = null;
    renderMeasure();
    scheduleViewerRender();
  }

  function selectGeometry(candidate) {
    if (state.selection.length === 1 && state.selection[0].geometry === candidate.geometry) {
      clearSelection();
      return;
    }
    if (state.selection.length === 1) {
      state.selection = [state.selection[0], candidate];
      state.measurement = minimumDistance(
        state.selection[0].geometry,
        state.selection[1].geometry,
      );
    } else {
      state.selection = [candidate];
      state.measurement = null;
    }
    renderMeasure();
    scheduleViewerRender();
  }

  function handleViewerClick(clientX, clientY) {
    const rect = nodes.viewerCanvas.getBoundingClientRect();
    const worldPoint = [
      state.viewport.centerX + (clientX - rect.left - rect.width / 2) / state.viewport.scale,
      state.viewport.centerY - (clientY - rect.top - rect.height / 2) / state.viewport.scale,
    ];
    const picked = pickGeometry(
      measureCandidates(),
      worldPoint,
      PICK_RADIUS / state.viewport.scale,
    );
    if (picked === null) {
      clearSelection();
      return;
    }
    selectGeometry(picked.candidate);
  }
```

`pointerdown` ハンドラーを次へ置き換える。

```js
  listen(nodes.viewerCanvas, 'pointerdown', event => {
    if (event.button !== 0) {
      return;
    }
    pointerDrag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    };
    nodes.viewerCanvas.setPointerCapture?.(event.pointerId);
    nodes.viewerCanvas.classList.add('is-panning');
  });
```

`pointermove` ハンドラーの `pointerDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };` を次へ置き換える。

```js
    pointerDrag = { ...pointerDrag, x: event.clientX, y: event.clientY };
```

`finishPointerDrag` を次へ置き換える。

```js
  const finishPointerDrag = event => {
    if (!pointerDrag || event.pointerId !== pointerDrag.id) {
      return;
    }
    const moved = Math.hypot(
      event.clientX - pointerDrag.startX,
      event.clientY - pointerDrag.startY,
    );
    if (nodes.viewerCanvas.hasPointerCapture?.(event.pointerId)) {
      nodes.viewerCanvas.releasePointerCapture(event.pointerId);
    }
    pointerDrag = null;
    nodes.viewerCanvas.classList.remove('is-panning');
    if (event.type === 'pointerup' && moved < CLICK_MOVE_LIMIT) {
      handleViewerClick(event.clientX, event.clientY);
    }
  };
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm.cmd test -- tests/ui/app.test.js`
Expected: PASS（既存テストも全件）

- [ ] **Step 5: コミット**

```bash
git add src/app.js tests/ui/app.test.js
git commit -m "feat: measure the minimum distance between two clicked geometries"
```

---

### Task 9: 選択の解除条件とエラー処理

状態が変わったときに選択を捨て、計測が失敗しても他の機能を保つ。

**Files:**
- Modify: `src/app.js`
- Test: `tests/ui/app.test.js`

**Interfaces:**
- Consumes: `clearSelection`, `selectGeometry`, `handleViewerClick`（Task 8）
- Produces: 内部 `failMeasure() -> void`（選択を捨てて失敗文言を表示する）

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/app.test.js` へ追加する。

```js
  it('clears the selection on Escape', async () => {
    const canvas = await mountWithTwoLines();
    clickCanvas(canvas, 200, 176);

    canvas.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
  });

  it('clears the selection when the layer visibility changes', async () => {
    const canvas = await mountWithTwoLines();
    clickCanvas(canvas, 200, 176);

    document.querySelectorAll('[data-testid="viewer-layer-toggle"]')[1].click();

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
  });

  it('clears the selection when the viewer mode changes', async () => {
    const canvas = await mountWithTwoLines();
    clickCanvas(canvas, 200, 176);

    document.querySelector('[data-testid="viewer-mode-diff"]').click();

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
  });

  it('clears the selection when a new preview starts', async () => {
    const canvas = await mountWithTwoLines();
    clickCanvas(canvas, 200, 176);

    setInputFiles(document.querySelector('[data-testid="file-input"]'), [
      hpglFile('c.hpgl', 'PU;', { lastModified: 999 }),
    ]);

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('図形をクリックすると2つの図形の最小距離を表示します。');
  });

  it('recovers when the distance computation throws', async () => {
    stubCanvasRect();
    const geometries = [
      { type: 'line', points: [[-5, 0], [5, 0]] },
      { type: 'line', points: [[-5, 3], [5, 3]] },
    ];
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(() => ({
        promise: Promise.resolve({
          files: [{
            name: 'a.hpgl',
            layerName: 'a',
            geometries,
            geometryCount: 2,
            errorCount: 0,
            warningCount: 0,
            diagnostics: [],
          }],
        }),
        cancel: vi.fn(),
      })),
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('a.hpgl')]);
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="viewer-controls"]').textContent,
    ).toContain('a.hpgl'));
    const canvas = document.querySelector('[data-testid="viewer-canvas"]');

    clickCanvas(canvas, 200, 176);
    geometries[1].points = [[Number.NaN, 0], [1, 1]];
    clickCanvas(canvas, 200, 64);

    expect(document.querySelector('[data-testid="viewer-measure"]').textContent)
      .toBe('距離を計算できませんでした。');
    expect(document.querySelector('[data-testid="viewer-status"]').dataset.kind).toBe('ready');
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm.cmd test -- tests/ui/app.test.js`
Expected: FAIL（Escや表示切り替えで選択が残る、例外が外へ漏れる）

- [ ] **Step 3: 最小限の実装を書く**

`src/app.js` の定数へ追加する。

```js
const MEASURE_FAILURE = '距離を計算できませんでした。';
```

`clearSelection` の直後へ追加する。ヒットテストも計測も同じ失敗表示を使う。

```js
  function failMeasure() {
    state.selection = [];
    state.measurement = null;
    nodes.viewerMeasure.textContent = MEASURE_FAILURE;
    scheduleViewerRender();
  }
```

`selectGeometry` の計測部分を次へ置き換える。

```js
    if (state.selection.length === 1) {
      const pair = [state.selection[0], candidate];
      let measurement;
      try {
        measurement = minimumDistance(pair[0].geometry, pair[1].geometry);
      } catch {
        failMeasure();
        return;
      }
      state.selection = pair;
      state.measurement = measurement;
    } else {
```

`handleViewerClick` を次へ置き換える。壊れた図形はヒットテストの段階で例外になるため、`pickGeometry` も保護する。

```js
  function handleViewerClick(clientX, clientY) {
    const rect = nodes.viewerCanvas.getBoundingClientRect();
    const worldPoint = [
      state.viewport.centerX + (clientX - rect.left - rect.width / 2) / state.viewport.scale,
      state.viewport.centerY - (clientY - rect.top - rect.height / 2) / state.viewport.scale,
    ];
    let picked;
    try {
      picked = pickGeometry(
        measureCandidates(),
        worldPoint,
        PICK_RADIUS / state.viewport.scale,
      );
    } catch {
      failMeasure();
      return;
    }
    if (picked === null) {
      clearSelection();
      return;
    }
    selectGeometry(picked.candidate);
  }
```

`handleViewerClick` の直後へキーボードリスナーを追加する（`listen(nodes.viewerCanvas, 'wheel', ...)` の並びへ置く）。

```js
  listen(nodes.viewerCanvas, 'keydown', event => {
    if (event.key === 'Escape') {
      clearSelection();
    }
  });
```

次の各所へ `clearSelection();` を追加する。

- `viewerModeNormal` の `change` ハンドラー内、`state.viewerMode = 'normal';` の直後
- `viewerModeDiff` の `change` ハンドラー内、`state.viewerMode = 'diff';` の直後
- `renderPreviewControls` 内の比較対象A/Bの `change` ハンドラー2か所、`renderPreviewControls();` の直前
- `renderPreviewControls` 内のレイヤー表示チェックの `change` ハンドラー内、`fitPreview();` の直前
- `startPreview` の冒頭（`state.previewToken = null;` の直後）
- `finishPreview` 内の `state.previewFiles = ...` の直前
- `failPreview` 内の `state.previewFiles = [];` の直前

`startPreview` で選択を消すため、`finishPreview` と `failPreview` の追加は保険として働く。いずれも `clearSelection()` は冪等である。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm.cmd test`
Expected: PASS（全ファイル）

- [ ] **Step 5: コミット**

```bash
git add src/app.js tests/ui/app.test.js
git commit -m "feat: clear the measurement selection on viewer state changes"
```

---

### Task 10: スタイル、ドキュメント、全体検証

**Files:**
- Modify: `src/styles.css`
- Modify: `README.md`
- Modify: `docs/todo.md`

**Interfaces:**
- Consumes: Task 7で追加した `.viewer-measure`
- Produces: なし

- [ ] **Step 1: スタイルを追加する**

`src/styles.css` の `.viewer-status` のルールの直後へ追加する。

```css
.viewer-measure {
  margin: 0.35rem 0 0;
  font-size: 0.9rem;
  color: #33475b;
}

.viewer-measure b {
  font-weight: 600;
}
```

同ファイルの `.viewer-stage canvas` のルールへ `cursor: crosshair;` を追加する。`.viewer-stage canvas.is-panning` は既存の指定をそのまま残す。

- [ ] **Step 2: README を更新する**

`README.md` の「主な特徴」の箇条書きへ追加する。

```markdown
- プレビュー上で図形を2つクリックすると、その2図形の最小距離をmm単位で表示
```

「使い方」の手順へ、変換手順の前に追加する。

```markdown
2. プレビューで図形をクリックすると1つ目として選択され、もう1つクリックすると2図形の最小距離を表示します。Escキーまたは図形のない場所のクリックで選択を解除できます。
```

追加後、既存の手順番号が連番になるよう振り直すこと。

- [ ] **Step 3: todo を更新する**

`docs/todo.md` の `## done` の「ビューワー機能」の入れ子へ追加する。

```markdown
  - 2図形の最小距離計測
```

- [ ] **Step 4: 全体検証**

```bash
npm.cmd test
npm.cmd run build
git diff --check
```

Expected: テスト全件PASS、ビルド成功、`git diff --check` は無出力

- [ ] **Step 5: 手動確認**

`npm.cmd run dev` を起動し、`reference` 内の代表HPGLを2ファイル読み込んで次を確認する。

- 線分どうし、線分と円弧、連続線どうしをクリックして距離が表示される
- 選択図形が濃色で太く描かれ、最接近点が破線と丸マーカーで結ばれる
- ドラッグでパンしても選択が発生しない
- Escキー、空白クリック、表示チェックの切り替えで選択が解除される
- 差分表示へ切り替えても計測でき、図形名に「Aのみ」「共通」「Bのみ」が付く

- [ ] **Step 6: コミット**

```bash
git add src/styles.css README.md docs/todo.md
git commit -m "docs: document the viewer minimum distance measurement"
```
