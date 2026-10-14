// 使用当前 .env 配置启动临时本地服务，真实调用一次学校上游。
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { configuration, createServer, events } from '../src/server.mjs';
import { fetchModelList } from '../src/transport.mjs';
import { isKimiK3Model } from '../src/models.mjs';
const config = configuration();
config.modelTtl = 0;
if (process.argv.includes('--cas')) config.token='';
const stream = process.argv.includes('--stream');
if (!config.key || !(config.token || (config.username && config.password))) {
  console.error('请先在 .env 填写 API_KEY，以及 GENAI_TOKEN 或 CAS 用户名和密码');
  process.exitCode = 1;
} else {
  let catalogueFresh = false;
  const liveModelFetcher = async (token, signal) => {
    catalogueFresh = false;
    const result = await fetchModelList(token, signal);
    const records = result?.result?.records || result?.data?.records || result?.data || [];
    assert.ok(Array.isArray(records) && result?.success !== false && (result?.success === true || records.length), 'Cannot confirm a fresh school model catalogue');
    catalogueFresh = true;
    return result;
  };
  const server = createServer(config, undefined, liveModelFetcher);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' };
    const catalogue = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(config.timeout + 15000) });
    assert.equal(catalogue.status, 200, 'Cannot read the current school model catalogue');
    assert.ok(catalogueFresh, 'Refusing inference with an outage fallback catalogue');
    const models = (await catalogue.json()).data;
    assert.ok(Array.isArray(models), 'Invalid school model catalogue');
    const selfHosted = models.filter(item => item.root_ai_type === 'xinference' && item.owned_by === 'shanghaitech' && item.primary !== false);
    const model = selfHosted.find(isKimiK3Model) || selfHosted[0];
    assert.ok(model, 'No confirmed self-deployed models are available');
    catalogueFresh = false;
    const check = await fetch(`${base}/v1/models/${encodeURIComponent(model.id)}`, { headers, signal: AbortSignal.timeout(config.timeout + 15000) });
    assert.equal(check.status, 200, 'Selected model is no longer available');
    assert.ok(catalogueFresh, 'Cannot confirm fresh model metadata before inference');
    const selected = await check.json();
    assert.equal(selected.root_ai_type, 'xinference', 'Refusing a model not confirmed as self-deployed');
    assert.equal(selected.owned_by, 'shanghaitech');
    console.log(`Verifying confirmed Xinference model: ${model.id}`);
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({model:model.id,messages:[{role:'user',content:'请只回复：API连接成功'}],max_tokens:64,stream,net_go:false}),
      signal: AbortSignal.timeout(config.timeout + 15000)
    });
    console.log(`HTTP ${res.status}`);
    if (stream && res.ok) {
      let text = '', done = false, count = 0;
      for await (const event of events(res.body)) {
        if (event.data === '[DONE]') { done = true; break; }
        const chunk = JSON.parse(event.data);
        if (chunk.error) throw new Error(chunk.error.message);
        text += chunk.choices?.[0]?.delta?.content || ''; count++;
      }
      console.log(text); console.log(`SSE chunks: ${count}; DONE: ${done}`);
      if (!done || !text) process.exitCode = 1;
    } else {
      const body = await res.json();
      console.log(res.ok ? body.choices?.[0]?.message?.content : body.error?.message);
      if (!res.ok || !body.choices?.[0]?.message?.content) process.exitCode = 1;
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
