import { parseGerber, parseGerberObjects } from '../gerber/index.js';
import { parseDrillList, parseGerberList } from './sidecars.js';

const INVALID_LAYER_CHARS = /[<>/\\":;?*|=,]/g;

const INCH_TO_MM = 25.4;
const BOUNDS_PAD_MM = 2;
const SPAN_MIN_RATIO = 0.25;
const SPAN_MAX_RATIO = 1.05;
const FORMAT_CANDIDATES = [
  { integerDigits: 2, fractionDigits: 4 },
  { integerDigits: 3, fractionDigits: 3 },
  { integerDigits: 3, fractionDigits: 4 },
  { integerDigits: 4, fractionDigits: 2 },
  { integerDigits: 4, fractionDigits: 3 },
];
const UNIT_CANDIDATES = ['mm', 'inch'];

function decode(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (data == null) {
    return '';
  }
  return new TextDecoder().decode(data);
}

function leafName(input) {
  const value = String(input.path || input.name || '');
  return value.split(/[\\/]/).pop() ?? '';
}

function dirName(input) {
  const value = String(input.path || input.name || '');
  const parts = value.split(/[\\/]/);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function namesEqual(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function defaultLayerName(input) {
  const leaf = leafName(input);
  const base = input.kind === 'hpgl'
    ? (leaf.replace(/\.[^.]+$/, '') || 'layer')
    : (leaf.replace(/\./g, '_') || 'layer');
  return base.replace(INVALID_LAYER_CHARS, '_') || 'layer';
}

function composeLayerName(parts) {
  return parts.filter(Boolean).join('_').replace(/[^A-Za-z0-9_-]+/g, '_') || 'layer';
}

function shortLayerCode(input) {
  const leaf = leafName(input);
  const dot = leaf.lastIndexOf('.');
  return dot >= 0 ? leaf.slice(dot + 1) : leaf;
}

function fileFunctionValues(attributes) {
  const file = attributes?.file;
  if (!file) {
    return null;
  }
  const values = file['.FileFunction'] ?? file.FileFunction;
  return Array.isArray(values) && values.length > 0 ? values : null;
}

function applyFileFunctionLayerName(drawable) {
  if (drawable.kind !== 'gerber') {
    return;
  }
  if (drawable.effectiveLayerName !== defaultLayerName(drawable)) {
    return;
  }
  try {
    const parsed = parseGerberObjects(drawable.data, {
      fileName: leafName(drawable),
      layerName: drawable.effectiveLayerName,
    });
    const values = fileFunctionValues(parsed.attributes);
    if (!values) {
      return;
    }
    drawable.effectiveLayerName = composeLayerName([shortLayerCode(drawable), ...values]);
  } catch {
    // Keep the default name when Gerber attributes cannot be read.
  }
}

function diagnostic(severity, fileName, command, message) {
  return {
    severity,
    fileName,
    command,
    offset: 0,
    message,
    skippedCommands: 0,
    skippedShapes: 0,
  };
}

function cloneDefaults(defaults) {
  return {
    units: defaults.units,
    integerDigits: defaults.integerDigits,
    fractionDigits: defaults.fractionDigits,
    zeroSuppression: defaults.zeroSuppression,
    tools: new Map(defaults.tools ?? []),
  };
}

function applyDefaults(drawable, defaults) {
  const current = drawable.parseOptions.defaults;
  const next = cloneDefaults(defaults);
  if (current?.tools instanceof Map && current.tools.size > 0 && next.tools.size === 0) {
    next.tools = new Map(current.tools);
  }
  if (current) {
    if (next.units == null) {
      next.units = current.units;
    }
    if (next.integerDigits == null) {
      next.integerDigits = current.integerDigits;
    }
    if (next.fractionDigits == null) {
      next.fractionDigits = current.fractionDigits;
    }
    if (next.zeroSuppression == null) {
      next.zeroSuppression = current.zeroSuppression;
    }
  }
  if (
    next.units != null
    && next.integerDigits != null
    && next.fractionDigits != null
    && next.zeroSuppression == null
  ) {
    next.zeroSuppression = 'L';
  }
  drawable.parseOptions = { defaults: next };
}

function findByRecordedName(sidecarInput, recordedName, kind, drawables) {
  if (!recordedName) {
    return { target: null };
  }
  const matches = drawables.filter(item => (
    item.kind === kind && namesEqual(leafName(item), recordedName)
  ));
  if (matches.length === 1) {
    return { target: matches[0] };
  }
  if (matches.length > 1) {
    const sameDir = matches.filter(item => dirName(item) === dirName(sidecarInput));
    if (sameDir.length === 1) {
      return { target: sameDir[0] };
    }
    return { ambiguous: true };
  }
  return { target: null };
}

function associateExcellon(sidecarInput, parsed, drawables, diagnostics) {
  const named = findByRecordedName(sidecarInput, parsed.fileName, 'excellon', drawables);
  if (named.ambiguous) {
    diagnostics.push(diagnostic(
      'warning',
      leafName(sidecarInput),
      'DRLIST',
      'Drill list matched multiple files and was not applied',
    ));
    return;
  }
  if (named.target) {
    applyDefaults(named.target, parsed.defaults);
    return;
  }

  const candidates = drawables.filter(item => item.kind === 'excellon');
  if (parsed.boardName) {
    const prefix = parsed.boardName.toLowerCase();
    const byBoard = candidates.filter(item => (
      dirName(item) === dirName(sidecarInput)
      && leafName(item).toLowerCase().startsWith(prefix)
    ));
    if (byBoard.length === 1) {
      applyDefaults(byBoard[0], parsed.defaults);
      return;
    }
    if (byBoard.length > 1) {
      diagnostics.push(diagnostic(
        'warning',
        leafName(sidecarInput),
        'DRLIST',
        'Drill list matched multiple files and was not applied',
      ));
      return;
    }
  }

  const group = candidates.filter(item => dirName(item) === dirName(sidecarInput));
  if (group.length === 1) {
    applyDefaults(group[0], parsed.defaults);
    return;
  }
  if (group.length > 1) {
    diagnostics.push(diagnostic(
      'warning',
      leafName(sidecarInput),
      'DRLIST',
      'Drill list matched multiple files and was not applied',
    ));
  }
}

function associateGerber(sidecarInput, parsed, drawables, diagnostics) {
  for (const [listedName, label] of parsed.layers) {
    const named = findByRecordedName(sidecarInput, listedName, 'gerber', drawables);
    if (named.ambiguous) {
      diagnostics.push(diagnostic(
        'warning',
        leafName(sidecarInput),
        'GBLIST',
        `Gerber list entry ${listedName} matched multiple files and was not applied`,
      ));
      continue;
    }
    if (named.target) {
      named.target.effectiveLayerName = label;
    }
  }
}

function includePoint(bounds, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return bounds;
  }
  if (bounds == null) {
    return { minX: x, minY: y, maxX: x, maxY: y };
  }
  return {
    minX: Math.min(bounds.minX, x),
    minY: Math.min(bounds.minY, y),
    maxX: Math.max(bounds.maxX, x),
    maxY: Math.max(bounds.maxY, y),
  };
}

function extendGeometry(bounds, geometry) {
  if (geometry.type === 'line' || geometry.type === 'polyline') {
    for (const point of geometry.points ?? []) {
      bounds = includePoint(bounds, point[0], point[1]);
    }
    if (geometry.x1 != null) {
      bounds = includePoint(bounds, geometry.x1, geometry.y1);
      bounds = includePoint(bounds, geometry.x2, geometry.y2);
    }
    return bounds;
  }
  if (geometry.type === 'circle' || geometry.type === 'arc') {
    const cx = geometry.center?.[0] ?? geometry.cx;
    const cy = geometry.center?.[1] ?? geometry.cy;
    const radius = geometry.radius ?? 0;
    bounds = includePoint(bounds, cx - radius, cy - radius);
    bounds = includePoint(bounds, cx + radius, cy + radius);
  }
  return bounds;
}

function gerberBoundsForGroup(drawables, groupDir) {
  let bounds = null;
  for (const input of drawables) {
    if (input.kind !== 'gerber' || dirName(input) !== groupDir) {
      continue;
    }
    try {
      const parsed = parseGerber(input.data, {
        fileName: leafName(input),
        layerName: input.effectiveLayerName,
      });
      if (!parsed.geometries?.length) {
        continue;
      }
      for (const geometry of parsed.geometries) {
        bounds = extendGeometry(bounds, geometry);
      }
    } catch {
      // Ignore failed Gerber files when computing drill bounds.
    }
  }
  return bounds;
}

function stripComment(line) {
  let text = line;
  const semicolon = text.indexOf(';');
  if (semicolon >= 0) {
    text = text.slice(0, semicolon);
  }
  return text.replace(/\([^)]*\)/g, '');
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

function takeDigits(raw, index) {
  const start = index.value;
  while (index.value < raw.length && raw[index.value] >= '0' && raw[index.value] <= '9') {
    index.value += 1;
  }
  return raw.slice(start, index.value);
}

function inspectExcellon(text) {
  const points = [];
  let units = null;
  let integerDigits = null;
  let fractionDigits = null;
  let lastX;
  let lastY;

  for (const line of text.split(/\r?\n/)) {
    const stripped = stripComment(line).replace(/\s+/g, '').toUpperCase();
    if (!stripped) {
      continue;
    }
    const isUnitHeader = stripped.startsWith('METRIC') || stripped.startsWith('M71');
    const isInchHeader = stripped.startsWith('INCH') || stripped.startsWith('M72');
    const isFormatHeader = isUnitHeader || isInchHeader
      || stripped.startsWith('FMAT') || stripped.includes('FORMAT');
    if (isUnitHeader) {
      units = 'mm';
    } else if (isInchHeader) {
      units = 'inch';
    }
    if (isFormatHeader) {
      const format = stripped.match(/0+\.0+/);
      if (format) {
        const [integerPart, fractionPart] = format[0].split('.');
        integerDigits = integerPart.length;
        fractionDigits = fractionPart.length;
      }
    }

    const index = { value: 0 };
    let xText;
    let yText;
    while (index.value < stripped.length) {
      const letter = stripped[index.value];
      index.value += 1;
      if (letter === 'X') {
        xText = takeNumber(stripped, index);
        continue;
      }
      if (letter === 'Y') {
        yText = takeNumber(stripped, index);
        continue;
      }
      if (letter === 'T' || letter === 'M' || letter === 'G') {
        takeDigits(stripped, index);
        if (stripped[index.value] === 'C') {
          index.value += 1;
          takeNumber(stripped, index);
        }
        continue;
      }
    }
    if (xText !== undefined) {
      lastX = xText;
    }
    if (yText !== undefined) {
      lastY = yText;
    }
    if (xText !== undefined || yText !== undefined) {
      if (lastX !== undefined && lastY !== undefined) {
        points.push({ x: lastX, y: lastY });
      }
    }
  }

  return { points, units, integerDigits, fractionDigits };
}

function convertBody(text, integerDigits, fractionDigits, units) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  let sign = 1;
  let body = text;
  if (body[0] === '+' || body[0] === '-') {
    sign = body[0] === '-' ? -1 : 1;
    body = body.slice(1);
  }
  if (body.length === 0) {
    return null;
  }
  let value;
  if (body.includes('.')) {
    value = Number(body);
  } else {
    const width = integerDigits + fractionDigits;
    if (width <= 0 || body.length > width || !/^\d+$/.test(body)) {
      return null;
    }
    const padded = body.padStart(width, '0');
    value = Number(`${padded.slice(0, integerDigits) || '0'}.${padded.slice(integerDigits)}`);
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  value *= sign;
  return units === 'inch' ? value * INCH_TO_MM : value;
}

function candidateFits(pointsMm, bounds) {
  if (bounds == null || pointsMm.length === 0) {
    return false;
  }
  const expanded = {
    minX: bounds.minX - BOUNDS_PAD_MM,
    minY: bounds.minY - BOUNDS_PAD_MM,
    maxX: bounds.maxX + BOUNDS_PAD_MM,
    maxY: bounds.maxY + BOUNDS_PAD_MM,
  };
  for (const [x, y] of pointsMm) {
    if (x < expanded.minX || x > expanded.maxX || y < expanded.minY || y > expanded.maxY) {
      return false;
    }
  }
  const xs = pointsMm.map(point => point[0]);
  const ys = pointsMm.map(point => point[1]);
  const drillSpanX = Math.max(...xs) - Math.min(...xs);
  const drillSpanY = Math.max(...ys) - Math.min(...ys);
  const gerberSpanX = bounds.maxX - bounds.minX;
  const gerberSpanY = bounds.maxY - bounds.minY;
  if (drillSpanX > 0) {
    const ratio = drillSpanX / gerberSpanX;
    if (!(ratio >= SPAN_MIN_RATIO && ratio <= SPAN_MAX_RATIO)) {
      return false;
    }
  }
  if (drillSpanY > 0) {
    const ratio = drillSpanY / gerberSpanY;
    if (!(ratio >= SPAN_MIN_RATIO && ratio <= SPAN_MAX_RATIO)) {
      return false;
    }
  }
  return true;
}

function isDrillFormatDetermined(defaults, inspected) {
  const hasUnits = defaults?.units != null || inspected.units != null;
  const hasDigits = (
    (defaults?.integerDigits != null && defaults?.fractionDigits != null)
    || (inspected.integerDigits != null && inspected.fractionDigits != null)
  );
  if (hasUnits && hasDigits) {
    return true;
  }
  if (hasUnits && inspected.points.length === 0) {
    return true;
  }
  if (hasUnits && inspected.points.every(token => token.x.includes('.') && token.y.includes('.'))) {
    return true;
  }
  return false;
}

function inferDrillFormat(drawable, bounds, diagnostics) {
  const defaults = drawable.parseOptions.defaults ?? {};
  const inspected = inspectExcellon(decode(drawable.data));
  if (isDrillFormatDetermined(defaults, inspected)) {
    return;
  }

  const hasUnits = defaults.units != null || inspected.units != null;
  const hasDigits = (
    (defaults.integerDigits != null && defaults.fractionDigits != null)
    || (inspected.integerDigits != null && inspected.fractionDigits != null)
  );
  const unitsList = hasUnits ? [defaults.units ?? inspected.units] : UNIT_CANDIDATES;
  const formats = hasDigits
    ? [{
      integerDigits: defaults.integerDigits ?? inspected.integerDigits,
      fractionDigits: defaults.fractionDigits ?? inspected.fractionDigits,
    }]
    : FORMAT_CANDIDATES;

  const survivors = [];
  for (const units of unitsList) {
    for (const format of formats) {
      const pointsMm = [];
      let valid = true;
      for (const token of inspected.points) {
        const x = convertBody(token.x, format.integerDigits, format.fractionDigits, units);
        const y = convertBody(token.y, format.integerDigits, format.fractionDigits, units);
        if (x == null || y == null) {
          valid = false;
          break;
        }
        pointsMm.push([x, y]);
      }
      if (!valid || !candidateFits(pointsMm, bounds)) {
        continue;
      }
      survivors.push({ units, ...format, zeroSuppression: 'L' });
    }
  }

  if (survivors.length === 1) {
    applyDefaults(drawable, {
      ...defaults,
      ...survivors[0],
      tools: defaults.tools ?? new Map(),
    });
    diagnostics.push(diagnostic(
      'warning',
      leafName(drawable),
      'DRILL_FORMAT',
      `Guessed Excellon format ${survivors[0].units} ${survivors[0].integerDigits}.${survivors[0].fractionDigits} with leading-zero suppression`,
    ));
    return;
  }

  diagnostics.push(diagnostic(
    'error',
    leafName(drawable),
    'DRILL_FORMAT_AMBIGUOUS',
    'Excellon units or coordinate format cannot be determined',
  ));
}

export function prepareInputSet(inputs = [], _options = {}) {
  const diagnostics = [];
  const auxiliaryFiles = [];
  const drawableInputs = [];
  const drillLists = [];
  const gerberLists = [];

  for (const input of inputs) {
    if (input.kind === 'gerber-list' || input.kind === 'drill-list') {
      auxiliaryFiles.push({ ...input });
      try {
        if (input.kind === 'drill-list') {
          drillLists.push({ input, parsed: parseDrillList(input.data) });
        } else {
          gerberLists.push({ input, parsed: parseGerberList(input.data) });
        }
      } catch (error) {
        diagnostics.push(diagnostic(
          'warning',
          leafName(input),
          input.kind === 'drill-list' ? 'DRLIST' : 'GBLIST',
          error instanceof Error ? error.message : 'Sidecar list could not be parsed',
        ));
      }
      continue;
    }
    if (input.kind === 'hpgl' || input.kind === 'gerber' || input.kind === 'excellon') {
      drawableInputs.push({
        ...input,
        effectiveLayerName: defaultLayerName(input),
        parseOptions: {},
      });
    }
  }

  for (const sidecar of drillLists) {
    associateExcellon(sidecar.input, sidecar.parsed, drawableInputs, diagnostics);
  }
  for (const sidecar of gerberLists) {
    associateGerber(sidecar.input, sidecar.parsed, drawableInputs, diagnostics);
  }
  for (const drawable of drawableInputs) {
    applyFileFunctionLayerName(drawable);
  }

  const boundsByDir = new Map();
  for (const drawable of drawableInputs) {
    if (drawable.kind !== 'excellon') {
      continue;
    }
    const defaults = drawable.parseOptions.defaults;
    const inspected = inspectExcellon(decode(drawable.data));
    if (isDrillFormatDetermined(defaults, inspected)) {
      continue;
    }
    const groupDir = dirName(drawable);
    if (!boundsByDir.has(groupDir)) {
      boundsByDir.set(groupDir, gerberBoundsForGroup(drawableInputs, groupDir));
    }
    inferDrillFormat(drawable, boundsByDir.get(groupDir), diagnostics);
  }

  return { drawableInputs, auxiliaryFiles, diagnostics };
}
