import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fetchModelList, upstreamFetch } from './transport.mjs';
import { modelDirectory } from './models.mjs';
import { TokenManager, secret } from './auth.mjs';
import { toolPolicy, toolPrompt, normalizeMessages, parseToolCalls } from './tools.mjs';
import { normalizeRequest, ProtocolOutput } from './protocols.mjs';
import { shutdown } from './lifecycle.mjs';

const UPSTREAM = 'https://genai.shanghaitech.edu.cn/htk/chat/start/chat';
const error = (status, message) => Object.assign(new Error(message), { status });
const bool = value => value === 'true';
export function configuration(env = process.env) {
  return { host: env.HOST || '127.0.0.1', port: Number(env.PORT || 8787),
    token: secret(env,'GENAI_TOKEN'), cookie: secret(env,'GENAI_COOKIE'),
    username: secret(env,'GENAI_USERNAME'), password: secret(env,'GENAI_PASSWORD'),
    group: env.GENAI_CHAT_GROUP_ID || '', key: secret(env,'API_KEY'),
    netGo: bool(env.GENAI_NET_GO), timeout: Number(env.GENAI_TIMEOUT_MS || 120000), modelTtl: Number(env.GENAI_MODEL_TTL_MS || 300000) };
}

export function upstreamBody(input, config, supportedModels) {
  const allowed = supportedModels?.length ? supportedModels : [{ id: 'qwen-instruct', root_ai_type: 'xinference' }];
  const selected = allowed.find(x => (typeof x === 'string' ? x : x.id) === (input.model ?? 'qwen-instruct'));
  if (!selected) throw error(400, `模型不可用：${input.model}`);
  const messages = normalizeMessages(input.messages, toolPolicy(input.tools,input.tool_choice));
  if (messages.at(-1).role !== 'user') throw error(400, '最后一条消息必须为 user 或工具结果');
  for (const key of Object.keys(input)) if (!['model','messages','stream','max_tokens','chat_group_id','net_go','tools','tool_choice'].includes(key)) throw error(400, `暂不支持参数 ${key}`);
  if (input.stream !== undefined && typeof input.stream !== 'boolean') throw error(400, 'stream 必须是布尔值');
  if (input.net_go !== undefined && typeof input.net_go !== 'boolean') throw error(400, 'net_go 必须是布尔值');
  const max = input.max_tokens ?? 16384;
  if (!Number.isInteger(max) || max < 1 || max > 16384) throw error(400, 'max_tokens 必须是 1–16384 的整数');
  const group = input.chat_group_id ?? config.group;
  if (typeof group !== 'string' || !group.trim()) throw error(400, '请配置 GENAI_CHAT_GROUP_ID 或传入 chat_group_id');
  const instructions=toolPrompt(toolPolicy(input.tools,input.tool_choice));
  const chatInfo=instructions ? `${instructions}\n\nUser request:\n${messages.at(-1).content}` : messages.at(-1).content;
  return { chatInfo, messages: messages.slice(0, -1),
    type: '3', stream: true, aiType: input.model ?? 'qwen-instruct', aiSecType: '1',
    chatGroupId: group, promptTokens: 0, imageUrl: '', imageUrls: [], width: '', height: '',
    rootAiType: selected.root_ai_type || 'xinference', maxToken: max, netGo: input.net_go ?? config.netGo };
}

// SSE 按行解析，支持 UTF-8 跨网络分块、CR/LF/CRLF、多行 data 和注释。
export async function* events(body) {
  const decoder = new TextDecoder();
  let buffer = '', data = [], event = '', first = true, eventBytes = 0;
  function line(value) {
    if (value === '') {
      const result = data.length ? { event: event || 'message', data: data.join('\n') } : null;
      data = []; event = ''; eventBytes = 0; return result;
    }
    const colon = value.indexOf(':');
    const key = colon < 0 ? value : value.slice(0, colon);
    let val = colon < 0 ? '' : value.slice(colon + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (key === 'data') { eventBytes += Buffer.byteLength(val); if (eventBytes > 1024 * 1024) throw error(502, '上游 SSE 事件超过 1 MiB'); data.push(val); }
    if (key === 'event') event = val;
    return null;
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (first && buffer.length) { buffer = buffer.replace(/^\uFEFF/, ''); first = false; }
    while (true) {
      const i = buffer.search(/[\r\n]/);
      if (i < 0 || (buffer[i] === '\r' && i === buffer.length - 1)) break;
      const value = buffer.slice(0, i), size = buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(i + size);
      const result = line(value); if (result) yield result;
    }
    if (Buffer.byteLength(buffer) > 1024 * 1024) throw error(502, '上游 SSE 行超过 1 MiB');
  }
  buffer += decoder.decode();
  if (buffer) { const result = line(buffer.replace(/[\r\n]+$/, '')); if (result) yield result; }
  const result = line(''); if (result) yield result;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  let size = 0; const parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw error(413, '请求不能超过 1 MiB'); parts.push(chunk); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw error(400, '无效 JSON'); }
}
function authorized(req, key) {
  const received = Buffer.from(req.headers.authorization || (req.url === '/v1/messages' && req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key']}` : '')), wanted = Buffer.from(`Bearer ${key}`);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}
async function write(res, text) {
  if (res.destroyed) throw error(499, '客户端已断开');
  if (!res.write(text)) await new Promise((resolve, reject) => {
    const clean = () => { res.off('drain', drain); res.off('close', close); };
    const drain = () => { clean(); resolve(); }, close = () => { clean(); reject(error(499, '客户端已断开')); };
    res.once('drain', drain); res.once('close', close);
  });
}

async function* authenticatedEvents(fetcher, options, tokenManager) {
  let renewed=false;
  while(true) {
    const response=await fetcher(UPSTREAM,options);
    if(response.status===401 && !renewed && tokenManager.renewable) {
      await response.body?.cancel();
      options.headers['x-access-token']=await tokenManager.get(true);renewed=true;continue;
    }
    if(!response.ok) {
      await response.body?.cancel();
      throw error([401,403].includes(response.status)?401:response.status===429?429:502,`上游 HTTP ${response.status}`);
    }
    if(!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel();throw error(502,'上游没有返回 SSE，可能登录已失效');
    }
    let emitted=false,retry=false;
    for await(const item of events(response.body)) {
      let value;try{value=JSON.parse(item.data);}catch{}
      const message=typeof value?.message==='string'?value.message:'';
      const expired=(value?.success===false || value?.code===401) && /token.*(?:失效|过期|expired|invalid)|请重新登录|登录已过期/i.test(message);
      if(expired) {
        if(!emitted && !renewed && tokenManager.renewable){retry=true;break;}
        throw error(401,'上游登录已失效');
      }
      emitted=true;yield item;
    }
    if(!retry)return;
    // No output was exposed; the rejected stream has been closed before retry.
    options.headers['x-access-token']=await tokenManager.get(true);renewed=true;
  }
}
export function createServer(config = configuration(), fetcher = upstreamFetch, modelFetcher = fetchModelList, tokenManager = new TokenManager(config)) {
  let busy = false;
  let modelCache = { at: 0, data: [] };
  let modelRetryAfter = 0;
  let modelPending;
  async function models() {
    if (!tokenManager.configured || Date.now() < modelRetryAfter || Date.now() - modelCache.at < (config.modelTtl ?? 300000)) return modelCache.data;
    if (modelPending) return modelPending;
    modelPending = (async () => { try {
      const raw = await modelFetcher(await tokenManager.get(), AbortSignal.timeout(Math.min(config.timeout, 10000)));
      const records = raw?.result?.records || raw?.data?.records || raw?.data || [];
      if (!Array.isArray(records) || raw?.success === false) throw new Error('Invalid model directory');
      const list = modelDirectory(records);
      if (raw?.success !== true && !records.length) throw new Error('Unrecognized model directory');
      modelCache = { at: Date.now(), data: list };
      modelRetryAfter = 0;
    } catch {
      // Retry outages sooner than the normal TTL without hammering the school.
      modelRetryAfter = Date.now() + Math.min(config.modelTtl ?? 300000, 10000);
    }
    return modelCache.data;
    })();
    try { return await modelPending; } finally { modelPending = undefined; }
  }
  return http.createServer(async (req, res) => {
    let controller, timer, acquired = false;
    try {
      if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { status: 'ok' });
      if (!config.key || !authorized(req, config.key)) throw error(401, '需要有效的本地 API Bearer 密钥');
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', upstream_configured: Boolean(tokenManager.configured && config.group) });
      if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, { object: 'list', data: await models() });
      if (req.method !== 'POST' || !['/v1/chat/completions','/v1/responses','/v1/messages'].includes(req.url)) throw error(404, '接口不存在');
      if (!tokenManager.configured) throw error(503, '请配置 GENAI_TOKEN 或 CAS 账号');
      const rawInput = await readBody(req);
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) throw error(400, '请求必须是 JSON 对象');
      const input = normalizeRequest(req.url,rawInput);
      const adapter = req.url === '/v1/chat/completions' ? null : new ProtocolOutput(req.url,input,async frame=>{
        if (!res.headersSent) res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no' });
        await write(res,frame);
      },rawInput);
      const policy = toolPolicy(input.tools,input.tool_choice);
      const catalogue = await models();
      if (!catalogue.length) throw error(503, '模型目录没有已确认的自部署国内模型');
      const body = upstreamBody(input, config, catalogue);
      if (busy) throw error(429, '当前账号有请求进行中，请完成后重试');
      busy = true; acquired = true;
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), config.timeout);
      res.on('close', () => controller.abort());
      const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream',
        'x-access-token': await tokenManager.get(), Origin: 'https://genai.shanghaitech.edu.cn',
        Referer: 'https://genai.shanghaitech.edu.cn/dashboard/analysis' };
      if (config.cookie) headers.Cookie = config.cookie;
      const source=authenticatedEvents(fetcher,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal,redirect:'error'},tokenManager);
      let text = '', reasoning = '', responseBytes = 0, last, finished = false, seen = false;
      for await (const item of source) {
        if (item.data === '[DONE]') { finished = true; break; }
        if (item.event === 'error') throw error(502, '上游返回错误事件');
        let chunk; try { chunk = JSON.parse(item.data); } catch { throw error(502, '上游 SSE 包含无效 JSON'); }
        if (chunk.error) throw error(502, '上游返回错误');
        if (!Array.isArray(chunk.choices)) throw error(502, '未知上游 SSE 格式');
        if (chunk.choices.length > 1 || chunk.choices.some(c => c.index !== 0)) throw error(502, '上游返回了不支持的多个候选');
        const choice = chunk.choices[0];
        if (choice?.delta?.content != null && typeof choice.delta.content !== 'string') throw error(502, '上游返回非文本内容');
        if (choice?.delta?.tool_calls) throw error(502, '暂不支持工具调用');
        if (choice) seen = true;
        const content = choice?.delta?.content || '';
        const thought = choice?.delta?.reasoning_content || '';
        if (typeof thought !== 'string') throw error(502, '上游返回无效推理字段');
        responseBytes += Buffer.byteLength(content) + Buffer.byteLength(thought);
        if (responseBytes > 8 * 1024 * 1024) throw error(502, '上游响应超过 8 MiB');
        if (!input.stream || policy) text += content;
        if (!input.stream || policy) reasoning += thought;
        if (choice?.finish_reason != null) finished = true;
        last = { ...last, ...chunk, choices: choice ? chunk.choices : last?.choices };
        if (input.stream && !policy) {
          if (adapter) { await adapter.reasoningDelta(thought); await adapter.delta(content); }
          else {
            if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
            await write(res, `data: ${JSON.stringify(chunk)}\n\n`);
          }
        }
      }
      if (!seen || !finished) throw error(502, '上游流意外结束，未收到完成标记');
      const parsed = parseToolCalls(adapter && input.stream && !policy ? adapter.text : text,policy,()=>`call_${randomUUID().replaceAll('-','')}`);
      const finish = parsed.tool_calls.length ? 'tool_calls' : last.choices?.[0]?.finish_reason || 'stop';
      const finalReasoning=adapter && input.stream && !policy ? adapter.reasoning : reasoning;
      const completion = { id: last.id || `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: last.created || Math.floor(Date.now()/1000), model: input.model || last.model || 'qwen-instruct', choices: [{ index: 0, message: { role: 'assistant', content: parsed.content, ...(finalReasoning ? { reasoning_content: finalReasoning } : {}), ...(parsed.tool_calls.length?{tool_calls:parsed.tool_calls}:{}) }, finish_reason: finish }], ...(last.usage ? { usage: last.usage } : {}) };
      if (adapter) {
        const result = await adapter.finish(completion,input.stream);
        if (input.stream) res.end();
        else { res.setHeader('X-Usage-Source',last.usage ? 'upstream' : 'estimate'); json(res,200,result); }
        return;
      }
      if (input.stream && policy) {
        res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no' });
        const delta = { role:'assistant', ...(parsed.content ? {content:parsed.content}:{}), ...(reasoning?{reasoning_content:reasoning}:{}), ...(parsed.tool_calls.length?{tool_calls:parsed.tool_calls.map((t,index)=>({...t,index}))}:{}) };
        await write(res,`data: ${JSON.stringify({...last,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
        await write(res,`data: ${JSON.stringify({...last,choices:[{index:0,delta:{},finish_reason:finish}]})}\n\n`);
      }
      if (input.stream) { await write(res, 'data: [DONE]\n\n'); res.end(); }
      else json(res, 200, completion);
    } catch (e) {
      const status = e.status || (controller?.signal.aborted ? 504 : 502);
      const payload = { ...(req.url === '/v1/messages' ? {type:'error'} : {}), error: { message: e.status ? e.message : status === 504 ? '上游请求超时或已取消' : '无法连接上游服务', type: status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'api_error', code: status } };
      if (!res.destroyed) { if (res.headersSent) res.end(`event: error\ndata: ${JSON.stringify(payload)}\n\n`); else json(res, status, payload); }
    } finally { clearTimeout(timer); controller?.abort(); if (acquired) busy = false; }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configuration();
  if (!config.key) throw new Error('请在 .env 中设置 API_KEY');
  if (!['127.0.0.1', '::1', 'localhost', '0.0.0.0'].includes(config.host)) throw new Error('HOST 必须是本机回环地址或 Docker 使用的 0.0.0.0');
  if (!Number.isFinite(config.timeout) || config.timeout <= 0) throw new Error('GENAI_TIMEOUT_MS 必须为正数');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT 必须为 1–65535 的整数');
  if (!Number.isFinite(config.modelTtl) || config.modelTtl < 0) throw new Error('GENAI_MODEL_TTL_MS 必须为非负数');
  const server=createServer(config);
  server.listen(config.port, config.host, () => console.log(`Webchat API: http://${config.host}:${config.port}/v1`));
  const stop=()=>shutdown(server).then(()=>process.exit(0),()=>process.exit(1));
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
}
