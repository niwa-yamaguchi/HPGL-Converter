import ConverterWorker from './converter.worker.js?worker&inline';

let nextRequestId = 0;

function validateArguments(files, layerNames, options) {
  if (!Array.isArray(files)) {
    throw new TypeError('Conversion files must be an array');
  }
  if (!Array.isArray(layerNames)) {
    throw new TypeError('Conversion layerNames must be an array');
  }
  if (files.length !== layerNames.length) {
    throw new RangeError('Conversion files and layerNames must have the same length');
  }
  files.forEach((file, index) => {
    if (file === null || typeof file !== 'object' || typeof file.name !== 'string'
        || typeof file.arrayBuffer !== 'function') {
      throw new TypeError(`Conversion file ${index} is invalid`);
    }
  });
  layerNames.forEach((layerName, index) => {
    if (typeof layerName !== 'string') {
      throw new TypeError(`Conversion layer ${index} must be a string`);
    }
  });
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Conversion options must be an object');
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw new TypeError('Conversion progress callback must be a function');
  }
  if (options.workerFactory !== undefined && typeof options.workerFactory !== 'function') {
    throw new TypeError('Conversion workerFactory must be a function');
  }
}

function nativeWorkerError(event) {
  if (event?.error instanceof Error) {
    return event.error;
  }
  return new Error(typeof event?.message === 'string' && event.message
    ? event.message
    : 'Conversion worker failed');
}

export function createConversionJob(files, layerNames, options = {}) {
  validateArguments(files, layerNames, options);

  const workerFactory = options.workerFactory ?? (() => new ConverterWorker());
  const worker = workerFactory();
  const requestId = `conversion-${Date.now()}-${nextRequestId += 1}`;
  let settled = false;
  let resolvePromise;
  let rejectPromise;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  function settle(action, value) {
    if (settled) {
      return;
    }
    settled = true;
    worker.terminate();
    action(value);
  }

  worker.onmessage = event => {
    const message = event.data;
    if (message === null || typeof message !== 'object' || message.requestId !== requestId) {
      return;
    }
    if (message.type === 'progress') {
      options.onProgress?.(message.event);
      return;
    }
    if (message.type === 'complete') {
      settle(resolvePromise, message.result);
      return;
    }
    if (message.type === 'error') {
      const text = typeof message.message === 'string' && message.message
        ? message.message
        : 'Conversion failed';
      settle(rejectPromise, new Error(text));
    }
  };

  worker.onerror = event => {
    event?.preventDefault?.();
    settle(rejectPromise, nativeWorkerError(event));
  };

  worker.onmessageerror = () => {
    settle(rejectPromise, new Error('Conversion worker message could not be decoded'));
  };

  try {
    worker.postMessage({ type: 'convert', requestId, files, layerNames });
  } catch (error) {
    settle(rejectPromise, error instanceof Error ? error : new Error('Worker post failed'));
  }

  return {
    promise,
    cancel() {
      settle(
        rejectPromise,
        new DOMException('Conversion cancelled', 'AbortError'),
      );
    },
  };
}
