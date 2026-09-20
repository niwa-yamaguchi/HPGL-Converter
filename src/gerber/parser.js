import { parseApertureDefinition } from './apertures.js';
import { createGerberCoordinateFormat } from './coordinates.js';
import { tokenizeGerber } from './tokenizer.js';

const DIAGNOSTIC_DETAIL_LIMIT = 100;
const MIRROR_VALUES = new Set(['N', 'X', 'Y', 'XY']);

function diagnostic(
  severity,
  token,
  message,
  fileName,
  { skippedCommands = 1, skippedShapes = 0 } = {},
) {
  return {
    severity,
    fileName,
    command: token.code,
    offset: token.offset,
    message,
    skippedCommands,
    skippedShapes,
  };
}

function snapshotTransform(transform) {
  return {
    mirror: transform.mirror,
    rotation: transform.rotation,
    scale: transform.scale,
  };
}

function cloneSegment(segment) {
  const copy = {
    interpolation: segment.interpolation,
    start: [...segment.start],
    end: [...segment.end],
  };
  if (segment.centerOffset) {
    copy.centerOffset = [...segment.centerOffset];
  }
  return copy;
}

function cloneContours(contours, currentContour) {
  if (contours === null) {
    return { contours: null, currentContour: null };
  }
  const cloned = contours.map(contour => contour.map(cloneSegment));
  if (currentContour === null) {
    return { contours: cloned, currentContour: null };
  }
  const index = contours.indexOf(currentContour);
  return { contours: cloned, currentContour: index >= 0 ? cloned[index] : null };
}

function parseStandardFields(raw) {
  const fields = {
    gCodes: [],
    dCodes: [],
    mCode: null,
    x: undefined,
    y: undefined,
    i: undefined,
    j: undefined,
  };
  let index = 0;

  while (index < raw.length) {
    const letter = raw[index];
    index += 1;

    if (letter === 'G' || letter === 'D' || letter === 'M') {
      const start = index;
      while (index < raw.length && raw[index] >= '0' && raw[index] <= '9') {
        index += 1;
      }
      if (start === index) {
        throw new RangeError(`Missing ${letter} code`);
      }
      const value = Number(raw.slice(start, index));
      if (letter === 'G') {
        fields.gCodes.push(value);
      } else if (letter === 'D') {
        fields.dCodes.push(value);
      } else {
        fields.mCode = value;
      }
      continue;
    }

    if (letter === 'X' || letter === 'Y' || letter === 'I' || letter === 'J') {
      const start = index;
      if (raw[index] === '+' || raw[index] === '-') {
        index += 1;
      }
      let sawDigit = false;
      let sawDot = false;
      while (index < raw.length) {
        const character = raw[index];
        if (character >= '0' && character <= '9') {
          sawDigit = true;
          index += 1;
          continue;
        }
        if (character === '.' && !sawDot) {
          sawDot = true;
          index += 1;
          continue;
        }
        break;
      }
      if (!sawDigit) {
        throw new RangeError(`Invalid ${letter} coordinate`);
      }
      fields[letter.toLowerCase()] = raw.slice(start, index);
      continue;
    }

    throw new RangeError('Unexpected character in Gerber command');
  }

  return fields;
}

function parseAttributeBody(raw) {
  const nameAndValues = raw.slice(2);
  if (nameAndValues.length === 0) {
    return { name: '', values: [] };
  }
  const [name, ...values] = nameAndValues.split(',');
  return { name, values };
}

function applyGerberDefaults(format, apertures, defaults) {
  if (!defaults) {
    return;
  }
  const integerDigits = defaults.integerDigits;
  const fractionDigits = defaults.fractionDigits;
  if (integerDigits != null && fractionDigits != null) {
    const suppression = defaults.zeroSuppression === 'T' ? 'T' : 'L';
    format.applyFs(
      `FS${suppression}AX${integerDigits}${fractionDigits}Y${integerDigits}${fractionDigits}`,
    );
  }
  if (defaults.units === 'inch') {
    format.applyMo('MOIN');
  } else if (defaults.units === 'mm') {
    format.applyMo('MOMM');
  }
  if (defaults.apertures instanceof Map) {
    for (const [code, definition] of defaults.apertures) {
      apertures.set(code, {
        ...definition,
        units: definition.units ?? defaults.units ?? null,
      });
    }
  }
}

export function parseGerberObjects(data, context, options = {}) {
  const tokenized = tokenizeGerber(data);
  const diagnostics = [];
  let errorCount = 0;
  let warningCount = 0;
  const objects = [];
  const apertures = new Map();
  const macros = new Map();
  const attributes = {
    file: {},
    aperture: {},
    object: {},
    imageName: undefined,
  };
  const format = createGerberCoordinateFormat();
  applyGerberDefaults(format, apertures, options.defaults);
  const state = {
    interpolation: 'linear',
    polarity: 'dark',
    apertureCode: null,
    functionCode: null,
    region: false,
    regionContours: null,
    regionOffset: null,
    currentContour: null,
    transform: { mirror: 'N', rotation: 0, scale: 1 },
    collectingMacro: null,
    position: [0, 0],
    ended: false,
  };

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

  for (const item of tokenized.diagnostics) {
    addDiagnostic({ ...item, fileName: context.fileName });
  }

  function currentTransform() {
    return snapshotTransform(state.transform);
  }

  function selectAperture(code) {
    if (!apertures.has(code)) {
      throw new RangeError(`Aperture D${code} is not defined`);
    }
    state.apertureCode = code;
  }

  function requireAperture() {
    if (state.apertureCode === null) {
      throw new RangeError('No aperture is selected');
    }
    return state.apertureCode;
  }

  function startRegion(token) {
    if (state.region) {
      throw new RangeError('G36 is already active');
    }
    state.region = true;
    state.regionContours = [];
    state.currentContour = null;
    state.regionOffset = token.offset;
  }

  function diagnoseUnclosedRegion() {
    addDiagnostic({
      severity: 'error',
      fileName: context.fileName,
      command: 'G36',
      offset: state.regionOffset,
      message: 'Unclosed G36 region',
      skippedCommands: 1,
      skippedShapes: 0,
    });
  }

  function endRegion() {
    if (!state.region) {
      throw new RangeError('G37 has no matching G36');
    }
    objects.push({
      kind: 'region',
      contours: state.regionContours,
      polarity: state.polarity,
      offset: state.regionOffset,
      transform: currentTransform(),
    });
    state.region = false;
    state.regionContours = null;
    state.currentContour = null;
    state.regionOffset = null;
  }

  function handleGCode(code, token) {
    if (code === 4) {
      return 'comment';
    }
    if (code === 1) {
      state.interpolation = 'linear';
      return null;
    }
    if (code === 2) {
      state.interpolation = 'clockwise';
      return null;
    }
    if (code === 3) {
      state.interpolation = 'counterclockwise';
      return null;
    }
    if (code === 36) {
      startRegion(token);
      return null;
    }
    if (code === 37) {
      endRegion();
      return null;
    }
    if (code === 75 || code === 54 || code === 17 || code === 90) {
      return null;
    }
    if (code === 70) {
      format.applyMo('MOIN');
      return null;
    }
    if (code === 71) {
      format.applyMo('MOMM');
      return null;
    }
    addDiagnostic(diagnostic(
      'warning',
      token,
      `Unsupported Gerber G${String(code).padStart(2, '0')} command`,
      context.fileName,
    ));
    return null;
  }

  function interpolate(fields, token) {
    if (!state.region) {
      requireAperture();
    }
    const start = [...state.position];
    const end = format.parsePoint(fields);
    const segment = {
      interpolation: state.interpolation,
      start,
      end,
    };
    if (state.interpolation !== 'linear') {
      segment.centerOffset = format.parseOffset({ i: fields.i, j: fields.j });
    }

    if (state.region) {
      if (state.currentContour === null) {
        state.currentContour = [];
        state.regionContours.push(state.currentContour);
      }
      state.currentContour.push(segment);
      state.position = end;
      return;
    }

    const draw = {
      kind: 'draw',
      interpolation: state.interpolation,
      start,
      end,
      apertureCode: state.apertureCode,
      polarity: state.polarity,
      offset: token.offset,
      transform: currentTransform(),
    };
    if (segment.centerOffset) {
      draw.centerOffset = segment.centerOffset;
    }
    objects.push(draw);
    state.position = end;
  }

  function move(fields) {
    state.position = format.parsePoint(fields);
    if (state.region) {
      state.currentContour = null;
    }
  }

  function flash(fields, token) {
    requireAperture();
    const point = format.parsePoint(fields);
    objects.push({
      kind: 'flash',
      point,
      apertureCode: state.apertureCode,
      polarity: state.polarity,
      offset: token.offset,
      transform: currentTransform(),
    });
    state.position = point;
  }

  function handleOperation(operation, fields, token) {
    if (operation === 1) {
      interpolate(fields, token);
      return;
    }
    if (operation === 2) {
      move(fields);
      return;
    }
    if (operation === 3) {
      if (state.region) {
        throw new RangeError('D03 is not allowed inside a region');
      }
      flash(fields, token);
      return;
    }
    throw new RangeError(`Unsupported operation D${String(operation).padStart(2, '0')}`);
  }

  function handleAd(token) {
    const definition = parseApertureDefinition(token.raw, macros);
    definition.offset = token.offset;
    definition.units = format.snapshot().units;
    apertures.set(definition.code, definition);
  }

  function handleAm(token) {
    const name = token.raw.slice(2);
    if (!name) {
      throw new RangeError('AM requires a macro name');
    }
    const definition = {
      name,
      primitives: [],
      offset: token.offset,
    };
    macros.set(name, definition);
    state.collectingMacro = definition;
  }

  function handleLp(token) {
    const raw = token.raw.toUpperCase();
    if (raw === 'LPD') {
      state.polarity = 'dark';
      return;
    }
    if (raw === 'LPC') {
      state.polarity = 'clear';
      return;
    }
    throw new RangeError('LP requires D or C');
  }

  function handleLm(token) {
    const value = token.raw.slice(2).toUpperCase();
    if (!MIRROR_VALUES.has(value)) {
      throw new RangeError('LM requires N, X, Y, or XY');
    }
    state.transform.mirror = value;
  }

  function handleLr(token) {
    const value = Number(token.raw.slice(2));
    if (!Number.isFinite(value)) {
      throw new RangeError('LR requires a finite rotation');
    }
    state.transform.rotation = value;
  }

  function handleLs(token) {
    const value = Number(token.raw.slice(2));
    if (!Number.isFinite(value) || value === 0) {
      throw new RangeError('LS requires a non-zero scale');
    }
    state.transform.scale = value;
  }

  function handleAs(token) {
    if (token.raw.toUpperCase() === 'ASAXBY') {
      return;
    }
    throw new RangeError('AS accepts AXBY only');
  }

  function handleIn(token) {
    attributes.imageName = token.raw.slice(2);
  }

  function handleAttribute(token) {
    const parsed = parseAttributeBody(token.raw);
    if (token.code === 'TD') {
      if (!parsed.name) {
        attributes.file = {};
        attributes.aperture = {};
        attributes.object = {};
        return;
      }
      delete attributes.file[parsed.name];
      delete attributes.aperture[parsed.name];
      delete attributes.object[parsed.name];
      return;
    }
    const target = token.code === 'TF'
      ? attributes.file
      : token.code === 'TA'
        ? attributes.aperture
        : attributes.object;
    target[parsed.name] = parsed.values;
  }

  function handleExtended(token) {
    if (state.collectingMacro && /^(?:\d|\$)/.test(token.code)) {
      state.collectingMacro.primitives.push(token.raw);
      return;
    }
    state.collectingMacro = null;

    if (token.code === 'FS') {
      format.applyFs(token.raw);
      return;
    }
    if (token.code === 'MO') {
      format.applyMo(token.raw);
      return;
    }
    if (token.code === 'SF') {
      format.applySf(token.raw);
      return;
    }
    if (token.code === 'AS') {
      handleAs(token);
      return;
    }
    if (token.code === 'IN') {
      handleIn(token);
      return;
    }
    if (token.code === 'AD') {
      handleAd(token);
      return;
    }
    if (token.code === 'AM') {
      handleAm(token);
      return;
    }
    if (token.code === 'LP') {
      handleLp(token);
      return;
    }
    if (token.code === 'LM') {
      handleLm(token);
      return;
    }
    if (token.code === 'LR') {
      handleLr(token);
      return;
    }
    if (token.code === 'LS') {
      handleLs(token);
      return;
    }
    if (token.code === 'TF' || token.code === 'TA' || token.code === 'TO' || token.code === 'TD') {
      handleAttribute(token);
      return;
    }
    addDiagnostic(diagnostic(
      'warning',
      token,
      'Unsupported Gerber command',
      context.fileName,
    ));
  }

  function handleStandard(token) {
    state.collectingMacro = null;
    if (token.raw.toUpperCase().startsWith('G04')) {
      return;
    }

    const fields = parseStandardFields(token.raw.toUpperCase());
    for (const gCode of fields.gCodes) {
      if (handleGCode(gCode, token) === 'comment') {
        return;
      }
    }

    if (fields.mCode === 0 || fields.mCode === 2) {
      if (state.region) {
        diagnoseUnclosedRegion();
        endRegion();
      }
      state.ended = true;
      return;
    }
    if (fields.mCode !== null) {
      addDiagnostic(diagnostic(
        'warning',
        token,
        `Unsupported Gerber M${String(fields.mCode).padStart(2, '0')} command`,
        context.fileName,
      ));
    }

    for (const dCode of fields.dCodes) {
      if (dCode >= 10) {
        selectAperture(dCode);
      }
    }

    const operation = fields.dCodes.find(code => code < 10);
    const hasCoordinates = fields.x !== undefined
      || fields.y !== undefined
      || fields.i !== undefined
      || fields.j !== undefined;
    if (operation !== undefined) {
      handleOperation(operation, fields, token);
      state.functionCode = operation;
      return;
    }
    if (hasCoordinates) {
      const operationCode = state.functionCode ?? 2;
      handleOperation(operationCode, fields, token);
      state.functionCode = operationCode;
    }
  }

  function snapshotCommand() {
    const region = cloneContours(state.regionContours, state.currentContour);
    return {
      interpolation: state.interpolation,
      polarity: state.polarity,
      apertureCode: state.apertureCode,
      functionCode: state.functionCode,
      region: state.region,
      regionContours: region.contours,
      regionOffset: state.regionOffset,
      currentContour: region.currentContour,
      transform: snapshotTransform(state.transform),
      collectingMacro: state.collectingMacro,
      macroPrimitiveCount: state.collectingMacro ? state.collectingMacro.primitives.length : 0,
      position: [...state.position],
      ended: state.ended,
      objectCount: objects.length,
      format: format.snapshot(),
    };
  }

  function restoreCommand(saved) {
    state.interpolation = saved.interpolation;
    state.polarity = saved.polarity;
    state.apertureCode = saved.apertureCode;
    state.functionCode = saved.functionCode;
    state.region = saved.region;
    state.regionContours = saved.regionContours;
    state.regionOffset = saved.regionOffset;
    state.currentContour = saved.currentContour;
    state.transform = saved.transform;
    state.collectingMacro = saved.collectingMacro;
    if (saved.collectingMacro) {
      saved.collectingMacro.primitives.length = saved.macroPrimitiveCount;
    }
    state.position = saved.position;
    state.ended = saved.ended;
    objects.length = saved.objectCount;
    format.restore(saved.format);
  }

  for (const token of tokenized.tokens) {
    if (state.ended) {
      break;
    }
    const saved = snapshotCommand();
    try {
      if (token.kind === 'extended') {
        handleExtended(token);
      } else {
        handleStandard(token);
      }
    } catch (error) {
      restoreCommand(saved);
      addDiagnostic(diagnostic(
        'error',
        token,
        error instanceof Error ? error.message : 'Invalid Gerber command',
        context.fileName,
      ));
    }
  }

  if (state.region) {
    diagnoseUnclosedRegion();
    endRegion();
  }

  return {
    objects,
    apertures,
    macros,
    attributes,
    diagnostics,
    summary: {
      objectCount: objects.length,
      errorCount,
      warningCount,
    },
  };
}
