export function parseDxfTags(text) {
  if (typeof text !== 'string' || !text.endsWith('\n')) {
    throw new TypeError('DXF text must be a newline-terminated string');
  }
  const lines = text.split('\n');
  lines.pop();
  if (lines.length % 2 !== 0) {
    throw new RangeError('DXF must contain complete group code/value pairs');
  }
  const tags = [];
  for (let index = 0; index < lines.length; index += 2) {
    const code = Number(lines[index].trim());
    if (!Number.isInteger(code)) {
      throw new TypeError(`Invalid DXF group code at line ${index + 1}`);
    }
    tags.push({ code, value: lines[index + 1] });
  }
  return tags;
}

export function sectionTags(tags, name) {
  for (let index = 0; index + 1 < tags.length; index += 1) {
    if (tags[index].code === 0 && tags[index].value === 'SECTION'
      && tags[index + 1].code === 2 && tags[index + 1].value === name) {
      const end = tags.findIndex((tag, candidate) => (
        candidate > index + 1 && tag.code === 0 && tag.value === 'ENDSEC'
      ));
      if (end < 0) {
        throw new RangeError(`DXF section ${name} has no ENDSEC`);
      }
      return tags.slice(index + 2, end);
    }
  }
  throw new RangeError(`DXF section ${name} was not found`);
}

export function records(tags) {
  const result = [];
  let current = null;
  for (const tag of tags) {
    if (tag.code === 0) {
      current = { type: tag.value, tags: [] };
      result.push(current);
    } else if (current) {
      current.tags.push(tag);
    }
  }
  return result;
}

export function recordValues(record, code) {
  return record.tags.filter(tag => tag.code === code).map(tag => tag.value);
}

export function tables(tags) {
  const tableTags = sectionTags(tags, 'TABLES');
  const result = [];
  for (let index = 0; index < tableTags.length; index += 1) {
    if (tableTags[index].code !== 0 || tableTags[index].value !== 'TABLE') {
      continue;
    }
    const end = tableTags.findIndex((tag, candidate) => (
      candidate > index && tag.code === 0 && tag.value === 'ENDTAB'
    ));
    if (end < 0) {
      throw new RangeError('DXF TABLE has no ENDTAB');
    }
    const tableRecords = records(tableTags.slice(index, end));
    const [table, ...entries] = tableRecords;
    result.push({ name: recordValues(table, 2)[0], table, entries });
    index = end;
  }
  return result;
}

function dictionaryEntries(record) {
  const result = new Map();
  for (let index = 0; index + 1 < record.tags.length; index += 1) {
    const name = record.tags[index];
    const target = record.tags[index + 1];
    if (name.code === 3 && (target.code === 350 || target.code === 360)) {
      result.set(name.value, target.value);
    }
  }
  return result;
}

function structuralRecords(tags) {
  return ['TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']
    .flatMap(name => records(sectionTags(tags, name)))
    .filter(record => record.type !== 'ENDTAB');
}

export function validateHandleGraph(tags) {
  const hasSections = tags.some(tag => tag.code === 0 && tag.value === 'SECTION');
  const structuralTags = hasSections
    ? ['TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS'].flatMap(name => sectionTags(tags, name))
    : tags;
  const handles = structuralTags
    .filter(tag => tag.code === 5 || tag.code === 105)
    .map(tag => tag.value);
  const unique = new Set(handles);
  if (unique.size !== handles.length) {
    throw new RangeError('DXF contains duplicate handles');
  }
  const references = structuralTags
    .filter(tag => [330, 340, 350, 360].includes(tag.code))
    .map(tag => tag.value)
    .filter(value => value !== '0');
  const missing = references.filter(reference => !unique.has(reference));
  if (missing.length > 0) {
    throw new RangeError(`DXF contains missing handle references: ${missing.join(', ')}`);
  }
  return { handles: unique, references };
}

export function validateRawDxfGraph(tags) {
  const graph = validateHandleGraph(tags);
  const allRecords = structuralRecords(tags);
  const recordsByHandle = new Map();
  for (const record of allRecords) {
    const handles = [...recordValues(record, 5), ...recordValues(record, 105)];
    if (handles.length !== 1) {
      throw new RangeError(`${record.type} must have exactly one handle`);
    }
    recordsByHandle.set(handles[0], record);
  }

  const parsedTables = tables(tags);
  for (const { name, table, entries } of parsedTables) {
    const count = Number(recordValues(table, 70)[0]);
    if (count !== entries.length) {
      throw new RangeError(`${name} table count does not match its records`);
    }
    const tableHandle = [...recordValues(table, 5), ...recordValues(table, 105)][0];
    if (recordValues(table, 5).length !== 1 || recordValues(table, 105).length !== 0) {
      throw new RangeError(`${name} table must use exactly one group 5 handle`);
    }
    for (const entry of entries) {
      if (entry.type !== name) {
        throw new RangeError(`${name} table contains ${entry.type}`);
      }
      if (recordValues(entry, 330).length !== 1 || recordValues(entry, 330)[0] !== tableHandle) {
        throw new RangeError(`${entry.type} table record has the wrong owner`);
      }
    }
  }

  const objectRecords = records(sectionTags(tags, 'OBJECTS'));
  const dictionaries = objectRecords.filter(record => record.type === 'DICTIONARY');
  const root = dictionaries.find(record => recordValues(record, 330)[0] === '0');
  if (!root) {
    throw new RangeError('DXF root dictionary was not found');
  }
  const rootEntries = dictionaryEntries(root);
  const groupDictionaryHandle = rootEntries.get('ACAD_GROUP');
  const layoutDictionaryHandle = rootEntries.get('ACAD_LAYOUT');
  for (const [name, handle] of [
    ['ACAD_GROUP', groupDictionaryHandle],
    ['ACAD_LAYOUT', layoutDictionaryHandle],
  ]) {
    if (!handle || recordsByHandle.get(handle)?.type !== 'DICTIONARY') {
      throw new RangeError(`${name} must target a DICTIONARY`);
    }
  }

  const layoutDictionary = recordsByHandle.get(layoutDictionaryHandle);
  if (recordValues(layoutDictionary, 330)[0] !== recordValues(root, 5)[0]) {
    throw new RangeError('ACAD_LAYOUT dictionary has the wrong owner');
  }
  const layoutEntries = dictionaryEntries(layoutDictionary);
  const expectedSpaces = [
    { layout: 'Model', block: '*Model_Space' },
    { layout: 'Layout1', block: '*Paper_Space' },
  ];
  const blockRecordTable = parsedTables.find(table => table.name === 'BLOCK_RECORD');
  if (!blockRecordTable) {
    throw new RangeError('BLOCK_RECORD table was not found');
  }
  for (const expected of expectedSpaces) {
    const layoutHandle = layoutEntries.get(expected.layout);
    const layout = recordsByHandle.get(layoutHandle);
    if (!layout || layout.type !== 'LAYOUT') {
      throw new RangeError(`${expected.layout} must target a LAYOUT`);
    }
    if (recordValues(layout, 330)[0] !== layoutDictionaryHandle) {
      throw new RangeError(`${expected.layout} LAYOUT has the wrong owner`);
    }
    if (recordValues(layout, 100).join(',') !== 'AcDbPlotSettings,AcDbLayout') {
      throw new RangeError(`${expected.layout} LAYOUT has the wrong subclasses`);
    }
    if (recordValues(layout, 1).at(-1) !== expected.layout) {
      throw new RangeError(`${expected.layout} LAYOUT has the wrong name`);
    }
    const blockRecord = blockRecordTable.entries.find(record => (
      recordValues(record, 2)[0] === expected.block
    ));
    if (!blockRecord) {
      throw new RangeError(`${expected.block} BLOCK_RECORD was not found`);
    }
    const blockRecordHandle = recordValues(blockRecord, 5)[0];
    if (recordValues(blockRecord, 340).length !== 1
      || recordValues(blockRecord, 340)[0] !== layoutHandle) {
      throw new RangeError(`${expected.block} BLOCK_RECORD has the wrong LAYOUT reference`);
    }
    if (recordValues(layout, 330).at(-1) !== blockRecordHandle) {
      throw new RangeError(`${expected.layout} LAYOUT has the wrong BLOCK_RECORD reference`);
    }
  }
  return graph;
}
