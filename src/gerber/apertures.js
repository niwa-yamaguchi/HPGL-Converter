const STANDARD_KINDS = {
  C: 'circle',
  R: 'rectangle',
  O: 'obround',
  P: 'polygon',
};
const MIN_CIRCLE_SEGMENTS = 12;
const MAX_CIRCLE_SEGMENTS = 4096;
const DEFAULT_CHORD_TOLERANCE_MM = 0.01;
const DEFAULT_MAX_VERTICES = 5000;
const AD_PATTERN = /^ADD(\d+)([A-Za-z][A-Za-z0-9_+-]*),?(.*)$/i;

class ApertureError extends RangeError {
  constructor(message, offset) {
    super(message);
    this.name = 'ApertureError';
    this.offset = offset;
  }
}

function fail(message, offset) {
  throw new ApertureError(message, offset);
}

function requireFinite(value, label, offset) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} must be finite`, offset);
  }
  return value;
}

function parseModifiers(body) {
  if (!body) {
    return [];
  }
  return body.split(/x/i).map((part, index) => {
    const value = Number(part);
    if (!Number.isFinite(value)) {
      throw new RangeError(`AD modifier ${index + 1} must be finite`);
    }
    return value;
  });
}

function validateStandardModifiers(kind, modifiers) {
  const count = modifiers.length;
  if (kind === 'circle' && count >= 1 && count <= 3) {
    return;
  }
  if ((kind === 'rectangle' || kind === 'obround') && count >= 2 && count <= 4) {
    return;
  }
  if (kind === 'polygon' && count >= 2 && count <= 5) {
    return;
  }
  throw new RangeError(`Invalid ${kind} aperture modifiers`);
}

function findMacro(macros, name) {
  if (macros.has(name)) {
    return macros.get(name);
  }
  const upper = name.toUpperCase();
  for (const [key, value] of macros) {
    if (key.toUpperCase() === upper) {
      return value;
    }
  }
  return undefined;
}

export function parseApertureDefinition(command, macros) {
  const match = AD_PATTERN.exec(command);
  if (!match) {
    throw new RangeError('Invalid AD command');
  }
  const code = Number(match[1]);
  if (code < 10) {
    throw new RangeError('Aperture codes must be 10 or greater');
  }
  const template = match[2];
  const modifiers = parseModifiers(match[3]);
  const kind = STANDARD_KINDS[template.toUpperCase()];
  if (kind) {
    validateStandardModifiers(kind, modifiers);
    return { kind, code, template, modifiers, raw: command };
  }
  const macro = findMacro(macros, template);
  if (!macro) {
    throw new RangeError(`Aperture macro ${template} is not defined`);
  }
  return {
    kind: 'macro',
    code,
    template,
    modifiers,
    primitives: [...macro.primitives],
    macroOffset: macro.offset,
    raw: command,
  };
}

function circleSegmentCount(radius, tolerance) {
  if (!(radius > 0) || !(tolerance > 0) || tolerance / radius >= 2) {
    return MIN_CIRCLE_SEGMENTS;
  }
  const cosine = Math.min(1, Math.max(-1, 1 - tolerance / radius));
  const segments = Math.ceil(Math.PI / Math.acos(cosine));
  return Math.min(MAX_CIRCLE_SEGMENTS, Math.max(MIN_CIRCLE_SEGMENTS, segments));
}

function ensureVertexCount(count, ctx) {
  if (count > ctx.maxVertices) {
    fail('Aperture vertex limit exceeded', ctx.offset);
  }
}

function circlePath(cx, cy, radius, ctx) {
  const segments = circleSegmentCount(radius * ctx.unitScale, ctx.tolerance);
  ensureVertexCount(segments, ctx);
  const path = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index * 2 * Math.PI) / segments;
    path.push({
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  }
  return path;
}

function rectanglePath(cx, cy, width, height) {
  const halfX = width / 2;
  const halfY = height / 2;
  return [
    { x: cx - halfX, y: cy - halfY },
    { x: cx + halfX, y: cy - halfY },
    { x: cx + halfX, y: cy + halfY },
    { x: cx - halfX, y: cy + halfY },
  ];
}

function regularPolygonPath(cx, cy, radius, vertices, rotationDeg, ctx) {
  const count = Math.round(vertices);
  if (count < 3) {
    fail('Polygon requires at least 3 vertices', ctx.offset);
  }
  ensureVertexCount(count, ctx);
  const start = (rotationDeg * Math.PI) / 180;
  const path = [];
  for (let index = 0; index < count; index += 1) {
    const angle = start + (index * 2 * Math.PI) / count;
    path.push({
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  }
  return path;
}

function obroundPath(width, height, ctx) {
  if (width >= height) {
    const radius = height / 2;
    const offset = (width - height) / 2;
    const cap = Math.max(6, Math.ceil(circleSegmentCount(radius * ctx.unitScale, ctx.tolerance) / 2));
    ensureVertexCount((cap + 1) * 2, ctx);
    const path = [];
    for (let index = 0; index <= cap; index += 1) {
      const angle = -Math.PI / 2 + (Math.PI * index) / cap;
      path.push({
        x: offset + radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    }
    for (let index = 0; index <= cap; index += 1) {
      const angle = Math.PI / 2 + (Math.PI * index) / cap;
      path.push({
        x: -offset + radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    }
    return path;
  }
  const radius = width / 2;
  const offset = (height - width) / 2;
  const cap = Math.max(6, Math.ceil(circleSegmentCount(radius * ctx.unitScale, ctx.tolerance) / 2));
  ensureVertexCount((cap + 1) * 2, ctx);
  const path = [];
  for (let index = 0; index <= cap; index += 1) {
    const angle = (Math.PI * index) / cap;
    path.push({
      x: radius * Math.cos(angle),
      y: offset + radius * Math.sin(angle),
    });
  }
  for (let index = 0; index <= cap; index += 1) {
    const angle = Math.PI + (Math.PI * index) / cap;
    path.push({
      x: radius * Math.cos(angle),
      y: -offset + radius * Math.sin(angle),
    });
  }
  return path;
}

function rotatePath(path, degrees) {
  if (!degrees) {
    return path;
  }
  const angle = (degrees * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return path.map(point => ({
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine,
  }));
}

function appendHole(paths, holeModifiers, ctx) {
  if (holeModifiers.length === 0) {
    return;
  }
  if (holeModifiers.length === 1) {
    const diameter = requireFinite(holeModifiers[0], 'Hole diameter', ctx.offset);
    if (diameter > 0) {
      paths.push({ exposure: 'clear', path: circlePath(0, 0, diameter / 2, ctx) });
    }
    return;
  }
  if (holeModifiers.length === 2) {
    const width = requireFinite(holeModifiers[0], 'Hole width', ctx.offset);
    const height = requireFinite(holeModifiers[1], 'Hole height', ctx.offset);
    if (width > 0 && height > 0) {
      paths.push({ exposure: 'clear', path: rectanglePath(0, 0, width, height) });
    }
    return;
  }
  fail('Too many hole modifiers', ctx.offset);
}

function instantiateCircle(modifiers, ctx) {
  const diameter = requireFinite(modifiers[0], 'Circle diameter', ctx.offset);
  const paths = [];
  if (diameter > 0) {
    paths.push({ exposure: 'dark', path: circlePath(0, 0, diameter / 2, ctx) });
  }
  appendHole(paths, modifiers.slice(1), ctx);
  return paths;
}

function instantiateRectangle(modifiers, ctx) {
  const width = requireFinite(modifiers[0], 'Rectangle width', ctx.offset);
  const height = requireFinite(modifiers[1], 'Rectangle height', ctx.offset);
  const paths = [{ exposure: 'dark', path: rectanglePath(0, 0, width, height) }];
  appendHole(paths, modifiers.slice(2), ctx);
  return paths;
}

function instantiateObround(modifiers, ctx) {
  const width = requireFinite(modifiers[0], 'Obround width', ctx.offset);
  const height = requireFinite(modifiers[1], 'Obround height', ctx.offset);
  const paths = [{ exposure: 'dark', path: obroundPath(width, height, ctx) }];
  appendHole(paths, modifiers.slice(2), ctx);
  return paths;
}

function instantiatePolygon(modifiers, ctx) {
  const diameter = requireFinite(modifiers[0], 'Polygon diameter', ctx.offset);
  const vertices = requireFinite(modifiers[1], 'Polygon vertices', ctx.offset);
  const rotation = modifiers.length >= 3
    ? requireFinite(modifiers[2], 'Polygon rotation', ctx.offset)
    : 0;
  const paths = [{
    exposure: 'dark',
    path: regularPolygonPath(0, 0, diameter / 2, vertices, rotation, ctx),
  }];
  appendHole(paths, modifiers.slice(3), ctx);
  return paths;
}

function tokenizeExpression(text, offset) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '$') {
      index += 1;
      const start = index;
      while (index < text.length && text[index] >= '0' && text[index] <= '9') {
        index += 1;
      }
      if (start === index) {
        fail('Invalid variable', offset);
      }
      tokens.push({ type: 'var', index: Number(text.slice(start, index)) });
      continue;
    }
    if (character === '+' || character === '-' || character === '/'
      || character === '(' || character === ')') {
      tokens.push({ type: character });
      index += 1;
      continue;
    }
    if (character === 'x' || character === 'X') {
      tokens.push({ type: 'x' });
      index += 1;
      continue;
    }
    if ((character >= '0' && character <= '9') || character === '.') {
      const start = index;
      let sawDot = false;
      let sawDigit = false;
      while (index < text.length) {
        const next = text[index];
        if (next >= '0' && next <= '9') {
          sawDigit = true;
          index += 1;
          continue;
        }
        if (next === '.' && !sawDot) {
          sawDot = true;
          index += 1;
          continue;
        }
        break;
      }
      if (!sawDigit) {
        fail('Invalid number', offset);
      }
      const value = Number(text.slice(start, index));
      if (!Number.isFinite(value)) {
        fail('Non-finite aperture value', offset);
      }
      tokens.push({ type: 'number', value });
      continue;
    }
    fail(`Unexpected character "${character}" in expression`, offset);
  }
  return tokens;
}

function evaluateExpression(text, vars, offset) {
  const tokens = tokenizeExpression(text, offset);
  let position = 0;

  const peek = () => tokens[position];
  const consume = () => {
    const token = tokens[position];
    position += 1;
    return token;
  };

  const parsePrimary = () => {
    const token = peek();
    if (!token) {
      fail('Unexpected end of expression', offset);
    }
    if (token.type === 'number') {
      consume();
      return token.value;
    }
    if (token.type === 'var') {
      consume();
      if (!vars.has(token.index)) {
        fail(`Undefined variable $${token.index}`, offset);
      }
      return requireFinite(vars.get(token.index), `$${token.index}`, offset);
    }
    if (token.type === '(') {
      consume();
      const value = parseExpression();
      if (!peek() || peek().type !== ')') {
        fail('Missing closing parenthesis', offset);
      }
      consume();
      return value;
    }
    fail('Unexpected token in expression', offset);
  };

  const parseUnary = () => {
    const token = peek();
    if (token && (token.type === '+' || token.type === '-')) {
      consume();
      const value = parseUnary();
      return token.type === '-' ? -value : value;
    }
    return parsePrimary();
  };

  const parseTerm = () => {
    let value = parseUnary();
    while (peek() && (peek().type === 'x' || peek().type === '/')) {
      const operator = consume().type;
      const right = parseUnary();
      if (operator === 'x') {
        value *= right;
      } else {
        if (right === 0) {
          fail('Division by zero', offset);
        }
        value /= right;
      }
    }
    return value;
  };

  const parseExpression = () => {
    let value = parseTerm();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const operator = consume().type;
      const right = parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };

  const value = parseExpression();
  if (position !== tokens.length) {
    fail('Unexpected trailing expression tokens', offset);
  }
  return requireFinite(value, 'Expression', offset);
}

function exposureOf(value, offset) {
  if (value === 0) {
    return 'clear';
  }
  if (value === 1) {
    return 'dark';
  }
  fail(`Invalid exposure ${value}`, offset);
}

function emitPrimitive(exposure, path, rotation, ctx) {
  ensureVertexCount(path.length, ctx);
  return [{ exposure, path: rotatePath(path, rotation) }];
}

function requireParamCount(values, min, max, name, offset) {
  if (values.length < min || values.length > max) {
    fail(`${name} primitive has ${values.length} parameters`, offset);
  }
}

function primitiveCircle(values, ctx) {
  requireParamCount(values, 4, 5, 'Circle', ctx.offset);
  const exposure = exposureOf(values[0], ctx.offset);
  const diameter = values[1];
  if (diameter === 0) {
    return [];
  }
  if (diameter < 0) {
    fail('Circle diameter must be non-negative', ctx.offset);
  }
  return emitPrimitive(
    exposure,
    circlePath(values[2], values[3], diameter / 2, ctx),
    values[4] ?? 0,
    ctx,
  );
}

function primitiveOutline(values, ctx) {
  if (values.length < 8) {
    fail('Outline primitive is incomplete', ctx.offset);
  }
  const exposure = exposureOf(values[0], ctx.offset);
  const vertices = Math.round(values[1]);
  if (vertices < 3) {
    fail('Outline requires at least 3 vertices', ctx.offset);
  }
  ensureVertexCount(vertices, ctx);
  const expected = 2 + (vertices + 1) * 2 + 1;
  if (values.length !== expected) {
    fail('Outline primitive has the wrong number of coordinates', ctx.offset);
  }
  const path = [];
  for (let index = 0; index < vertices; index += 1) {
    const base = 2 + index * 2;
    path.push({ x: values[base], y: values[base + 1] });
  }
  return emitPrimitive(exposure, path, values[values.length - 1], ctx);
}

function primitivePolygon(values, ctx) {
  requireParamCount(values, 6, 6, 'Polygon', ctx.offset);
  return emitPrimitive(
    exposureOf(values[0], ctx.offset),
    regularPolygonPath(values[2], values[3], values[4] / 2, values[1], 0, ctx),
    values[5],
    ctx,
  );
}

function primitiveVectorLine(values, ctx) {
  requireParamCount(values, 7, 7, 'Vector line', ctx.offset);
  const [, width, x1, y1, x2, y2, rotation] = values;
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length === 0 || width === 0) {
    return [];
  }
  const nx = (-(y2 - y1) / length) * (width / 2);
  const ny = ((x2 - x1) / length) * (width / 2);
  const path = [
    { x: x1 + nx, y: y1 + ny },
    { x: x2 + nx, y: y2 + ny },
    { x: x2 - nx, y: y2 - ny },
    { x: x1 - nx, y: y1 - ny },
  ];
  return emitPrimitive(exposureOf(values[0], ctx.offset), path, rotation, ctx);
}

function primitiveCenterLine(values, ctx) {
  requireParamCount(values, 6, 6, 'Center line', ctx.offset);
  return emitPrimitive(
    exposureOf(values[0], ctx.offset),
    rectanglePath(values[3], values[4], values[1], values[2]),
    values[5],
    ctx,
  );
}

function primitiveLowerLeftLine(values, ctx) {
  requireParamCount(values, 6, 6, 'Lower-left line', ctx.offset);
  return emitPrimitive(
    exposureOf(values[0], ctx.offset),
    rectanglePath(values[3] + values[1] / 2, values[4] + values[2] / 2, values[1], values[2]),
    values[5],
    ctx,
  );
}

function primitiveMoire(values, ctx) {
  requireParamCount(values, 9, 9, 'Moire', ctx.offset);
  const [cx, cy, outerDia, ringThickness, gap, maxRings, crossThickness, crossLength, rotation] = values;
  const paths = [];
  let outer = outerDia;
  const rings = Math.max(0, Math.round(maxRings));
  for (let index = 0; index < rings && outer > 0; index += 1) {
    paths.push({ exposure: 'dark', path: circlePath(cx, cy, outer / 2, ctx) });
    const inner = outer - 2 * ringThickness;
    if (inner > 0) {
      paths.push({ exposure: 'clear', path: circlePath(cx, cy, inner / 2, ctx) });
      outer = inner - 2 * gap;
    } else {
      break;
    }
  }
  if (crossThickness > 0 && crossLength > 0) {
    paths.push({ exposure: 'dark', path: rectanglePath(cx, cy, crossLength, crossThickness) });
    paths.push({ exposure: 'dark', path: rectanglePath(cx, cy, crossThickness, crossLength) });
  }
  return paths.map(item => ({
    exposure: item.exposure,
    path: rotatePath(item.path, rotation),
  }));
}

function primitiveThermal(values, ctx) {
  requireParamCount(values, 6, 6, 'Thermal', ctx.offset);
  const [cx, cy, outerDia, innerDia, gap, rotation] = values;
  const paths = [
    { exposure: 'dark', path: circlePath(cx, cy, outerDia / 2, ctx) },
  ];
  if (innerDia > 0) {
    paths.push({ exposure: 'clear', path: circlePath(cx, cy, innerDia / 2, ctx) });
  }
  if (gap > 0 && outerDia > 0) {
    const extent = outerDia / 2;
    paths.push({ exposure: 'clear', path: rectanglePath(cx + extent / 2, cy, extent, gap) });
    paths.push({ exposure: 'clear', path: rectanglePath(cx - extent / 2, cy, extent, gap) });
    paths.push({ exposure: 'clear', path: rectanglePath(cx, cy + extent / 2, gap, extent) });
    paths.push({ exposure: 'clear', path: rectanglePath(cx, cy - extent / 2, gap, extent) });
  }
  return paths.map(item => ({
    exposure: item.exposure,
    path: rotatePath(item.path, rotation),
  }));
}

function isCommentPrimitive(raw) {
  return /^0(?:$|[^0-9])/.test(raw);
}

function handleAssignment(raw, vars, offset) {
  const equals = raw.indexOf('=');
  if (equals < 1) {
    fail('Invalid variable assignment', offset);
  }
  const name = raw.slice(0, equals);
  const match = /^\$(\d+)$/.exec(name);
  if (!match) {
    fail('Invalid variable name', offset);
  }
  vars.set(Number(match[1]), evaluateExpression(raw.slice(equals + 1), vars, offset));
}

function expandPrimitive(raw, vars, ctx) {
  if (raw.startsWith('$')) {
    handleAssignment(raw, vars, ctx.offset);
    return [];
  }
  if (isCommentPrimitive(raw)) {
    return [];
  }
  const fields = raw.split(',');
  const values = fields.map(field => evaluateExpression(field, vars, ctx.offset));
  const code = values[0];
  const params = values.slice(1);
  switch (code) {
    case 1:
      return primitiveCircle(params, ctx);
    case 4:
      return primitiveOutline(params, ctx);
    case 5:
      return primitivePolygon(params, ctx);
    case 6:
      return primitiveMoire(params, ctx);
    case 7:
      return primitiveThermal(params, ctx);
    case 20:
      return primitiveVectorLine(params, ctx);
    case 21:
      return primitiveCenterLine(params, ctx);
    case 22:
      return primitiveLowerLeftLine(params, ctx);
    default:
      fail(`Unsupported aperture macro primitive ${code}`, ctx.offset);
  }
}

function instantiateMacro(definition, ctx) {
  const vars = new Map();
  definition.modifiers.forEach((value, index) => {
    vars.set(index + 1, requireFinite(value, `$${index + 1}`, ctx.offset));
  });
  const paths = [];
  for (const primitive of definition.primitives) {
    paths.push(...expandPrimitive(primitive, vars, ctx));
  }
  return paths;
}

function scalePaths(paths, unitScale) {
  if (unitScale === 1) {
    return paths;
  }
  return paths.map(item => ({
    exposure: item.exposure,
    path: item.path.map(point => ({
      x: point.x * unitScale,
      y: point.y * unitScale,
    })),
  }));
}

export function instantiateAperture(definition, options = {}) {
  const unitScale = (options.units ?? definition.units) === 'inch' ? 25.4 : 1;
  const ctx = {
    tolerance: options.chordToleranceMm ?? DEFAULT_CHORD_TOLERANCE_MM,
    maxVertices: options.maxVertices ?? DEFAULT_MAX_VERTICES,
    offset: definition.offset ?? definition.macroOffset,
    unitScale,
  };
  let paths;
  switch (definition.kind) {
    case 'circle':
      paths = instantiateCircle(definition.modifiers, ctx);
      break;
    case 'rectangle':
      paths = instantiateRectangle(definition.modifiers, ctx);
      break;
    case 'obround':
      paths = instantiateObround(definition.modifiers, ctx);
      break;
    case 'polygon':
      paths = instantiatePolygon(definition.modifiers, ctx);
      break;
    case 'macro':
      paths = instantiateMacro(definition, ctx);
      break;
    default:
      fail(`Unsupported aperture kind ${definition.kind}`, ctx.offset);
  }
  return scalePaths(paths, unitScale);
}
