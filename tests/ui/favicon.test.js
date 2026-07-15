import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readProjectFile = path => readFile(resolve(path), 'utf8');

describe('favicon', () => {
  it('links the SVG favicon from the document head', async () => {
    const html = await readProjectFile('index.html');

    expect(html).toContain(
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    );
  });

  it('uses the approved conversion-arrow SVG design', async () => {
    const svg = await readProjectFile('public/favicon.svg');

    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain('fill="#146fae"');
    expect(svg).toContain('stroke="#ffffff"');
    expect(svg).toContain('fill="#f1a72d"');
    expect(svg).toContain('fill="#0c223d"');
    expect(svg.match(/<path\b/g)).toHaveLength(2);
    expect(svg.match(/<circle\b/g)).toHaveLength(2);
  });
});
