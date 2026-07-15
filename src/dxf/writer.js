import { escapeDxfText } from './escape.js';
import { createHandleAllocator } from './handles.js';

const GEOMETRY_TYPES = new Set(['line', 'polyline', 'circle', 'arc', 'text']);
const ENTITY_SUBCLASSES = {
  LINE: ['AcDbLine'],
  LWPOLYLINE: ['AcDbPolyline'],
  CIRCLE: ['AcDbCircle'],
  ARC: ['AcDbCircle', 'AcDbArc'],
  TEXT: ['AcDbText'],
};
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
    modelBegin: allocator.next(),
    modelEnd: allocator.next(),
    paperBegin: allocator.next(),
    paperEnd: allocator.next(),
  };
  const objects = {
    rootDictionary: allocator.next(),
    acadGroup: allocator.next(),
    acadLayout: allocator.next(),
    modelLayout: allocator.next(),
    paperLayout: allocator.next(),
  };
  const entities = Array.from({ length: geometryCount }, () => allocator.next());
  return { tables, records, blocks, objects, entities, handseed: allocator.peek() };
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
  };
}

function commonPairs(type, common, handle, owner) {
  return [
    [0, type], [5, handle], [330, owner], [100, 'AcDbEntity'],
    [8, common.layer],
  ];
}

function linePairs(geometry, common, handle, owner) {
  if (!Array.isArray(geometry.points) || geometry.points.length !== 2) {
    throw new RangeError('LINE requires exactly 2 points');
  }
  const start = validatePoint(geometry.points[0], 'LINE start');
  const end = validatePoint(geometry.points[1], 'LINE end');
  return [
    ...commonPairs('LINE', common, handle, owner),
    [100, ENTITY_SUBCLASSES.LINE[0]],
    [10, start[0]], [20, start[1]], [30, 0],
    [11, end[0]], [21, end[1]], [31, 0],
  ];
}

function polylinePairs(geometry, common, handle, owner) {
  if (!Array.isArray(geometry.points) || geometry.points.length < 3) {
    throw new RangeError('LWPOLYLINE requires at least 3 points');
  }
  const points = geometry.points.map((point, index) => (
    validatePoint(point, `LWPOLYLINE point ${index}`)
  ));
  return [
    ...commonPairs('LWPOLYLINE', common, handle, owner),
    [100, ENTITY_SUBCLASSES.LWPOLYLINE[0]],
    [90, points.length],
    [70, 0],
    ...points.flatMap(point => [[10, point[0]], [20, point[1]]]),
  ];
}

function circlePairs(geometry, common, handle, owner) {
  const center = validatePoint(geometry.center, 'CIRCLE center');
  const radius = validateRadius(geometry.radius, 'CIRCLE');
  return [
    ...commonPairs('CIRCLE', common, handle, owner),
    [100, ENTITY_SUBCLASSES.CIRCLE[0]],
    [10, center[0]], [20, center[1]], [30, 0], [40, radius],
  ];
}

function arcPairs(geometry, common, handle, owner) {
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
    ...commonPairs('ARC', common, handle, owner),
    [100, ENTITY_SUBCLASSES.ARC[0]],
    [10, center[0]], [20, center[1]], [30, 0], [40, radius],
    [100, ENTITY_SUBCLASSES.ARC[1]],
    [50, normalizeAngle(dxfStart)], [51, normalizeAngle(dxfEnd)],
  ];
}

function textPairs(geometry, common, handle, owner) {
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
    ...commonPairs('TEXT', common, handle, owner),
    [100, ENTITY_SUBCLASSES.TEXT[0]],
    [10, point[0]], [20, point[1]], [30, 0], [40, height],
    [1, escapeDxfText(geometry.text)], [50, rotation],
    [100, ENTITY_SUBCLASSES.TEXT[0]],
  ];
}

function geometryPairs(geometry, handle, owner) {
  if (geometry === null || typeof geometry !== 'object' || Array.isArray(geometry)) {
    throw new TypeError('Geometry must be an object');
  }
  if (!GEOMETRY_TYPES.has(geometry.type)) {
    throw new TypeError(`Unknown geometry type: ${String(geometry.type)}`);
  }
  const common = validateCommonGeometry(geometry);
  switch (geometry.type) {
    case 'line':
      return linePairs(geometry, common, handle, owner);
    case 'polyline':
      return polylinePairs(geometry, common, handle, owner);
    case 'circle':
      return circlePairs(geometry, common, handle, owner);
    case 'arc':
      return arcPairs(geometry, common, handle, owner);
    case 'text':
      return textPairs(geometry, common, handle, owner);
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
    const escapedLayer = escapeDxfText(layer);
    if (!seen.has(escapedLayer)) {
      seen.add(escapedLayer);
      result.push(escapedLayer);
    }
  }
  return result;
}

function writeHeader(chunks, graph) {
  pushSectionStart(chunks, 'HEADER');
  pushPairs(chunks, [
    [9, '$ACADVER'], [1, 'AC1015'],
    [9, '$HANDSEED'], [5, graph.handseed],
    [9, '$INSUNITS'], [70, 4],
    [0, 'ENDSEC'],
  ]);
}

function writeTableStart(chunks, graph, name, size) {
  pushPairs(chunks, [
    [0, 'TABLE'], [2, name], [5, graph.tables[name]], [330, 0],
    [100, 'AcDbSymbolTable'], [70, size],
  ]);
  if (name === 'DIMSTYLE') {
    pushPairs(chunks, [[100, 'AcDbDimStyleTable'], [71, 0]]);
  }
}

function writeTableEnd(chunks) {
  chunks.push(pair(0, 'ENDTAB'));
}

function writeTableRecord(chunks, graph, tableName, type, handle, values) {
  const definition = TABLE_DEFINITIONS.find(([name]) => name === tableName);
  pushPairs(chunks, [
    [0, type], [5, handle], [330, graph.tables[tableName]],
    [100, 'AcDbSymbolTableRecord'], [100, definition[1]],
    ...values,
  ]);
}

function writeViewportTable(chunks, graph) {
  writeTableStart(chunks, graph, 'VPORT', 1);
  writeTableRecord(chunks, graph, 'VPORT', 'VPORT', graph.records.activeViewport, [
    [2, '*ACTIVE'], [70, 0],
    [10, 0], [20, 0], [11, 1], [21, 1],
    [12, 0], [22, 0], [13, 0], [23, 0],
    [14, 10], [24, 10], [15, 10], [25, 10],
    [16, 0], [26, 0], [36, 1],
    [17, 0], [27, 0], [37, 0],
    [40, 100], [41, 1], [42, 50], [43, 0], [44, 0],
    [50, 0], [51, 0], [71, 0], [72, 100],
    [73, 1], [74, 3], [75, 0], [76, 0], [77, 0], [78, 0],
  ]);
  writeTableEnd(chunks);
}

function writeLinetypeTable(chunks, graph) {
  writeTableStart(chunks, graph, 'LTYPE', 3);
  const linetypes = [
    [graph.records.byBlock, 'ByBlock', ''],
    [graph.records.byLayer, 'ByLayer', ''],
    [graph.records.continuous, 'CONTINUOUS', 'Solid line'],
  ];
  for (const [handle, name, description] of linetypes) {
    writeTableRecord(chunks, graph, 'LTYPE', 'LTYPE', handle, [
      [2, name], [70, 0], [3, description], [72, 65], [73, 0], [40, 0],
    ]);
  }
  writeTableEnd(chunks);
}

function writeLayerTable(chunks, layers, graph) {
  writeTableStart(chunks, graph, 'LAYER', layers.length);
  for (const layer of layers) {
    const index = layers.indexOf(layer);
    const handle = index === 0 ? graph.records.layer0 : graph.records.layers[index - 1];
    writeTableRecord(chunks, graph, 'LAYER', 'LAYER', handle, [
      [2, layer], [70, 0],
      [62, 7], [6, 'CONTINUOUS'],
    ]);
  }
  writeTableEnd(chunks);
}

function writeStyleTable(chunks, graph) {
  writeTableStart(chunks, graph, 'STYLE', 1);
  writeTableRecord(chunks, graph, 'STYLE', 'STYLE', graph.records.standardStyle, [
    [2, 'STANDARD'], [70, 0], [40, 0], [41, 1], [50, 0],
    [71, 0], [42, 2.5], [3, 'txt'], [4, ''],
  ]);
  writeTableEnd(chunks);
}

function writeEmptyTable(chunks, graph, name) {
  writeTableStart(chunks, graph, name, 0);
  writeTableEnd(chunks);
}

function writeAppIdTable(chunks, graph) {
  writeTableStart(chunks, graph, 'APPID', 1);
  writeTableRecord(chunks, graph, 'APPID', 'APPID', graph.records.acadApp, [
    [2, 'ACAD'], [70, 0],
  ]);
  writeTableEnd(chunks);
}

function writeBlockRecordTable(chunks, graph) {
  writeTableStart(chunks, graph, 'BLOCK_RECORD', 2);
  writeTableRecord(chunks, graph, 'BLOCK_RECORD', 'BLOCK_RECORD', graph.records.modelSpace, [
    [2, '*Model_Space'], [70, 0], [340, graph.objects.modelLayout],
  ]);
  writeTableRecord(chunks, graph, 'BLOCK_RECORD', 'BLOCK_RECORD', graph.records.paperSpace, [
    [2, '*Paper_Space'], [70, 0], [340, graph.objects.paperLayout],
  ]);
  writeTableEnd(chunks);
}

function writeTables(chunks, layers, graph) {
  pushSectionStart(chunks, 'TABLES');
  writeViewportTable(chunks, graph);
  writeLinetypeTable(chunks, graph);
  writeLayerTable(chunks, layers, graph);
  writeStyleTable(chunks, graph);
  writeEmptyTable(chunks, graph, 'VIEW');
  writeEmptyTable(chunks, graph, 'UCS');
  writeAppIdTable(chunks, graph);
  writeEmptyTable(chunks, graph, 'DIMSTYLE');
  writeBlockRecordTable(chunks, graph);
  chunks.push(pair(0, 'ENDSEC'));
}

function writeBlock(chunks, name, owner, beginHandle, endHandle) {
  pushPairs(chunks, [
    [0, 'BLOCK'], [5, beginHandle], [330, owner],
    [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockBegin'],
    [2, name], [70, 0], [10, 0], [20, 0], [30, 0], [3, name], [1, ''],
    [0, 'ENDBLK'], [5, endHandle], [330, owner],
    [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockEnd'],
  ]);
}

function writeBlocks(chunks, graph) {
  pushSectionStart(chunks, 'BLOCKS');
  writeBlock(
    chunks, '*Model_Space', graph.records.modelSpace,
    graph.blocks.modelBegin, graph.blocks.modelEnd,
  );
  writeBlock(
    chunks, '*Paper_Space', graph.records.paperSpace,
    graph.blocks.paperBegin, graph.blocks.paperEnd,
  );
  chunks.push(pair(0, 'ENDSEC'));
}

function writeObjects(chunks, graph) {
  pushSectionStart(chunks, 'OBJECTS');
  pushPairs(chunks, [
    [0, 'DICTIONARY'], [5, graph.objects.rootDictionary], [330, 0],
    [100, 'AcDbDictionary'], [280, 0], [281, 1],
    [3, 'ACAD_GROUP'], [350, graph.objects.acadGroup],
    [3, 'ACAD_LAYOUT'], [350, graph.objects.acadLayout],
    [0, 'DICTIONARY'], [5, graph.objects.acadGroup],
    [330, graph.objects.rootDictionary], [100, 'AcDbDictionary'],
    [280, 0], [281, 1],
    [0, 'DICTIONARY'], [5, graph.objects.acadLayout],
    [330, graph.objects.rootDictionary], [100, 'AcDbDictionary'],
    [280, 0], [281, 1],
    [3, 'Model'], [350, graph.objects.modelLayout],
    [3, 'Layout1'], [350, graph.objects.paperLayout],
  ]);
  writeLayout(
    chunks, graph.objects.modelLayout, graph.objects.acadLayout,
    'Model', 0, 1024, graph.records.modelSpace,
  );
  writeLayout(
    chunks, graph.objects.paperLayout, graph.objects.acadLayout,
    'Layout1', 1, 0, graph.records.paperSpace,
  );
  pushPairs(chunks, [
    [0, 'ENDSEC'],
  ]);
}

function writeLayout(chunks, handle, owner, name, tabOrder, plotFlags, blockRecord) {
  pushPairs(chunks, [
    [0, 'LAYOUT'], [5, handle], [330, owner],
    [100, 'AcDbPlotSettings'],
    [1, ''], [4, 'A3'], [6, ''],
    [40, 7.5], [41, 20], [42, 7.5], [43, 20],
    [44, 420], [45, 297],
    [46, 0], [47, 0], [48, 0], [49, 0],
    [140, 0], [141, 0], [142, 1], [143, 1],
    [70, plotFlags], [72, 1], [73, 0], [74, 5], [7, ''],
    [75, 16], [76, 0], [77, 2], [78, 300],
    [147, 1], [148, 0], [149, 0],
    [100, 'AcDbLayout'],
    [1, name], [70, 1], [71, tabOrder],
    [10, 0], [20, 0], [11, 420], [21, 297],
    [12, 0], [22, 0], [32, 0],
    [14, 1e20], [24, 1e20], [34, 1e20],
    [15, -1e20], [25, -1e20], [35, -1e20],
    [146, 0], [13, 0], [23, 0], [33, 0],
    [16, 1], [26, 0], [36, 0],
    [17, 0], [27, 1], [37, 0],
    [76, 1], [330, blockRecord],
  ]);
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
  const graph = allocateDocumentGraph(layers, input.geometries.length);
  const chunks = [];
  writeHeader(chunks, graph);
  pushEmptySection(chunks, 'CLASSES');
  writeTables(chunks, layers, graph);
  writeBlocks(chunks, graph);
  pushSectionStart(chunks, 'ENTITIES');
  for (const [index, geometry] of input.geometries.entries()) {
    pushPairs(chunks, geometryPairs(
      geometry, graph.entities[index], graph.records.modelSpace,
    ));
  }
  chunks.push(pair(0, 'ENDSEC'));
  writeObjects(chunks, graph);
  chunks.push(pair(0, 'EOF'));
  return chunks;
}
