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
  const unitX = centreDistance > EPSILON
    ? (second.center[0] - first.center[0]) / centreDistance
    : 0;
  const unitY = centreDistance > EPSILON
    ? (second.center[1] - first.center[1]) / centreDistance
    : 0;
  if (centreDistance > EPSILON) {
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
