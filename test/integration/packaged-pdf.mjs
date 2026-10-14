import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { simplePdf } from '../fixtures.mjs';

// Exercise the lazily loaded PDF parser inside the actual distributed runtime.
export async function checkPackagedPdf(base, key) {
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options,
      headers: { Authorization: `Bearer ${key}`, ...options.headers }, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`);
    return response.json();
  };
  const form = new FormData();
  form.append('purpose', 'assistants');
  form.append('file', new File([simplePdf('Packaged PDF compression verification')], 'runtime.pdf', { type: 'application/pdf' }));
  const file = await request('/v1/files', { method: 'POST', body: form });
  const store = await request('/v1/vector_stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_ids: [file.id] }) });
  assert.equal(store.file_counts.completed, 1);
  const result = await request(`/v1/vector_stores/${store.id}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'compression verification' }) });
  assert.equal(result.data[0]?.file_id, file.id);
  console.log('Packaged PDF extraction and search passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkPackagedPdf(process.argv[2], process.argv[3]);
}
