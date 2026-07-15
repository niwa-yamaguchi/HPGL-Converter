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

export function validateHandleGraph(tags) {
  const handles = tags
    .filter(tag => tag.code === 5 || tag.code === 105)
    .map(tag => tag.value);
  const unique = new Set(handles);
  if (unique.size !== handles.length) {
    throw new RangeError('DXF contains duplicate handles');
  }
  const references = tags
    .filter(tag => [330, 340, 350, 360].includes(tag.code))
    .map(tag => tag.value)
    .filter(value => value !== '0');
  const missing = references.filter(reference => !unique.has(reference));
  if (missing.length > 0) {
    throw new RangeError(`DXF contains missing handle references: ${missing.join(', ')}`);
  }
  return { handles: unique, references };
}
