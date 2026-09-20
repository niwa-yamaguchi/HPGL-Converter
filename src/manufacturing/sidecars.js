function decodeUtf8(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (data == null) {
    return '';
  }
  return new TextDecoder().decode(data);
}

function sidecarScore(text) {
  let score = 0;
  if (text.includes('\uFFFD')) {
    score -= 8;
  }
  if (/RS274D/.test(text)) score += 2;
  if (/出力ファイル名/.test(text)) score += 2;
  if (/処理ファイル名/.test(text)) score += 2;
  if (/ドリル出力/.test(text)) score += 2;
  if (/座標フォーマット/.test(text)) score += 2;
  if (/Board\s+Name/i.test(text)) score += 2;
  if (/File\s+Name\s*:/i.test(text)) score += 1;
  return score;
}

function decode(data) {
  const utf8 = decodeUtf8(data);
  if (typeof data === 'string' || data == null) {
    return utf8;
  }
  let shiftJis = utf8;
  try {
    shiftJis = new TextDecoder('shift_jis').decode(data);
  } catch {
    return utf8;
  }
  return sidecarScore(shiftJis) > sidecarScore(utf8) ? shiftJis : utf8;
}

const layerLabel = (code, purpose, side) => [code, purpose, side]
  .filter(Boolean).join('_').replace(/[^A-Za-z0-9_-]+/g, '_')
  .replace(/_+$/g, '');

function parseUnits(value) {
  const text = String(value).toLowerCase();
  if (/mm|metric|ミリ/.test(text)) {
    return 'mm';
  }
  if (/inch|インチ/.test(text)) {
    return 'inch';
  }
  return null;
}

function leafFromPath(value) {
  return String(value).split(/[\\/]/).pop() ?? '';
}

function extensionCode(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1) : fileName;
}

function circleAperture(code, diameter) {
  return {
    kind: 'circle',
    code,
    template: 'C',
    modifiers: [diameter],
    raw: `ADD${code}C,${diameter}`,
  };
}

function rectangleAperture(code, width, height) {
  return {
    kind: 'rectangle',
    code,
    template: 'R',
    modifiers: [width, height],
    raw: `ADD${code}R,${width}X${height}`,
  };
}

function magicPurposeLabel(text) {
  const compact = String(text).replace(/\s+/g, '');
  if (/部品面/.test(compact)) {
    return 'Top';
  }
  if (/半田面|ハンダ面/.test(compact)) {
    return 'Bottom';
  }
  if (/レジスト|ﾚｼﾞｽﾄ/.test(compact)) {
    const side = /B/.test(compact) ? 'Bottom' : /A/.test(compact) ? 'Top' : '';
    return side ? `Solder_Mask_${side}` : 'Solder_Mask';
  }
  if (/シルク/.test(compact)) {
    const side = /B/.test(compact) ? 'Bottom' : /A/.test(compact) ? 'Top' : '';
    return side ? `Silk_${side}` : 'Silk';
  }
  if (/外形/.test(compact)) {
    const side = /B/.test(compact) ? 'B' : /A/.test(compact) ? 'A' : '';
    return side ? `Outline_${side}` : 'Outline';
  }
  return '';
}

export function isMagicGerberSummary(text) {
  return /RS274D/.test(text) && /出力ファイル名/.test(text);
}

export function isMagicDrillSummary(text) {
  return /ドリル出力/.test(text) || /座標フォーマット整数/.test(text);
}

export function looksLikeGerberSummary(data) {
  return isMagicGerberSummary(decode(data));
}

function parseEnglishGerberList(text) {
  const layers = new Map();
  let boardName = '';

  for (const line of text.split(/\r?\n/)) {
    const board = line.match(/Board\s+Name\s*:\s*(\S+)/i);
    if (board) {
      boardName = board[1];
      continue;
    }

    const entry = line.match(/^\s*(\S+\.\S+)\s*:\s*(.+?)\s*$/);
    if (!entry) {
      continue;
    }

    const fileName = entry[1];
    const rest = entry[2].replace(/:+\s*$/, '').trim();
    const parsed = rest.match(/^(.*?)(?:\[([^\]]*)\])?\s*$/);
    const purpose = (parsed?.[1] ?? rest).trim();
    const side = (parsed?.[2] ?? '').replace(/\bSide\b/gi, '').trim();
    layers.set(fileName, layerLabel(extensionCode(fileName), purpose, side));
  }

  return { boardName, layers, fileDefaults: new Map() };
}

function parseMagicGerberList(text) {
  const layers = new Map();
  const fileDefaults = new Map();
  const board = text.match(/処理ファイル名\s*\[([^\]]+)\]/);
  const boardName = board ? board[1].trim() : '';
  const sections = text.split(/出力ファイル名\s*\[/);

  for (const section of sections.slice(1)) {
    const close = section.indexOf(']');
    if (close < 0) {
      continue;
    }
    const fileName = leafFromPath(section.slice(0, close).trim());
    if (!fileName) {
      continue;
    }
    const body = section.slice(close + 1);
    const purposeLine = body.match(/出力レベル[\s\S]*?^\s*\d+\s+(.+)$/m);
    const purpose = magicPurposeLabel(purposeLine?.[1] ?? '');
    const unitsLine = body.match(/単位[^:\n]*[:：]\s*(.+)/);
    const format = body.match(/整数部\s*(\d+)\s*桁\s*,\s*小数部\s*(\d+)\s*桁/);
    const apertures = new Map();
    for (const line of body.split(/\r?\n/)) {
      const row = line.match(/^\s*(\d{2,3})\s+(\d+\.\d+)(?:\s+(\d+\.\d+))?(?:\s+(\d+\.\d+))?(?:\s+(\d+\.\d+))?\s+(\S+)/);
      if (!row || !/円/.test(line)) {
        continue;
      }
      const code = Number(row[1]);
      const outerX = Number(row[2]);
      const outerY = row[3] ? Number(row[3]) : NaN;
      if (!Number.isFinite(code) || !Number.isFinite(outerX)) {
        continue;
      }
      if (Number.isFinite(outerY) && outerY > 0 && outerY !== outerX) {
        apertures.set(code, rectangleAperture(code, outerX, outerY));
      } else {
        apertures.set(code, circleAperture(code, outerX));
      }
    }
    const defaults = {
      units: parseUnits(unitsLine?.[1] ?? '') ?? 'mm',
      integerDigits: format ? Number(format[1]) : null,
      fractionDigits: format ? Number(format[2]) : null,
      zeroSuppression: 'L',
      apertures,
    };
    layers.set(fileName, layerLabel(extensionCode(fileName), purpose));
    fileDefaults.set(fileName, defaults);
  }

  return { boardName, layers, fileDefaults };
}

export function parseGerberList(data) {
  const text = decode(data);
  if (isMagicGerberSummary(text)) {
    return parseMagicGerberList(text);
  }
  return parseEnglishGerberList(text);
}

function parseEnglishDrillList(text) {
  let boardName = '';
  let fileName = '';
  let units = null;
  let integerDigits = null;
  let fractionDigits = null;
  let zeroSuppression = null;
  const listedTools = [];

  for (const line of text.split(/\r?\n/)) {
    const board = line.match(/Board\s+Name\s*:\s*(\S+)/i);
    if (board) {
      boardName = board[1];
    }
    const listed = line.match(/File\s+Name\s*:\s*(\S+)/i);
    if (listed) {
      fileName = listed[1];
    }
    const format = line.match(/Integers\s+(\d+)\s*,\s*Fractions\s+(\d+)/i);
    if (format) {
      integerDigits = Number(format[1]);
      fractionDigits = Number(format[2]);
    }
    const unitsLine = line.match(/Units\s*:\s*(.+)$/i);
    if (unitsLine) {
      units = parseUnits(unitsLine[1]) ?? units;
    }
    const suppression = line.match(/Zero\s+Suppression\s*:\s*(\S+)/i);
    if (suppression && /^on$/i.test(suppression[1])) {
      zeroSuppression = 'L';
    }
    const tool = line.match(/T(\d+)\s*\|\s*([+-]?\d+(?:\.\d+)?)/i);
    if (tool) {
      const diameter = Number(tool[2]);
      if (Number.isFinite(diameter)) {
        listedTools.push([Number(tool[1]), diameter]);
      }
    }
  }

  const scale = units === 'inch' ? 25.4 : 1;
  const tools = new Map(listedTools.map(([number, diameter]) => [number, diameter * scale]));

  return {
    boardName,
    fileName,
    defaults: {
      units,
      integerDigits,
      fractionDigits,
      zeroSuppression,
      tools,
    },
  };
}

function parseMagicDrillList(text) {
  const board = text.match(/処理ＰＷＢ[^:\n]*[:：]\s*(\S+)/)
    || text.match(/処理PWB[^:\n]*[:：]\s*(\S+)/i);
  const listed = text.match(/出力ファイル名\s*[:：]\s*(\S+)/);
  const unitsLine = text.match(/座標単位\s*[:：]\s*(\S+)/);
  const integerLine = text.match(/座標フォーマット整数\s*[:：]\s*(\d+)/);
  const fractionLine = text.match(/座標フォーマット小数\s*[:：]\s*(\d+)/);
  const listedTools = [];
  for (const line of text.split(/\r?\n/)) {
    const tool = line.match(/^\s*\d+\s+(\d+)\s+(\d+\.\d+)/);
    if (!tool) {
      continue;
    }
    listedTools.push([Number(tool[1]), Number(tool[2])]);
  }
  const units = parseUnits(unitsLine?.[1] ?? '') ?? 'mm';
  const scale = units === 'inch' ? 25.4 : 1;
  return {
    boardName: board ? leafFromPath(board[1]).replace(/\.[^.]+$/, '') : '',
    fileName: listed ? leafFromPath(listed[1]) : '',
    defaults: {
      units,
      integerDigits: integerLine ? Number(integerLine[1]) : null,
      fractionDigits: fractionLine ? Number(fractionLine[1]) : null,
      zeroSuppression: null,
      tools: new Map(listedTools.map(([number, diameter]) => [number, diameter * scale])),
    },
  };
}

export function parseDrillList(data) {
  const text = decode(data);
  if (isMagicDrillSummary(text)) {
    return parseMagicDrillList(text);
  }
  return parseEnglishDrillList(text);
}
