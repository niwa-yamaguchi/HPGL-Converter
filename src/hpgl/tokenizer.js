const ESC = 0x1b;
const ETX = 0x03;
const DOT = 0x2e;
const COLON = 0x3a;
const SEMICOLON = 0x3b;
const LINE_FEED = 0x0a;

const isAlpha = byte => (
  (byte >= 0x41 && byte <= 0x5a)
  || (byte >= 0x61 && byte <= 0x7a)
);

const isWhitespace = byte => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);

const upperPair = (first, second) => (
  String.fromCharCode(first, second).toUpperCase()
);

function invalidStartDiagnostic(offset) {
  return {
    severity: 'warning',
    command: '',
    offset,
    message: 'Invalid HPGL command start',
    skippedCommands: 1,
    skippedShapes: 0,
  };
}

function skipEscDotSequence(data, cursor) {
  cursor += 2;
  while (cursor < data.length && data[cursor] !== COLON && data[cursor] !== LINE_FEED) {
    cursor += 1;
  }
  return cursor < data.length ? cursor + 1 : cursor;
}

function readLabel(data, paramsStart, decoder) {
  let etx = paramsStart;
  while (etx < data.length && data[etx] !== ETX) {
    etx += 1;
  }

  let paramsEnd = etx;
  let nextCursor = etx < data.length ? etx + 1 : etx;
  if (etx === data.length) {
    paramsEnd = paramsStart;
    while (paramsEnd < data.length && data[paramsEnd] !== SEMICOLON) {
      paramsEnd += 1;
    }
    nextCursor = paramsEnd;
  }

  const params = data.slice(paramsStart, paramsEnd);
  return {
    params,
    label: decoder.decode(params),
    nextCursor,
  };
}

export function tokenizeHpgl(data) {
  const tokens = [];
  const diagnostics = [];
  const decoder = new TextDecoder('utf-8');
  let cursor = 0;

  while (cursor < data.length) {
    const byte = data[cursor];
    if (byte === SEMICOLON || isWhitespace(byte)) {
      cursor += 1;
      continue;
    }

    if (byte === ESC && data[cursor + 1] === DOT) {
      cursor = skipEscDotSequence(data, cursor);
      continue;
    }

    const offset = cursor;
    if (!isAlpha(data[cursor]) || !isAlpha(data[cursor + 1])) {
      diagnostics.push(invalidStartDiagnostic(offset));
      while (cursor < data.length && data[cursor] !== SEMICOLON) {
        cursor += 1;
      }
      continue;
    }

    const code = upperPair(data[cursor], data[cursor + 1]);
    cursor += 2;
    const paramsStart = cursor;

    if (code === 'LB') {
      const label = readLabel(data, paramsStart, decoder);
      tokens.push({ code, params: label.params, offset, label: label.label });
      cursor = label.nextCursor;
      continue;
    }

    while (cursor < data.length && data[cursor] !== SEMICOLON) {
      if (isAlpha(data[cursor]) && isAlpha(data[cursor + 1])) {
        break;
      }
      cursor += 1;
    }
    tokens.push({ code, params: data.slice(paramsStart, cursor), offset });
  }

  return { tokens, diagnostics };
}
