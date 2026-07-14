import { describe, expect, it } from 'vitest';
import { parseHpgl } from '../../src/hpgl/parser.js';

const ascii = text => new TextEncoder().encode(text);
const context = { fileName: 'a.hpgl', layerName: 'a' };

describe('parseHpgl independent shapes', () => {
  it('maps SP0 to ACI 1 and emits a circle, signed arc, and text', () => {
    const result = parseHpgl(
      ascii('SP0;PA0,0;CI40;PD;AA40,0,-180;PU;LBNOTE\x03'),
      context,
    );

    expect(result.geometries).toEqual([
      {
        type: 'circle',
        center: [0, 0],
        radius: 1,
        layer: 'a',
        color: 1,
        fileName: 'a.hpgl',
        offset: 10,
      },
      {
        type: 'arc',
        center: [1, 0],
        radius: 1,
        startAngle: 180,
        endAngle: 0,
        layer: 'a',
        color: 1,
        fileName: 'a.hpgl',
        offset: 18,
      },
      {
        type: 'text',
        point: [2, 0],
        text: 'NOTE',
        height: 5,
        rotation: 0,
        layer: 'a',
        color: 1,
        fileName: 'a.hpgl',
        offset: 33,
      },
    ]);
    expect(result.summary).toEqual({ geometryCount: 3, errorCount: 0, warningCount: 0 });
  });

  it('turns a full AA sweep into a circle and leaves the next movement at the same point', () => {
    const result = parseHpgl(
      ascii('PA40,0;PD;AA0,0,360;PD80,0;PU;'),
      context,
    );

    expect(result.geometries).toEqual([
      expect.objectContaining({
        type: 'circle', center: [0, 0], radius: 1, offset: 10,
      }),
      expect.objectContaining({
        type: 'line', points: [[1, 0], [2, 0]], offset: 20,
      }),
    ]);
  });

  it('recognizes a full-circle sweep within tolerance from either side', () => {
    const result = parseHpgl(
      ascii('PA40,0;PD;AA0,0,359.9999999995;AA0,0,360.0000000005;'),
      context,
    );

    expect(result.geometries).toEqual([
      expect.objectContaining({ type: 'circle', center: [0, 0], radius: 1 }),
      expect.objectContaining({ type: 'circle', center: [0, 0], radius: 1 }),
    ]);
  });

  it('computes positive and negative AA endpoints without normalizing angles', () => {
    const result = parseHpgl(
      ascii('PA40,0;PD;AA0,0,90;PD0,80;PU;PA0,40;PD;AA0,0,-90;PD80,0;PU;'),
      context,
    );

    expect(result.geometries).toEqual([
      expect.objectContaining({
        type: 'arc', center: [0, 0], radius: 1, startAngle: 0, endAngle: 90,
      }),
      expect.objectContaining({ type: 'line', points: [[0, 1], [0, 2]] }),
      expect.objectContaining({
        type: 'arc', center: [0, 0], radius: 1, startAngle: 90, endAngle: 0,
      }),
      expect.objectContaining({ type: 'line', points: [[1, 0], [2, 0]] }),
    ]);
  });

  it('computes positive and negative AR centers and endpoints from the current raw point', () => {
    const result = parseHpgl(
      ascii('PA40,0;PD;AR0,40,90;PD120,40;PU;PA40,0;PD;AR0,40,-90;PD-40,40;PU;'),
      context,
    );

    expect(result.geometries).toEqual([
      expect.objectContaining({
        type: 'arc', center: [1, 1], radius: 1, startAngle: -90, endAngle: 0,
      }),
      expect.objectContaining({ type: 'line', points: [[2, 1], [3, 1]] }),
      expect.objectContaining({
        type: 'arc', center: [1, 1], radius: 1, startAngle: -90, endAngle: -180,
      }),
      expect.objectContaining({ type: 'line', points: [[0, 1], [-1, 1]] }),
    ]);
  });

  it('updates position for a pen-up arc without emitting arc geometry', () => {
    const result = parseHpgl(ascii('PA40,0;AA0,0,90;PD0,80;PU;'), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ type: 'line', points: [[0, 1], [0, 2]] }),
    ]);
  });

  it('uses the average anisotropic SC scale for circle and arc radii', () => {
    const result = parseHpgl(
      ascii('IP0,0,4000,2000;SC0,100,0,100;PA50,50;CI10;PD;AA40,50,90;'),
      context,
    );

    expect(result.geometries).toEqual([
      expect.objectContaining({ type: 'circle', center: [50, 25], radius: 7.5 }),
      expect.objectContaining({ type: 'arc', center: [40, 25], radius: 7.5 }),
    ]);
  });

  it.each([
    'CI0',
    'CI-40',
    'CI',
    'AA40,0,90',
    'AA0,0,0',
    'AA0,0',
    'AR0,0,90',
    'AR40,0,0',
    'AR0,0',
  ])('does not flush or move state for invalid independent shape %s', command => {
    const result = parseHpgl(ascii(`PD40,0;${command};PD80,0;PU;`), context);

    expect(result.geometries).toEqual([
      expect.objectContaining({
        type: 'polyline', points: [[0, 0], [1, 0], [2, 0]],
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', command: command.slice(0, 2) }),
    ]);
  });

  it('preserves malformed UTF-8 labels with replacement characters', () => {
    const source = new Uint8Array([0x4c, 0x42, 0xc3, 0x28, 0x03]);
    const result = parseHpgl(source, context);

    expect(result.geometries).toEqual([
      expect.objectContaining({ type: 'text', point: [0, 0], text: '\ufffd(' }),
    ]);
  });
});
