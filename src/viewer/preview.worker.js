import { parseInputs } from '../converter.js';
import { classifyInputName } from '../files/file-policy.js';

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

function workerInput(file, layerName, data, readError) {
  const input = {
    name: file.name,
    path: file.path ?? file.name,
    kind: file.kind ?? classifyInputName(file.name),
    layerName,
    data,
  };
  if (readError !== undefined) {
    input.readError = readError;
  }
  return input;
}

export async function handlePreviewMessage(message, post) {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : '';

  try {
    validateRequest(message);
    if (typeof post !== 'function') {
      throw new TypeError('Worker post callback must be a function');
    }

    const inputs = [];
    for (let index = 0; index < message.files.length; index += 1) {
      const file = message.files[index];
      const layerName = message.layerNames[index];
      if (file === null || typeof file !== 'object' || typeof file.name !== 'string'
          || file.blob === null || typeof file.blob !== 'object'
          || typeof file.blob.arrayBuffer !== 'function') {
        throw new TypeError(`Preview file ${index} is invalid`);
      }
      if (typeof layerName !== 'string') {
        throw new TypeError(`Preview layerName ${index} must be a string`);
      }

      post({
        type: 'progress',
        requestId,
        event: {
          phase: 'reading',
          fileName: file.name,
          index: index + 1,
          total: message.files.length,
        },
      });
      try {
        const buffer = await file.blob.arrayBuffer();
        inputs.push(workerInput(file, layerName, new Uint8Array(buffer)));
      } catch (error) {
        inputs.push(workerInput(file, layerName, null, safeMessage(error)));
      }
    }

    const parsed = parseInputs(inputs, {
      strokeMode: message.options?.strokeMode ?? 'outline',
      onProgress: event => post({ type: 'progress', requestId, event }),
    });
    const files = parsed.files.map(file => ({
      ...file,
      geometries: parsed.geometries.filter(geometry => geometry.fileName === file.name),
    }));
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
