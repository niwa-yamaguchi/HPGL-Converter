export function escapeDxfText(value) {
  if (typeof value !== 'string') {
    throw new TypeError('DXF text must be a string');
  }

  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit === 0x7f) {
      escaped += ' ';
    } else if (codeUnit <= 0x7e) {
      escaped += value[index];
    } else {
      escaped += `\\U+${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return escaped;
}
