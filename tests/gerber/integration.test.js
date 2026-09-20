import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGerber } from '../../src/gerber/index.js';

const context = { fileName: 'board.gbr', layerName: 'board' };
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gerber');
const loadFixture = name => new Uint8Array(readFileSync(join(fixtureDir, name)));

describe('Gerber fixtures', () => {
  it('plots outline.gbr as a single closed contour', () => {
    const result = parseGerber(loadFixture('outline.gbr'), context, { strokeMode: 'outline' });
    expect(result.summary.errorCount).toBe(0);
    expect(result.geometries).toHaveLength(1);
    expect(result.geometries[0]).toEqual(expect.objectContaining({
      type: 'polyline',
      closed: true,
      layer: 'board',
      fileName: 'board.gbr',
    }));
    expect(result.attributes).toEqual(expect.any(Object));
  });

  it('plots centerline.gbr as strokes plus remaining closed contours', () => {
    const outline = parseGerber(loadFixture('centerline.gbr'), context, { strokeMode: 'outline' });
    const centerline = parseGerber(
      loadFixture('centerline.gbr'),
      context,
      { strokeMode: 'centerline' },
    );
    expect(outline.summary.errorCount).toBe(0);
    expect(centerline.summary.errorCount).toBe(0);
    expect(outline.geometries.every(item => item.type === 'polyline' && item.closed)).toBe(true);
    expect(centerline.geometries).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'line' }),
      expect.objectContaining({ type: 'arc' }),
      expect.objectContaining({ type: 'polyline', closed: true }),
    ]));
  });

  it('plots macro-region.gbr flashes and polarity holes without fatal errors', () => {
    const result = parseGerber(loadFixture('macro-region.gbr'), context);
    const closed = result.geometries.filter(item => item.type === 'polyline' && item.closed);
    expect(result.summary.errorCount).toBe(0);
    expect(closed.length).toBeGreaterThanOrEqual(3);
    expect(closed.every(item => item.points.length >= 3)).toBe(true);
  });
});
