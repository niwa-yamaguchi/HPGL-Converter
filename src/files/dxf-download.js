import { normalizeOutputName } from './file-policy.js';

export function triggerDxfDownload(buffer, outputName, deps = {}) {
  const documentRef = deps.documentRef ?? document;
  const urlApi = deps.urlApi ?? URL;
  const name = normalizeOutputName(outputName);
  const blob = new Blob([buffer], { type: 'application/dxf' });
  const objectUrl = urlApi.createObjectURL(blob);
  let anchor;
  try {
    anchor = documentRef.createElement('a');
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.hidden = true;
    documentRef.body.append(anchor);
    anchor.click();
    return name;
  } finally {
    try {
      anchor?.remove();
    } finally {
      urlApi.revokeObjectURL(objectUrl);
    }
  }
}
