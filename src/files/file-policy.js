const INPUT_PATTERN = /\.(?:hpgl|hpg|plt|h(?:0[1-9]|[1-9]\d))$/i;
const ZIP_PATTERN = /\.zip$/i;

export const isSupportedHpglName = name => INPUT_PATTERN.test(name);
export const isZipName = name => ZIP_PATTERN.test(name);

export const fileIdentity = file => `${file.name}\0${file.size}\0${file.lastModified}`;

export function normalizeOutputName(name) {
  const base = name.trim() || 'converted.dxf';
  return /\.dxf$/i.test(base) ? base : `${base}.dxf`;
}

export function defaultOutputName(sourceName) {
  const leaf = String(sourceName).trim().split(/[\\/]/).pop() ?? '';
  const stem = leaf.replace(/\.[^.]+$/, '');
  return normalizeOutputName(stem);
}
