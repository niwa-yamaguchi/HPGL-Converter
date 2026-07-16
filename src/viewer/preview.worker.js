import { parseHpgl } from '../hpgl/parser.js';

function safeMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Preview failed';
}

function validateRequest(message) {
  if (message === null || typeof message !== 'object' || message.type !== 'preview') {
    throw new TypeError('Invalid preview request');
  }
  if (typeof message.requestId !== 'string') {
    throw new TypeError('Preview requestId must be a string');
  }
  if (!Array.isArray(message.files) || !Array.isArray(message.layerNames)) {
    throw new TypeError('Preview files and layerNames must be arrays');
  }
  if (message.files.length !== message.layerNames.length) {
    throw new RangeError('Preview files and layerNames must have the same length');
  }
}

function failedFile(fileName, layerName, error) {
  return {
    name: fileName,
    layerName,
    geometries: [],
    geometryCount: 0,
    errorCount: 1,
    warningCount: 0,
    diagnostics: [{
      severity: 'error',
      fileName,
      command: 'FILE',
      offset: 0,
      message: safeMessage(error),
      skippedCommands: 1,
      skippedShapes: 0,
    }],
  };
}

export async function handlePreviewMessage(message, post) {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : '';

  try {
    validateRequest(message);
    if (typeof post !== 'function') {
      throw new TypeError('Worker post callback must be a function');
    }

    const files = [];
    for (let index = 0; index < message.files.length; index += 1) {
      const file = message.files[index];
      const layerName = message.layerNames[index];
      if (file === null || typeof file !== 'object' || typeof file.name !== 'string'
          || typeof file.arrayBuffer !== 'function') {
        throw new TypeError(`Preview file ${index} is invalid`);
      }
      if (typeof layerName !== 'string') {
        throw new TypeError(`Preview layerName ${index} must be a string`);
      }

      const progress = phase => post({
        type: 'progress',
        requestId,
        event: {
          phase,
          fileName: file.name,
          index: index + 1,
          total: message.files.length,
        },
      });

      progress('reading');
      try {
        const parsed = parseHpgl(new Uint8Array(await file.arrayBuffer()), {
          fileName: file.name,
          layerName,
        });
        files.push({
          name: file.name,
          layerName,
          geometries: parsed.geometries,
          geometryCount: parsed.summary.geometryCount,
          errorCount: parsed.summary.errorCount,
          warningCount: parsed.summary.warningCount,
          diagnostics: parsed.diagnostics,
        });
      } catch (error) {
        files.push(failedFile(file.name, layerName, error));
      }
      progress('parsed');
    }

    post({ type: 'complete', requestId, result: { files } });
  } catch (error) {
    post({ type: 'error', requestId, message: safeMessage(error) });
  }
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', event => {
    void handlePreviewMessage(event.data, (...args) => self.postMessage(...args));
  });
}
