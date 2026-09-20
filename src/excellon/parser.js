import {
  inflatePaths,
  EndType,
  JoinType,
} from 'clipper2-ts';

const INCH_TO_MM = 25.4;
const SCALE = 1_000_000;
const CHORD_TOLERANCE_MM = 0.01;
const DIAGNOSTIC_DETAIL_LIMIT = 100;
const END_CODES = new Set([0, 2, 30]);

function decode(data) {
  if (typeof data === 'string') {
    return data;
  }
  return new TextDecoder().decode(data);
}

function padTool(number) {
  return `T${String(number).padStart(2, '0')}`;
}

function unknownLayer(layerName, toolNumber) {
  return `${layerName}_UNKNOWN_${padTool(toolNumber)}`;
}

function toInt(value, label = 'Excellon coordinate') {
  const scaled = Math.round(value * SCALE);
  if (!Number.isSafeInteger(scaled)) {
    throw new RangeError(`${label} exceeds the integer conversion range`);
  }
  return scaled;
}

function fromInt(value) {
  return value / SCALE;
}

function clipperToPoints(path) {
  const points = path.map(point => [fromInt(point.x), fromInt(point.y)]);
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      points.pop();
    }
  }
  return points;
}

function parseCoordinateBody(text, integerDigits, fractionDigits, zeroSuppression) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new RangeError('Coordinate value is missing');
  }

  let sign = 1;
  let body = text;
  if (body[0] === '+' || body[0] === '-') {
    sign = body[0] === '-' ? -1 : 1;
    body = body.slice(1);
  }
  if (body.length === 0) {
    throw new RangeError('Coordinate value is missing');
  }

  if (body.includes('.')) {
    const value = Number(body);
    if (!Number.isFinite(value)) {
      throw new RangeError('Coordinate value is invalid');
    }
    return sign * value;
  }

  if (!/^\d+$/.test(body)) {
    throw new RangeError('Coordinate value is invalid');
  }

  if (integerDigits == null || fractionDigits == null || zeroSuppression == null) {
    const error = new RangeError('Excellon units or coordinate format cannot be determined');
    error.fileLevel = true;
    throw error;
  }

  const width = integerDigits + fractionDigits;
  if (width === 0) {
    throw new RangeError('Coordinate format width must be positive');
  }
  if (body.length > width) {
    throw new RangeError('Coordinate value exceeds the digit width');
  }

  const padded = zeroSuppression === 'L'
    ? body.padStart(width, '0')
    : body.padEnd(width, '0');
  const value = Number(`${padded.slice(0, integerDigits) || '0'}.${padded.slice(integerDigits)}`);
  if (!Number.isFinite(value)) {
    throw new RangeError('Coordinate value is invalid');
  }
  return sign * value;
}

function stripComment(line) {
  let text = line;
  const semicolon = text.indexOf(';');
  if (semicolon >= 0) {
    text = text.slice(0, semicolon);
  }
  return text.replace(/\([^)]*\)/g, '');
}

function applyUnitsCommand(raw, state) {
  const upper = raw.toUpperCase().replace(/\s+/g, '');
  let rest = '';
  if (upper.startsWith('METRIC')) {
    state.units = 'mm';
    rest = upper.slice(6);
  } else if (upper.startsWith('INCH')) {
    state.units = 'inch';
    rest = upper.slice(4);
  } else {
    return false;
  }
  if (rest.startsWith(',')) {
    rest = rest.slice(1);
  }
  for (const part of rest.split(',').filter(Boolean)) {
    if (part === 'TZ') {
      state.zeroSuppression = 'T';
    } else if (part === 'LZ') {
      state.zeroSuppression = 'L';
    } else if (/^0+\.0+$/.test(part)) {
      const [integerPart, fractionPart] = part.split('.');
      state.integerDigits = integerPart.length;
      state.fractionDigits = fractionPart.length;
    }
  }
  return true;
}

function offsetSlot(points, radiusMm) {
  if (!(radiusMm > 0) || points.length < 2) {
    return [];
  }
  const paths = inflatePaths(
    [points.map(point => ({ x: toInt(point[0]), y: toInt(point[1]) }))],
    radiusMm * SCALE,
    JoinType.Round,
    EndType.Round,
    2,
    CHORD_TOLERANCE_MM * SCALE,
  );
  return paths
    .map(clipperToPoints)
    .filter(path => path.length >= 3);
}

export function parseExcellon(data, context, options = {}) {
  const defaults = options.defaults ?? null;
  const marker = options.unknownToolMarkerMm ?? 1;
  const fileName = context.fileName;
  const layerName = context.layerName;
  const halfMarker = marker / 2;

  const tools = new Map();
  const state = {
    units: null,
    integerDigits: null,
    fractionDigits: null,
    zeroSuppression: null,
  };

  if (defaults) {
    if (defaults.units != null) {
      state.units = defaults.units;
    }
    if (defaults.integerDigits != null) {
      state.integerDigits = defaults.integerDigits;
    }
    if (defaults.fractionDigits != null) {
      state.fractionDigits = defaults.fractionDigits;
    }
    if (defaults.zeroSuppression != null) {
      state.zeroSuppression = defaults.zeroSuppression;
    }
    if (defaults.tools instanceof Map) {
      for (const [number, diameter] of defaults.tools) {
        tools.set(number, diameter);
      }
    }
  }

  const diagnostics = [];
  const geometries = [];
  let errorCount = 0;
  let warningCount = 0;
  let fatal = false;
  let ended = false;
  let currentTool = null;
  let incremental = false;
  let rapid = false;
  let lastX = 0;
  let lastY = 0;
  let hasPosition = false;
  let pendingHole = null;
  let g85Start = null;
  let routing = false;
  let routingPath = [];
  let routingOffset = 0;

  function addDiagnostic(item) {
    if (item.severity === 'error') {
      errorCount += 1;
    } else {
      warningCount += 1;
    }
    if (diagnostics.length < DIAGNOSTIC_DETAIL_LIMIT) {
      diagnostics.push(item);
      diagnostics.sort((first, second) => first.offset - second.offset);
    } else if (item.offset < diagnostics[diagnostics.length - 1].offset) {
      diagnostics.push(item);
      diagnostics.sort((first, second) => first.offset - second.offset);
      diagnostics.pop();
    }
  }

  function metadata(offset, layer = layerName) {
    return { layer, fileName, offset };
  }

  function toMm(value) {
    const mm = state.units === 'inch' ? value * INCH_TO_MM : value;
    if (!Number.isFinite(mm)) {
      throw new RangeError('Millimetre coordinate must be finite');
    }
    return mm;
  }

  function fileLevelError(offset, command, message) {
    fatal = true;
    geometries.length = 0;
    pendingHole = null;
    g85Start = null;
    routing = false;
    routingPath = [];
    addDiagnostic({
      severity: 'error',
      fileName,
      command,
      offset,
      message,
      skippedCommands: 1,
      skippedShapes: 0,
    });
  }

  function resolvePoint(xText, yText, offset) {
    if (state.units == null) {
      const error = new RangeError('Excellon units or coordinate format cannot be determined');
      error.fileLevel = true;
      throw error;
    }
    let x = lastX;
    let y = lastY;
    if (xText !== undefined) {
      const value = parseCoordinateBody(
        xText,
        state.integerDigits,
        state.fractionDigits,
        state.zeroSuppression,
      );
      const mm = toMm(value);
      x = incremental ? lastX + mm : mm;
    }
    if (yText !== undefined) {
      const value = parseCoordinateBody(
        yText,
        state.integerDigits,
        state.fractionDigits,
        state.zeroSuppression,
      );
      const mm = toMm(value);
      y = incremental ? lastY + mm : mm;
    }
    lastX = x;
    lastY = y;
    hasPosition = true;
    return { point: [x, y], offset };
  }

  function isRawTool(stored) {
    return stored != null && typeof stored === 'object' && 'raw' in stored;
  }

  function reconvertRawTools() {
    if (state.units == null) {
      return;
    }
    for (const [number, stored] of tools) {
      if (isRawTool(stored)) {
        tools.set(number, toMm(stored.raw));
      }
    }
  }

  function currentDiameter() {
    if (currentTool == null) {
      return null;
    }
    const stored = tools.get(currentTool);
    let diameter = null;
    if (typeof stored === 'number') {
      diameter = stored;
    } else if (isRawTool(stored) && state.units != null) {
      diameter = toMm(stored.raw);
    }
    return typeof diameter === 'number' && diameter > 0 ? diameter : null;
  }

  function warnUnknown(offset) {
    const toolNumber = currentTool ?? 0;
    addDiagnostic({
      severity: 'warning',
      fileName,
      command: padTool(toolNumber),
      offset,
      message: `Tool ${padTool(toolNumber)} diameter is unknown`,
      skippedCommands: 0,
      skippedShapes: 0,
    });
  }

  function emitCross(point, offset) {
    const toolNumber = currentTool ?? 0;
    const layer = unknownLayer(layerName, toolNumber);
    warnUnknown(offset);
    geometries.push({
      type: 'line',
      points: [[point[0] - halfMarker, point[1]], [point[0] + halfMarker, point[1]]],
      ...metadata(offset, layer),
    });
    geometries.push({
      type: 'line',
      points: [[point[0], point[1] - halfMarker], [point[0], point[1] + halfMarker]],
      ...metadata(offset, layer),
    });
  }

  function emitHole(point, offset) {
    const diameter = currentDiameter();
    if (diameter == null) {
      emitCross(point, offset);
      return;
    }
    geometries.push({
      type: 'circle',
      center: [...point],
      radius: diameter / 2,
      ...metadata(offset),
    });
  }

  function emitKnownSlot(points, offset) {
    const diameter = currentDiameter();
    const outlines = offsetSlot(points, diameter / 2);
    for (const path of outlines) {
      geometries.push({
        type: 'polyline',
        points: path,
        closed: true,
        ...metadata(offset),
      });
    }
  }

  function emitUnknownSlot(points, offset) {
    const toolNumber = currentTool ?? 0;
    const layer = unknownLayer(layerName, toolNumber);
    warnUnknown(offset);
    for (let index = 1; index < points.length; index += 1) {
      geometries.push({
        type: 'line',
        points: [points[index - 1], points[index]],
        ...metadata(offset, layer),
      });
    }
  }

  function emitSlot(points, offset) {
    if (points.length < 2) {
      if (points.length === 1) {
        emitHole(points[0], offset);
      }
      return;
    }
    if (currentDiameter() == null) {
      emitUnknownSlot(points, offset);
      return;
    }
    emitKnownSlot(points, offset);
  }

  function flushHole() {
    if (pendingHole) {
      emitHole(pendingHole.point, pendingHole.offset);
      pendingHole = null;
    }
  }

  function applyPoint(point, offset) {
    if (g85Start) {
      emitSlot([g85Start.point, point], g85Start.offset);
      g85Start = null;
      rapid = false;
      return;
    }
    if (routing) {
      routingPath.push(point);
      return;
    }
    if (rapid) {
      flushHole();
      pendingHole = null;
      rapid = false;
      return;
    }
    flushHole();
    pendingHole = { point, offset };
  }

  function beginG85(offset) {
    const start = pendingHole ?? (hasPosition ? { point: [lastX, lastY], offset } : null);
    pendingHole = null;
    g85Start = start ?? { point: [lastX, lastY], offset };
  }

  function beginRoute(offset) {
    routing = true;
    routingOffset = offset;
    routingPath = [];
    if (pendingHole) {
      routingPath.push(pendingHole.point);
      pendingHole = null;
    } else if (hasPosition) {
      routingPath.push([lastX, lastY]);
    }
  }

  function endRoute() {
    if (!routing) {
      return;
    }
    emitSlot(routingPath, routingOffset);
    routing = false;
    routingPath = [];
  }

  function defineTool(number, diameter) {
    tools.set(number, { raw: diameter });
  }

  function selectTool(number) {
    currentTool = number;
  }

  function takeDigits(raw, index) {
    const start = index.value;
    while (index.value < raw.length && raw[index.value] >= '0' && raw[index.value] <= '9') {
      index.value += 1;
    }
    return raw.slice(start, index.value);
  }

  function takeNumber(raw, index) {
    const start = index.value;
    if (raw[index.value] === '+' || raw[index.value] === '-') {
      index.value += 1;
    }
    while (
      index.value < raw.length
      && ((raw[index.value] >= '0' && raw[index.value] <= '9') || raw[index.value] === '.')
    ) {
      index.value += 1;
    }
    return raw.slice(start, index.value);
  }

  function processLine(line, lineOffset) {
    const stripped = stripComment(line).replace(/\s+/g, '').toUpperCase();
    if (!stripped || fatal || ended) {
      return;
    }
    if (applyUnitsCommand(stripped, state)) {
      reconvertRawTools();
      return;
    }
    if (stripped.startsWith('FMAT')) {
      return;
    }

    const index = { value: 0 };
    let xText;
    let yText;

    const commitXY = () => {
      if (xText === undefined && yText === undefined) {
        return;
      }
      try {
        const resolved = resolvePoint(xText, yText, lineOffset);
        applyPoint(resolved.point, resolved.offset);
      } catch (error) {
        if (error?.fileLevel) {
          fileLevelError(
            lineOffset,
            xText !== undefined ? 'X' : 'Y',
            error.message,
          );
        } else {
          addDiagnostic({
            severity: 'error',
            fileName,
            command: xText !== undefined ? 'X' : 'Y',
            offset: lineOffset,
            message: error instanceof Error ? error.message : 'Invalid Excellon coordinate',
            skippedCommands: 1,
            skippedShapes: 1,
          });
        }
      }
      xText = undefined;
      yText = undefined;
    };

    while (index.value < stripped.length && !fatal && !ended) {
      const letter = stripped[index.value];
      index.value += 1;

      if (letter === '%') {
        continue;
      }

      if (letter === 'X') {
        xText = takeNumber(stripped, index);
        continue;
      }
      if (letter === 'Y') {
        yText = takeNumber(stripped, index);
        continue;
      }

      if (letter === 'T') {
        const digits = takeDigits(stripped, index);
        if (!digits) {
          continue;
        }
        commitXY();
        if (fatal) {
          return;
        }
        flushHole();
        const number = Number(digits);
        if (stripped[index.value] === 'C') {
          index.value += 1;
          const diameterText = takeNumber(stripped, index);
          const diameter = Number(diameterText);
          if (Number.isFinite(diameter)) {
            defineTool(number, diameter);
          }
        }
        selectTool(number);
        continue;
      }

      if (letter === 'G') {
        const digits = takeDigits(stripped, index);
        if (!digits) {
          continue;
        }
        const code = Number(digits);
        if (code === 85) {
          commitXY();
          if (fatal) {
            return;
          }
          beginG85(lineOffset);
        } else if (code === 90) {
          incremental = false;
        } else if (code === 91) {
          incremental = true;
        } else if (code === 0 || code === 80) {
          commitXY();
          flushHole();
          rapid = true;
        } else if (code === 5 || code === 81) {
          rapid = false;
        }
        continue;
      }

      if (letter === 'M') {
        const digits = takeDigits(stripped, index);
        if (!digits) {
          continue;
        }
        const code = Number(digits);
        if (code === 71) {
          state.units = 'mm';
          reconvertRawTools();
        } else if (code === 72) {
          state.units = 'inch';
          reconvertRawTools();
        } else if (code === 15) {
          commitXY();
          if (fatal) {
            return;
          }
          beginRoute(lineOffset);
        } else if (code === 16) {
          commitXY();
          if (fatal) {
            return;
          }
          endRoute();
        } else if (END_CODES.has(code)) {
          commitXY();
          if (fatal) {
            return;
          }
          endRoute();
          flushHole();
          ended = true;
        }
      }
    }

    commitXY();
  }

  const text = decode(data);
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (fatal || ended) {
      break;
    }
    if (index !== text.length && text[index] !== '\n') {
      continue;
    }
    let line = text.slice(start, index);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    processLine(line, start);
    start = index + 1;
  }

  if (!fatal) {
    endRoute();
    flushHole();
  }

  return {
    geometries,
    diagnostics,
    summary: {
      geometryCount: geometries.length,
      errorCount,
      warningCount,
    },
  };
}
