function decode(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (data == null) {
    return '';
  }
  return new TextDecoder().decode(data);
}

const layerLabel = (code, purpose, side) => [code, purpose, side]
  .filter(Boolean).join('_').replace(/[^A-Za-z0-9_-]+/g, '_');

function parseUnits(value) {
  const text = String(value).toLowerCase();
  if (/mm|metric/.test(text)) {
    return 'mm';
  }
  if (/inch/.test(text)) {
    return 'inch';
  }
  return null;
}

export function parseGerberList(data) {
  const layers = new Map();
  let boardName = '';

  for (const line of decode(data).split(/\r?\n/)) {
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
    const dot = fileName.lastIndexOf('.');
    const code = dot >= 0 ? fileName.slice(dot + 1) : fileName;
    layers.set(fileName, layerLabel(code, purpose, side));
  }

  return { boardName, layers };
}

export function parseDrillList(data) {
  let boardName = '';
  let fileName = '';
  let units = null;
  let integerDigits = null;
  let fractionDigits = null;
  let zeroSuppression = null;
  const listedTools = [];

  for (const line of decode(data).split(/\r?\n/)) {
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
