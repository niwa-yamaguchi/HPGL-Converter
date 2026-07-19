// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/app.js';
import { compareGeometrySets as compareGeometrySetsDefault } from '../../src/viewer/geometry.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function hpglFile(name, content = 'PA0,0;', options = {}) {
  return new File([content], name, {
    type: 'application/octet-stream',
    lastModified: 123,
    ...options,
  });
}

function zipFile(name) {
  return new File(['zip bytes'], name, {
    type: 'application/zip',
    lastModified: 789,
  });
}

function inputRecord(name, identity = `id:${name}`) {
  const blob = new Blob(['PU;']);
  return { name, blob, size: blob.size, identity };
}

function sourceResult({
  sourceName,
  kind = 'zip',
  items = [],
  ignored = {},
  error = null,
}) {
  return {
    sourceName,
    kind,
    items,
    ignored: {
      directories: 0,
      unsupported: 0,
      nestedArchives: 0,
      unsafePaths: 0,
      ...ignored,
    },
    error,
  };
}

function setInputFiles(input, files) {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function dropFiles(zone, files) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  zone.dispatchEvent(event);
}

function deferredJob() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, cancel: vi.fn(), resolve, reject };
}

function line(points) {
  return { type: 'line', points };
}

const emptyPreviewJob = vi.fn(() => ({
  promise: Promise.resolve({ files: [] }),
  cancel: vi.fn(),
}));

function previewResult(files) {
  return {
    files: files.map((file, index) => ({
      name: file.name,
      layerName: file.name.replace(/\.[^.]+$/, ''),
      geometries: [line([[index, 0], [index + 1, 1]])],
      geometryCount: 1,
      errorCount: 0,
      warningCount: 0,
      diagnostics: [],
    })),
  };
}

function result({ errors = 0, warnings = 0, diagnostics = [] } = {}) {
  return {
    buffer: new Uint8Array([0, 1, 2]).buffer,
    totals: {
      fileCount: 1,
      geometryCount: 3,
      errorCount: errors,
      warningCount: warnings,
    },
    files: [{
      name: 'sample.hpgl',
      layerName: 'sample',
      geometryCount: 3,
      errorCount: errors,
      warningCount: warnings,
      diagnostics,
    }],
  };
}

describe('mountApp', () => {
  let mounted;

  function mount(deps = {}) {
    mounted = mountApp(document.querySelector('#test-root'), {
      createPreviewJob: emptyPreviewJob,
      renderViewer: vi.fn(),
      ...deps,
    });
    return mounted;
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="test-root"></div>';
    URL.createObjectURL = vi.fn(() => 'blob:test-download');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    emptyPreviewJob.mockClear();
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => {
      queueMicrotask(() => callback(0));
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    mounted?.destroy();
    mounted = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the private local workflow with one native file-picker tab stop', () => {
    mount({ createConversionJob: vi.fn() });

    expect(document.body.textContent).toContain('HPGL → DXF Converter');
    expect(document.body.textContent).toContain('ファイルは外部へ送信されません');
    expect(document.body.textContent).toContain('.hpgl');
    expect(document.body.textContent).toContain('40 HPGL単位 = 1 mm');
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="progress"]').getAttribute('aria-label'))
      .toBe('変換進捗');
    expect(document.querySelector('[data-testid="convert-button"]').disabled).toBe(true);

    const input = document.querySelector('[data-testid="file-input"]');
    expect(input.getAttribute('aria-label')).toBe('HPGLまたはZIPファイルを選択');
    expect(input.hidden || input.tabIndex === -1).toBe(true);
    expect(document.querySelector('[data-testid="output-name"]').value).toBe('converted.dxf');
    const click = vi.spyOn(input, 'click');
    const zone = document.querySelector('[data-testid="drop-zone"]');
    expect(zone).toBeInstanceOf(HTMLButtonElement);
    expect(zone.type).toBe('button');
    expect(zone.hasAttribute('role')).toBe(false);
    expect(zone.hasAttribute('tabindex')).toBe(false);
    expect(zone.contains(input)).toBe(false);
    expect(zone.querySelector('button, input, select, textarea, a[href], [tabindex]')).toBeNull();

    const pickerControls = document.querySelectorAll(
      '[data-testid="file-input"], [data-testid="drop-zone"], [data-testid="select-button"]',
    );
    expect([...pickerControls].filter(control => !control.hidden && control.tabIndex >= 0)).toEqual([zone]);

    zone.querySelector('[data-testid="drop-title"]').click();
    expect(click).toHaveBeenCalledOnce();
  });

  it('adds supported files while rejecting unsupported and duplicate files with a notice', () => {
    mount({ createConversionJob: vi.fn() });
    const input = document.querySelector('[data-testid="file-input"]');
    const supported = hpglFile('drawing.H01');

    setInputFiles(input, [supported, hpglFile('notes.txt')]);
    expect(document.body.textContent).toContain('drawing.H01');
    expect(document.body.textContent).toContain('drawing');
    expect(document.body.textContent).toContain('notes.txt は対応していない形式です');

    setInputFiles(input, [supported]);
    expect(document.querySelectorAll('[data-testid="file-row"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('drawing.H01 はすでに追加されています');
  });

  it('accepts ZIP and disables mutable file controls while expanding', async () => {
    const job = deferredJob();
    const createUploadExpansionJob = vi.fn(() => job);
    mount({
      createConversionJob: vi.fn(),
      createUploadExpansionJob,
    });
    const input = document.querySelector('[data-testid="file-input"]');
    expect(input.accept).toContain('.zip');
    setInputFiles(input, [hpglFile('existing.H01')]);

    setInputFiles(input, [zipFile('drawings.zip')]);

    expect(createUploadExpansionJob).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'drawings.zip' }),
    ]);
    expect(document.body.textContent).toContain('ZIPを展開しています');
    expect(input.disabled).toBe(true);
    expect(document.querySelector('[data-testid="drop-zone"]').disabled).toBe(true);
    expect(document.querySelector('[data-testid="convert-button"]').disabled).toBe(true);
    expect(document.querySelector('[data-testid="remove-button"]').disabled).toBe(true);

    job.resolve({
      results: [sourceResult({
        sourceName: 'drawings.zip',
        items: [inputRecord('parts/A.H01')],
        ignored: {
          directories: 1,
          unsupported: 1,
          nestedArchives: 1,
          unsafePaths: 1,
        },
      })],
    });

    await vi.waitFor(() => expect(document.body.textContent).toContain('parts/A.H01'));
    const archiveRow = [...document.querySelectorAll('[data-testid="file-row"]')]
      .find(row => row.textContent.includes('parts/A.H01'));
    expect(archiveRow.textContent).toContain('parts_A');
    expect(document.body.textContent).toContain(
      'ディレクトリ 1件、非対応 1件、ZIP内ZIP 1件、不正パス 1件を無視しました',
    );
    expect(input.disabled).toBe(false);
  });

  it('keeps successful source files when another ZIP in the upload fails', async () => {
    const job = deferredJob();
    mount({
      createConversionJob: vi.fn(),
      createUploadExpansionJob: vi.fn(() => job),
    });

    setInputFiles(document.querySelector('[data-testid="file-input"]'), [
      zipFile('broken.zip'),
      hpglFile('good.H01'),
    ]);
    job.resolve({
      results: [
        sourceResult({
          sourceName: 'broken.zip',
          error: new Error('破損したZIPです'),
        }),
        sourceResult({
          sourceName: 'good.H01',
          kind: 'hpgl',
          items: [inputRecord('good.H01')],
        }),
      ],
    });

    await vi.waitFor(() => expect(document.body.textContent).toContain('good.H01'));
    expect(document.querySelectorAll('[data-testid="file-row"]')).toHaveLength(1);
    expect(document.body.textContent)
      .toContain('broken.zip を展開できませんでした: 破損したZIPです');
    expect(document.querySelector('[data-testid="output-name"]').value).toBe('good.dxf');
  });

  it('warns without adding a row when a ZIP has no supported HPGL', async () => {
    const job = deferredJob();
    mount({
      createConversionJob: vi.fn(),
      createUploadExpansionJob: vi.fn(() => job),
    });

    setInputFiles(document.querySelector('[data-testid="file-input"]'), [
      zipFile('empty.zip'),
    ]);
    job.resolve({
      results: [sourceResult({
        sourceName: 'empty.zip',
        ignored: { unsupported: 2 },
      })],
    });

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('empty.zip に対応HPGLがありません');
    });
    expect(document.querySelectorAll('[data-testid="file-row"]')).toHaveLength(0);
    expect(document.querySelector('[data-testid="output-name"]').value).toBe('converted.dxf');
  });

  it('unlocks without changing existing files when an import returns a null source result', async () => {
    const job = deferredJob();
    mount({
      createConversionJob: vi.fn(),
      createUploadExpansionJob: vi.fn(() => job),
    });
    const input = document.querySelector('[data-testid="file-input"]');
    setInputFiles(input, [hpglFile('existing.H01')]);
    setInputFiles(input, [zipFile('invalid-result.zip')]);

    job.resolve({ results: [null] });

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('ZIPの展開に失敗しました');
    });
    expect(input.disabled).toBe(false);
    expect(document.querySelector('[data-testid="drop-zone"]').disabled).toBe(false);
    expect(document.querySelector('[data-testid="convert-button"]').disabled).toBe(false);
    expect(document.querySelectorAll('[data-testid="file-row"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="file-row"]').textContent)
      .toContain('existing.H01');
  });

  it('rejects invalid input records atomically without partially merging valid entries', async () => {
    const job = deferredJob();
    mount({
      createConversionJob: vi.fn(),
      createUploadExpansionJob: vi.fn(() => job),
    });
    const input = document.querySelector('[data-testid="file-input"]');
    setInputFiles(input, [hpglFile('existing.H01')]);
    const originalOutputName = document.querySelector('[data-testid="output-name"]').value;
    setInputFiles(input, [zipFile('invalid-item.zip')]);

    job.resolve({
      results: [sourceResult({
        sourceName: 'invalid-item.zip',
        items: [inputRecord('would-add.H01'), null],
      })],
    });

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('ZIPの展開に失敗しました');
    });
    expect(input.disabled).toBe(false);
    expect(document.querySelector('[data-testid="drop-zone"]').disabled).toBe(false);
    expect(document.querySelector('[data-testid="convert-button"]').disabled).toBe(false);
    expect(document.querySelectorAll('[data-testid="file-row"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('existing.H01');
    expect(document.body.textContent).not.toContain('would-add.H01');
    expect(document.querySelector('[data-testid="output-name"]').value)
      .toBe(originalOutputName);
  });

  it('seeds the DXF name from the first successfully added source once', async () => {
    const zipJob = deferredJob();
    mount({
      createConversionJob: vi.fn(),
      createUploadExpansionJob: vi.fn(() => zipJob),
    });
    const input = document.querySelector('[data-testid="file-input"]');
    const output = document.querySelector('[data-testid="output-name"]');

    setInputFiles(input, [zipFile('drawings.zip')]);
    zipJob.resolve({
      results: [sourceResult({
        sourceName: 'drawings.zip',
        items: [inputRecord('parts/A.H01')],
      })],
    });
    await vi.waitFor(() => expect(output.value).toBe('drawings.dxf'));

    setInputFiles(input, [hpglFile('later.H02')]);
    expect(output.value).toBe('drawings.dxf');

    while (document.querySelector('[data-testid="remove-button"]')) {
      document.querySelector('[data-testid="remove-button"]').click();
    }
    setInputFiles(input, [hpglFile('after-clear.H03')]);
    expect(output.value).toBe('drawings.dxf');
  });

  it('does not overwrite a name edited before the first successful upload', () => {
    mount({ createConversionJob: vi.fn() });
    const output = document.querySelector('[data-testid="output-name"]');
    output.value = 'manual.dxf';
    output.dispatchEvent(new Event('input', { bubbles: true }));

    setInputFiles(
      document.querySelector('[data-testid="file-input"]'),
      [hpglFile('drawing.H01')],
    );

    expect(output.value).toBe('manual.dxf');
  });

  it('cancels an active ZIP expansion and ignores its stale completion when destroyed', async () => {
    const job = deferredJob();
    mount({
      createConversionJob: vi.fn(),
      createUploadExpansionJob: vi.fn(() => job),
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [
      zipFile('pending.zip'),
    ]);

    mounted.destroy();
    mounted = undefined;
    job.resolve({
      results: [sourceResult({
        sourceName: 'pending.zip',
        items: [inputRecord('stale.H01')],
      })],
    });
    await flush();

    expect(job.cancel).toHaveBeenCalledOnce();
    expect(document.querySelector('#test-root').textContent).not.toContain('stale.H01');
  });

  it('adds dropped files and recomputes case-insensitive layer suffixes after removal', () => {
    mount({ createConversionJob: vi.fn() });
    const zone = document.querySelector('[data-testid="drop-zone"]');

    dropFiles(zone, [hpglFile('sample.hpgl'), hpglFile('SAMPLE.plt', 'PU;', { lastModified: 456 })]);
    const rows = document.querySelectorAll('[data-testid="file-row"]');
    expect(rows[0].textContent).toContain('sample');
    expect(rows[1].textContent).toContain('SAMPLE_2');

    rows[0].querySelector('[data-testid="remove-button"]').click();
    expect(document.querySelectorAll('[data-testid="file-row"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="file-row"]').textContent).toContain('SAMPLE');
    expect(document.querySelector('[data-testid="file-row"]').textContent).not.toContain('SAMPLE_2');
  });

  it('automatically previews added files with colors and hides unchecked layers', async () => {
    const createPreviewJob = vi.fn((files, _layers, options) => ({
      promise: Promise.resolve(previewResult(files)),
      cancel: vi.fn(),
      options,
    }));
    const renderViewer = vi.fn();
    mount({ createConversionJob: vi.fn(), createPreviewJob, renderViewer });
    const files = [hpglFile('first.hpgl'), hpglFile('second.plt', 'PU;', { lastModified: 456 })];

    setInputFiles(document.querySelector('[data-testid="file-input"]'), files);

    expect(createPreviewJob).toHaveBeenCalledWith(
      files.map(file => expect.objectContaining({
        name: file.name,
        blob: file,
        size: file.size,
        identity: expect.any(String),
      })),
      ['first', 'second'],
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="viewer-layer-toggle"]')).toHaveLength(2));
    expect(document.querySelector('[data-testid="viewer-controls"]').textContent).toContain('first.hpgl');
    expect(document.querySelector('[data-testid="viewer-controls"]').textContent).toContain('図形 1');
    expect(document.querySelectorAll('.viewer-swatch')).toHaveLength(2);
    await vi.waitFor(() => expect(renderViewer).toHaveBeenCalled());
    expect(renderViewer.mock.lastCall[1]).toHaveLength(2);

    document.querySelector('[data-testid="viewer-layer-toggle"]').click();

    await vi.waitFor(() => expect(renderViewer.mock.lastCall[1]).toHaveLength(1));
    expect(renderViewer.mock.lastCall[1][0].geometries).toEqual(previewResult(files).files[1].geometries);
    expect(renderViewer.mock.lastCall[1][0].color).toBe('#e67e22');
  });

  it('assigns eight distinct colors to eight normally displayed files', async () => {
    const renderViewer = vi.fn();
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(files => ({
        promise: Promise.resolve(previewResult(files)),
        cancel: vi.fn(),
      })),
      renderViewer,
    });
    const files = Array.from({ length: 8 }, (_, index) => hpglFile(`drawing-${index + 1}.hpgl`));

    setInputFiles(document.querySelector('[data-testid="file-input"]'), files);

    await vi.waitFor(() => expect(document.querySelectorAll('.viewer-swatch')).toHaveLength(8));
    await vi.waitFor(() => expect(renderViewer.mock.lastCall[1]).toHaveLength(8));
    const swatchColors = [...document.querySelectorAll('.viewer-swatch')]
      .map(swatch => swatch.style.backgroundColor);
    const canvasColors = renderViewer.mock.lastCall[1].map(group => group.color);
    expect(new Set(swatchColors).size).toBe(8);
    expect(new Set(canvasColors).size).toBe(8);
  });

  it('compares two different files as multisets in diff mode', async () => {
    const common = line([[0, 0], [1, 1]]);
    const onlyA = line([[2, 0], [3, 1]]);
    const onlyB = line([[4, 0], [5, 1]]);
    const preview = {
      files: [
        { ...previewResult([hpglFile('a.hpgl')]).files[0], geometries: [common, onlyA], geometryCount: 2 },
        { ...previewResult([hpglFile('b.hpgl')]).files[0], geometries: [common, onlyB], geometryCount: 2 },
      ],
    };
    const renderViewer = vi.fn();
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(() => ({ promise: Promise.resolve(preview), cancel: vi.fn() })),
      renderViewer,
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [
      hpglFile('a.hpgl'),
      hpglFile('b.hpgl', 'PU;', { lastModified: 456 }),
    ]);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="viewer-mode-diff"]').disabled).toBe(false));

    document.querySelector('[data-testid="viewer-mode-diff"]').click();

    const compareA = document.querySelector('[data-testid="viewer-compare-a"]');
    const compareB = document.querySelector('[data-testid="viewer-compare-b"]');
    expect(compareA.value).not.toBe(compareB.value);
    expect(document.querySelector('[data-testid="viewer-diff-counts"]').textContent)
      .toBe('Aのみ 1 / 共通 1 / Bのみ 1');
    await vi.waitFor(() => expect(renderViewer.mock.lastCall[1].map(group => group.geometries.length)).toEqual([1, 1, 1]));
  });

  it('reuses the cached comparison while zooming and panning', async () => {
    const compareGeometrySets = vi.fn(compareGeometrySetsDefault);
    const files = [
      hpglFile('a.hpgl'),
      hpglFile('b.hpgl', 'PU;', { lastModified: 456 }),
    ];
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(() => ({
        promise: Promise.resolve(previewResult(files)),
        cancel: vi.fn(),
      })),
      compareGeometrySets,
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), files);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="viewer-mode-diff"]').disabled).toBe(false));

    document.querySelector('[data-testid="viewer-mode-diff"]').click();
    await vi.waitFor(() => expect(compareGeometrySets).toHaveBeenCalledOnce());
    const canvas = document.querySelector('[data-testid="viewer-canvas"]');

    canvas.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: 50, clientY: 40, deltaY: -100,
    }));
    canvas.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true, button: 0, clientX: 50, clientY: 40,
    }));
    canvas.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true, clientX: 65, clientY: 50,
    }));
    await flush();

    expect(compareGeometrySets).toHaveBeenCalledOnce();
  });

  it('cancels the previous preview and ignores its stale completion', async () => {
    const jobs = [deferredJob(), deferredJob()];
    const requests = [];
    const createPreviewJob = vi.fn(files => {
      requests.push(files);
      return jobs[requests.length - 1];
    });
    mount({ createConversionJob: vi.fn(), createPreviewJob });
    const first = hpglFile('first.hpgl');
    const second = hpglFile('second.hpgl', 'PU;', { lastModified: 456 });

    setInputFiles(document.querySelector('[data-testid="file-input"]'), [first]);
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [second]);

    expect(jobs[0].cancel).toHaveBeenCalledOnce();
    jobs[1].resolve(previewResult([first, second]));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="viewer-controls"]').textContent).toContain('second.hpgl'));
    jobs[0].resolve(previewResult([hpglFile('obsolete.hpgl')]));
    await flush();
    expect(document.querySelector('[data-testid="viewer-controls"]').textContent).not.toContain('obsolete.hpgl');
    expect(document.querySelector('[data-testid="viewer-controls"]').textContent).toContain('second.hpgl');
  });

  it('clears the canvas while a replacement preview is pending', async () => {
    const jobs = [deferredJob(), deferredJob()];
    let requestIndex = 0;
    const renderViewer = vi.fn();
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(() => jobs[requestIndex++]),
      renderViewer,
    });
    const first = hpglFile('first.hpgl');
    const second = hpglFile('second.hpgl', 'PU;', { lastModified: 456 });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [first]);
    jobs[0].resolve(previewResult([first]));
    await vi.waitFor(() => expect(renderViewer.mock.lastCall[1]).toHaveLength(1));
    renderViewer.mockClear();

    setInputFiles(document.querySelector('[data-testid="file-input"]'), [second]);

    await vi.waitFor(() => expect(renderViewer).toHaveBeenCalledWith(
      document.querySelector('[data-testid="viewer-canvas"]'),
      [],
      expect.any(Object),
    ));
  });

  it('clears stale preview counts before reparsing and after a preview failure', async () => {
    const firstJob = deferredJob();
    const secondJob = deferredJob();
    const jobs = [firstJob, secondJob];
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(() => jobs.shift()),
    });
    const files = [
      hpglFile('first.hpgl'),
      hpglFile('second.hpgl', 'PU;', { lastModified: 456 }),
    ];
    const parsed = previewResult(files);
    parsed.files[0].geometryCount = 7;
    parsed.files[1].geometryCount = 9;
    setInputFiles(document.querySelector('[data-testid="file-input"]'), files);
    firstJob.resolve(parsed);
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="file-row"]')[0].children[4].textContent).toBe('7'));

    document.querySelectorAll('[data-testid="remove-button"]')[0].click();

    expect(document.querySelector('[data-testid="file-row"]').children[4].textContent).toBe('0');
    secondJob.reject(new Error('preview crashed'));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="viewer-status"]').textContent).toContain('preview crashed'));
    expect(document.querySelector('[data-testid="file-row"]').children[4].textContent).toBe('0');
    expect(document.querySelector('[data-testid="convert-button"]').disabled).toBe(false);
  });

  it('refits and redraws the viewer when its canvas is resized', async () => {
    let resizeCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) {
        resizeCallback = callback;
      }

      observe = observe;
      disconnect = disconnect;
    });
    let width = 800;
    let height = 480;
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {},
    }));
    const renderViewer = vi.fn();
    mount({
      createConversionJob: vi.fn(),
      createPreviewJob: vi.fn(files => ({ promise: Promise.resolve(previewResult(files)), cancel: vi.fn() })),
      renderViewer,
    });
    const canvas = document.querySelector('[data-testid="viewer-canvas"]');
    expect(observe).toHaveBeenCalledWith(canvas);
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);
    await vi.waitFor(() => expect(renderViewer.mock.lastCall[2]).toEqual(expect.objectContaining({ width: 800, height: 480 })));

    width = 400;
    height = 280;
    resizeCallback();

    await vi.waitFor(() => expect(renderViewer.mock.lastCall[2]).toEqual(expect.objectContaining({ width: 400, height: 280 })));
    mounted.destroy();
    mounted = undefined;
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('cancels an active preview job when destroyed', () => {
    const job = deferredJob();
    mount({ createConversionJob: vi.fn(), createPreviewJob: () => job });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);

    mounted.destroy();
    mounted = undefined;

    expect(job.cancel).toHaveBeenCalledOnce();
  });

  it('finishes all cleanup even when job cancellation throws during destroy', () => {
    const conversionJob = deferredJob();
    conversionJob.cancel.mockImplementation(() => {
      throw new Error('conversion cancel failed');
    });
    const previewJob = deferredJob();
    mount({ createConversionJob: () => conversionJob, createPreviewJob: () => previewJob });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);
    document.querySelector('[data-testid="convert-button"]').click();

    expect(() => mounted.destroy()).not.toThrow();
    mounted = undefined;

    expect(conversionJob.cancel).toHaveBeenCalledOnce();
    expect(previewJob.cancel).toHaveBeenCalledOnce();
    expect(document.querySelector('#test-root').children).toHaveLength(0);
  });

  it('disables mutable controls during conversion and renders progress', async () => {
    const job = deferredJob();
    const createConversionJob = vi.fn((files, layers, options) => {
      job.options = options;
      return job;
    });
    mount({ createConversionJob });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);

    document.querySelector('[data-testid="convert-button"]').click();
    expect(createConversionJob).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'sample.hpgl' })],
      ['sample'],
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(document.querySelector('[data-testid="file-input"]').disabled).toBe(true);
    expect(document.querySelector('[data-testid="output-name"]').disabled).toBe(true);
    expect(document.querySelector('[data-testid="remove-button"]').disabled).toBe(true);
    expect(document.querySelector('[data-testid="cancel-button"]').hidden).toBe(false);

    job.options.onProgress({ phase: 'reading', fileName: 'sample.hpgl', index: 1, total: 1 });
    expect(document.querySelector('[data-testid="progress"]').value).toBe(0);
    expect(document.body.textContent).toContain('sample.hpgl を読み込んでいます');

    job.options.onProgress({ fileName: 'sample.hpgl', index: 1, total: 1, geometryCount: 3, errorCount: 0, warningCount: 1 });
    expect(document.querySelector('[data-testid="progress"]').value).toBe(1);
    expect(document.body.textContent).toContain('sample.hpgl を処理しました');
    expect(document.querySelector('[data-testid="file-row"]').textContent).toContain('3');

    job.resolve(result());
    await flush();
  });

  it('renders totals, per-file counts, capped diagnostics, and error-bearing download copy', async () => {
    const diagnostics = Array.from({ length: 105 }, (_, index) => ({
      severity: index % 2 ? 'warning' : 'error',
      fileName: 'sample.hpgl',
      command: 'PD',
      offset: index,
      message: `診断 ${index + 1}`,
      skippedCommands: 1,
      skippedShapes: 0,
    }));
    const createConversionJob = vi.fn(() => ({
      promise: Promise.resolve(result({ errors: 53, warnings: 52, diagnostics })),
      cancel: vi.fn(),
    }));
    mount({ createConversionJob });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);

    document.querySelector('[data-testid="convert-button"]').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('変換完了'));

    expect(document.body.textContent).toContain('エラーありで生成されたDXF');
    expect(document.querySelector('[data-testid="results"]').textContent).toContain('図形 3');
    expect(document.querySelectorAll('[data-testid="diagnostic"]')).toHaveLength(100);
    expect(document.body.textContent).toContain('先頭100件を表示');
    expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull();
  });

  it('downloads once automatically and keeps the manual download button', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    mount({
      createConversionJob: () => ({
        promise: Promise.resolve(result()),
        cancel: vi.fn(),
      }),
    });
    setInputFiles(
      document.querySelector('[data-testid="file-input"]'),
      [hpglFile('sample.hpgl')],
    );
    document.querySelector('[data-testid="convert-button"]').click();

    await vi.waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
    expect(anchorClick.mock.instances[0].download).toBe('sample.dxf');
    expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull();

    document.querySelector('[data-testid="download-button"]').click();
    expect(anchorClick).toHaveBeenCalledTimes(2);
  });

  it('automatically downloads a DXF that contains conversion diagnostics', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    mount({
      createConversionJob: () => ({
        promise: Promise.resolve(result({ errors: 1, diagnostics: [{ message: 'bad command' }] })),
        cancel: vi.fn(),
      }),
    });
    setInputFiles(
      document.querySelector('[data-testid="file-input"]'),
      [hpglFile('sample.hpgl')],
    );
    document.querySelector('[data-testid="convert-button"]').click();

    await vi.waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
    expect(document.body.textContent).toContain('エラーありで生成されたDXF');
    expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull();
  });

  it('keeps the result and manual retry when automatic download is blocked', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => { throw new Error('blocked'); });
    mount({
      createConversionJob: () => ({ promise: Promise.resolve(result()), cancel: vi.fn() }),
    });
    setInputFiles(
      document.querySelector('[data-testid="file-input"]'),
      [hpglFile('sample.hpgl')],
    );
    document.querySelector('[data-testid="convert-button"]').click();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('自動ダウンロードを開始できませんでした');
    });
    expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="results"]').hidden).toBe(false);
  });

  it('downloads with a normalized name and revokes the temporary Blob URL', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mount({
      createConversionJob: () => ({ promise: Promise.resolve(result()), cancel: vi.fn() }),
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);
    document.querySelector('[data-testid="output-name"]').value = '  production  ';
    document.querySelector('[data-testid="convert-button"]').click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull());

    anchorClick.mockClear();
    URL.createObjectURL.mockClear();
    URL.revokeObjectURL.mockClear();
    document.querySelector('[data-testid="download-button"]').click();

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/dxf' }));
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(anchorClick.mock.instances[0].download).toBe('production.dxf');
    expect(anchorClick.mock.instances[0].isConnected).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-download');
  });

  it('releases each new download URL once without repeating cleanup on rerun or destroy', async () => {
    const jobs = [];
    URL.createObjectURL
      .mockReset()
      .mockReturnValueOnce('blob:first-auto')
      .mockReturnValueOnce('blob:first-manual')
      .mockReturnValueOnce('blob:second-auto')
      .mockReturnValueOnce('blob:second-manual');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mount({
      createConversionJob: () => {
        const job = deferredJob();
        jobs.push(job);
        return job;
      },
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);
    document.querySelector('[data-testid="convert-button"]').click();
    jobs[0].resolve(result());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-auto');

    URL.createObjectURL.mockClear();
    URL.revokeObjectURL.mockClear();
    document.querySelector('[data-testid="download-button"]').click();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-manual');

    URL.createObjectURL.mockClear();
    URL.revokeObjectURL.mockClear();
    document.querySelector('[data-testid="convert-button"]').click();
    expect(document.querySelector('[data-testid="download-button"]')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    jobs[1].resolve(result());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second-auto');

    URL.createObjectURL.mockClear();
    URL.revokeObjectURL.mockClear();
    document.querySelector('[data-testid="download-button"]').click();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second-manual');

    URL.createObjectURL.mockClear();
    URL.revokeObjectURL.mockClear();
    mounted.destroy();
    mounted = undefined;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('restores controls without a download after a fatal conversion error', async () => {
    mount({
      createConversionJob: () => ({ promise: Promise.reject(new Error('worker crashed')), cancel: vi.fn() }),
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);
    document.querySelector('[data-testid="convert-button"]').click();

    await vi.waitFor(() => expect(document.body.textContent).toContain('変換に失敗しました'));
    expect(document.body.textContent).toContain('worker crashed');
    expect(document.querySelector('[data-testid="file-input"]').disabled).toBe(false);
    expect(document.querySelector('[data-testid="convert-button"]').disabled).toBe(false);
    expect(document.querySelector('[data-testid="download-button"]')).toBeNull();
  });

  it('cancels the active job and restores the retained inputs and settings', async () => {
    const job = deferredJob();
    job.cancel.mockImplementation(() => job.reject(new DOMException('Conversion cancelled', 'AbortError')));
    mount({ createConversionJob: () => job });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);
    document.querySelector('[data-testid="output-name"]').value = 'retained.dxf';
    document.querySelector('[data-testid="convert-button"]').click();
    document.querySelector('[data-testid="cancel-button"]').click();

    await vi.waitFor(() => expect(document.body.textContent).toContain('変換をキャンセルしました'));
    expect(job.cancel).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('sample.hpgl');
    expect(document.querySelector('[data-testid="output-name"]').value).toBe('retained.dxf');
    expect(document.querySelector('[data-testid="convert-button"]').disabled).toBe(false);
    expect(document.querySelector('[data-testid="download-button"]')).toBeNull();
  });

  it('keeps the UI source offline-only and configures a single-file build', async () => {
    const [appSource, viteConfig] = await Promise.all([
      readFile(resolve(process.cwd(), 'src/app.js'), 'utf8'),
      readFile(resolve(process.cwd(), 'vite.config.js'), 'utf8'),
    ]);

    expect(appSource).not.toMatch(/\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|localStorage)\b/);
    expect(viteConfig).toContain("base: './'");
    expect(viteConfig).toContain('viteSingleFile()');
    expect(viteConfig).toContain('modulePreload: false');
  });

  it('documents the ZIP limits, default name, and download workflow', async () => {
    const readme = await readFile(resolve(process.cwd(), 'README.md'), 'utf8');

    expect(readme).toContain('ZIP');
    expect(readme).toContain('サブフォルダ');
    expect(readme).toContain('対応するHPGLファイルだけ');
    expect(readme).toContain('50 MiB');
    expect(readme).toContain('100件');
    expect(readme).toContain('20 MiB');
    expect(readme).toContain('100 MiB');
    expect(readme).toContain('最初に追加できた元ファイル名');
    expect(readme).toContain('一度だけ');
    expect(readme).toContain('drawings.zip');
    expect(readme).toContain('drawings.dxf');
    expect(readme).toContain('種類別');
    expect(readme).toContain('自動ダウンロード');
    expect(readme).toContain('自動ダウンロードを開始できなかった場合');
    expect(readme).toContain('再ダウンロード');
    expect(readme).toContain('自動変更されません');
  });
});
