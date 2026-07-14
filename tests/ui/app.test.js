// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/app.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function hpglFile(name, content = 'PA0,0;', options = {}) {
  return new File([content], name, {
    type: 'application/octet-stream',
    lastModified: 123,
    ...options,
  });
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

  beforeEach(() => {
    document.body.innerHTML = '<div id="test-root"></div>';
    URL.createObjectURL = vi.fn(() => 'blob:test-download');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    mounted?.destroy();
    mounted = undefined;
    vi.restoreAllMocks();
  });

  it('shows the private local workflow with one native file-picker tab stop', () => {
    mounted = mountApp(document.querySelector('#test-root'), { createConversionJob: vi.fn() });

    expect(document.body.textContent).toContain('HPGL → DXF Converter');
    expect(document.body.textContent).toContain('ファイルは外部へ送信されません');
    expect(document.body.textContent).toContain('.hpgl');
    expect(document.body.textContent).toContain('40 HPGL単位 = 1 mm');
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="progress"]').getAttribute('aria-label'))
      .toBe('変換進捗');
    expect(document.querySelector('[data-testid="convert-button"]').disabled).toBe(true);

    const input = document.querySelector('[data-testid="file-input"]');
    expect(input.getAttribute('aria-label')).toBe('HPGLファイルを選択');
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
    mounted = mountApp(document.querySelector('#test-root'), { createConversionJob: vi.fn() });
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

  it('adds dropped files and recomputes case-insensitive layer suffixes after removal', () => {
    mounted = mountApp(document.querySelector('#test-root'), { createConversionJob: vi.fn() });
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

  it('disables mutable controls during conversion and renders progress', async () => {
    const job = deferredJob();
    const createConversionJob = vi.fn((files, layers, options) => {
      job.options = options;
      return job;
    });
    mounted = mountApp(document.querySelector('#test-root'), { createConversionJob });
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
    mounted = mountApp(document.querySelector('#test-root'), { createConversionJob });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);

    document.querySelector('[data-testid="convert-button"]').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('変換完了'));

    expect(document.body.textContent).toContain('エラーありで生成されたDXF');
    expect(document.querySelector('[data-testid="results"]').textContent).toContain('図形 3');
    expect(document.querySelectorAll('[data-testid="diagnostic"]')).toHaveLength(100);
    expect(document.body.textContent).toContain('先頭100件を表示');
    expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull();
  });

  it('downloads with a normalized name and revokes the temporary Blob URL', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mounted = mountApp(document.querySelector('#test-root'), {
      createConversionJob: () => ({ promise: Promise.resolve(result()), cancel: vi.fn() }),
    });
    setInputFiles(document.querySelector('[data-testid="file-input"]'), [hpglFile('sample.hpgl')]);
    document.querySelector('[data-testid="output-name"]').value = '  production  ';
    document.querySelector('[data-testid="convert-button"]').click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull());

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
      .mockReturnValueOnce('blob:first-download')
      .mockReturnValueOnce('blob:second-download');
    mounted = mountApp(document.querySelector('#test-root'), {
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
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    URL.createObjectURL.mockClear();
    URL.revokeObjectURL.mockClear();
    document.querySelector('[data-testid="download-button"]').click();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-download');

    URL.createObjectURL.mockClear();
    URL.revokeObjectURL.mockClear();
    document.querySelector('[data-testid="convert-button"]').click();
    expect(document.querySelector('[data-testid="download-button"]')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    jobs[1].resolve(result());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="download-button"]')).not.toBeNull());

    URL.createObjectURL.mockClear();
    URL.revokeObjectURL.mockClear();
    document.querySelector('[data-testid="download-button"]').click();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second-download');

    URL.createObjectURL.mockClear();
    URL.revokeObjectURL.mockClear();
    mounted.destroy();
    mounted = undefined;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('restores controls without a download after a fatal conversion error', async () => {
    mounted = mountApp(document.querySelector('#test-root'), {
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
    mounted = mountApp(document.querySelector('#test-root'), { createConversionJob: () => job });
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
});
