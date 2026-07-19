import { describe, expect, it, vi } from 'vitest';
import { createUploadExpansionJob } from '../../src/files/upload-expander.js';

const file = (name, content = 'PU;') => (
  new File([content], name, { lastModified: 123 })
);

describe('createUploadExpansionJob', () => {
  it('preserves source order across HPGL, ZIP, and unsupported files', async () => {
    const zipItem = {
      name: 'parts/A.H01',
      blob: new Blob(['PU;']),
      size: 3,
      identity: 'zip-entry',
    };
    const createZipJob = vi.fn(() => ({
      promise: Promise.resolve({
        items: [zipItem],
        ignored: {
          directories: 0, unsupported: 1, nestedArchives: 0, unsafePaths: 0,
        },
      }),
      cancel: vi.fn(),
    }));

    const result = await createUploadExpansionJob([
      file('first.H01'),
      file('bundle.zip'),
      file('notes.txt'),
      file('last.plt'),
    ], { createZipJob }).promise;

    expect(result.results.map(source => source.kind)).toEqual([
      'hpgl', 'zip', 'unsupported', 'hpgl',
    ]);
    expect(result.results[1].items).toEqual([zipItem]);
    expect(result.results[2].items).toEqual([]);
  });

  it('keeps later sources after one ZIP fails', async () => {
    const createZipJob = vi.fn(() => ({
      promise: Promise.reject(new Error('broken archive')),
      cancel: vi.fn(),
    }));

    const result = await createUploadExpansionJob([
      file('broken.zip'),
      file('good.H01'),
    ], { createZipJob }).promise;

    expect(result.results[0]).toMatchObject({
      sourceName: 'broken.zip', kind: 'zip', items: [], error: expect.any(Error),
    });
    expect(result.results[1]).toMatchObject({
      sourceName: 'good.H01', kind: 'hpgl', items: [expect.any(Object)], error: null,
    });
  });

  it('cancels the active ZIP and rejects with AbortError', async () => {
    const cancel = vi.fn();
    const createZipJob = vi.fn(() => ({
      promise: new Promise(() => {}),
      cancel,
    }));
    const job = createUploadExpansionJob([file('pending.zip')], { createZipJob });
    await Promise.resolve();
    job.cancel();

    await expect(job.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
