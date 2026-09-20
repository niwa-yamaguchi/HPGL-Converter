const FS_PATTERN = /^FS([LT])A(?:G\d)?X(\d)(\d)Y(\d)(\d)(?:[DM]\d+)*$/;
const MO_PATTERN = /^MO(MM|IN)$/;
const SF_PATTERN = /^SFA([+-]?(?:\d+\.?\d*|\.\d+))B([+-]?(?:\d+\.?\d*|\.\d+))$/;
const INCH_TO_MM = 25.4;

function assertFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  return value;
}

function parseDigitPair(value, label) {
  const digit = Number(value);
  if (!Number.isInteger(digit) || digit < 0 || digit > 7) {
    throw new RangeError(`${label} digit count must be between 0 and 7`);
  }
  return digit;
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
    assertFinite(value, 'Coordinate');
    return sign * value;
  }

  if (!/^\d+$/.test(body)) {
    throw new RangeError('Coordinate value is invalid');
  }

  const width = integerDigits + fractionDigits;
  if (width === 0) {
    throw new RangeError('Coordinate format width must be positive');
  }
  if (body.length > width) {
    throw new RangeError('Coordinate value exceeds the FS digit width');
  }

  const padded = zeroSuppression === 'L'
    ? body.padStart(width, '0')
    : body.padEnd(width, '0');
  const value = Number(`${padded.slice(0, integerDigits) || '0'}.${padded.slice(integerDigits)}`);
  assertFinite(value, 'Coordinate');
  return sign * value;
}

export function createGerberCoordinateFormat() {
  let zeroSuppression = null;
  let xInteger = null;
  let xFraction = null;
  let yInteger = null;
  let yFraction = null;
  let units = null;
  let scaleX = 1;
  let scaleY = 1;
  let lastX = 0;
  let lastY = 0;

  function ensureReady() {
    if (zeroSuppression === null || units === null) {
      throw new RangeError('Coordinate format is not defined');
    }
  }

  function toMm(value, scale) {
    const scaled = value * scale;
    assertFinite(scaled, 'Scaled coordinate');
    const mm = units === 'inch' ? scaled * INCH_TO_MM : scaled;
    return assertFinite(mm, 'Millimetre coordinate');
  }

  function parseAxis(text, integerDigits, fractionDigits, scale, lastValue) {
    if (text === undefined) {
      return lastValue;
    }
    return toMm(
      parseCoordinateBody(text, integerDigits, fractionDigits, zeroSuppression),
      scale,
    );
  }

  function applyFs(command) {
    const text = String(command).toUpperCase().replace(/\s+/g, '');
    const match = FS_PATTERN.exec(text);
    if (!match) {
      throw new RangeError('FS requires leading or trailing zero suppression and absolute axes');
    }
    const nextXInteger = parseDigitPair(match[2], 'X integer');
    const nextXFraction = parseDigitPair(match[3], 'X decimal');
    const nextYInteger = parseDigitPair(match[4], 'Y integer');
    const nextYFraction = parseDigitPair(match[5], 'Y decimal');
    if (nextXInteger + nextXFraction === 0 || nextYInteger + nextYFraction === 0) {
      throw new RangeError('FS digit width must be positive');
    }
    zeroSuppression = match[1];
    xInteger = nextXInteger;
    xFraction = nextXFraction;
    yInteger = nextYInteger;
    yFraction = nextYFraction;
    return true;
  }

  function applyMo(command) {
    const text = String(command).toUpperCase().replace(/\s+/g, '');
    const match = MO_PATTERN.exec(text);
    if (!match) {
      throw new RangeError('MO requires MM or IN');
    }
    units = match[1] === 'IN' ? 'inch' : 'mm';
    return true;
  }

  function applySf(command) {
    const text = String(command).toUpperCase().replace(/\s+/g, '');
    const match = SF_PATTERN.exec(text);
    if (!match) {
      throw new RangeError('SF requires A and B scale factors');
    }
    const nextX = Number(match[1]);
    const nextY = Number(match[2]);
    assertFinite(nextX, 'SF A');
    assertFinite(nextY, 'SF B');
    if (nextX === 0 || nextY === 0) {
      throw new RangeError('SF scale factors must be non-zero');
    }
    scaleX = nextX;
    scaleY = nextY;
    return true;
  }

  function parsePoint(fields = {}) {
    ensureReady();
    const x = parseAxis(fields.x, xInteger, xFraction, scaleX, lastX);
    const y = parseAxis(fields.y, yInteger, yFraction, scaleY, lastY);
    lastX = x;
    lastY = y;
    return [x, y];
  }

  function parseOffset(fields = {}) {
    ensureReady();
    const i = fields.i === undefined
      ? 0
      : toMm(parseCoordinateBody(fields.i, xInteger, xFraction, zeroSuppression), scaleX);
    const j = fields.j === undefined
      ? 0
      : toMm(parseCoordinateBody(fields.j, yInteger, yFraction, zeroSuppression), scaleY);
    return [i, j];
  }

  function snapshot() {
    return {
      zeroSuppression,
      xInteger,
      xFraction,
      yInteger,
      yFraction,
      units,
      scaleX,
      scaleY,
      lastX,
      lastY,
    };
  }

  function restore(saved) {
    zeroSuppression = saved.zeroSuppression;
    xInteger = saved.xInteger;
    xFraction = saved.xFraction;
    yInteger = saved.yInteger;
    yFraction = saved.yFraction;
    units = saved.units;
    scaleX = saved.scaleX;
    scaleY = saved.scaleY;
    lastX = saved.lastX;
    lastY = saved.lastY;
  }

  return {
    applyFs,
    applyMo,
    applySf,
    parsePoint,
    parseOffset,
    snapshot,
    restore,
  };
}
