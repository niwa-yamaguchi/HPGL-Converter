const INPUT_PATTERN = /\.(?:hpgl|hpg|plt|h(?:0[1-9]|[1-9]\d))$/i;

export const isSupportedHpglName = name => INPUT_PATTERN.test(name);

export const fileIdentity = file => `${file.name}\0${file.size}\0${file.lastModified}`;

export function normalizeOutputName(name) {
  const base = name.trim() || 'converted.dxf';
  return /\.dxf$/i.test(base) ? base : `${base}.dxf`;
}
