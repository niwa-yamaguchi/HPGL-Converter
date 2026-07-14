const FLAGS = {
  PEN: 0x3a,
  PEN_UP: 0x3c,
  FRACTIONAL_BITS: 0x3e,
  ABSOLUTE: 0x3d,
  BASE_32: 0x37,
};

const MAX_FRACTIONAL_BITS = 30;

function fail(message) {
  return { events: [], error: message };
}

function decodeValue(data, start, base) {
  const nonTerminatorEnd = base === 64 ? 126 : 94;
  const terminatorStart = base === 64 ? 191 : 95;
  const terminatorEnd = base === 64 ? 254 : 126;
  let cursor = start;
  let encoded = 0;
  let place = 1;

  while (cursor < data.length) {
    const byte = data[cursor];
    let digit;
    let terminated = false;

    if (byte >= 63 && byte <= nonTerminatorEnd) {
      digit = byte - 63;
    } else if (byte >= terminatorStart && byte <= terminatorEnd) {
      digit = byte - terminatorStart;
      terminated = true;
    } else {
      return {
        error: cursor === start ? 'Invalid PE digit byte' : 'PE value is missing a terminator',
      };
    }

    encoded += digit * place;
    if (!Number.isFinite(encoded)) {
      return { error: 'PE encoded value is not finite' };
    }
    cursor += 1;

    if (terminated) {
      const value = encoded % 2 === 0 ? encoded / 2 : -(encoded - 1) / 2;
      return { value, nextCursor: cursor };
    }

    place *= base;
    if (!Number.isFinite(place)) {
      return { error: 'PE encoded value is not finite' };
    }
  }

  return { error: 'PE value is missing a terminator' };
}

export function decodePe(data) {
  const events = [];
  let cursor = 0;
  let base = 64;
  let fractionalBits = 0;
  let nextAbsolute = false;
  let nextPenDown = true;

  while (cursor < data.length) {
    const byte = data[cursor];

    if (byte === FLAGS.BASE_32) {
      base = 32;
      cursor += 1;
      continue;
    }
    if (byte === FLAGS.PEN_UP) {
      nextPenDown = false;
      cursor += 1;
      continue;
    }
    if (byte === FLAGS.ABSOLUTE) {
      nextAbsolute = true;
      cursor += 1;
      continue;
    }
    if (byte === FLAGS.PEN || byte === FLAGS.FRACTIONAL_BITS) {
      const flag = byte;
      const decoded = decodeValue(data, cursor + 1, base);
      if (decoded.error) {
        return fail(decoded.error);
      }
      cursor = decoded.nextCursor;

      if (flag === FLAGS.PEN) {
        events.push({ type: 'pen', value: decoded.value });
      } else {
        if (decoded.value < 0 || decoded.value > MAX_FRACTIONAL_BITS) {
          return fail('PE fractional bit count must be from 0 through 30');
        }
        fractionalBits = decoded.value;
      }
      continue;
    }

    const x = decodeValue(data, cursor, base);
    if (x.error) {
      return fail(x.error);
    }
    const y = decodeValue(data, x.nextCursor, base);
    if (y.error) {
      return fail(y.error);
    }

    const divisor = 2 ** fractionalBits;
    const coordinateX = x.value / divisor;
    const coordinateY = y.value / divisor;
    if (!Number.isFinite(coordinateX) || !Number.isFinite(coordinateY)) {
      return fail('PE coordinate must be finite');
    }

    events.push({
      type: 'move',
      x: coordinateX,
      y: coordinateY,
      absolute: nextAbsolute,
      penDown: nextPenDown,
    });
    cursor = y.nextCursor;
    nextAbsolute = false;
    nextPenDown = true;
  }

  if (nextAbsolute || !nextPenDown) {
    return fail('PE one-shot flag requires a coordinate pair');
  }
  return { events };
}
