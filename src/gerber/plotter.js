import {
  difference,
  inflatePaths,
  minkowskiSum,
  translatePath,
  union,
  EndType,
  FillRule,
  JoinType,
} from 'clipper2-ts';
import { instantiateAperture } from './apertures.js';

const SCALE = 1_000_000;
const MIN_CIRCLE_SEGMENTS = 12;
const MAX_CIRCLE_SEGMENTS = 4096;
const DEFAULT_CHORD_TOLERANCE_MM = 0.01;
const DIAGNOSTIC_DETAIL_LIMIT = 100;
const IDENTITY_TRANSFORM = Object.freeze({ mirror: 'N', rotation: 0, scale: 1 });

export const DEFAULT_LIMITS = Object.freeze({
  maxPolygons: 200_000,
  maxVertices: 2_000_000,
});

class PlotLimitError extends RangeError {
  constructor(message) {
    super(message);
    this.name = 'PlotLimitError';
  }
}

function toInt(value, label = 'Gerber coordinate') {
  const scaled = Math.round(value * SCALE);
  if (!Number.isSafeInteger(scaled)) {
    throw new RangeError(`${label} exceeds the integer conversion range`);
  }
  return scaled;
}

function fromInt(value) {
  return value / SCALE;
}

function pathToClipper(path) {
  return path.map(point => ({ x: toInt(point.x), y: toInt(point.y) }));
}

function pointsToClipper(points) {
  return points.map(point => ({ x: toInt(point[0]), y: toInt(point[1]) }));
}

function clipperToPoints(path) {
  const points = path.map(point => [fromInt(point.x), fromInt(point.y)]);
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      points.pop();
    }
  }
  return points;
}

function transformOf(object) {
  return object.transform ?? IDENTITY_TRANSFORM;
}

function transformPath(path, transform) {
  const scale = transform.scale ?? 1;
  const angle = ((transform.rotation ?? 0) * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const mirror = transform.mirror ?? 'N';
  const mirrorX = mirror.includes('X');
  const mirrorY = mirror.includes('Y');
  return path.map(point => {
    let x = point.x * scale;
    let y = point.y * scale;
    if (angle) {
      const rotatedX = x * cosine - y * sine;
      const rotatedY = x * sine + y * cosine;
      x = rotatedX;
      y = rotatedY;
    }
    if (mirrorX) {
      x = -x;
    }
    if (mirrorY) {
      y = -y;
    }
    return { x, y };
  });
}

function vertexCount(paths) {
  return paths.reduce((total, path) => total + path.length, 0);
}

function enforceLimits(paths, limits) {
  if (paths.length > limits.maxPolygons || vertexCount(paths) > limits.maxVertices) {
    throw new PlotLimitError('Gerber polygon or vertex limit exceeded');
  }
}

function applyPolarity(artwork, paths, polarity) {
  if (paths.length === 0) {
    return artwork;
  }
  if (artwork.length === 0) {
    return polarity === 'dark' ? union(paths, FillRule.NonZero) : [];
  }
  return polarity === 'dark'
    ? union(artwork, paths, FillRule.NonZero)
    : difference(artwork, paths, FillRule.NonZero);
}

function circleSegmentCount(radius, tolerance) {
  if (!(radius > 0) || !(tolerance > 0) || tolerance / radius >= 2) {
    return MIN_CIRCLE_SEGMENTS;
  }
  const cosine = Math.min(1, Math.max(-1, 1 - tolerance / radius));
  const segments = Math.ceil(Math.PI / Math.acos(cosine));
  return Math.min(MAX_CIRCLE_SEGMENTS, Math.max(MIN_CIRCLE_SEGMENTS, segments));
}

function almostEqual(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1]) <= 1e-12;
}

function tessellateArc(start, end, centerOffset, clockwise, tolerance) {
  const center = [start[0] + centerOffset[0], start[1] + centerOffset[1]];
  const radius = Math.hypot(centerOffset[0], centerOffset[1]);
  if (!(radius > 0)) {
    return [start, end];
  }
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  let sweep = endAngle - startAngle;
  if (almostEqual(start, end)) {
    sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;
  } else if (clockwise) {
    if (sweep >= 0) {
      sweep -= 2 * Math.PI;
    }
  } else if (sweep <= 0) {
    sweep += 2 * Math.PI;
  }
  const fullSegments = circleSegmentCount(radius, tolerance);
  const segments = Math.max(2, Math.ceil(fullSegments * (Math.abs(sweep) / (2 * Math.PI))));
  const points = [start];
  for (let index = 1; index < segments; index += 1) {
    const angle = startAngle + (sweep * index) / segments;
    points.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle),
    ]);
  }
  if (!almostEqual(start, end)) {
    points.push(end);
  }
  return points;
}

function centerlinePoints(object, tolerance) {
  if (object.interpolation === 'linear') {
    return [object.start, object.end];
  }
  return tessellateArc(
    object.start,
    object.end,
    object.centerOffset ?? [0, 0],
    object.interpolation === 'clockwise',
    tolerance,
  );
}

function contourPoints(contour, tolerance) {
  if (contour.length === 0) {
    return [];
  }
  const points = [[...contour[0].start]];
  for (const segment of contour) {
    if (segment.interpolation === 'linear') {
      points.push([...segment.end]);
      continue;
    }
    const arc = tessellateArc(
      segment.start,
      segment.end,
      segment.centerOffset ?? [0, 0],
      segment.interpolation === 'clockwise',
      tolerance,
    );
    points.push(...arc.slice(1));
  }
  if (points.length > 1 && almostEqual(points[0], points[points.length - 1])) {
    points.pop();
  }
  return points;
}

function pathRadius(path) {
  return Math.max(0, ...path.map(point => Math.hypot(point.x, point.y)));
}

function isClosedCenterline(object) {
  return object.interpolation !== 'linear' && almostEqual(object.start, object.end);
}

function sweepCircular(centerline, radiusMm, closed) {
  if (!(radiusMm > 0) || centerline.length < 2) {
    return [];
  }
  return inflatePaths(
    [pointsToClipper(centerline)],
    radiusMm * SCALE,
    JoinType.Round,
    closed ? EndType.Polygon : EndType.Round,
    2,
    DEFAULT_CHORD_TOLERANCE_MM * SCALE,
  );
}

function sweepNonCircular(centerline, pattern, closed) {
  if (centerline.length < 2 || pattern.length < 3) {
    return [];
  }
  return minkowskiSum(pathToClipper(pattern), pointsToClipper(centerline), closed);
}

function combineAperturePaths(items) {
  let result = [];
  for (const item of items) {
    if (item.path.length < 3) {
      continue;
    }
    result = applyPolarity(result, [pathToClipper(item.path)], item.exposure);
  }
  return result;
}

function placeAt(paths, point) {
  const dx = toInt(point[0]);
  const dy = toInt(point[1]);
  if (dx === 0 && dy === 0) {
    return paths;
  }
  return paths.map(path => translatePath(path, dx, dy));
}

function metadata(context, offset) {
  return {
    layer: context.layerName,
    fileName: context.fileName,
    offset,
  };
}

function drawToStroke(object, context) {
  const common = metadata(context, object.offset);
  if (object.interpolation === 'linear') {
    return {
      type: 'line',
      points: [object.start, object.end],
      ...common,
    };
  }
  const offset = object.centerOffset ?? [0, 0];
  const center = [object.start[0] + offset[0], object.start[1] + offset[1]];
  const radius = Math.hypot(offset[0], offset[1]);
  if (!(radius > 0)) {
    return {
      type: 'line',
      points: [object.start, object.end],
      ...common,
    };
  }
  if (almostEqual(object.start, object.end)) {
    return { type: 'circle', center, radius, ...common };
  }
  const startAngle = Math.atan2(object.start[1] - center[1], object.start[0] - center[0])
    * (180 / Math.PI);
  const endAngle = Math.atan2(object.end[1] - center[1], object.end[0] - center[0])
    * (180 / Math.PI);
  let sweep = endAngle - startAngle;
  if (object.interpolation === 'clockwise') {
    if (sweep >= 0) {
      sweep -= 360;
    }
  } else if (sweep <= 0) {
    sweep += 360;
  }
  return {
    type: 'arc',
    center,
    radius,
    startAngle,
    endAngle: startAngle + sweep,
    ...common,
  };
}

function darkAperturePaths(instantiated, transform) {
  return instantiated
    .filter(item => item.exposure === 'dark')
    .map(item => ({ exposure: 'dark', path: transformPath(item.path, transform) }));
}

function plotDraw(object, definition, instantiated, chordToleranceMm) {
  const transform = transformOf(object);
  const dark = darkAperturePaths(instantiated, transform);
  if (dark.length === 0) {
    return [];
  }
  const centerline = centerlinePoints(object, chordToleranceMm);
  const closed = isClosedCenterline(object);
  const degenerateLinear = object.interpolation === 'linear'
    && (centerline.length < 2 || almostEqual(centerline[0], centerline[centerline.length - 1]));
  if (degenerateLinear) {
    return placeAt(combineAperturePaths(dark), object.start);
  }
  if (definition.kind === 'circle') {
    return sweepCircular(centerline, pathRadius(dark[0].path), closed);
  }
  let result = [];
  for (const item of dark) {
    result = applyPolarity(result, sweepNonCircular(centerline, item.path, closed), 'dark');
  }
  return result;
}

function plotFlash(object, instantiated) {
  const transform = transformOf(object);
  const transformed = instantiated.map(item => ({
    exposure: item.exposure,
    path: transformPath(item.path, transform),
  }));
  return placeAt(combineAperturePaths(transformed), object.point);
}

function plotRegion(object, chordToleranceMm) {
  const paths = (object.contours ?? [])
    .map(contour => contourPoints(contour, chordToleranceMm))
    .filter(points => points.length >= 3)
    .map(pointsToClipper);
  if (paths.length === 0) {
    return [];
  }
  return union(paths, FillRule.EvenOdd);
}

function commandName(object) {
  if (object.kind === 'flash') {
    return 'D03';
  }
  if (object.kind === 'region') {
    return 'G36';
  }
  return 'D01';
}

function isFatalPlotError(error) {
  return error instanceof PlotLimitError
    || (error instanceof RangeError && /integer conversion range/.test(error.message));
}

export function plotGerber(parsed, context, options = {}) {
  const strokeMode = options.strokeMode ?? 'outline';
  if (!['outline', 'centerline'].includes(strokeMode)) {
    throw new RangeError('Gerber strokeMode must be outline or centerline');
  }
  const chordToleranceMm = options.chordToleranceMm ?? DEFAULT_CHORD_TOLERANCE_MM;
  const limits = {
    maxPolygons: options.limits?.maxPolygons ?? DEFAULT_LIMITS.maxPolygons,
    maxVertices: options.limits?.maxVertices ?? DEFAULT_LIMITS.maxVertices,
  };
  const diagnostics = [...(parsed.diagnostics ?? [])];
  let errorCount = parsed.summary?.errorCount ?? 0;
  let warningCount = parsed.summary?.warningCount ?? 0;
  const geometries = [];
  const apertureCache = new Map();
  let artwork = [];
  let pendingPolarity = null;
  let pendingPaths = [];
  let usedCenterline = false;
  let usedFilled = false;

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

  function instantiate(definition) {
    const cached = apertureCache.get(definition.code);
    if (cached) {
      return cached;
    }
    const paths = instantiateAperture(definition, { chordToleranceMm });
    apertureCache.set(definition.code, paths);
    return paths;
  }

  function requireAperture(code) {
    const definition = parsed.apertures.get(code);
    if (!definition) {
      throw new RangeError(`Aperture D${code} is not defined`);
    }
    return definition;
  }

  function flushPolarity() {
    if (pendingPaths.length === 0) {
      return;
    }
    artwork = applyPolarity(artwork, pendingPaths, pendingPolarity);
    pendingPaths = [];
    pendingPolarity = null;
    enforceLimits(artwork, limits);
  }

  try {
    for (const object of parsed.objects ?? []) {
      try {
        if (object.kind === 'draw' && strokeMode === 'centerline') {
          flushPolarity();
          usedCenterline = true;
          geometries.push(drawToStroke(object, context));
          continue;
        }

        let paths = [];
        if (object.kind === 'draw') {
          const definition = requireAperture(object.apertureCode);
          paths = plotDraw(object, definition, instantiate(definition), chordToleranceMm);
          usedFilled = true;
        } else if (object.kind === 'flash') {
          const definition = requireAperture(object.apertureCode);
          paths = plotFlash(object, instantiate(definition));
          usedFilled = true;
        } else if (object.kind === 'region') {
          paths = plotRegion(object, chordToleranceMm);
          usedFilled = true;
        } else {
          continue;
        }
        if (pendingPolarity != null && pendingPolarity !== object.polarity) {
          flushPolarity();
        }
        pendingPolarity = object.polarity;
        pendingPaths.push(...paths);
      } catch (error) {
        if (isFatalPlotError(error)) {
          throw error;
        }
        flushPolarity();
        addDiagnostic({
          severity: 'error',
          fileName: context.fileName,
          command: commandName(object),
          offset: object.offset ?? 0,
          message: error instanceof Error ? error.message : 'Gerber plot failed',
          skippedCommands: 1,
          skippedShapes: 1,
        });
      }
    }

    flushPolarity();
    enforceLimits(artwork, limits);
    for (const path of artwork) {
      const points = clipperToPoints(path);
      if (points.length < 3) {
        continue;
      }
      geometries.push({
        type: 'polyline',
        points,
        closed: true,
        ...metadata(context, 0),
      });
    }

    if (strokeMode === 'centerline' && usedCenterline && usedFilled) {
      addDiagnostic({
        severity: 'warning',
        fileName: context.fileName,
        command: 'PLOT',
        offset: 0,
        message: 'Centerline mode mixes strokes and filled contours',
        skippedCommands: 0,
        skippedShapes: 0,
      });
    }
  } catch (error) {
    addDiagnostic({
      severity: 'error',
      fileName: context.fileName,
      command: 'PLOT',
      offset: 0,
      message: error instanceof Error ? error.message : 'Gerber plot failed',
      skippedCommands: 0,
      skippedShapes: 0,
    });
    return {
      geometries: [],
      diagnostics,
      summary: { geometryCount: 0, errorCount, warningCount },
    };
  }

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
