import { isSupportedHpglName, isZipName } from './file-policy.js';
import { createNativeInputRecord } from './input-records.js';
import { createZipExpansionJob } from './zip-reader.js';

const emptyIgnored = () => ({
  directories: 0,
  unsupported: 0,
  nestedArchives: 0,
  unsafePaths: 0,
});

const abortError = () => new DOMException('Upload expansion cancelled', 'AbortError');

export function createUploadExpansionJob(sources, options = {}) {
  if (!Array.isArray(sources)) {
    throw new TypeError('Upload sources must be an array');
  }
  const createZipJob = options.createZipJob ?? createZipExpansionJob;
  let currentJob = null;
  let cancelled = false;
  let settled = false;
  let rejectCancellation;
  const cancellation = new Promise((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const work = (async () => {
    const results = [];
    for (const source of sources) {
      if (cancelled) {
        throw abortError();
      }
      if (isSupportedHpglName(source.name)) {
        results.push({
          sourceName: source.name,
          kind: 'hpgl',
          items: [createNativeInputRecord(source)],
          ignored: emptyIgnored(),
          error: null,
        });
        continue;
      }
      if (!isZipName(source.name)) {
        results.push({
          sourceName: source.name,
          kind: 'unsupported',
          items: [],
          ignored: { ...emptyIgnored(), unsupported: 1 },
          error: null,
        });
        continue;
      }
      currentJob = createZipJob(source);
      try {
        const expanded = await currentJob.promise;
        results.push({
          sourceName: source.name,
          kind: 'zip',
          items: expanded.items,
          ignored: expanded.ignored,
          error: null,
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }
        results.push({
          sourceName: source.name,
          kind: 'zip',
          items: [],
          ignored: emptyIgnored(),
          error: error instanceof Error ? error : new Error('ZIP expansion failed'),
        });
      } finally {
        currentJob = null;
      }
    }
    return { results };
  })();

  const promise = Promise.race([work, cancellation]).finally(() => {
    settled = true;
  });

  return {
    promise,
    cancel() {
      if (settled || cancelled) {
        return;
      }
      cancelled = true;
      currentJob?.cancel();
      rejectCancellation(abortError());
    },
  };
}
