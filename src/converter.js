import { writeDxf } from './dxf/writer.js';
import { parseExcellon } from './excellon/parser.js';
import { classifyInputName } from './files/file-policy.js';
import { parseGerber } from './gerber/index.js';
import { parseHpgl } from './hpgl/parser.js';
import { prepareInputSet } from './manufacturing/input-set.js';

const DRAWABLE_KINDS = new Set(['hpgl', 'gerber', 'excellon']);
const STROKE_MODES = new Set(['outline', 'centerline']);

function validateInput(input, index) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`Input ${index} must be an object`);
  }
  if (typeof input.name !== 'string') {
    throw new TypeError(`Input ${index} name must be a string`);
  }
  if (typeof input.layerName !== 'string') {
    throw new TypeError(`Input ${index} layerName must be a string`);
  }

  const readFailure = input.data === null && typeof input.readError === 'string';
  if (!(input.data instanceof Uint8Array) && !readFailure) {
    throw new TypeError(`Input ${index} data must be a Uint8Array`);
  }
}

function errorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  const message = String(error);
  return message && message !== '[object Object]'
    ? message
    : 'Unexpected file conversion failure';
}

function fileDiagnostic(fileName, message) {
  return {
    severity: 'error',
    fileName,
    command: 'FILE',
    offset: 0,
    message,
    skippedCommands: 0,
    skippedShapes: 0,
  };
}

function failedFileResult(input, error) {
  return {
    geometries: [],
    file: {
      name: input.name,
      layerName: input.layerName,
      geometryCount: 0,
      errorCount: 1,
      warningCount: 0,
      diagnostics: [fileDiagnostic(input.name, errorMessage(error))],
    },
  };
}

function leafName(value) {
  return String(value).split(/[\\/]/).pop() ?? '';
}

function namesEqual(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function jobLeaf(job) {
  return leafName(job.input.path || job.input.name);
}

function assignPreparedDiagnostics(jobs, diagnostics) {
  const extras = jobs.map(() => []);
  const leftover = [];
  const cursor = new Map();

  function takeNext(key, indexes) {
    const next = cursor.get(key) ?? 0;
    if (next >= indexes.length) {
      return null;
    }
    cursor.set(key, next + 1);
    return indexes[next];
  }

  for (const diagnostic of diagnostics) {
    const fileName = diagnostic.fileName;
    const pathHits = jobs
      .map((job, index) => index)
      .filter(index => namesEqual(jobs[index].input.path, fileName));
    if (pathHits.length === 1) {
      extras[pathHits[0]].push(diagnostic);
      continue;
    }
    if (pathHits.length > 1) {
      const index = takeNext(`path:${String(fileName).toLowerCase()}`, pathHits);
      if (index != null) {
        extras[index].push(diagnostic);
        continue;
      }
      leftover.push(diagnostic);
      continue;
    }

    const leafHits = jobs
      .map((job, index) => index)
      .filter(index => namesEqual(jobLeaf(jobs[index]), fileName));
    if (leafHits.length === 1) {
      extras[leafHits[0]].push(diagnostic);
      continue;
    }
    if (leafHits.length > 1) {
      const index = takeNext(`leaf:${String(fileName).toLowerCase()}`, leafHits);
      if (index != null) {
        extras[index].push(diagnostic);
        continue;
      }
    }
    leftover.push(diagnostic);
  }

  return { extras, leftover };
}

function resolveLayerName(input, fallback) {
  return input.layerName !== '' ? input.layerName : fallback;
}

function defaultLayerName(input) {
  return leafName(input.name).replace(/\.[^.]+$/, '') || 'layer';
}

function normalizeInput(input) {
  return {
    ...input,
    kind: input.kind ?? classifyInputName(input.name),
    path: input.path ?? input.name,
  };
}

function isReadFailure(input) {
  return input.data === null && typeof input.readError === 'string';
}

function parseDrawable(input, drawable, strokeMode) {
  const layerName = resolveLayerName(input, drawable?.effectiveLayerName ?? defaultLayerName(input));
  const context = { fileName: input.name, layerName };
  const kind = drawable?.kind ?? input.kind;
  if (kind === 'gerber') {
    return parseGerber(input.data, context, { strokeMode });
  }
  if (kind === 'excellon') {
    return parseExcellon(input.data, context, {
      defaults: drawable?.parseOptions?.defaults,
      unknownToolMarkerMm: 1,
    });
  }
  return parseHpgl(input.data, context);
}

function withPreparedDiagnostics(file, extra) {
  let errorCount = file.errorCount;
  let warningCount = file.warningCount;
  for (const diagnostic of extra) {
    if (diagnostic.severity === 'error') {
      errorCount += 1;
    } else {
      warningCount += 1;
    }
  }
  return {
    ...file,
    errorCount,
    warningCount,
    diagnostics: [...file.diagnostics, ...extra],
  };
}

/**
 * Parse ordered HPGL, Gerber, and Excellon inputs into shared geometries.
 *
 * Sidecars are consumed for metadata and omitted from `files` / `layers`.
 * Worker code may pass the internal read-failure sentinel
 * `{ name, layerName, data: null, readError: string }`.
 */
export function parseInputs(inputs, options = {}) {
  if (!Array.isArray(inputs)) {
    throw new TypeError('Conversion inputs must be an array');
  }
  const strokeMode = options.strokeMode ?? 'outline';
  if (!STROKE_MODES.has(strokeMode)) {
    throw new RangeError('Gerber strokeMode must be outline or centerline');
  }
  inputs.forEach(validateInput);

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const normalized = inputs.map(normalizeInput);
  const prepared = prepareInputSet(normalized.filter(input => !isReadFailure(input)));
  const pendingDrawables = [...prepared.drawableInputs];

  const jobs = [];
  for (const input of normalized) {
    if (isReadFailure(input)) {
      jobs.push({ input, drawable: null });
      continue;
    }
    if (!DRAWABLE_KINDS.has(input.kind)) {
      continue;
    }
    jobs.push({ input, drawable: pendingDrawables.shift() ?? input });
  }

  const assigned = assignPreparedDiagnostics(jobs, prepared.diagnostics);
  const layers = [];
  const geometries = [];
  const files = [];

  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    const { input, drawable } = jobs[jobIndex];
    const layerName = resolveLayerName(
      input,
      drawable?.effectiveLayerName ?? defaultLayerName(input),
    );
    let converted;

    try {
      if (isReadFailure(input)) {
        throw new Error(input.readError);
      }
      const parsed = parseDrawable(input, drawable, strokeMode);
      converted = {
        geometries: parsed.geometries,
        file: {
          name: input.name,
          layerName,
          geometryCount: parsed.summary.geometryCount,
          errorCount: parsed.summary.errorCount,
          warningCount: parsed.summary.warningCount,
          diagnostics: parsed.diagnostics,
        },
      };
    } catch (error) {
      converted = failedFileResult({ ...input, layerName }, error);
    }

    converted.file = withPreparedDiagnostics(converted.file, assigned.extras[jobIndex]);
    geometries.push(...converted.geometries);
    files.push(converted.file);
    layers.push(converted.file.layerName);
    onProgress({
      fileName: converted.file.name,
      index: jobIndex + 1,
      total: jobs.length,
      geometryCount: converted.file.geometryCount,
      errorCount: converted.file.errorCount,
      warningCount: converted.file.warningCount,
    });
  }

  let leftoverErrorCount = 0;
  let leftoverWarningCount = 0;
  for (const diagnostic of assigned.leftover) {
    if (diagnostic.severity === 'error') {
      leftoverErrorCount += 1;
    } else {
      leftoverWarningCount += 1;
    }
  }

  const totals = {
    fileCount: files.length,
    geometryCount: 0,
    errorCount: leftoverErrorCount,
    warningCount: leftoverWarningCount,
  };
  for (const file of files) {
    totals.geometryCount += file.geometryCount;
    totals.errorCount += file.errorCount;
    totals.warningCount += file.warningCount;
  }

  return { files, geometries, layers, totals };
}

/**
 * Convert ordered HPGL/Gerber/Excellon byte inputs into one DXF.
 *
 * Worker code may pass the internal read-failure sentinel
 * `{ name, layerName, data: null, readError: string }`. Normal callers must
 * provide `Uint8Array` data.
 */
export async function convertInputs(inputs, onProgress, options = {}) {
  if (!Array.isArray(inputs)) {
    throw new TypeError('Conversion inputs must be an array');
  }
  if (typeof onProgress !== 'function') {
    throw new TypeError('Conversion progress callback must be a function');
  }

  const parsed = parseInputs(inputs, { ...options, onProgress });
  const text = writeDxf({ layers: parsed.layers, geometries: parsed.geometries }).join('');
  const encoded = new TextEncoder().encode(text);
  const buffer = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );

  return { buffer, files: parsed.files, totals: parsed.totals };
}
