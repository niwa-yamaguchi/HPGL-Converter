const PRECISION = 1000;
const VIEWPORT_MIN_SCALE = 1e-6;
const VIEWPORT_MAX_SCALE = 1e6;

const assertObject = (value, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
};

const assertArray = (value, label) => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
};

const assertFinite = (value, label) => {
  if (typeof value !== 'number') {
    throw new TypeError(`${label} must be a number`);
  }
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
};

const assertPoint = (point, label) => {
  assertArray(point, label);
  if (point.length !== 2) {
    throw new TypeError(`${label} must contain two coordinates`);
  }
  assertFinite(point[0], `${label}[0]`);
  assertFinite(point[1], `${label}[1]`);
};

const assertPoints = (points, label) => {
  assertArray(points, label);
  if (points.length === 0) {
    throw new RangeError(`${label} must not be empty`);
  }
  points.forEach((point, index) => assertPoint(point, `${label}[${index}]`));
};

const assertGeometry = geometry => {
  assertObject(geometry, 'geometry');
  if (typeof geometry.type !== 'string') {
    throw new TypeError('geometry.type must be a string');
  }

  switch (geometry.type) {
    case 'line':
    case 'polyline':
      assertPoints(geometry.points, 'geometry.points');
      break;
    case 'circle':
      assertPoint(geometry.center, 'geometry.center');
      assertFinite(geometry.radius, 'geometry.radius');
      break;
    case 'arc':
      assertPoint(geometry.center, 'geometry.center');
      assertFinite(geometry.radius, 'geometry.radius');
      assertFinite(geometry.startAngle, 'geometry.startAngle');
      assertFinite(geometry.endAngle, 'geometry.endAngle');
      break;
    case 'text':
      assertPoint(geometry.point, 'geometry.point');
      if (typeof geometry.text !== 'string') {
        throw new TypeError('geometry.text must be a string');
      }
      assertFinite(geometry.height, 'geometry.height');
      assertFinite(geometry.rotation, 'geometry.rotation');
      break;
    default:
      throw new TypeError(`Unknown viewer geometry type: ${String(geometry.type)}`);
  }
};

const assertBounds = bounds => {
  assertObject(bounds, 'bounds');
  assertFinite(bounds.minX, 'bounds.minX');
  assertFinite(bounds.minY, 'bounds.minY');
  assertFinite(bounds.maxX, 'bounds.maxX');
  assertFinite(bounds.maxY, 'bounds.maxY');
};

const assertViewport = viewport => {
  assertObject(viewport, 'viewport');
  assertFinite(viewport.centerX, 'viewport.centerX');
  assertFinite(viewport.centerY, 'viewport.centerY');
  assertFinite(viewport.scale, 'viewport.scale');
  assertFinite(viewport.width, 'viewport.width');
  assertFinite(viewport.height, 'viewport.height');
  if (viewport.scale <= 0) {
    throw new RangeError('viewport.scale must be positive');
  }
};

const rounded = value => {
  const result = Math.round(value * PRECISION) / PRECISION;
  if (!Number.isFinite(result)) {
    throw new RangeError('Rounded geometry value must be finite');
  }
  return Object.is(result, -0) ? 0 : result;
};
const pointKey = point => `${rounded(point[0])},${rounded(point[1])}`;
const angle = value => {
  const result = rounded(((value % 360) + 360) % 360);
  return result === 360 ? 0 : result;
};

export function geometryKey(geometry) {
  assertGeometry(geometry);
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
  assertArray(a, 'a');
  assertArray(b, 'b');
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
  assertGeometry(geometry);
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
  assertArray(geometries, 'geometries');
  if (geometries.length === 0) return null;
  return geometries.map(geometryBounds).reduce((result, bounds) => ({
    minX: Math.min(result.minX, bounds.minX), minY: Math.min(result.minY, bounds.minY),
    maxX: Math.max(result.maxX, bounds.maxX), maxY: Math.max(result.maxY, bounds.maxY),
  }));
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function fitViewport(bounds, width, height, padding = 12) {
  if (bounds !== null) assertBounds(bounds);
  assertFinite(width, 'width');
  assertFinite(height, 'height');
  assertFinite(padding, 'padding');
  if (!bounds) return { centerX: 0, centerY: 0, scale: 1, width, height };
  const scale = clamp(Math.min(
    Math.max(1, width - 2 * padding) / Math.max(1, bounds.maxX - bounds.minX),
    Math.max(1, height - 2 * padding) / Math.max(1, bounds.maxY - bounds.minY),
  ), VIEWPORT_MIN_SCALE, VIEWPORT_MAX_SCALE);
  return {
    centerX: bounds.minX / 2 + bounds.maxX / 2,
    centerY: bounds.minY / 2 + bounds.maxY / 2,
    scale, width, height,
  };
}

export function zoomViewport(viewport, screenPoint, deltaY) {
  assertViewport(viewport);
  assertPoint([screenPoint?.x, screenPoint?.y], 'screenPoint');
  assertFinite(deltaY, 'deltaY');
  const scale = clamp(
    viewport.scale * clamp(Math.exp(-deltaY * 0.0015), 0.1, 10),
    VIEWPORT_MIN_SCALE,
    VIEWPORT_MAX_SCALE,
  );
  const worldX = viewport.centerX + (screenPoint.x - viewport.width / 2) / viewport.scale;
  const worldY = viewport.centerY - (screenPoint.y - viewport.height / 2) / viewport.scale;
  const result = {
    ...viewport,
    scale,
    centerX: worldX - (screenPoint.x - viewport.width / 2) / scale,
    centerY: worldY + (screenPoint.y - viewport.height / 2) / scale,
  };
  assertViewport(result);
  return result;
}

export function panViewport(viewport, dx, dy) {
  assertViewport(viewport);
  assertFinite(dx, 'dx');
  assertFinite(dy, 'dy');
  const result = {
    ...viewport,
    centerX: viewport.centerX - dx / viewport.scale,
    centerY: viewport.centerY + dy / viewport.scale,
  };
  assertViewport(result);
  return result;
}
