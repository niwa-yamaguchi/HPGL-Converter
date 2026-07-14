const INVALID_LAYER_CHARS = /[<>/\\":;?*|=,]/g;

const stripExtension = name => name.replace(/\.[^.]+$/, '');

export function assignLayerNames(names) {
  const used = new Set();

  return names.map(name => {
    const base = stripExtension(name).replace(INVALID_LAYER_CHARS, '_') || 'layer';
    let candidate = base;

    for (let suffix = 2; used.has(candidate.toLocaleLowerCase('en-US')); suffix += 1) {
      candidate = `${base}_${suffix}`;
    }

    used.add(candidate.toLocaleLowerCase('en-US'));
    return candidate;
  });
}
