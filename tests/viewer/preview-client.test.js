import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createPreviewJob } from '../../src/viewer/preview-client.js';
import { handlePreviewMessage } from '../../src/viewer/preview.worker.js';

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

const file = (name, source = '') => ({
  name,
  arrayBuffer: async () => new TextEncoder().encode(source).buffer,
});

function setup(options = {}) {
  const worker = new FakeWorker();
  const workerFactory = vi.fn(() => worker);
  return { worker, workerFactory, options: { workerFactory, ...options } };
}

describe('createPreviewJob', () => {
  it('posts a preview request, forwards progress, completes, and terminates', async () => {
    const onProgress = vi.fn();
    const harness = setup({ onProgress });
    const files = [file('a.hpgl')];
    const job = createPreviewJob(files, ['a'], harness.options);
    const request = harness.worker.messages[0];

    expect(request).toMatchObject({ type: 'preview', files, layerNames: ['a'] });
    expect(typeof request.requestId).toBe('string');
    harness.worker.emit({
      type: 'progress', requestId: 'another-request', event: { index: 99 },
    });
    harness.worker.emit({
      type: 'progress', requestId: request.requestId, event: { index: 1, total: 1 },
    });
    harness.worker.emit({
      type: 'complete', requestId: request.requestId, result: { files: [] },
    });

    await expect(job.promise).resolves.toEqual({ files: [] });
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({ index: 1, total: 1 });
    expect(harness.worker.terminateCount).toBe(1);
  });

  it('cancels once with AbortError and ignores later settlement', async () => {
    const harness = setup();
    const job = createPreviewJob([file('a.hpgl')], ['a'], harness.options);
    const { requestId } = harness.worker.messages[0];

    job.cancel();
    job.cancel();
    harness.worker.emit({ type: 'complete', requestId, result: { files: [] } });

    await expect(job.promise).rejects.toMatchObject({
      name: 'AbortError', message: 'Preview cancelled',
    });
    expect(harness.worker.terminateCount).toBe(1);
  });

  it('rejects protocol, native, and message errors and terminates', async () => {
    const protocolHarness = setup();
    const protocol = createPreviewJob(
      [file('protocol.hpgl')], ['protocol'], protocolHarness.options,
    );
    const protocolRequest = protocolHarness.worker.messages[0];
    protocolHarness.worker.emit({
      type: 'error', requestId: protocolRequest.requestId, message: 'preview failed',
    });
    await expect(protocol.promise).rejects.toThrow('preview failed');
    expect(protocolHarness.worker.terminateCount).toBe(1);

    const nativeHarness = setup();
    const native = createPreviewJob([file('native.hpgl')], ['native'], nativeHarness.options);
    const nativeError = new Error('native failure');
    const preventDefault = vi.fn();
    nativeHarness.worker.onerror({ error: nativeError, preventDefault });
    await expect(native.promise).rejects.toBe(nativeError);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(nativeHarness.worker.terminateCount).toBe(1);

    const messageHarness = setup();
    const message = createPreviewJob([file('message.hpgl')], ['message'], messageHarness.options);
    messageHarness.worker.onmessageerror({});
    await expect(message.promise).rejects.toThrow(/message/i);
    expect(messageHarness.worker.terminateCount).toBe(1);
  });

  it.each([
    ['files array', null, [], /files.*array/i],
    ['layerNames array', [], null, /layerNames.*array/i],
    ['equal lengths', [file('a.hpgl')], [], /same length/i],
    ['file shape', [{}], ['a'], /file/i],
    ['layer shape', [file('a.hpgl')], [42], /layer/i],
    ['options object', [], [], /options.*object/i, null],
    ['progress callback', [], [], /progress.*function/i, { onProgress: 42 }],
    ['worker factory', [], [], /workerFactory.*function/i, { workerFactory: 42 }],
  ])('validates %s before creating a worker', (_label, files, layers, error, options) => {
    const workerFactory = vi.fn(() => new FakeWorker());
    const actualOptions = options === undefined ? { workerFactory } : options;

    expect(() => createPreviewJob(files, layers, actualOptions)).toThrow(error);
    expect(workerFactory).not.toHaveBeenCalled();
  });
});

describe('preview worker protocol', () => {
  it('isolates a failed file, preserves successful geometry, and continues in order', async () => {
    const order = [];
    const files = [
      {
        name: 'bad.hpgl',
        async arrayBuffer() {
          order.push('bad');
          throw new Error('cannot read');
        },
      },
      {
        name: 'good.hpgl',
        async arrayBuffer() {
          order.push('good');
          return new TextEncoder().encode('PD40,0;PU;').buffer;
        },
      },
    ];
    const posted = [];

    await handlePreviewMessage({
      type: 'preview', requestId: 'preview-7', files, layerNames: ['bad', 'good'],
    }, message => posted.push(message));

    expect(order).toEqual(['bad', 'good']);
    expect(posted.map(message => message.type)).toEqual([
      'progress', 'progress', 'progress', 'progress', 'complete',
    ]);
    expect(posted.slice(0, 4)).toMatchObject([
      {
        type: 'progress', requestId: 'preview-7',
        event: { phase: 'reading', fileName: 'bad.hpgl', index: 1, total: 2 },
      },
      {
        type: 'progress', requestId: 'preview-7',
        event: { phase: 'parsed', fileName: 'bad.hpgl', index: 1, total: 2 },
      },
      {
        type: 'progress', requestId: 'preview-7',
        event: { phase: 'reading', fileName: 'good.hpgl', index: 2, total: 2 },
      },
      {
        type: 'progress', requestId: 'preview-7',
        event: { phase: 'parsed', fileName: 'good.hpgl', index: 2, total: 2 },
      },
    ]);
    const result = posted[4].result;
    expect(result.files[0]).toMatchObject({
      name: 'bad.hpgl', layerName: 'bad', geometries: [],
      geometryCount: 0, errorCount: 1, warningCount: 0,
      diagnostics: [{
        severity: 'error', fileName: 'bad.hpgl', command: 'FILE', offset: 0,
        message: 'cannot read', skippedCommands: 1, skippedShapes: 0,
      }],
    });
    expect(result.files[1]).toMatchObject({
      name: 'good.hpgl', layerName: 'good', geometryCount: 1,
      errorCount: 0, warningCount: 0,
    });
    expect(result.files[1].geometries).toHaveLength(1);
    expect(result.files[1].geometries[0]).toMatchObject({
      type: 'line', layer: 'good', fileName: 'good.hpgl',
    });
  });

  it('posts a safe error for an invalid request', async () => {
    const posted = [];

    await handlePreviewMessage({
      type: 'preview', requestId: 'bad-request', files: [file('a.hpgl')], layerNames: [],
    }, message => posted.push(message));

    expect(posted).toEqual([{
      type: 'error', requestId: 'bad-request', message: expect.any(String),
    }]);
  });

  it('uses an inline worker and contains no network API calls', async () => {
    const client = await readFile(
      new URL('../../src/viewer/preview-client.js', import.meta.url), 'utf8',
    );
    const worker = await readFile(
      new URL('../../src/viewer/preview.worker.js', import.meta.url), 'utf8',
    );
    const sources = `${client}\n${worker}`;
    const banned = ['fetch', 'XMLHttpRequest', 'send' + 'Beacon', 'Web' + 'Socket'];

    expect(client).toContain("import PreviewWorker from './preview.worker.js?worker&inline';");
    for (const name of banned) {
      expect(sources).not.toContain(name);
    }
    expect(sources).not.toMatch(/https?:\/\//i);
  });
});
