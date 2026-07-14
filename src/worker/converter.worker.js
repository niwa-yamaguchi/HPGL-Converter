import { convertInputs } from '../converter.js';

function safeMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Conversion failed';
}

function validateRequest(message) {
  if (message === null || typeof message !== 'object' || message.type !== 'convert') {
    throw new TypeError('Invalid conversion request');
  }
  if (typeof message.requestId !== 'string') {
    throw new TypeError('Conversion requestId must be a string');
  }
  if (!Array.isArray(message.files) || !Array.isArray(message.layerNames)) {
    throw new TypeError('Conversion files and layerNames must be arrays');
  }
  if (message.files.length !== message.layerNames.length) {
    throw new RangeError('Conversion files and layerNames must have the same length');
  }
}

export async function handleConversionMessage(message, post) {
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
          || typeof file.arrayBuffer !== 'function') {
        throw new TypeError(`Conversion file ${index} is invalid`);
      }
      if (typeof layerName !== 'string') {
        throw new TypeError(`Conversion layerName ${index} must be a string`);
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
        const buffer = await file.arrayBuffer();
        inputs.push({ name: file.name, layerName, data: new Uint8Array(buffer) });
      } catch (error) {
        inputs.push({
          name: file.name,
          layerName,
          data: null,
          readError: safeMessage(error),
        });
      }
    }

    const result = await convertInputs(inputs, event => {
      post({ type: 'progress', requestId, event });
    });
    post({ type: 'complete', requestId, result }, [result.buffer]);
  } catch (error) {
    post({ type: 'error', requestId, message: safeMessage(error) });
  }
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', event => {
    void handleConversionMessage(event.data, (...args) => self.postMessage(...args));
  });
}
