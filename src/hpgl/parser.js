import { createCoordinateTransform } from './coordinates.js';
import { tokenizeHpgl } from './tokenizer.js';

const ASCII_DECODER = new TextDecoder('utf-8');
const NUMBER_SOURCE = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const PARAMETER_LIST = new RegExp(
  `^[\\x09-\\x0d ]*(?:${NUMBER_SOURCE}(?:[,\\x09-\\x0d ]+${NUMBER_SOURCE})*)?[\\x09-\\x0d ]*$`,
);
const NUMBER = new RegExp(NUMBER_SOURCE, 'g');
const MOTION_COMMANDS = new Set(['PA', 'PR', 'PU', 'PD']);
const INDEPENDENT_SHAPE_COMMANDS = new Set(['AA', 'AR', 'CI', 'LB']);

function diagnostic(severity, token, message) {
  return {
    severity,
    command: token.code,
    offset: token.offset,
    message,
    skippedCommands: 1,
    skippedShapes: 0,
  };
}

function parseNumbers(params) {
  if (params.some(byte => byte > 0x7f)) {
    throw new TypeError('Numeric parameters must contain ASCII bytes only');
  }
  const text = ASCII_DECODER.decode(params);
  if (!PARAMETER_LIST.test(text)) {
    throw new TypeError('Invalid numeric parameters');
  }
  const values = [...text.matchAll(NUMBER)].map(match => Number(match[0]));
  if (values.some(value => !Number.isFinite(value))) {
    throw new RangeError('Numeric parameters must be finite');
  }
  return values;
}

function validateCoordinateValues(values) {
  if (values.length % 2 !== 0) {
    throw new RangeError('Motion commands require coordinate pairs');
  }
}

function validateNoParameters(values, command) {
  if (values.length !== 0) {
    throw new RangeError(`${command} does not accept numeric parameters`);
  }
}

function validateIndependentShape(token) {
  if (token.code === 'LB') {
    return;
  }

  const values = parseNumbers(token.params);
  const allowedLengths = token.code === 'CI' ? [1, 2] : [3, 4];
  if (!allowedLengths.includes(values.length)) {
    throw new RangeError(
      `${token.code} requires ${allowedLengths.join(' or ')} numeric values`,
    );
  }
}

export function parseHpgl(data, context) {
  const tokenized = tokenizeHpgl(data);
  const diagnostics = [...tokenized.diagnostics];
  const geometries = [];
  const state = {
    rawPosition: [0, 0],
    positionMm: [0, 0],
    absolute: true,
    penDown: false,
    color: 1,
    polyline: [],
    polylineOffset: null,
    transform: createCoordinateTransform(),
  };

  function flushPolyline() {
    if (state.polyline.length >= 2) {
      geometries.push({
        type: state.polyline.length === 2 ? 'line' : 'polyline',
        layer: context.layerName,
        color: state.color,
        fileName: context.fileName,
        offset: state.polylineOffset,
        points: state.polyline.map(point => [...point]),
      });
    }
    state.polyline = [];
    state.polylineOffset = null;
  }

  function prepareDestinations(values, absolute) {
    validateCoordinateValues(values);
    const destinations = [];
    let raw = [...state.rawPosition];
    let mm = [...state.positionMm];

    for (let index = 0; index < values.length; index += 2) {
      if (absolute) {
        raw = [values[index], values[index + 1]];
        mm = state.transform.toMm(raw[0], raw[1]);
      } else {
        raw = [raw[0] + values[index], raw[1] + values[index + 1]];
        const delta = state.transform.deltaToMm(values[index], values[index + 1]);
        mm = [mm[0] + delta[0], mm[1] + delta[1]];
      }
      destinations.push({ raw: [...raw], mm: [...mm] });
    }
    return destinations;
  }

  function move(destinations, offset) {
    for (const destination of destinations) {
      if (state.penDown) {
        if (state.polyline.length === 0) {
          state.polyline.push([...state.positionMm]);
          state.polylineOffset = offset;
        }
        state.polyline.push([...destination.mm]);
      }
      state.rawPosition = [...destination.raw];
      state.positionMm = [...destination.mm];
    }
  }

  function handleMotion(token, values) {
    const absolute = token.code === 'PA'
      ? true
      : token.code === 'PR'
        ? false
        : state.absolute;
    const destinations = prepareDestinations(values, absolute);

    if (token.code === 'PA' || token.code === 'PR') {
      state.absolute = absolute;
    } else if (token.code === 'PU') {
      state.penDown = false;
      flushPolyline();
    } else {
      state.penDown = true;
    }
    move(destinations, token.offset);
  }

  for (const token of tokenized.tokens) {
    try {
      if (MOTION_COMMANDS.has(token.code)) {
        handleMotion(token, parseNumbers(token.params));
        continue;
      }

      if (token.code === 'IP') {
        state.transform.applyIP(parseNumbers(token.params));
        continue;
      }
      if (token.code === 'IR') {
        state.transform.applyIR(parseNumbers(token.params));
        continue;
      }
      if (token.code === 'SC') {
        state.transform.applySC(parseNumbers(token.params));
        continue;
      }
      if (token.code === 'SP') {
        const values = parseNumbers(token.params);
        if (values.length > 1) {
          throw new RangeError('SP accepts at most one pen number');
        }
        const color = values[0] ?? 0;
        if (!Number.isInteger(color) || color < 0 || color > 255) {
          throw new RangeError('SP pen number must be an integer from 0 through 255');
        }
        flushPolyline();
        state.color = color;
        continue;
      }
      if (token.code === 'IN') {
        const values = parseNumbers(token.params);
        validateNoParameters(values, 'IN');
        flushPolyline();
        state.rawPosition = [0, 0];
        state.positionMm = [0, 0];
        state.absolute = true;
        state.penDown = false;
        state.color = 1;
        state.transform.reset();
        continue;
      }
      if (token.code === 'DF') {
        validateNoParameters(parseNumbers(token.params), 'DF');
        continue;
      }

      if (INDEPENDENT_SHAPE_COMMANDS.has(token.code)) {
        validateIndependentShape(token);
        flushPolyline();
      }
      diagnostics.push(diagnostic('warning', token, 'Unsupported HPGL command'));
    } catch (error) {
      diagnostics.push(diagnostic(
        'error',
        token,
        error instanceof Error ? error.message : 'Invalid HPGL command',
      ));
    }
  }

  flushPolyline();
  return {
    geometries,
    diagnostics,
    summary: {
      geometryCount: geometries.length,
      errorCount: diagnostics.filter(item => item.severity === 'error').length,
      warningCount: diagnostics.filter(item => item.severity === 'warning').length,
    },
  };
}
