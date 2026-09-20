const PERCENT = 0x25;
const STAR = 0x2a;

const isWhitespace = byte => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
const isAlpha = byte => (
  (byte >= 0x41 && byte <= 0x5a)
  || (byte >= 0x61 && byte <= 0x7a)
);

function invalidStartDiagnostic(offset) {
  return {
    severity: 'warning',
    command: '',
    offset,
    message: 'Invalid Gerber command start',
    skippedCommands: 1,
    skippedShapes: 0,
  };
}

function unterminatedDiagnostic(offset, command = '') {
  return {
    severity: 'warning',
    command,
    offset,
    message: 'Unterminated Gerber command',
    skippedCommands: 1,
    skippedShapes: 0,
  };
}

function decodeBody(data, start, end) {
  let raw = '';
  for (let index = start; index < end; index += 1) {
    const byte = data[index];
    if (isWhitespace(byte)) {
      continue;
    }
    raw += String.fromCharCode(byte);
  }
  return raw;
}

function padCode(prefix, value) {
  if (prefix === 'D' && value >= 10) {
    return `D${value}`;
  }
  return `${prefix}${String(value).padStart(2, '0')}`;
}

function standardCode(raw) {
  const upper = raw.toUpperCase();
  const dMatch = /D(\d+)/.exec(upper);
  if (dMatch) {
    return padCode('D', Number(dMatch[1]));
  }
  const gMatch = /G(\d+)/.exec(upper);
  if (gMatch) {
    return padCode('G', Number(gMatch[1]));
  }
  const mMatch = /M(\d+)/.exec(upper);
  if (mMatch) {
    return padCode('M', Number(mMatch[1]));
  }
  return 'XY';
}

function extendedCode(raw) {
  const upper = raw.toUpperCase();
  const letters = /^([A-Z]{2})/.exec(upper);
  if (letters) {
    return letters[1];
  }
  const primitive = /^(\$?\d+)/.exec(upper);
  if (primitive) {
    return primitive[1];
  }
  return upper.slice(0, 2);
}

function skipInvalid(data, cursor) {
  while (cursor < data.length) {
    const byte = data[cursor];
    if (isWhitespace(byte) || byte === STAR || byte === PERCENT) {
      break;
    }
    cursor += 1;
  }
  if (cursor < data.length && data[cursor] === STAR) {
    cursor += 1;
  }
  return cursor;
}

function readUntilStar(data, cursor) {
  const start = cursor;
  while (cursor < data.length && data[cursor] !== STAR && data[cursor] !== PERCENT) {
    cursor += 1;
  }
  return { start, end: cursor, cursor };
}

export function tokenizeGerber(data) {
  const tokens = [];
  const diagnostics = [];
  let cursor = 0;

  while (cursor < data.length) {
    const byte = data[cursor];
    if (isWhitespace(byte)) {
      cursor += 1;
      continue;
    }

    if (byte === PERCENT) {
      const blockOffset = cursor;
      cursor += 1;
      let first = true;

      while (cursor < data.length) {
        while (cursor < data.length && isWhitespace(data[cursor])) {
          cursor += 1;
        }
        if (cursor >= data.length) {
          diagnostics.push(unterminatedDiagnostic(blockOffset, '%'));
          break;
        }
        if (data[cursor] === PERCENT) {
          cursor += 1;
          break;
        }

        const commandOffset = first ? blockOffset : cursor;
        first = false;
        const body = readUntilStar(data, cursor);
        if (body.cursor >= data.length || data[body.cursor] !== STAR) {
          diagnostics.push(unterminatedDiagnostic(commandOffset, '%'));
          cursor = body.cursor;
          break;
        }
        const raw = decodeBody(data, body.start, body.end);
        if (raw.length > 0) {
          tokens.push({
            kind: 'extended',
            code: extendedCode(raw),
            raw,
            offset: commandOffset,
          });
        }
        cursor = body.cursor + 1;
      }
      continue;
    }

    if (byte === STAR) {
      cursor += 1;
      continue;
    }

    if (!isAlpha(byte)) {
      diagnostics.push(invalidStartDiagnostic(cursor));
      cursor = skipInvalid(data, cursor);
      continue;
    }

    const offset = cursor;
    const body = readUntilStar(data, cursor);
    if (body.cursor >= data.length || data[body.cursor] !== STAR) {
      diagnostics.push(unterminatedDiagnostic(offset));
      break;
    }
    const raw = decodeBody(data, body.start, body.end);
    if (raw.length > 0) {
      tokens.push({
        kind: 'standard',
        code: standardCode(raw),
        raw,
        offset,
      });
    }
    cursor = body.cursor + 1;
  }

  return { tokens, diagnostics };
}
