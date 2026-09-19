const HPGL_PATTERN = /\.(?:hpgl|hpg|hgl|pltl?(?:[1-9]|[1-9]\d)?|h(?:0[1-9]|[1-9]\d))$/i;
const GERBER_PATTERN = /\.(?:gbr|ger|pho|art|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gm1|g(?:0?[1-9]|[1-9]\d))$/i;
const EXCELLON_PATTERN = /\.(?:drl|xnc|dr(?:0?[1-9]|[1-9]\d))$/i;
const GERBER_LIST_PATTERN = /(?:^|[_-])X-GBLIST\.txt$/i;
const DRILL_LIST_PATTERN = /(?:^|[_-])DRLIST(?:_M)?\.txt$/i;
const ZIP_PATTERN = /\.zip$/i;

export const isSupportedHpglName = name => HPGL_PATTERN.test(name);
export const isZipName = name => ZIP_PATTERN.test(name);

export function classifyInputName(name) {
  const leaf = String(name).split(/[\\/]/).pop() ?? '';
  if (ZIP_PATTERN.test(leaf)) return 'zip';
  if (GERBER_LIST_PATTERN.test(leaf)) return 'gerber-list';
  if (DRILL_LIST_PATTERN.test(leaf)) return 'drill-list';
  if (HPGL_PATTERN.test(leaf)) return 'hpgl';
  if (GERBER_PATTERN.test(leaf)) return 'gerber';
  if (EXCELLON_PATTERN.test(leaf)) return 'excellon';
  return 'unsupported';
}

export const isSupportedInputName = name => classifyInputName(name) !== 'unsupported';

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
