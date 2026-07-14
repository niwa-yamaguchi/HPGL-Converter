import { createCoordinateTransform } from './coordinates.js';
import { decodePe } from './pe-decoder.js';
import { tokenizeHpgl } from './tokenizer.js';

const ASCII_DECODER = new TextDecoder('utf-8');
const NUMBER_SOURCE = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const PARAMETER_LIST = new RegExp(
  `^[\\x09-\\x0d ]*(?:${NUMBER_SOURCE}(?:[,\\x09-\\x0d ]+${NUMBER_SOURCE})*)?[\\x09-\\x0d ]*$`,
);
const NUMBER = new RegExp(NUMBER_SOURCE, 'g');
const MOTION_COMMANDS = new Set(['PA', 'PR', 'PU', 'PD']);
const NO_OP_COMMANDS = new Set(['CT', 'LT', 'VS', 'PG', 'RO', 'PS']);
const FULL_CIRCLE_TOLERANCE = 1e-9;
const DIAGNOSTIC_DETAIL_LIMIT = 100;

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

function validateShapeValues(values, allowedLengths, command) {
  if (!allowedLengths.includes(values.length)) {
    throw new RangeError(
      `${command} requires ${allowedLengths.join(' or ')} numeric values`,
    );
  }
}

function isFullCircleSweep(sweep) {
  const absoluteSweep = Math.abs(sweep);
  const turns = Math.round(absoluteSweep / 360);
  return turns > 0
    && Math.abs(absoluteSweep - turns * 360) <= FULL_CIRCLE_TOLERANCE;
}

function normalizedTrig(value) {
  if (Math.abs(value) <= Number.EPSILON * 8) {
    return 0;
  }
  if (Math.abs(Math.abs(value) - 1) <= Number.EPSILON * 8) {
    return Math.sign(value);
  }
  return value;
}

export function parseHpgl(data, context) {
  const tokenized = tokenizeHpgl(data);
  const diagnostics = [];
  let errorCount = 0;
  let warningCount = 0;
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

  function shapeMetadata(token) {
    return {
      layer: context.layerName,
      color: state.color,
      fileName: context.fileName,
      offset: token.offset,
    };
  }

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

  function selectPen(pen, command) {
    if (!Number.isInteger(pen) || pen < 0 || pen > 255) {
      throw new RangeError(`${command} pen number must be an integer from 0 through 255`);
    }
    state.color = pen === 0 ? 1 : pen;
  }

  function handlePen(token) {
    flushPolyline();
    try {
      const values = parseNumbers(token.params);
      if (values.length !== 1) {
        throw new RangeError('SP requires one pen number');
      }
      selectPen(values[0], 'SP');
    } catch (error) {
      state.color = 7;
      throw error;
    }
  }

  function handlePe(token) {
    const decoded = decodePe(token.params);
    if (decoded.error) {
      throw new TypeError(decoded.error);
    }

    for (const event of decoded.events) {
      if (event.type === 'move') {
        const destinations = prepareDestinations([event.x, event.y], event.absolute);
        state.penDown = event.penDown;
        if (!event.penDown) {
          flushPolyline();
        }
        move(destinations, token.offset);
        continue;
      }

      flushPolyline();
      try {
        selectPen(event.value, 'PE');
      } catch (error) {
        state.color = 7;
        addDiagnostic(diagnostic(
          'error',
          token,
          error instanceof Error ? error.message : 'Invalid PE pen selection',
          context.fileName,
        ));
      }
    }
  }

  function handleCircle(token) {
    const values = parseNumbers(token.params);
    validateShapeValues(values, [1, 2], 'CI');
    if (values[0] <= 0) {
      throw new RangeError('CI radius must be positive');
    }
    const radius = state.transform.radiusToMm(values[0]);

    flushPolyline();
    geometries.push({
      type: 'circle',
      center: [...state.positionMm],
      radius,
      ...shapeMetadata(token),
    });
  }

  function handleArc(token) {
    const values = parseNumbers(token.params);
    validateShapeValues(values, [3, 4], token.code);
    const sweep = values[2];
    if (sweep === 0) {
      throw new RangeError(`${token.code} sweep must be non-zero`);
    }

    const relative = token.code === 'AR';
    const centerRaw = relative
      ? [state.rawPosition[0] + values[0], state.rawPosition[1] + values[1]]
      : [values[0], values[1]];
    if (!centerRaw.every(Number.isFinite)) {
      throw new RangeError(`${token.code} center must be finite`);
    }
    const startVector = [
      state.rawPosition[0] - centerRaw[0],
      state.rawPosition[1] - centerRaw[1],
    ];
    const rawRadius = Math.hypot(startVector[0], startVector[1]);
    if (!Number.isFinite(rawRadius) || rawRadius === 0) {
      throw new RangeError(`${token.code} radius must be non-zero`);
    }

    const centerMm = relative
      ? (() => {
        const delta = state.transform.deltaToMm(values[0], values[1]);
        return [state.positionMm[0] + delta[0], state.positionMm[1] + delta[1]];
      })()
      : state.transform.toMm(centerRaw[0], centerRaw[1]);
    const radius = state.transform.radiusToMm(rawRadius);
    const startAngle = Math.atan2(startVector[1], startVector[0]) * (180 / Math.PI);
    const endAngle = startAngle + sweep;
    const fullCircle = isFullCircleSweep(sweep);
    let endpointRaw = [...state.rawPosition];
    let endpointMm = [...state.positionMm];

    if (!fullCircle) {
      const radians = sweep * (Math.PI / 180);
      const cosine = normalizedTrig(Math.cos(radians));
      const sine = normalizedTrig(Math.sin(radians));
      const endVector = [
        startVector[0] * cosine - startVector[1] * sine,
        startVector[0] * sine + startVector[1] * cosine,
      ];
      endpointRaw = [centerRaw[0] + endVector[0], centerRaw[1] + endVector[1]];
      const endpointDelta = state.transform.deltaToMm(endVector[0], endVector[1]);
      endpointMm = [centerMm[0] + endpointDelta[0], centerMm[1] + endpointDelta[1]];
    }

    flushPolyline();
    if (state.penDown) {
      geometries.push(fullCircle
        ? {
          type: 'circle', center: centerMm, radius, ...shapeMetadata(token),
        }
        : {
          type: 'arc',
          center: centerMm,
          radius,
          startAngle,
          endAngle,
          ...shapeMetadata(token),
        });
    }
    state.rawPosition = endpointRaw;
    state.positionMm = endpointMm;
  }

  function handleLabel(token) {
    flushPolyline();
    geometries.push({
      type: 'text',
      point: [...state.positionMm],
      text: token.label,
      height: 5,
      rotation: 0,
      ...shapeMetadata(token),
    });
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
        const values = parseNumbers(token.params);
        state.transform.applySC(values.length > 4 ? values.slice(0, 4) : values);
        if (values.length > 4) {
          addDiagnostic(diagnostic(
            'warning',
            token,
            'Optional SC parameters are ignored',
            context.fileName,
            { skippedCommands: 0 },
          ));
        }
        continue;
      }
      if (token.code === 'SP') {
        handlePen(token);
        continue;
      }
      if (token.code === 'PE') {
        handlePe(token);
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
      if (token.code === 'CI') {
        handleCircle(token);
        continue;
      }
      if (token.code === 'AA' || token.code === 'AR') {
        handleArc(token);
        continue;
      }
      if (token.code === 'LB') {
        handleLabel(token);
        continue;
      }
      if (NO_OP_COMMANDS.has(token.code)) {
        continue;
      }
      addDiagnostic(diagnostic(
        'warning', token, 'Unsupported HPGL command', context.fileName,
      ));
    } catch (error) {
      addDiagnostic(diagnostic(
        'error',
        token,
        error instanceof Error ? error.message : 'Invalid HPGL command',
        context.fileName,
      ));
    }
  }

  flushPolyline();
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
