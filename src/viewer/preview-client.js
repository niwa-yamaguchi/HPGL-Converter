import PreviewWorker from './preview.worker.js?worker&inline';
import { toWorkerInput } from '../files/input-records.js';

let nextRequestId = 0;

function validateArguments(files, layerNames, options) {
  if (!Array.isArray(files)) {
    throw new TypeError('Preview files must be an array');
  }
  if (!Array.isArray(layerNames)) {
    throw new TypeError('Preview layerNames must be an array');
  }
  if (files.length !== layerNames.length) {
    throw new RangeError('Preview files and layerNames must have the same length');
  }
  const workerFiles = files.map((file, index) => {
    try {
      return toWorkerInput(file);
    } catch (error) {
      throw new TypeError(`Preview file ${index} is invalid`, { cause: error });
    }
  });
  layerNames.forEach((layerName, index) => {
    if (typeof layerName !== 'string') {
      throw new TypeError(`Preview layer ${index} must be a string`);
    }
  });
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Preview options must be an object');
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw new TypeError('Preview progress callback must be a function');
  }
  if (options.workerFactory !== undefined && typeof options.workerFactory !== 'function') {
    throw new TypeError('Preview workerFactory must be a function');
  }
  return workerFiles;
}

function nativeWorkerError(event) {
  if (event?.error instanceof Error) {
    return event.error;
  }
  return new Error(typeof event?.message === 'string' && event.message
    ? event.message
    : 'Preview worker failed');
}

export function createPreviewJob(files, layerNames, options = {}) {
  const workerFiles = validateArguments(files, layerNames, options);

  const workerFactory = options.workerFactory ?? (() => new PreviewWorker());
  const worker = workerFactory();
  const requestId = `preview-${Date.now()}-${nextRequestId += 1}`;
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
        : 'Preview failed';
      settle(rejectPromise, new Error(text));
    }
  };

  worker.onerror = event => {
    event?.preventDefault?.();
    settle(rejectPromise, nativeWorkerError(event));
  };

  worker.onmessageerror = () => {
    settle(rejectPromise, new Error('Preview worker message could not be decoded'));
  };

  try {
    worker.postMessage({ type: 'preview', requestId, files: workerFiles, layerNames });
  } catch (error) {
    settle(rejectPromise, error instanceof Error ? error : new Error('Worker post failed'));
  }

  return {
    promise,
    cancel() {
      settle(
        rejectPromise,
        new DOMException('Preview cancelled', 'AbortError'),
      );
    },
  };
}
