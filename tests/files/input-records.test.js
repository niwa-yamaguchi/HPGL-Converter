import { describe, expect, it } from 'vitest';
import {
  createArchiveInputRecord,
  createNativeInputRecord,
  toWorkerInput,
} from '../../src/files/input-records.js';

describe('input records', () => {
  it('wraps a native File without copying its bytes', () => {
    const file = new File(['PA0,0;'], 'drawing.H01', { lastModified: 123 });
    const record = createNativeInputRecord(file);

    expect(record).toMatchObject({
      name: 'drawing.H01',
      blob: file,
      size: file.size,
      identity: `drawing.H01\0${file.size}\0${file.lastModified}`,
    });
  });

  it('keeps an archive relative path outside File.name', async () => {
    const source = new File(['zip'], 'drawings.zip', { lastModified: 456 });
    const bytes = new TextEncoder().encode('PD40,0;PU;');
    const record = createArchiveInputRecord(
      source,
      'parts/A.H01',
      bytes,
      'sha256:abc123',
    );

    expect(record.name).toBe('parts/A.H01');
    expect(record.size).toBe(bytes.byteLength);
    expect(record.identity).toBe(
      `drawings.zip\0${source.size}\0${source.lastModified}`
      + '\0sha256:abc123\0parts/A.H01',
    );
    expect(new Uint8Array(await record.blob.arrayBuffer())).toEqual(bytes);
  });

  it('creates a structured-cloneable worker payload', () => {
    const file = new File(['PU;'], 'drawing.hpgl');
    const record = createNativeInputRecord(file);

    expect(toWorkerInput(record)).toEqual({ name: 'drawing.hpgl', blob: file });
  });

  it('records native kind and file-name path', () => {
    const file = new File(['G04*'], 'board.gtl', { lastModified: 123 });
    const record = createNativeInputRecord(file);

    expect(record.kind).toBe('gerber');
    expect(record.path).toBe('board.gtl');
  });

  it('records archive kind from the entry leaf and the normalized path', () => {
    const source = new File(['zip'], 'drawings.zip', { lastModified: 456 });
    const bytes = new TextEncoder().encode('M48');
    const record = createArchiveInputRecord(
      source,
      'fab/board.drl',
      bytes,
      'sha256:abc123',
    );

    expect(record.kind).toBe('excellon');
    expect(record.path).toBe('fab/board.drl');
  });

  it.each([null, {}, { name: 'a', blob: {}, size: 0, identity: 'a' }])(
    'rejects invalid input record %j',
    record => expect(() => toWorkerInput(record)).toThrow(TypeError),
  );
});
