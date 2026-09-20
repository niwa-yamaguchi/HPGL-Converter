import { parseGerberObjects } from './parser.js';
import { plotGerber } from './plotter.js';

export { parseApertureDefinition, instantiateAperture } from './apertures.js';
export { parseGerberObjects } from './parser.js';
export { plotGerber, DEFAULT_LIMITS } from './plotter.js';

export function parseGerber(data, context, options = {}) {
  const parsed = parseGerberObjects(data, context);
  const plotted = plotGerber(parsed, context, options);
  return {
    geometries: plotted.geometries,
    diagnostics: plotted.diagnostics,
    summary: plotted.summary,
    attributes: parsed.attributes,
  };
}
