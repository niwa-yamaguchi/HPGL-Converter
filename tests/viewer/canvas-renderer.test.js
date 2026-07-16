import { describe, expect, it, vi } from 'vitest';
import { renderViewer } from '../../src/viewer/canvas-renderer.js';

const fakeCanvas = (width, height) => {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillText: vi.fn(),
  };
  const canvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: vi.fn(() => ({ width, height })),
    getContext: vi.fn(() => context),
  };
  return { canvas, context };
};

const viewport = { centerX: 5, centerY: 5, scale: 10, width: 400, height: 240 };

describe('canvas renderer', () => {
  it('sizes for DPR and flips world Y while drawing every supported shape', () => {
    const { canvas, context } = fakeCanvas(400, 240);
    renderViewer(canvas, [{
      color: '#146fae',
      opacity: 0.75,
      geometries: [
        { type: 'line', points: [[0, 0], [10, 10]] },
        { type: 'polyline', points: [[0, 0], [2, 3], [4, 5]] },
        { type: 'circle', center: [5, 5], radius: 2 },
        { type: 'arc', center: [8, 8], radius: 3, startAngle: 0, endAngle: 90 },
        { type: 'text', point: [1, 2], text: 'A', height: 5, rotation: 30 },
      ],
    }], viewport, { devicePixelRatio: 2 });

    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(480);
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 400, 240);
    expect(context.lineTo).toHaveBeenCalledWith(250, 70);
    expect(context.arc).toHaveBeenCalledWith(200, 120, 20, 0, Math.PI * 2);
    expect(context.translate).toHaveBeenCalledWith(160, 150);
    expect(context.rotate).toHaveBeenCalledWith(-Math.PI / 6);
    expect(context.fillText).toHaveBeenCalledWith('A', 0, 0);
    expect(context.stroke).toHaveBeenCalledTimes(4);
    expect(context.strokeStyle).toBe('#146fae');
    expect(context.fillStyle).toBe('#146fae');
    expect(context.globalAlpha).toBe(0.75);
    expect(context.lineWidth).toBe(1.25);
    expect(context.font).toBe('50px sans-serif');
  });

  it('preserves positive and negative HPGL arc sweeps after flipping Y', () => {
    const { canvas, context } = fakeCanvas(400, 240);
    renderViewer(canvas, [{
      color: '#000000',
      geometries: [
        { type: 'arc', center: [5, 5], radius: 2, startAngle: 10, endAngle: 100 },
        { type: 'arc', center: [5, 5], radius: 2, startAngle: 100, endAngle: 10 },
      ],
    }], viewport, { devicePixelRatio: 1 });

    expect(context.arc).toHaveBeenNthCalledWith(
      1, 200, 120, 20, -10 * Math.PI / 180, -100 * Math.PI / 180, true,
    );
    expect(context.arc).toHaveBeenNthCalledWith(
      2, 200, 120, 20, -100 * Math.PI / 180, -10 * Math.PI / 180, false,
    );
  });

  it('only prepares and clears the canvas when groups are empty', () => {
    const { canvas, context } = fakeCanvas(400, 240);
    renderViewer(canvas, [], viewport, { devicePixelRatio: 1 });

    expect(context.clearRect).toHaveBeenCalledOnce();
    expect(context.beginPath).not.toHaveBeenCalled();
    expect(context.stroke).not.toHaveBeenCalled();
    expect(context.fillText).not.toHaveBeenCalled();
  });
});
