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
