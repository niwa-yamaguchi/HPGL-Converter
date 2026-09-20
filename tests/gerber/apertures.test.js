import { describe, expect, it } from 'vitest';
import {
  instantiateAperture,
  parseApertureDefinition,
} from '../../src/gerber/apertures.js';

const macrosOf = (name, primitives, offset = 12) => new Map([
  [name, { name, primitives, offset }],
]);

const maxRadius = path => Math.max(...path.map(point => Math.hypot(point.x, point.y)));

const bounds = path => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of path) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
};

const hasPoint = (path, x, y, digits = 6) => {
  const scale = 10 ** digits;
  return path.some(point => (
    Math.round(point.x * scale) === Math.round(x * scale)
    && Math.round(point.y * scale) === Math.round(y * scale)
  ));
};

const instantiate = (command, macros = new Map(), options = { chordToleranceMm: 0.01 }) => (
  instantiateAperture(parseApertureDefinition(command, macros), options)
);

describe('parseApertureDefinition', () => {
  it('parses standard C, R, O, and P templates', () => {
    expect(parseApertureDefinition('ADD10C,1.0', new Map())).toEqual(expect.objectContaining({
      kind: 'circle', code: 10, template: 'C', modifiers: [1],
    }));
    expect(parseApertureDefinition('ADD11R,2.0X1.0', new Map())).toEqual(expect.objectContaining({
      kind: 'rectangle', code: 11, template: 'R', modifiers: [2, 1],
    }));
    expect(parseApertureDefinition('ADD12O,2.0X1.0', new Map())).toEqual(expect.objectContaining({
      kind: 'obround', code: 12, template: 'O', modifiers: [2, 1],
    }));
    expect(parseApertureDefinition('ADD13P,2.0X6X30', new Map())).toEqual(expect.objectContaining({
      kind: 'polygon', code: 13, template: 'P', modifiers: [2, 6, 30],
    }));
  });

  it('attaches macro primitives from the AM map', () => {
    const macros = macrosOf('Donut', ['1,1,$1,0,0', '1,0,$2,0,0']);
    expect(parseApertureDefinition('ADD10Donut,1.5X0.5', macros)).toEqual(expect.objectContaining({
      kind: 'macro',
      code: 10,
      template: 'Donut',
      modifiers: [1.5, 0.5],
      primitives: ['1,1,$1,0,0', '1,0,$2,0,0'],
    }));
  });

  it('rejects unknown macros and codes below 10', () => {
    expect(() => parseApertureDefinition('ADD10Unknown,1', new Map())).toThrow(/macro/i);
    expect(() => parseApertureDefinition('ADD9C,1.0', new Map())).toThrow();
  });
});

describe('instantiateAperture', () => {
  it.each([
    ['C,1.0', 1], ['R,2.0X1.0', 1], ['O,2.0X1.0', 1], ['P,2.0X6X30', 1],
  ])('materializes %s as a closed path', (body, pathCount) => {
    const aperture = parseApertureDefinition(`ADD10${body}`, new Map());
    const paths = instantiateAperture(aperture, { chordToleranceMm: 0.01 });
    expect(paths).toHaveLength(pathCount);
    expect(paths[0].path.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps standard apertures origin-centered and dark', () => {
    const circle = instantiate('ADD10C,1.0');
    const rectangle = instantiate('ADD10R,2.0X1.0');
    const obround = instantiate('ADD10O,2.0X1.0');
    const polygon = instantiate('ADD10P,2.0X6X30');

    expect(circle[0].exposure).toBe('dark');
    expect(maxRadius(circle[0].path)).toBeCloseTo(0.5, 6);
    expect(bounds(circle[0].path).cx).toBeCloseTo(0, 6);
    expect(bounds(circle[0].path).cy).toBeCloseTo(0, 6);

    expect(rectangle[0].path).toHaveLength(4);
    expect(hasPoint(rectangle[0].path, 1, 0.5)).toBe(true);
    expect(hasPoint(rectangle[0].path, -1, -0.5)).toBe(true);
    expect(bounds(rectangle[0].path)).toEqual(expect.objectContaining({
      minX: -1, maxX: 1, minY: -0.5, maxY: 0.5,
    }));

    const obroundBox = bounds(obround[0].path);
    expect(obroundBox.minX).toBeCloseTo(-1, 5);
    expect(obroundBox.maxX).toBeCloseTo(1, 5);
    expect(obroundBox.minY).toBeCloseTo(-0.5, 5);
    expect(obroundBox.maxY).toBeCloseTo(0.5, 5);
    expect(obround[0].path.length).toBeGreaterThan(4);

    expect(polygon[0].path).toHaveLength(6);
    expect(hasPoint(polygon[0].path, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6))).toBe(true);
  });

  it('adds a clear circular hole for C,1.0X0.4', () => {
    const paths = instantiate('ADD10C,1.0X0.4');
    expect(paths).toHaveLength(2);
    expect(paths[0].exposure).toBe('dark');
    expect(paths[1].exposure).toBe('clear');
    expect(maxRadius(paths[0].path)).toBeCloseTo(0.5, 6);
    expect(maxRadius(paths[1].path)).toBeCloseTo(0.2, 6);
    expect(bounds(paths[1].path).cx).toBeCloseTo(0, 6);
    expect(bounds(paths[1].path).cy).toBeCloseTo(0, 6);
  });

  it('adds a clear circular hole for a rectangle', () => {
    const paths = instantiate('ADD10R,2.0X1.0X0.4');
    expect(paths).toHaveLength(2);
    expect(paths[1].exposure).toBe('clear');
    expect(maxRadius(paths[1].path)).toBeCloseTo(0.2, 6);
  });

  it('adds a clear rectangular hole for R,2.0X1.0X0.6X0.4', () => {
    const paths = instantiate('ADD10R,2.0X1.0X0.6X0.4');
    expect(paths).toHaveLength(2);
    expect(paths[1].exposure).toBe('clear');
    expect(paths[1].path).toHaveLength(4);
    expect(hasPoint(paths[1].path, 0.3, 0.2)).toBe(true);
    expect(hasPoint(paths[1].path, -0.3, -0.2)).toBe(true);
    expect(bounds(paths[1].path).cx).toBeCloseTo(0, 6);
    expect(bounds(paths[1].path).cy).toBeCloseTo(0, 6);
  });

  it('adds a clear rectangular hole for a circle', () => {
    const paths = instantiate('ADD10C,1.0X0.4X0.2');
    expect(paths).toHaveLength(2);
    expect(paths[1].exposure).toBe('clear');
    expect(paths[1].path).toHaveLength(4);
    expect(hasPoint(paths[1].path, 0.2, 0.1)).toBe(true);
  });

  it('clamps circle tessellation between 12 and 4096 segments', () => {
    const tiny = instantiate('ADD10C,0.01', new Map(), { chordToleranceMm: 0.01 });
    const huge = instantiate('ADD10C,100000', new Map(), { chordToleranceMm: 0.01 });
    expect(tiny[0].path.length).toBe(12);
    expect(huge[0].path.length).toBe(4096);
  });

  it('scales inch paths without converting polygon vertices or rotation', () => {
    const aperture = parseApertureDefinition('ADD10P,0.1X6X30', new Map());
    const paths = instantiateAperture(aperture, { chordToleranceMm: 0.01, units: 'inch' });
    const radius = 0.05 * 25.4;
    expect(aperture.modifiers).toEqual([0.1, 6, 30]);
    expect(paths[0].path).toHaveLength(6);
    expect(hasPoint(
      paths[0].path,
      radius * Math.cos(Math.PI / 6),
      radius * Math.sin(Math.PI / 6),
    )).toBe(true);
  });

  it('scales inch AM circle literals to millimetres', () => {
    const macros = macrosOf('Disk', ['1,1,0.1,0,0']);
    const paths = instantiate('ADD10Disk', macros, { chordToleranceMm: 0.01, units: 'inch' });
    expect(maxRadius(paths[0].path)).toBeCloseTo(1.27, 5);
  });

  it('evaluates variable assignment, x multiply, and parentheses', () => {
    const macros = macrosOf('Scaled', [
      '$3=($1+$2)x0.5',
      '1,1,$3,0,0',
    ]);
    const paths = instantiate('ADD10Scaled,2.0X4.0', macros);
    expect(paths).toHaveLength(1);
    expect(paths[0].exposure).toBe('dark');
    expect(maxRadius(paths[0].path)).toBeCloseTo(1.5, 6);
  });

  it('expands circle primitive 1 with dark and clear exposure', () => {
    const macros = macrosOf('Donut', ['1,1,$1,0,0', '1,0,$2,0,0']);
    const paths = instantiate('ADD10Donut,1.5X0.5', macros);
    expect(paths.map(item => item.exposure)).toEqual(['dark', 'clear']);
    expect(maxRadius(paths[0].path)).toBeCloseTo(0.75, 6);
    expect(maxRadius(paths[1].path)).toBeCloseTo(0.25, 6);
  });

  it('rotates a circle primitive around the aperture origin after generation', () => {
    const macros = macrosOf('OffCenter', ['1,1,0.2,1,0,90']);
    const box = bounds(instantiate('ADD10OffCenter,1', macros)[0].path);
    expect(box.cx).toBeCloseTo(0, 5);
    expect(box.cy).toBeCloseTo(1, 5);
  });

  it('expands outline primitive 4', () => {
    const macros = macrosOf('Tri', ['4,1,3,0,0,1,0,0.5,0.866,0,0,0']);
    const path = instantiate('ADD10Tri,1', macros)[0].path;
    expect(path).toHaveLength(3);
    expect(hasPoint(path, 0, 0)).toBe(true);
    expect(hasPoint(path, 1, 0)).toBe(true);
    expect(hasPoint(path, 0.5, 0.866)).toBe(true);
  });

  it('expands polygon primitive 5', () => {
    const macros = macrosOf('Hex', ['5,1,6,0,0,2,30']);
    const path = instantiate('ADD10Hex,1', macros)[0].path;
    expect(path).toHaveLength(6);
    expect(hasPoint(path, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6))).toBe(true);
  });

  it('expands moire primitive 6 into rings and crosshairs', () => {
    const macros = macrosOf('Moire', ['6,0,0,5,0.5,0.4,2,0.2,4,0']);
    const paths = instantiate('ADD10Moire,1', macros);
    expect(paths.length).toBeGreaterThanOrEqual(4);
    expect(paths.some(item => item.exposure === 'dark')).toBe(true);
    expect(paths.some(item => item.exposure === 'clear')).toBe(true);
    expect(Math.max(...paths.map(item => maxRadius(item.path)))).toBeCloseTo(2.5, 5);
  });

  it('expands thermal primitive 7 into a ring with clear gaps', () => {
    const macros = macrosOf('Thermal', ['7,0,0,1,0.5,0.2,0']);
    const paths = instantiate('ADD10Thermal,1', macros);
    const dark = paths.filter(item => item.exposure === 'dark');
    const clear = paths.filter(item => item.exposure === 'clear');
    expect(dark).toHaveLength(1);
    expect(clear.length).toBeGreaterThanOrEqual(5);
    expect(maxRadius(dark[0].path)).toBeCloseTo(0.5, 6);
  });

  it('expands vector line primitive 20', () => {
    const macros = macrosOf('Vec', ['20,1,0.2,0,0,1,0,0']);
    const box = bounds(instantiate('ADD10Vec,1', macros)[0].path);
    expect(box.minX).toBeCloseTo(0, 6);
    expect(box.maxX).toBeCloseTo(1, 6);
    expect(box.minY).toBeCloseTo(-0.1, 6);
    expect(box.maxY).toBeCloseTo(0.1, 6);
  });

  it('expands center line primitive 21', () => {
    const macros = macrosOf('Ctr', ['21,1,2,1,0,0,0']);
    const path = instantiate('ADD10Ctr,1', macros)[0].path;
    expect(path).toHaveLength(4);
    expect(hasPoint(path, 1, 0.5)).toBe(true);
    expect(hasPoint(path, -1, -0.5)).toBe(true);
  });

  it('expands lower-left line primitive 22', () => {
    const macros = macrosOf('Ll', ['22,1,2,1,-1,-0.5,0']);
    const path = instantiate('ADD10Ll,1', macros)[0].path;
    expect(path).toHaveLength(4);
    expect(hasPoint(path, -1, -0.5)).toBe(true);
    expect(hasPoint(path, 1, 0.5)).toBe(true);
  });

  it('treats space-stripped 0$ AM comment lines as comments', () => {
    const macros = macrosOf('RoundRect', [
      '0$1Rounding radius',
      '1,1,$1+$1,0,0',
      '20,1,$1,0,0,$1+$1,0,0',
    ]);

    expect(() => instantiate('ADD10RoundRect,0.2', macros)).not.toThrow(/R/);
    const paths = instantiate('ADD10RoundRect,0.2', macros);
    expect(paths.length).toBeGreaterThan(0);
    expect(maxRadius(paths[0].path)).toBeCloseTo(0.2, 6);
  });

  it('skips comment primitives and evaluates a KiCad-style roundrect macro', () => {
    const macros = macrosOf('RoundRect', [
      '0 Box with rounded corners',
      '$4=$1x0.5',
      '$5=$2x0.5',
      '21,1,$1-$3,$2-$3,0,0,0',
      '1,1,$3,$4-$3x0.5,$5-$3x0.5',
    ]);
    const paths = instantiate('ADD10RoundRect,2.0X1.0X0.2', macros);
    expect(paths).toHaveLength(2);
    expect(paths.every(item => item.exposure === 'dark')).toBe(true);
    expect(hasPoint(paths[0].path, 0.9, 0.4)).toBe(true);
    expect(hasPoint(paths[0].path, -0.9, -0.4)).toBe(true);
    const circle = bounds(paths[1].path);
    expect(circle.cx).toBeCloseTo(0.9, 5);
    expect(circle.cy).toBeCloseTo(0.4, 5);
    expect(maxRadius(paths[1].path.map(point => ({
      x: point.x - circle.cx,
      y: point.y - circle.cy,
    })))).toBeCloseTo(0.1, 5);
  });

  it('throws errors that carry the original AM or AD offset', () => {
    const undefinedVar = parseApertureDefinition(
      'ADD10Bad,1',
      macrosOf('Bad', ['1,1,$9,0,0'], 40),
    );
    undefinedVar.offset = 80;
    try {
      instantiateAperture(undefinedVar, { chordToleranceMm: 0.01 });
      throw new Error('expected undefined variable to throw');
    } catch (error) {
      expect(error.message).toMatch(/variable/i);
      expect(error.offset).toBe(80);
    }

    const divZero = parseApertureDefinition(
      'ADD10Zero,1',
      macrosOf('Zero', ['1,1,1/0,0,0'], 15),
    );
    divZero.offset = 21;
    expect(() => instantiateAperture(divZero, { chordToleranceMm: 0.01 })).toThrow(/zero/i);

    const vertices = parseApertureDefinition(
      'ADD10Hex,1',
      macrosOf('Hex', ['5,1,6,0,0,2,0'], 8),
    );
    vertices.offset = 9;
    try {
      instantiateAperture(vertices, { chordToleranceMm: 0.01, maxVertices: 5 });
      throw new Error('expected vertex limit to throw');
    } catch (error) {
      expect(error.message).toMatch(/vertex/i);
      expect(error.offset).toBe(9);
    }
  });
});
