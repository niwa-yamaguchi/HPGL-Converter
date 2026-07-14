import { writeDxf } from './dxf/writer.js';
import { parseHpgl } from './hpgl/parser.js';

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

/**
 * Convert ordered HPGL byte inputs into one DXF.
 *
 * Worker code may pass the internal read-failure sentinel
 * `{ name, layerName, data: null, readError: string }`. Normal callers must
 * provide `Uint8Array` data.
 */
export async function convertInputs(inputs, onProgress) {
  if (!Array.isArray(inputs)) {
    throw new TypeError('Conversion inputs must be an array');
  }
  if (typeof onProgress !== 'function') {
    throw new TypeError('Conversion progress callback must be a function');
  }
  inputs.forEach(validateInput);

  const layers = inputs.map(input => input.layerName);
  const geometries = [];
  const files = [];
  const totals = {
    fileCount: inputs.length,
    geometryCount: 0,
    errorCount: 0,
    warningCount: 0,
  };

  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    const input = inputs[inputIndex];
    let converted;

    try {
      if (input.data === null) {
        throw new Error(input.readError);
      }
      const parsed = parseHpgl(input.data, {
        fileName: input.name,
        layerName: input.layerName,
      });
      converted = {
        geometries: parsed.geometries,
        file: {
          name: input.name,
          layerName: input.layerName,
          geometryCount: parsed.summary.geometryCount,
          errorCount: parsed.summary.errorCount,
          warningCount: parsed.summary.warningCount,
          diagnostics: parsed.diagnostics,
        },
      };
    } catch (error) {
      converted = failedFileResult(input, error);
    }

    geometries.push(...converted.geometries);
    files.push(converted.file);
    totals.geometryCount += converted.file.geometryCount;
    totals.errorCount += converted.file.errorCount;
    totals.warningCount += converted.file.warningCount;
    onProgress({
      fileName: converted.file.name,
      index: inputIndex + 1,
      total: inputs.length,
      geometryCount: converted.file.geometryCount,
      errorCount: converted.file.errorCount,
      warningCount: converted.file.warningCount,
    });
  }

  const text = writeDxf({ layers, geometries }).join('');
  const encoded = new TextEncoder().encode(text);
  const buffer = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );

  return { buffer, files, totals };
}
