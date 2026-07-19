import { normalizeOutputName } from './file-policy.js';

export function triggerDxfDownload(buffer, outputName, deps = {}) {
  const documentRef = deps.documentRef ?? document;
  const urlApi = deps.urlApi ?? URL;
  const blob = new Blob([buffer], { type: 'application/dxf' });
  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  const name = normalizeOutputName(outputName);
  anchor.href = objectUrl;
  anchor.download = name;
  anchor.hidden = true;
  try {
    documentRef.body.append(anchor);
    anchor.click();
    return name;
  } finally {
    anchor.remove();
    urlApi.revokeObjectURL(objectUrl);
  }
}
