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
  const count = async input => request('/v1/responses/input_tokens', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input})});
  const empty = await count('');
  const parsed = await count([{role:'user',content:[{type:'input_file',file_id:file.id}]}]);
  assert.ok(parsed.input_tokens > empty.input_tokens + 10, 'PDF text must contribute to the input estimate');
  console.log('Packaged PDF extraction passed without upstream requests');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkPackagedPdf(process.argv[2], process.argv[3]);
}
