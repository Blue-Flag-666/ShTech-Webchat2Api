// 使用当前 .env 配置启动临时本地服务，真实调用一次学校上游。
import { once } from 'node:events';
import { configuration, createServer, events } from './server.mjs';
const config = configuration();
const stream = process.argv.includes('--stream');
if (!config.key || !(config.token || (config.username && config.password)) || !config.group) {
  console.error('请先在 .env 填写 API_KEY、GENAI_CHAT_GROUP_ID，以及 GENAI_TOKEN 或 CAS 用户名和密码');
  process.exitCode = 1;
} else {
  const server = createServer(config);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({model:'qwen-instruct',messages:[{role:'user',content:'请只回复：API连接成功'}],max_tokens:64,stream,net_go:false})
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
