import { escapeDxfText } from './escape.js';

const GEOMETRY_TYPES = new Set(['line', 'polyline', 'circle', 'arc', 'text']);

function pair(code, value) {
  return `${code}\n${value}\n`;
}

function pushPairs(chunks, pairs) {
  for (const [code, value] of pairs) {
    chunks.push(pair(code, value));
  }
}

function pushSectionStart(chunks, name) {
  pushPairs(chunks, [[0, 'SECTION'], [2, name]]);
}

function pushEmptySection(chunks, name) {
  pushSectionStart(chunks, name);
  chunks.push(pair(0, 'ENDSEC'));
}

function validatePoint(point, label) {
  if (!Array.isArray(point) || point.length !== 2) {
    throw new TypeError(`${label} coordinate must contain exactly 2 values`);
  }
  if (!point.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new RangeError(`${label} coordinate values must be finite numbers`);
  }
  return point;
}

function validateRadius(radius, label) {
  if (typeof radius !== 'number' || !Number.isFinite(radius)) {
    throw new RangeError(`${label} radius must be finite`);
  }
  if (radius <= 0) {
    throw new RangeError(`${label} radius must be positive`);
  }
  return radius;
}

function validateColor(color) {
  if (typeof color !== 'number' || !Number.isFinite(color)) {
    throw new RangeError('Geometry color must be a finite integer from 1 through 255');
  }
  if (!Number.isInteger(color)) {
    throw new RangeError('Geometry color must be an integer from 1 through 255');
  }
  if (color < 1 || color > 255) {
    throw new RangeError('Geometry color must be from 1 through 255');
  }
  return color;
}

function validateFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  return value;
}

function normalizeAngle(angle) {
  const normalized = ((angle % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function validateCommonGeometry(geometry) {
  if (geometry === null || typeof geometry !== 'object' || Array.isArray(geometry)) {
    throw new TypeError('Geometry must be an object');
  }
  if (typeof geometry.layer !== 'string') {
    throw new TypeError('Geometry layer must be a string');
  }
  return {
    layer: escapeDxfText(geometry.layer),
    color: validateColor(geometry.color),
  };
}

function commonPairs(type, common) {
  return [[0, type], [8, common.layer], [62, common.color]];
}

function linePairs(geometry, common) {
  if (!Array.isArray(geometry.points) || geometry.points.length !== 2) {
    throw new RangeError('LINE requires exactly 2 points');
  }
  const start = validatePoint(geometry.points[0], 'LINE start');
  const end = validatePoint(geometry.points[1], 'LINE end');
  return [
    ...commonPairs('LINE', common),
    [10, start[0]], [20, start[1]], [30, 0],
    [11, end[0]], [21, end[1]], [31, 0],
  ];
}

function polylinePairs(geometry, common) {
  if (!Array.isArray(geometry.points) || geometry.points.length < 3) {
    throw new RangeError('LWPOLYLINE requires at least 3 points');
  }
  const points = geometry.points.map((point, index) => (
    validatePoint(point, `LWPOLYLINE point ${index}`)
  ));
  return [
    ...commonPairs('LWPOLYLINE', common),
    [90, points.length],
    [70, 0],
    ...points.flatMap(point => [[10, point[0]], [20, point[1]]]),
  ];
}

function circlePairs(geometry, common) {
  const center = validatePoint(geometry.center, 'CIRCLE center');
  const radius = validateRadius(geometry.radius, 'CIRCLE');
  return [
    ...commonPairs('CIRCLE', common),
    [10, center[0]], [20, center[1]], [30, 0], [40, radius],
  ];
}

function arcPairs(geometry, common) {
  const center = validatePoint(geometry.center, 'ARC center');
  const radius = validateRadius(geometry.radius, 'ARC');
  const hpglStart = validateFinite(geometry.startAngle, 'ARC start angle');
  const hpglEnd = validateFinite(geometry.endAngle, 'ARC end angle');
  const sweep = hpglEnd - hpglStart;
  if (sweep === 0) {
    throw new RangeError('ARC sweep must be non-zero');
  }
  if (Math.abs(sweep) >= 360) {
    throw new RangeError('ARC sweep magnitude must be less than 360 degrees');
  }
  const dxfStart = sweep > 0 ? hpglStart : hpglEnd;
  const dxfEnd = sweep > 0 ? hpglEnd : hpglStart;
  return [
    ...commonPairs('ARC', common),
    [10, center[0]], [20, center[1]], [30, 0], [40, radius],
    [50, normalizeAngle(dxfStart)], [51, normalizeAngle(dxfEnd)],
  ];
}

function textPairs(geometry, common) {
  const point = validatePoint(geometry.point, 'TEXT insertion');
  const height = validateFinite(geometry.height, 'TEXT height');
  if (height <= 0) {
    throw new RangeError('TEXT height must be positive');
  }
  const rotation = validateFinite(geometry.rotation, 'TEXT rotation');
  if (typeof geometry.text !== 'string') {
    throw new TypeError('TEXT value must be a string');
  }
  return [
    ...commonPairs('TEXT', common),
    [10, point[0]], [20, point[1]], [30, 0], [40, height],
    [1, escapeDxfText(geometry.text)], [50, rotation],
  ];
}

function geometryPairs(geometry) {
  if (geometry === null || typeof geometry !== 'object' || Array.isArray(geometry)) {
    throw new TypeError('Geometry must be an object');
  }
  if (!GEOMETRY_TYPES.has(geometry.type)) {
    throw new TypeError(`Unknown geometry type: ${String(geometry.type)}`);
  }
  const common = validateCommonGeometry(geometry);
  switch (geometry.type) {
    case 'line':
      return linePairs(geometry, common);
    case 'polyline':
      return polylinePairs(geometry, common);
    case 'circle':
      return circlePairs(geometry, common);
    case 'arc':
      return arcPairs(geometry, common);
    case 'text':
      return textPairs(geometry, common);
    default:
      throw new TypeError(`Unknown geometry type: ${String(geometry.type)}`);
  }
}

function uniqueLayers(layers) {
  const result = ['0'];
  const seen = new Set(result);
  for (const layer of layers) {
    if (typeof layer !== 'string') {
      throw new TypeError('Every layer must be a string');
    }
    if (!seen.has(layer)) {
      seen.add(layer);
      result.push(layer);
    }
  }
  return result;
}

function writeHeader(chunks) {
  pushSectionStart(chunks, 'HEADER');
  pushPairs(chunks, [
    [9, '$ACADVER'], [1, 'AC1015'],
    [9, '$INSUNITS'], [70, 4],
    [0, 'ENDSEC'],
  ]);
}

function writeTables(chunks, layers) {
  pushSectionStart(chunks, 'TABLES');
  pushPairs(chunks, [
    [0, 'TABLE'], [2, 'LTYPE'], [70, 1],
    [0, 'LTYPE'], [2, 'CONTINUOUS'], [70, 0], [3, 'Solid line'],
    [72, 65], [73, 0], [40, 0],
    [0, 'ENDTAB'],
    [0, 'TABLE'], [2, 'LAYER'], [70, layers.length],
  ]);
  for (const layer of layers) {
    pushPairs(chunks, [
      [0, 'LAYER'], [2, escapeDxfText(layer)], [70, 0],
      [62, 7], [6, 'CONTINUOUS'],
    ]);
  }
  pushPairs(chunks, [[0, 'ENDTAB'], [0, 'ENDSEC']]);
}

export function writeDxf(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('DXF input must be an object');
  }
  if (!Array.isArray(input.layers)) {
    throw new TypeError('DXF layers must be an array');
  }
  if (!Array.isArray(input.geometries)) {
    throw new TypeError('DXF geometries must be an array');
  }

  const layers = uniqueLayers(input.layers);
  const chunks = [];
  writeHeader(chunks);
  writeTables(chunks, layers);
  pushEmptySection(chunks, 'BLOCKS');
  pushSectionStart(chunks, 'ENTITIES');
  for (const geometry of input.geometries) {
    pushPairs(chunks, geometryPairs(geometry));
  }
  chunks.push(pair(0, 'ENDSEC'));
  pushEmptySection(chunks, 'OBJECTS');
  chunks.push(pair(0, 'EOF'));
  return chunks;
}
