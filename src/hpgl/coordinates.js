const MM_PER_PLOTTER_UNIT = 0.025;

function validateValues(values, allowedLengths, command) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${command} values must be an array`);
  }
  if (!allowedLengths.includes(values.length)) {
    throw new RangeError(
      `${command} requires ${allowedLengths.join(' or ')} numeric values`,
    );
  }
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`${command} values must be finite numbers`);
  }
}

function validateCoordinatePair(x, y, operation) {
  if (
    typeof x !== 'number'
    || typeof y !== 'number'
    || !Number.isFinite(x)
    || !Number.isFinite(y)
  ) {
    throw new TypeError(`${operation} coordinates must be finite numbers`);
  }
}

function validateResultPair(result, operation) {
  if (!result.every(Number.isFinite)) {
    throw new RangeError(`${operation} result coordinates must be finite`);
  }
  return result;
}

export function createCoordinateTransform() {
  let p1;
  let p2;
  let explicitP1;
  let explicitP2;
  let sc;

  function reset() {
    p1 = [0, 0];
    p2 = null;
    explicitP1 = [0, 0];
    explicitP2 = null;
    sc = null;
    return true;
  }

  function scales() {
    if (sc !== null && p2 !== null) {
      const result = [
        ((p2[0] - p1[0]) / (sc[1] - sc[0])) * MM_PER_PLOTTER_UNIT,
        ((p2[1] - p1[1]) / (sc[3] - sc[2])) * MM_PER_PLOTTER_UNIT,
      ];
      if (!result.every(Number.isFinite)) {
        throw new RangeError('Coordinate scales must be finite');
      }
      return result;
    }
    return [MM_PER_PLOTTER_UNIT, MM_PER_PLOTTER_UNIT];
  }

  function toMm(x, y) {
    validateCoordinatePair(x, y, 'Absolute');
    if (sc !== null && p2 !== null) {
      const [scaleX, scaleY] = scales();
      return validateResultPair(
        [(x - sc[0]) * scaleX, (y - sc[2]) * scaleY],
        'Absolute',
      );
    }
    return validateResultPair([
      (x - p1[0]) * MM_PER_PLOTTER_UNIT,
      (y - p1[1]) * MM_PER_PLOTTER_UNIT,
    ], 'Absolute');
  }

  function deltaToMm(dx, dy) {
    validateCoordinatePair(dx, dy, 'Relative');
    const [scaleX, scaleY] = scales();
    return validateResultPair([dx * scaleX, dy * scaleY], 'Relative');
  }

  function radiusToMm(radius) {
    if (typeof radius !== 'number' || !Number.isFinite(radius)) {
      throw new TypeError('Radius must be a finite number');
    }
    const [scaleX, scaleY] = scales();
    const result = radius * ((Math.abs(scaleX) + Math.abs(scaleY)) / 2);
    if (!Number.isFinite(result)) {
      throw new RangeError('Transformed radius must be finite');
    }
    if (result <= 0) {
      throw new RangeError('Transformed radius must be positive');
    }
    return result;
  }

  function applyIP(values) {
    validateValues(values, [2, 4], 'IP');
    const nextP1 = [values[0], values[1]];
    const nextP2 = values.length === 4 ? [values[2], values[3]] : explicitP2;
    p1 = nextP1;
    p2 = nextP2;
    explicitP1 = [...nextP1];
    explicitP2 = nextP2 === null ? null : [...nextP2];
    return true;
  }

  function applyIR(values) {
    validateValues(values, [0, 2, 4], 'IR');
    if (explicitP2 === null) {
      throw new RangeError('IR requires an explicit IP P2 point');
    }

    const percentages = values.length === 0
      ? [0, 0, 100, 100]
      : [values[0], values[1], values[2] ?? 100, values[3] ?? 100];
    const width = explicitP2[0] - explicitP1[0];
    const height = explicitP2[1] - explicitP1[1];
    const nextP1 = [
      explicitP1[0] + (width * percentages[0]) / 100,
      explicitP1[1] + (height * percentages[1]) / 100,
    ];
    const nextP2 = [
      explicitP1[0] + (width * percentages[2]) / 100,
      explicitP1[1] + (height * percentages[3]) / 100,
    ];
    validateResultPair(nextP1, 'IR P1');
    validateResultPair(nextP2, 'IR P2');
    p1 = nextP1;
    p2 = nextP2;
    return true;
  }

  function applySC(values) {
    validateValues(values, [4], 'SC');
    if (values[0] === values[1] || values[2] === values[3]) {
      throw new RangeError('SC coordinate spans must be non-zero');
    }
    sc = [...values];
    return true;
  }

  function points() {
    return {
      p1: [...p1],
      p2: p2 === null ? null : [...p2],
    };
  }

  reset();
  return {
    toMm,
    deltaToMm,
    radiusToMm,
    applyIP,
    applyIR,
    applySC,
    reset,
    points,
  };
}
