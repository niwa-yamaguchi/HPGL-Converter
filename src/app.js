import './styles.css';
import { fileIdentity, isSupportedHpglName, normalizeOutputName } from './files/file-policy.js';
import { assignLayerNames } from './files/layer-names.js';
import { createConversionJob as createDefaultConversionJob } from './worker/worker-client.js';

const SUPPORTED_EXTENSIONS = '.hpgl / .hpg / .plt / .h01〜.h99';
const MAX_VISIBLE_DIAGNOSTICS = 100;

function formatFileSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export function mountApp(root, deps = {}) {
  if (!(root instanceof HTMLElement)) {
    throw new TypeError('mountApp root must be an HTMLElement');
  }
  const createConversionJob = deps.createConversionJob ?? createDefaultConversionJob;
  if (typeof createConversionJob !== 'function') {
    throw new TypeError('createConversionJob must be a function');
  }

  root.innerHTML = `
    <main class="app-shell">
      <header class="hero">
        <div>
          <p class="eyebrow">LOCAL ENGINEERING UTILITY</p>
          <h1>HPGL <span aria-hidden="true">→</span> DXF Converter</h1>
          <p class="hero-copy">複数のHPGL図面を、ファイルごとのレイヤーを持つ1つのDXFへ変換します。</p>
        </div>
        <div class="privacy-card">
          <strong>ファイルは外部へ送信されません</strong>
          <span>このブラウザのメモリ内だけで処理します</span>
          <span>対応形式: ${SUPPORTED_EXTENSIONS}</span>
        </div>
      </header>

      <section class="panel" aria-labelledby="files-heading">
        <div class="section-heading">
          <div>
            <p class="step-label">STEP 1</p>
            <h2 id="files-heading">変換するファイル</h2>
          </div>
          <span class="file-count" data-testid="file-count">0 ファイル</span>
        </div>

        <input data-testid="file-input" type="file" multiple hidden aria-label="HPGLファイルを選択"
          accept=".hpgl,.hpg,.plt,.h01,.h02,.h03,.h04,.h05,.h06,.h07,.h08,.h09,.h10,.h11,.h12,.h13,.h14,.h15,.h16,.h17,.h18,.h19,.h20,.h21,.h22,.h23,.h24,.h25,.h26,.h27,.h28,.h29,.h30,.h31,.h32,.h33,.h34,.h35,.h36,.h37,.h38,.h39,.h40,.h41,.h42,.h43,.h44,.h45,.h46,.h47,.h48,.h49,.h50,.h51,.h52,.h53,.h54,.h55,.h56,.h57,.h58,.h59,.h60,.h61,.h62,.h63,.h64,.h65,.h66,.h67,.h68,.h69,.h70,.h71,.h72,.h73,.h74,.h75,.h76,.h77,.h78,.h79,.h80,.h81,.h82,.h83,.h84,.h85,.h86,.h87,.h88,.h89,.h90,.h91,.h92,.h93,.h94,.h95,.h96,.h97,.h98,.h99">
        <button class="drop-zone" data-testid="drop-zone" type="button"
          aria-label="HPGLファイルを追加" aria-describedby="drop-help">
          <span class="drop-title" data-testid="drop-title">HPGLファイルをここへドロップ</span>
          <span id="drop-help" class="drop-help">または Enter / Space キーでファイル選択を開けます</span>
          <span class="drop-action" aria-hidden="true">ファイルを選択</span>
        </button>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">ファイル名</th>
                <th scope="col">サイズ</th>
                <th scope="col">レイヤー</th>
                <th scope="col">状態</th>
                <th scope="col">図形</th>
                <th scope="col">エラー</th>
                <th scope="col">警告</th>
                <th scope="col"><span class="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody data-testid="file-list"></tbody>
          </table>
        </div>
      </section>

      <section class="panel settings-panel" aria-labelledby="settings-heading">
        <div>
          <p class="step-label">STEP 2</p>
          <h2 id="settings-heading">出力設定</h2>
        </div>
        <div class="setting-field">
          <label for="output-name">出力ファイル名</label>
          <input id="output-name" data-testid="output-name" type="text" value="converted.dxf" autocomplete="off">
        </div>
        <div class="scale-note">
          <span>固定スケール</span>
          <strong>40 HPGL単位 = 1 mm</strong>
        </div>
      </section>

      <section class="panel action-panel" aria-labelledby="action-heading">
        <div>
          <p class="step-label">STEP 3</p>
          <h2 id="action-heading">変換</h2>
        </div>
        <div class="action-controls">
          <button type="button" class="primary-button" data-testid="convert-button">DXFに変換</button>
          <button type="button" class="cancel-button" data-testid="cancel-button" hidden>キャンセル</button>
        </div>
        <div class="progress-wrap" data-testid="progress-wrap" hidden>
          <progress data-testid="progress" value="0" max="1">0%</progress>
          <span data-testid="current-file">変換を準備しています</span>
        </div>
        <p class="status-message" data-testid="status" aria-live="polite">ファイルを追加してください。</p>
      </section>

      <section class="panel results-panel" data-testid="results" aria-labelledby="results-heading" hidden>
        <div data-testid="results-content"></div>
      </section>
    </main>
  `;

  const nodes = {
    input: root.querySelector('[data-testid="file-input"]'),
    dropZone: root.querySelector('[data-testid="drop-zone"]'),
    fileList: root.querySelector('[data-testid="file-list"]'),
    fileCount: root.querySelector('[data-testid="file-count"]'),
    outputName: root.querySelector('[data-testid="output-name"]'),
    convert: root.querySelector('[data-testid="convert-button"]'),
    cancel: root.querySelector('[data-testid="cancel-button"]'),
    progressWrap: root.querySelector('[data-testid="progress-wrap"]'),
    progress: root.querySelector('[data-testid="progress"]'),
    currentFile: root.querySelector('[data-testid="current-file"]'),
    status: root.querySelector('[data-testid="status"]'),
    results: root.querySelector('[data-testid="results"]'),
    resultsContent: root.querySelector('[data-testid="results-content"]'),
  };

  const state = {
    files: [],
    layerNames: [],
    progressByIndex: new Map(),
    progressIndex: 0,
    converting: false,
    result: null,
    job: null,
    token: null,
    destroyed: false,
  };
  const listeners = [];

  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  }

  function announce(message, kind = 'info') {
    nodes.status.textContent = message;
    nodes.status.dataset.kind = kind;
  }

  function clearResult() {
    state.result = null;
    nodes.results.hidden = true;
    nodes.resultsContent.replaceChildren();
  }

  function fileDisplay(index) {
    const completed = state.result?.files?.[index];
    if (completed) {
      return {
        status: completed.errorCount > 0 ? 'エラーあり' : '完了',
        statusKind: completed.errorCount > 0 ? 'error' : 'success',
        geometryCount: number(completed.geometryCount),
        errorCount: number(completed.errorCount),
        warningCount: number(completed.warningCount),
      };
    }
    const progress = state.progressByIndex.get(index);
    if (progress) {
      return {
        status: progress.errorCount > 0 ? 'エラーあり' : '完了',
        statusKind: progress.errorCount > 0 ? 'error' : 'success',
        geometryCount: number(progress.geometryCount),
        errorCount: number(progress.errorCount),
        warningCount: number(progress.warningCount),
      };
    }
    if (state.converting && index === state.progressIndex) {
      return { status: '変換中', statusKind: 'working', geometryCount: 0, errorCount: 0, warningCount: 0 };
    }
    return { status: '待機中', statusKind: 'idle', geometryCount: 0, errorCount: 0, warningCount: 0 };
  }

  function removeFile(index) {
    if (state.converting) {
      return;
    }
    const [removed] = state.files.splice(index, 1);
    state.layerNames = assignLayerNames(state.files.map(file => file.name));
    state.progressByIndex.clear();
    state.progressIndex = 0;
    clearResult();
    renderFiles();
    announce(`${removed.name} を削除しました。`);
  }

  function renderFiles() {
    nodes.fileList.replaceChildren();
    nodes.fileCount.textContent = `${state.files.length} ファイル`;

    if (state.files.length === 0) {
      const row = element('tr', 'empty-row');
      const cell = element('td', '', 'ファイルはまだ追加されていません。');
      cell.colSpan = 8;
      row.append(cell);
      nodes.fileList.append(row);
    } else {
      state.files.forEach((file, index) => {
        const display = fileDisplay(index);
        const row = element('tr');
        row.dataset.testid = 'file-row';

        const nameCell = element('td', 'file-name', file.name);
        const sizeCell = element('td', '', formatFileSize(file.size));
        const layerCell = element('td', 'layer-name', state.layerNames[index]);
        const statusCell = element('td');
        statusCell.append(element('span', `status-pill status-${display.statusKind}`, display.status));
        const geometryCell = element('td', 'numeric', String(display.geometryCount));
        const errorCell = element('td', 'numeric', String(display.errorCount));
        const warningCell = element('td', 'numeric', String(display.warningCount));
        const actionCell = element('td', 'row-action');
        const remove = element('button', 'icon-button', '削除');
        remove.type = 'button';
        remove.dataset.testid = 'remove-button';
        remove.disabled = state.converting;
        remove.setAttribute('aria-label', `${file.name} を削除`);
        remove.addEventListener('click', () => removeFile(index));
        actionCell.append(remove);
        row.append(nameCell, sizeCell, layerCell, statusCell, geometryCell, errorCell, warningCell, actionCell);
        nodes.fileList.append(row);
      });
    }

    nodes.input.disabled = state.converting;
    nodes.dropZone.disabled = state.converting;
    nodes.outputName.disabled = state.converting;
    nodes.convert.disabled = state.converting || state.files.length === 0;
    nodes.cancel.hidden = !state.converting;
  }

  function addFiles(fileList) {
    if (state.converting) {
      return;
    }
    const known = new Set(state.files.map(fileIdentity));
    const notices = [];
    let added = 0;

    Array.from(fileList ?? []).forEach(file => {
      if (!isSupportedHpglName(file.name)) {
        notices.push(`${file.name} は対応していない形式です`);
        return;
      }
      const identity = fileIdentity(file);
      if (known.has(identity)) {
        notices.push(`${file.name} はすでに追加されています`);
        return;
      }
      known.add(identity);
      state.files.push(file);
      added += 1;
    });

    if (added > 0) {
      state.layerNames = assignLayerNames(state.files.map(file => file.name));
      state.progressByIndex.clear();
      state.progressIndex = 0;
      clearResult();
      renderFiles();
    }
    if (notices.length > 0) {
      announce(notices.join('。'), 'warning');
    } else if (added > 0) {
      announce(`${added}件のファイルを追加しました。`);
    }
  }

  function renderDiagnostic(diagnostic) {
    const item = element('li', `diagnostic diagnostic-${diagnostic.severity ?? 'error'}`);
    item.dataset.testid = 'diagnostic';
    const command = diagnostic.command ? ` / ${diagnostic.command}` : '';
    const offset = Number.isFinite(diagnostic.offset) ? ` / 位置 ${diagnostic.offset}` : '';
    const skipped = number(diagnostic.skippedCommands) + number(diagnostic.skippedShapes);
    const skippedText = skipped > 0 ? ` / スキップ ${skipped}` : '';
    item.textContent = `${diagnostic.severity === 'warning' ? '警告' : 'エラー'}${command}${offset}: ${diagnostic.message ?? '不明な問題'}${skippedText}`;
    return item;
  }

  function renderResults() {
    nodes.resultsContent.replaceChildren();
    const totals = state.result.totals ?? {};
    const headingRow = element('div', 'section-heading');
    const headingBlock = element('div');
    headingBlock.append(element('p', 'step-label', 'RESULT'), element('h2', '', '変換完了'));
    headingBlock.querySelector('h2').id = 'results-heading';
    headingRow.append(headingBlock);

    const summary = element(
      'p',
      'result-summary',
      `ファイル ${number(totals.fileCount)} / 図形 ${number(totals.geometryCount)} / エラー ${number(totals.errorCount)} / 警告 ${number(totals.warningCount)}`,
    );
    const hasErrors = number(totals.errorCount) > 0;
    const banner = element(
      'p',
      `result-banner ${hasErrors ? 'result-warning' : 'result-success'}`,
      hasErrors ? 'エラーありで生成されたDXF' : 'エラーなしでDXFを生成しました',
    );
    const fileResults = element('div', 'file-results');

    (state.result.files ?? []).forEach(file => {
      const article = element('article', 'file-result');
      article.append(
        element('h3', 'file-name', file.name),
        element(
          'p',
          'file-result-counts',
          `レイヤー ${file.layerName} / 図形 ${number(file.geometryCount)} / エラー ${number(file.errorCount)} / 警告 ${number(file.warningCount)}`,
        ),
      );
      const diagnosticTotal = number(file.errorCount) + number(file.warningCount);
      if (diagnosticTotal > 0 || (file.diagnostics?.length ?? 0) > 0) {
        const details = element('details', 'diagnostic-details');
        const capText = diagnosticTotal > MAX_VISIBLE_DIAGNOSTICS ? '（先頭100件を表示）' : '';
        details.append(element('summary', '', `診断 ${diagnosticTotal}件 ${capText}`.trim()));
        const list = element('ul', 'diagnostic-list');
        (file.diagnostics ?? []).slice(0, MAX_VISIBLE_DIAGNOSTICS).forEach(diagnostic => {
          list.append(renderDiagnostic(diagnostic));
        });
        details.append(list);
        article.append(details);
      }
      fileResults.append(article);
    });

    const download = element('button', 'primary-button download-button', 'DXFをダウンロード');
    download.type = 'button';
    download.dataset.testid = 'download-button';
    download.addEventListener('click', downloadResult);
    nodes.resultsContent.append(headingRow, summary, banner, fileResults, download);
    nodes.results.hidden = false;
  }

  function downloadResult() {
    if (!state.result?.buffer) {
      return;
    }
    const blob = new Blob([state.result.buffer], { type: 'application/dxf' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = normalizeOutputName(nodes.outputName.value);
    anchor.hidden = true;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    }
    announce(`${anchor.download} のダウンロードを開始しました。`, 'success');
  }

  function finishConversion(token, conversionResult) {
    if (state.destroyed || state.token !== token) {
      return;
    }
    state.converting = false;
    state.job = null;
    state.result = conversionResult;
    state.progressIndex = state.files.length;
    renderFiles();
    nodes.progressWrap.hidden = true;
    renderResults();
    announce('変換完了。DXFをダウンロードできます。', 'success');
  }

  function failConversion(token, error) {
    if (state.destroyed || state.token !== token) {
      return;
    }
    state.converting = false;
    state.job = null;
    clearResult();
    nodes.progressWrap.hidden = true;
    renderFiles();
    if (error?.name === 'AbortError') {
      announce('変換をキャンセルしました。ファイルと設定は保持されています。', 'warning');
      return;
    }
    const message = error instanceof Error && error.message ? error.message : '不明なエラー';
    announce(`変換に失敗しました: ${message}`, 'error');
  }

  function startConversion() {
    if (state.converting || state.files.length === 0) {
      return;
    }
    clearResult();
    state.progressByIndex.clear();
    state.progressIndex = 0;
    state.converting = true;
    const token = Symbol('conversion');
    state.token = token;
    nodes.progress.value = 0;
    nodes.progress.max = state.files.length;
    nodes.currentFile.textContent = '変換を準備しています';
    nodes.progressWrap.hidden = false;
    announce('変換中です。', 'working');
    renderFiles();

    const onProgress = event => {
      if (state.destroyed || state.token !== token || !state.converting) {
        return;
      }
      const index = Math.max(0, number(event.index));
      const total = Math.max(1, number(event.total) || state.files.length);
      state.progressIndex = Math.min(index, state.files.length);
      if (index > 0) {
        state.progressByIndex.set(index - 1, event);
      }
      nodes.progress.max = total;
      nodes.progress.value = Math.min(index, total);
      nodes.currentFile.textContent = `${event.fileName ?? 'ファイル'} を処理しました (${index} / ${total})`;
      renderFiles();
    };

    let job;
    try {
      job = createConversionJob([...state.files], [...state.layerNames], { onProgress });
      if (!job || typeof job.cancel !== 'function' || !job.promise) {
        throw new TypeError('変換ジョブを開始できませんでした');
      }
      state.job = job;
    } catch (error) {
      failConversion(token, error);
      return;
    }
    Promise.resolve(job.promise).then(
      conversionResult => finishConversion(token, conversionResult),
      error => failConversion(token, error),
    );
  }

  listen(nodes.input, 'change', () => {
    addFiles(nodes.input.files);
    nodes.input.value = '';
  });
  listen(nodes.dropZone, 'click', () => {
    if (!state.converting) {
      nodes.input.click();
    }
  });
  listen(nodes.dropZone, 'dragover', event => {
    event.preventDefault();
    if (!state.converting) {
      nodes.dropZone.classList.add('is-dragging');
    }
  });
  listen(nodes.dropZone, 'dragleave', () => nodes.dropZone.classList.remove('is-dragging'));
  listen(nodes.dropZone, 'drop', event => {
    event.preventDefault();
    nodes.dropZone.classList.remove('is-dragging');
    addFiles(event.dataTransfer?.files);
  });
  listen(nodes.convert, 'click', startConversion);
  listen(nodes.cancel, 'click', () => {
    if (state.job) {
      announce('キャンセルしています…', 'working');
      try {
        state.job.cancel();
      } catch (error) {
        failConversion(state.token, error);
      }
    }
  });

  renderFiles();

  return {
    destroy() {
      if (state.destroyed) {
        return;
      }
      state.destroyed = true;
      state.token = null;
      if (state.job) {
        state.job.cancel();
        state.job = null;
      }
      listeners.splice(0).forEach(remove => remove());
      root.replaceChildren();
    },
  };
}

const appRoot = typeof document === 'undefined' ? null : document.querySelector('#app');
if (appRoot) {
  mountApp(appRoot);
}
