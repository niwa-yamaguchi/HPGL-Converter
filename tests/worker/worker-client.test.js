import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { handleConversionMessage } from '../../src/worker/converter.worker.js';
import { createConversionJob } from '../../src/worker/worker-client.js';

class FakeWorker {
  constructor() {
    this.messages = [];
    this.terminateCount = 0;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminateCount += 1;
  }

  emit(data) {
    this.onmessage?.({ data });
  }
}

const file = (name, source = '') => {
  const blob = new Blob([source]);
  return { name, blob, size: blob.size, identity: `id:${name}` };
};

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setup(options = {}) {
  const workers = [];
  const workerFactory = vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { workers, workerFactory, options: { workerFactory, ...options } };
}

describe('createConversionJob', () => {
  it('creates a fresh worker and request ID, posts files, and forwards matching progress', async () => {
    const onProgress = vi.fn();
    const harness = setup({ onProgress });
    const files = [file('a.hpgl')];
    const first = createConversionJob(files, ['a'], harness.options);
    const second = createConversionJob(files, ['a'], harness.options);
    const [firstWorker, secondWorker] = harness.workers;
    const firstRequest = firstWorker.messages[0];
    const secondRequest = secondWorker.messages[0];

    expect(harness.workerFactory).toHaveBeenCalledTimes(2);
    expect(firstRequest).toMatchObject({
      type: 'convert',
      files: [{ name: 'a.hpgl', blob: files[0].blob }],
      layerNames: ['a'],
    });
    expect(firstRequest.files[0]).not.toHaveProperty('identity');
    expect(typeof firstRequest.requestId).toBe('string');
    expect(firstRequest.requestId).not.toBe(secondRequest.requestId);

    firstWorker.emit({
      type: 'progress', requestId: 'another-request', event: { index: 99 },
    });
    firstWorker.emit({
      type: 'progress', requestId: firstRequest.requestId, event: { index: 1 },
    });
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({ index: 1 });

    const firstResult = { buffer: new ArrayBuffer(4), files: [], totals: {} };
    firstWorker.emit({ type: 'complete', requestId: firstRequest.requestId, result: firstResult });
    secondWorker.emit({ type: 'complete', requestId: secondRequest.requestId, result: firstResult });
    await expect(first.promise).resolves.toBe(firstResult);
    await expect(second.promise).resolves.toBe(firstResult);
    expect(firstWorker.terminateCount).toBe(1);
    expect(secondWorker.terminateCount).toBe(1);
  });

  it('rejects a matching protocol error and terminates', async () => {
    const harness = setup();
    const job = createConversionJob([file('a')], ['a'], harness.options);
    const worker = harness.workers[0];
    const { requestId } = worker.messages[0];

    worker.emit({ type: 'error', requestId, message: 'conversion failed' });

    await expect(job.promise).rejects.toThrow('conversion failed');
    expect(worker.terminateCount).toBe(1);
  });

  it('rejects native and message errors and terminates each worker', async () => {
    const nativeHarness = setup();
    const native = createConversionJob([file('a')], ['a'], nativeHarness.options);
    const nativeWorker = nativeHarness.workers[0];
    const preventDefault = vi.fn();
    nativeWorker.onerror({ message: 'native failure', preventDefault });

    await expect(native.promise).rejects.toThrow('native failure');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(nativeWorker.terminateCount).toBe(1);

    const messageHarness = setup();
    const message = createConversionJob([file('a')], ['a'], messageHarness.options);
    const messageWorker = messageHarness.workers[0];
    messageWorker.onmessageerror({});

    await expect(message.promise).rejects.toThrow(/message/i);
    expect(messageWorker.terminateCount).toBe(1);
  });

  it('cancels once with AbortError and ignores repeated or post-settlement cancel', async () => {
    const harness = setup();
    const job = createConversionJob([file('a')], ['a'], harness.options);
    const worker = harness.workers[0];

    job.cancel();
    job.cancel();
    await expect(job.promise).rejects.toMatchObject({
      name: 'AbortError', message: 'Conversion cancelled',
    });
    expect(worker.terminateCount).toBe(1);

    const doneHarness = setup();
    const done = createConversionJob([file('b')], ['b'], doneHarness.options);
    const doneWorker = doneHarness.workers[0];
    const { requestId } = doneWorker.messages[0];
    doneWorker.emit({ type: 'complete', requestId, result: { buffer: new ArrayBuffer(0) } });
    await done.promise;
    done.cancel();
    expect(doneWorker.terminateCount).toBe(1);
  });

  it.each([
    ['files array', null, [], /files.*array/i],
    ['layer array', [], null, /layerNames.*array/i],
    ['equal lengths', [file('a')], [], /same length/i],
    ['file shape', [{}], ['a'], /file/i],
    ['layer shape', [file('a')], [42], /layer/i],
    ['progress callback', [], [], /progress.*function/i, { onProgress: 42 }],
  ])('validates %s before creating a worker', (_label, files, layers, message, extra = {}) => {
    const harness = setup(extra);

    expect(() => createConversionJob(files, layers, harness.options)).toThrow(message);
    expect(harness.workerFactory).not.toHaveBeenCalled();
  });
});

describe('converter worker protocol', () => {
  it('does not start reading the second file before the first read settles', async () => {
    const firstRead = deferred();
    const firstArrayBuffer = vi.fn(() => firstRead.promise);
    const secondArrayBuffer = vi.fn(async () => (
      new TextEncoder().encode('PD0,40;PU;').buffer
    ));
    const conversion = handleConversionMessage({
      type: 'convert',
      requestId: 'sequential-read',
      files: [
        { name: 'first.hpgl', blob: { arrayBuffer: firstArrayBuffer } },
        { name: 'second.hpgl', blob: { arrayBuffer: secondArrayBuffer } },
      ],
      layerNames: ['first', 'second'],
    }, () => {});

    expect(firstArrayBuffer).toHaveBeenCalledOnce();
    expect(secondArrayBuffer).not.toHaveBeenCalled();

    firstRead.resolve(new TextEncoder().encode('PD40,0;PU;').buffer);
    await conversion;

    expect(secondArrayBuffer).toHaveBeenCalledOnce();
  });

  it('reads sequentially, isolates read failures, forwards progress, and transfers the result', async () => {
    const order = [];
    const files = [
      {
        name: 'bad.hpgl',
        blob: {
          async arrayBuffer() {
            order.push('bad:start');
            order.push('bad:end');
            throw new Error('cannot read');
          },
        },
      },
      {
        name: 'good.hpgl',
        blob: {
          async arrayBuffer() {
            order.push('good:start');
            order.push('good:end');
            return new TextEncoder().encode('SP6;PD40,0;PU;').buffer;
          },
        },
      },
    ];
    const posted = [];
    await handleConversionMessage({
      type: 'convert', requestId: 'request-7', files, layerNames: ['bad', 'good'],
    }, (...args) => posted.push(args));

    expect(order).toEqual(['bad:start', 'bad:end', 'good:start', 'good:end']);
    expect(posted.map(([message]) => message.type)).toEqual([
      'progress', 'progress', 'progress', 'progress', 'complete',
    ]);
    expect(posted[0][0]).toMatchObject({
      type: 'progress',
      requestId: 'request-7',
      event: { phase: 'reading', fileName: 'bad.hpgl', index: 1, total: 2 },
    });
    expect(posted[1][0]).toMatchObject({
      type: 'progress',
      requestId: 'request-7',
      event: { phase: 'reading', fileName: 'good.hpgl', index: 2, total: 2 },
    });
    expect(posted[2][0]).toMatchObject({
      type: 'progress', requestId: 'request-7', event: { fileName: 'bad.hpgl', index: 1 },
    });
    const [complete, transfer] = posted[4];
    expect(complete.requestId).toBe('request-7');
    expect(complete.result.files[0]).toMatchObject({ geometryCount: 0, errorCount: 1 });
    expect(complete.result.files[1]).toMatchObject({ geometryCount: 1, errorCount: 0 });
    expect(transfer).toEqual([complete.result.buffer]);
  });

  it('posts a safe error for invalid lengths', async () => {
    const posted = [];
    await handleConversionMessage({
      type: 'convert', requestId: 'bad-request', files: [file('a')], layerNames: [],
    }, (...args) => posted.push(args));

    expect(posted).toEqual([[
      { type: 'error', requestId: 'bad-request', message: expect.any(String) },
    ]]);
  });

  it('uses the inline worker import and contains no network API calls', async () => {
    const client = await readFile(new URL('../../src/worker/worker-client.js', import.meta.url), 'utf8');
    const worker = await readFile(new URL('../../src/worker/converter.worker.js', import.meta.url), 'utf8');
    const sources = `${client}\n${worker}`;
    const banned = ['fetch', 'XMLHttpRequest', 'send' + 'Beacon', 'Web' + 'Socket'];

    expect(client).toContain("import ConverterWorker from './converter.worker.js?worker&inline';");
    for (const name of banned) {
      expect(sources).not.toContain(name);
    }
    expect(sources).not.toMatch(/https?:\/\//i);
  });
});
