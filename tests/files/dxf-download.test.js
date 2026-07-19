// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triggerDxfDownload } from '../../src/files/dxf-download.js';

describe('triggerDxfDownload', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clicks a detached DXF download and revokes its Blob URL', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const urlApi = {
      createObjectURL: vi.fn(() => 'blob:dxf'),
      revokeObjectURL: vi.fn(),
    };

    const name = triggerDxfDownload(
      new Uint8Array([0, 1, 2]).buffer,
      ' production ',
      { documentRef: document, urlApi },
    );

    expect(name).toBe('production.dxf');
    expect(urlApi.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'application/dxf' }),
    );
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0].download).toBe('production.dxf');
    expect(click.mock.instances[0].isConnected).toBe(false);
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:dxf');
  });

  it('revokes the URL when anchor click throws', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => { throw new Error('blocked'); });
    const urlApi = {
      createObjectURL: vi.fn(() => 'blob:blocked'),
      revokeObjectURL: vi.fn(),
    };

    expect(() => triggerDxfDownload(
      new ArrayBuffer(0),
      'drawing.dxf',
      { documentRef: document, urlApi },
    )).toThrow('blocked');
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:blocked');
  });

  it('revokes the URL when the anchor cannot be attached', () => {
    const urlApi = {
      createObjectURL: vi.fn(() => 'blob:append-failed'),
      revokeObjectURL: vi.fn(),
    };
    vi.spyOn(document.body, 'append').mockImplementation(() => {
      throw new Error('append blocked');
    });

    expect(() => triggerDxfDownload(
      new ArrayBuffer(0),
      'drawing.dxf',
      { documentRef: document, urlApi },
    )).toThrow('append blocked');
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:append-failed');
  });

  it('revokes the URL when creating the anchor throws', () => {
    const urlApi = {
      createObjectURL: vi.fn(() => 'blob:create-failed'),
      revokeObjectURL: vi.fn(),
    };
    const documentRef = {
      createElement: vi.fn(() => { throw new Error('create blocked'); }),
    };

    expect(() => triggerDxfDownload(
      new ArrayBuffer(0),
      'drawing.dxf',
      { documentRef, urlApi },
    )).toThrow('create blocked');
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:create-failed');
  });

  it('revokes the URL when removing the anchor throws', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'remove')
      .mockImplementation(() => { throw new Error('remove blocked'); });
    const urlApi = {
      createObjectURL: vi.fn(() => 'blob:remove-failed'),
      revokeObjectURL: vi.fn(),
    };

    expect(() => triggerDxfDownload(
      new ArrayBuffer(0),
      'drawing.dxf',
      { documentRef: document, urlApi },
    )).toThrow('remove blocked');
    expect(click).toHaveBeenCalledOnce();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:remove-failed');
  });
});
