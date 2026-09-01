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
