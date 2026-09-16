import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fetchModelList, upstreamFetch } from './transport.mjs';
import { modelDirectory } from './models.mjs';
import { TokenManager, secret } from './auth.mjs';
import { toolPolicy, toolPrompt, normalizeMessages, parseToolCalls } from './tools.mjs';
import { normalizeRequest, ProtocolOutput } from './protocols.mjs';
import { shutdown } from './lifecycle.mjs';
import { outputPolicy, outputPrompt, parseStructured } from './structured.mjs';
import { RequestQueue } from './queue.mjs';
import { extractImages, prepareImages } from './images.mjs';
import { ResponseStore } from './response-store.mjs';

const UPSTREAM = 'https://genai.shanghaitech.edu.cn/htk/chat/start/chat';
const error = (status, message) => Object.assign(new Error(message), { status });
const bool = value => value === 'true';
export function configuration(env = process.env) {
  return { host: env.HOST || '127.0.0.1', port: Number(env.PORT || 8787),
    token: secret(env,'GENAI_TOKEN'), cookie: secret(env,'GENAI_COOKIE'),
    username: secret(env,'GENAI_USERNAME'), password: secret(env,'GENAI_PASSWORD'),
    group: env.GENAI_CHAT_GROUP_ID || '', key: secret(env,'API_KEY'), uploadToken:secret(env,'GENAI_UPLOAD_TOKEN'),
    netGo: bool(env.GENAI_NET_GO), timeout: Number(env.GENAI_TIMEOUT_MS || 120000), modelTtl: Number(env.GENAI_MODEL_TTL_MS || 300000),
    concurrency:Number(env.GENAI_CONCURRENCY || 1),queueSize:Number(env.GENAI_QUEUE_SIZE || 32),queueTimeout:Number(env.GENAI_QUEUE_TIMEOUT_MS || 120000),
    requestLimit:Number(env.GENAI_REQUEST_LIMIT_MB || 144)*1024*1024,
    responseStoreSize:Number(env.GENAI_RESPONSE_STORE_SIZE || 128),responseStoreTtl:Number(env.GENAI_RESPONSE_STORE_TTL_MS || 3600000),
    upstreamRetries:Number(env.GENAI_UPSTREAM_RETRIES ?? 2),corsOrigin:env.CORS_ORIGIN || '' };
}

export function upstreamBody(input, config, supportedModels, formatPolicy=null,media={}) {
  const allowed = supportedModels?.length ? supportedModels : [{ id: 'qwen-instruct', root_ai_type: 'xinference' }];
  const selected = allowed.find(x => (typeof x === 'string' ? x : x.id) === (input.model ?? 'qwen-instruct'));
  if (!selected) throw error(400, `模型不可用：${input.model}`);
  const messages = normalizeMessages(input.messages, toolPolicy(input.tools,input.tool_choice,input.parallel_tool_calls));
  const partial=messages.at(-1).role==='assistant'&&messages.at(-1).partial===true;
  const dynamicTail=messages.at(-1).role==='system'&&messages.at(-1).dynamic===true&&messages.some(message=>message.role==='user');
  if (messages.at(-1).role !== 'user'&&!partial&&!dynamicTail) throw error(400, '最后一条消息必须为 user、工具结果、动态工具或 partial assistant');
  for (const key of Object.keys(input)) if (!['model','messages','stream','max_tokens','max_completion_tokens','chat_group_id','net_go','tools','tool_choice','response_format','parallel_tool_calls','stream_options','temperature','top_p','top_k','min_p','presence_penalty','frequency_penalty','repetition_penalty','stop','seed','n','logprobs','top_logprobs','user','service_tier','reasoning_effort','verbosity','thinking'].includes(key)) throw error(400, `暂不支持参数 ${key}`);
  if (input.stream !== undefined && typeof input.stream !== 'boolean') throw error(400, 'stream 必须是布尔值');
  if (input.net_go !== undefined && typeof input.net_go !== 'boolean') throw error(400, 'net_go 必须是布尔值');
  if (input.parallel_tool_calls !== undefined && typeof input.parallel_tool_calls !== 'boolean') throw error(400, 'parallel_tool_calls 必须是布尔值');
  if(input.max_tokens!==undefined&&input.max_completion_tokens!==undefined&&input.max_tokens!==input.max_completion_tokens)throw error(400,'max_tokens 与 max_completion_tokens 不能冲突');
  for(const key of ['temperature','top_p','top_k','min_p','presence_penalty','frequency_penalty','repetition_penalty']) if(input[key]!==undefined&&typeof input[key]!=='number')throw error(400,`${key} 必须是数字`);
  if(input.temperature!==undefined&&(input.temperature<0||input.temperature>2))throw error(400,'temperature 必须为 0–2');
  for(const key of ['top_p','min_p'])if(input[key]!==undefined&&(input[key]<0||input[key]>1))throw error(400,`${key} 必须为 0–1`);
  if(input.top_k!==undefined&&(!Number.isInteger(input.top_k)||input.top_k<0))throw error(400,'top_k 必须为非负整数');
  for(const key of ['presence_penalty','frequency_penalty'])if(input[key]!==undefined&&(input[key]<-2||input[key]>2))throw error(400,`${key} 必须为 -2–2`);
  if(input.repetition_penalty!==undefined&&input.repetition_penalty<=0)throw error(400,'repetition_penalty 必须大于 0');
  if(input.seed!==undefined&&!Number.isInteger(input.seed))throw error(400,'seed 必须是整数');
  if(input.n!==undefined&&input.n!==1)throw error(400,'当前 n 仅支持 1');
  if(input.logprobs!==undefined&&input.logprobs!==false)throw error(400,'当前不支持 logprobs=true');
  if(input.top_logprobs!==undefined&&input.top_logprobs!==0)throw error(400,'当前不支持 top_logprobs');
  if(input.reasoning_effort!==undefined&&!['none','minimal','low','medium','high','xhigh','max'].includes(input.reasoning_effort))throw error(400,'reasoning_effort 无效');
  if(input.verbosity!==undefined&&!['low','medium','high'].includes(input.verbosity))throw error(400,'verbosity 无效');
  if(input.stop!==undefined&&typeof input.stop!=='string'&&(!Array.isArray(input.stop)||input.stop.some(x=>typeof x!=='string')))throw error(400,'stop 必须是字符串或字符串数组');
  if(input.stream_options!==undefined) {
    if(!input.stream || !input.stream_options || typeof input.stream_options!=='object' || Array.isArray(input.stream_options) || Object.keys(input.stream_options).some(key=>key!=='include_usage') || typeof input.stream_options.include_usage!=='boolean') throw error(400,'stream_options 仅支持流式 include_usage 布尔值');
  }
  const selectedId=typeof selected==='string'?selected:[selected.id,selected.upstream_id].filter(Boolean).join(' ');
  const kimiK3=/kimi[-_ ]?k3/i.test(selectedId);
  const modelLimit=typeof selected==='object'&&Number.isInteger(selected.max_tokens)&&selected.max_tokens>0?selected.max_tokens:16384;
  const max = input.max_tokens ?? input.max_completion_tokens ?? (kimiK3?Math.min(131072,modelLimit):Math.min(16384,modelLimit));
  if (!Number.isInteger(max) || max < 1 || max > modelLimit) throw error(400, `max_tokens 必须是 1–${modelLimit} 的整数`);
  const group = input.chat_group_id ?? config.group;
  if (typeof group !== 'string') throw error(400, 'chat_group_id 必须是字符串');
  const requestedEffort=input.thinking?.type==='disabled'?'none':input.thinking?.effort??input.reasoning_effort??(kimiK3?'max':undefined);
  const effectiveEffort=kimiK3?({none:'low',minimal:'low',medium:'high',xhigh:'max'}[requestedEffort]||requestedEffort):requestedEffort;
  const behavior=[effectiveEffort&&effectiveEffort!=='none'?`Use ${effectiveEffort} reasoning effort.`:'',input.verbosity?`Use ${input.verbosity} response verbosity.`:'',partial?'Continue from the final assistant prefix. Return only the new continuation; do not repeat the prefix.':'',dynamicTail?'Answer the most recent user request using the dynamically loaded tools when appropriate.':''].filter(Boolean).join(' ');
  const instructions=[behavior,toolPrompt(toolPolicy(input.tools,input.tool_choice,input.parallel_tool_calls)),outputPrompt(formatPolicy)].filter(Boolean).join('\n\n');
  const chatInfo=partial?(instructions||'Continue from the final assistant prefix and return only the continuation.')
    :dynamicTail?(instructions||'Answer the most recent user request using the dynamically loaded tools when appropriate.')
    :(instructions ? `${instructions}\n\nUser request:\n${messages.at(-1).content}` : messages.at(-1).content);
  const history=(partial||dynamicTail?messages:messages.slice(0,-1)).map(({partial,dynamic,...message})=>message);
  return { chatInfo, messages:history,
    type: '3', stream: true, aiType: selected.upstream_id || input.model || 'qwen-instruct', aiSecType: '1',
    ...(group.trim()?{chatGroupId:group}:{}),promptTokens: 0, imageUrl: '', imageUrls: [], width: '', height: '',
    rootAiType: selected.root_ai_type || 'xinference', maxToken: max, netGo: input.net_go ?? config.netGo,...media,
    ...Object.fromEntries(['temperature','top_p','top_k','min_p','presence_penalty','frequency_penalty','repetition_penalty','stop','seed'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]])) };
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
function chatUsage(value,promptEstimate,completionEstimate) {
  const count=(...keys)=>{for(const key of keys){const number=value?.[key];if(Number.isInteger(number)&&number>=0)return number;}};
  const prompt_tokens=count('prompt_tokens','input_tokens') ?? promptEstimate;
  const completion_tokens=count('completion_tokens','output_tokens') ?? completionEstimate;
  const total_tokens=count('total_tokens') ?? prompt_tokens+completion_tokens;
  return {...(value || {}),prompt_tokens,completion_tokens,total_tokens};
}
function responseInputItems(input) {
  if(input.input===undefined)return [];
  return Array.isArray(input.input)?structuredClone(input.input).map(item=>item&&typeof item==='object'&&!Array.isArray(item)?{...item,id:item.id||`item_${randomUUID().replaceAll('-','')}`}:{id:`item_${randomUUID().replaceAll('-','')}`,type:'input_text',text:String(item)})
    :[{id:`msg_${randomUUID().replaceAll('-','')}`,type:'message',role:'user',content:[{type:'input_text',text:input.input}]}];
}
function responseAssistant(response) {
  const messages=(response.output||[]).filter(item=>item?.type==='message');
  const content=messages.flatMap(item=>item.content||[]).filter(part=>part?.type==='output_text').map(part=>part.text||'').join('')||null;
  const tool_calls=(response.output||[]).filter(item=>['function_call','custom_tool_call'].includes(item?.type)).map(item=>({id:item.call_id,type:'function',function:{name:item.name,arguments:item.type==='custom_tool_call'?JSON.stringify({input:item.input}):item.arguments}}));
  return {role:'assistant',content,...(tool_calls.length?{tool_calls}:{})};
}
function estimateTokens(value) {
  let images=0;
  const serialized=JSON.stringify(value,(_key,item)=>{
    if(typeof item==='string'&&/^data:image\//i.test(item)){images++;return '[image]';}
    return item;
  });
  return Math.ceil(Buffer.byteLength(serialized||'')/3)+images*1024;
}
async function readBody(req,limit=144*1024*1024) {
  let size = 0; const parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw error(413, `请求不能超过 ${Math.floor(limit/1048576)} MiB`); parts.push(chunk); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw error(400, '无效 JSON'); }
}
function authorized(req, key, path=req.url) {
  const raw=req.headers.authorization||(req.headers['x-api-key']?`Bearer ${req.headers['x-api-key']}`:'')||(req.headers['api-key']?`Bearer ${req.headers['api-key']}`:'');
  const received = Buffer.from(raw), wanted = Buffer.from(`Bearer ${key}`);
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
async function* withHeartbeats(iterable,interval=15000) {
  const iterator=iterable[Symbol.asyncIterator]();let pending=iterator.next();
  while(true){
    let timer;const tick=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),interval);});
    const next=await Promise.race([pending,tick]);clearTimeout(timer);
    if(next===null){yield null;continue;}
    if(next.done)return;yield next.value;pending=iterator.next();
  }
}

function delay(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(error(499,'客户端已断开'));const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(error(499,'客户端已断开'));}signal?.addEventListener('abort',abort,{once:true});});}
async function* authenticatedEvents(fetcher, options, tokenManager, retries=2) {
  let renewed=false,attempt=0;
  while(true) {
    const response=await fetcher(UPSTREAM,options);
    if(response.status===401 && !renewed && tokenManager.renewable) {
      await response.body?.cancel();
      options.headers['x-access-token']=await tokenManager.get(true);renewed=true;continue;
    }
    if([429,502,503,504].includes(response.status)&&attempt<retries){
      const header=Number(response.headers.get('retry-after')),pause=Number.isFinite(header)&&header>0?Math.min(header*1000,30000):Math.min(1000*2**attempt,8000);
      attempt++;await response.body?.cancel();await delay(pause,options.signal);continue;
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
export function createServer(config = configuration(), fetcher = upstreamFetch, modelFetcher = fetchModelList, tokenManager = new TokenManager(config), imageFetcher=fetch, frontendFetcher) {
  const queue=new RequestQueue(config.concurrency??1,config.queueSize??32,config.queueTimeout??120000);
  const responseStore=new ResponseStore(config.responseStoreSize??128,config.responseStoreTtl??3600000);
  const conversationStore=new ResponseStore(config.responseStoreSize??128,config.responseStoreTtl??3600000,'对话');
  const backgroundJobs=new Map();
  const backgroundStreams=new Map();
  function notifyBackground(log){log.version++;for(const notify of log.waiters)notify();log.waiters.clear();}
  function closeBackground(log){if(!log.done){log.done=true;notifyBackground(log);}}
  function pruneBackground(){
    const now=Date.now();
    for(const [id,log] of backgroundStreams)if(log.expires<=now){closeBackground(log);backgroundStreams.delete(id);}
    while(backgroundStreams.size>(config.responseStoreSize??128)){const id=backgroundStreams.keys().next().value,log=backgroundStreams.get(id);closeBackground(log);backgroundStreams.delete(id);}
  }
  function addBackgroundEvent(log,type,value){
    if(log.done)return;
    const sequence=log.nextSequence++,data={...value,type,sequence_number:sequence};
    log.events.push({sequence,frame:`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`});
    log.expires=Date.now()+(config.responseStoreTtl??3600000);
    notifyBackground(log);
    return data;
  }
  function backgroundResponse(value,id,store,conversationId){return {...value,id,background:true,store,conversation:conversationId?{id:conversationId}:null};}
  function metadata(value={}){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>16)throw error(400,'metadata 必须是最多 16 项的对象');
    for(const [key,item] of Object.entries(value))if(key.length>64||typeof item!=='string'||item.length>512)throw error(400,'metadata 键最多 64 字符，值必须是最多 512 字符的字符串');
    return structuredClone(value);
  }
  const conversationObject=value=>({id:value.id,object:'conversation',created_at:value.created_at,metadata:value.metadata});
  function appendConversation(id,items){
    if(!id)return;const value=conversationStore.get(id);value.items.push(...structuredClone(items));conversationStore.set(id,value);
  }
  async function streamBackground(req,res,log,startingAfter=-1){
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});
    let cursor=startingAfter,closed=false;
    const close=()=>{closed=true;for(const notify of log.waiters)notify();};
    res.once('close',close);
    try{
      while(!closed){
        for(const item of log.events)if(item.sequence>cursor){await write(res,item.frame);cursor=item.sequence;}
        if(log.done)break;
        const version=log.version;
        await new Promise(resolve=>{const wake=()=>{log.waiters.delete(wake);resolve();};log.waiters.add(wake);if(closed||log.done||log.version!==version)wake();});
      }
      if(!closed&&!res.writableEnded)res.end();
    }finally{res.off('close',close);}
  }
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
  let server;
  async function runBackground(id,raw,job) {
    try{
      job.controller.signal.throwIfAborted();
      const current=responseStore.get(id);current.response={...current.response,status:'in_progress'};responseStore.set(id,current);
      const address=server.address();if(!address||typeof address!=='object')throw new Error('本地服务尚未监听');
      const host=address.family==='IPv6'?'[::1]':'127.0.0.1';
      const response=await fetch(`http://${host}:${address.port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json','Accept':'text/event-stream'},body:JSON.stringify({...raw,background:false,stream:true,store:false}),signal:job.controller.signal});
      if(!response.ok){const value=await response.json().catch(()=>null);throw new Error(value?.error?.message||`后台请求 HTTP ${response.status}`);}
      if(!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream'))throw new Error('后台请求没有返回 SSE');
      let terminal;
      for await(const item of events(response.body)){
        let value;try{value=JSON.parse(item.data);}catch{throw new Error('后台请求返回无效 SSE JSON');}
        if(item.event==='error'||value?.type==='error')throw new Error(value?.message||'后台请求返回错误事件');
        if(!item.event.startsWith('response.'))continue;
        if(value.response)value={...value,response:backgroundResponse(value.response,id,job.store,job.conversationId)};
        value={...value,sequence_number:(Number.isInteger(value.sequence_number)?value.sequence_number:job.log.nextSequence-1)+1};
        const emitted=addBackgroundEvent(job.log,item.event,value);
        if(emitted?.response){
          const stored=responseStore.get(id);
          stored.response=emitted.response;
          if(['response.completed','response.incomplete'].includes(item.event)){
            terminal=emitted.response;stored.messages=[...job.messages,responseAssistant(terminal)];
            appendConversation(job.conversationId,[...job.conversationItems,...terminal.output]);
          }
          responseStore.set(id,stored);
        }
      }
      job.controller.signal.throwIfAborted();
      if(!terminal)throw new Error('后台流意外结束，未收到终止事件');
      job.terminal=true;closeBackground(job.log);
    }catch(cause){
      if(job.deleted||job.terminal)return;
      try{
        const stored=responseStore.get(id),cancelled=job.controller.signal.aborted;
        stored.response={...stored.response,status:cancelled?'cancelled':'failed',completed_at:null,error:cancelled?null:{code:'server_error',message:cause?.message||'后台请求失败'}};
        responseStore.set(id,stored);
        addBackgroundEvent(job.log,cancelled?'response.cancelled':'response.failed',{response:stored.response});closeBackground(job.log);job.terminal=true;
      }catch{}
    }finally{if(backgroundJobs.get(id)===job)backgroundJobs.delete(id);}
  }
  server=http.createServer(async (req, res) => {
    let controller, timer, release, path=req.url,requestUrl;
    try {
      requestUrl=new URL(req.url,'http://localhost');path=requestUrl.pathname;
      if(path==='/anthropic/v1/messages')path='/v1/messages';
      if(path==='/anthropic/v1/messages/count_tokens')path='/v1/messages/count_tokens';
      const origin=req.headers.origin,allowed=config.corsOrigin==='*'||config.corsOrigin&&origin===config.corsOrigin;
      if(allowed){res.setHeader('Access-Control-Allow-Origin',config.corsOrigin==='*'?'*':origin);res.setHeader('Access-Control-Expose-Headers','X-Usage-Source, Retry-After');res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){
        if(!allowed)throw error(403,'未允许该浏览器来源');
        res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'Accept, Authorization, Content-Type, X-API-Key, API-Key, Anthropic-Version, Anthropic-Beta, OpenAI-Organization, OpenAI-Project','Access-Control-Max-Age':'600'});return res.end();
      }
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok' });
      if (!config.key || !authorized(req, config.key, path)) throw error(401, '需要有效的本地 API Bearer 密钥');
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok', upstream_configured: tokenManager.configured,active_requests:queue.active,queued_requests:queue.depth,background_requests:backgroundJobs.size,stored_responses:responseStore.size,stored_conversations:conversationStore.size });
      if(req.method==='POST'&&path==='/v1/conversations'){
        if(!(config.responseStoreSize??128))throw error(400,'Conversations 需要启用响应存储');
        const body=await readBody(req,config.requestLimit),id=`conv_${randomUUID().replaceAll('-','')}`;
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['items','metadata'].includes(key)))throw error(400,'对话请求无效');
        if(body.items!==undefined&&(!Array.isArray(body.items)||body.items.length>20))throw error(400,'items 必须是最多 20 项的数组');
        const value={id,created_at:Math.floor(Date.now()/1000),metadata:metadata(body.metadata),items:responseInputItems({input:body.items||[]})};conversationStore.set(id,value);
        return json(res,200,conversationObject(value));
      }
      const conversationMatch=/^\/v1\/conversations\/([^/]+)(?:\/items(?:\/([^/]+))?)?$/.exec(path);
      if(conversationMatch){
        let conversationId,itemId;try{conversationId=decodeURIComponent(conversationMatch[1]);itemId=conversationMatch[2]&&decodeURIComponent(conversationMatch[2]);}catch{throw error(400,'对话资源 ID 编码无效');}
        const value=conversationStore.get(conversationId),isItems=path.includes('/items');
        if(!isItems){
          if(req.method==='GET')return json(res,200,conversationObject(value));
          if(req.method==='POST'){const body=await readBody(req,config.requestLimit);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='metadata'))throw error(400,'对话更新只支持 metadata');value.metadata=metadata(body.metadata);conversationStore.set(conversationId,value);return json(res,200,conversationObject(value));}
          if(req.method==='DELETE'){conversationStore.delete(conversationId);return json(res,200,{id:conversationId,object:'conversation.deleted',deleted:true});}
        }else if(itemId){
          const index=value.items.findIndex(item=>item.id===itemId);if(index<0)throw error(404,`对话项不存在：${itemId}`);
          if(req.method==='GET')return json(res,200,value.items[index]);
          if(req.method==='DELETE'){value.items.splice(index,1);conversationStore.set(conversationId,value);return json(res,200,conversationObject(value));}
        }else{
          if(req.method==='POST'){const body=await readBody(req,config.requestLimit);if(!body||!Array.isArray(body.items)||!body.items.length||body.items.length>20||Object.keys(body).some(key=>key!=='items'))throw error(400,'items 必须是 1–20 项的数组');const added=responseInputItems({input:body.items});value.items.push(...added);conversationStore.set(conversationId,value);return json(res,200,{object:'list',data:added,first_id:added[0].id,last_id:added.at(-1).id,has_more:false});}
          if(req.method==='GET'){
            const order=requestUrl.searchParams.get('order')||'desc',limit=Number(requestUrl.searchParams.get('limit')||20),after=requestUrl.searchParams.get('after');
            if(!['asc','desc'].includes(order)||!Number.isInteger(limit)||limit<1||limit>100||[...requestUrl.searchParams.keys()].some(key=>!['order','limit','after'].includes(key)))throw error(400,'对话项分页参数无效');
            let items=order==='asc'?[...value.items]:[...value.items].reverse();if(after){const index=items.findIndex(item=>item.id===after);if(index<0)throw error(400,'after 对话项不存在');items=items.slice(index+1);}const has_more=items.length>limit;items=items.slice(0,limit);
            return json(res,200,{object:'list',data:items,first_id:items[0]?.id??null,last_id:items.at(-1)?.id??null,has_more});
          }
        }
        throw error(405,'该对话资源不支持此方法');
      }
      const storedMatch=/^\/v1\/responses\/([^/]+)(\/(?:input_items|cancel))?$/.exec(path);
      if(storedMatch){
        let responseId;try{responseId=decodeURIComponent(storedMatch[1]);}catch{throw error(400,'响应 ID 编码无效');}
        if(req.method==='GET'){
          const stored=responseStore.get(responseId);
          if(storedMatch[2]==='/input_items')return json(res,200,{object:'list',data:stored.input_items,first_id:stored.input_items[0]?.id??null,last_id:stored.input_items.at(-1)?.id??null,has_more:false});
          if(storedMatch[2])throw error(405,'该响应资源不支持此方法');
          const stream=requestUrl.searchParams.get('stream');
          if([...requestUrl.searchParams.keys()].some(key=>!['stream','starting_after'].includes(key)))throw error(400,'响应读取包含不支持的查询参数');
          if(stream!==null&&!['true','false'].includes(stream))throw error(400,'stream 必须为 true 或 false');
          if(stream==='true'){
            const raw=requestUrl.searchParams.get('starting_after'),startingAfter=raw===null?-1:Number(raw);
            if(raw!==null&&(!Number.isInteger(startingAfter)||startingAfter<0))throw error(400,'starting_after 必须是非负整数');
            pruneBackground();const log=backgroundStreams.get(responseId);if(!log)throw error(404,`响应事件流不存在或已过期：${responseId}`);
            return streamBackground(req,res,log,startingAfter);
          }
          if(requestUrl.searchParams.has('starting_after'))throw error(400,'starting_after 仅能与 stream=true 一起使用');
          return json(res,200,stored.response);
        }
        if(req.method==='POST'&&storedMatch[2]==='/cancel'){
          const stored=responseStore.get(responseId),job=backgroundJobs.get(responseId);
          if(!job||!['queued','in_progress'].includes(stored.response.status))throw error(400,'只有运行中的后台响应可以取消');
          job.terminal=true;job.controller.abort();stored.response={...stored.response,status:'cancelled',completed_at:null,error:null};responseStore.set(responseId,stored);
          addBackgroundEvent(job.log,'response.cancelled',{response:stored.response});closeBackground(job.log);
          return json(res,200,stored.response);
        }
        if(req.method==='DELETE'&&!storedMatch[2]){const job=backgroundJobs.get(responseId);if(job){job.deleted=true;job.controller.abort();backgroundJobs.delete(responseId);}const log=backgroundStreams.get(responseId);if(log){closeBackground(log);backgroundStreams.delete(responseId);}responseStore.delete(responseId);return json(res,200,{id:responseId,object:'response.deleted',deleted:true});}
        throw error(405,'该响应资源不支持此方法');
      }
      const publicModel=model=>Object.fromEntries(Object.entries(model).filter(([key])=>key!=='upstream_id'));
      if (req.method === 'GET' && path === '/v1/models') return json(res, 200, { object: 'list', data: (await models()).map(publicModel) });
      if (req.method === 'GET' && path.startsWith('/v1/models/')) {
        let modelId;try{modelId=decodeURIComponent(path.slice('/v1/models/'.length));}catch{throw error(400,'模型 ID 编码无效');}
        const model=(await models()).find(item=>item.id===modelId);
        if(!model)throw error(404,`模型不存在：${modelId}`);
        return json(res,200,publicModel(model));
      }
      if(req.method==='POST'&&path==='/v1/messages/count_tokens'){
        const value=await readBody(req,config.requestLimit);if(!value||typeof value!=='object'||Array.isArray(value))throw error(400,'请求必须是 JSON 对象');
        return json(res,200,{input_tokens:estimateTokens(value)});
      }
      if(req.method==='POST'&&path==='/v1/tokenizers/estimate-token-count'){
        const value=await readBody(req,config.requestLimit);if(!value||typeof value!=='object'||Array.isArray(value))throw error(400,'请求必须是 JSON 对象');
        if(typeof value.model!=='string'||!Array.isArray(value.messages)||!value.messages.length)throw error(400,'model 和非空 messages 为必填项');
        const catalogue=await models();if(!catalogue.some(model=>model.id===value.model))throw error(400,`模型不可用：${value.model}`);
        return json(res,200,{data:{total_tokens:estimateTokens(value)}});
      }
      if (req.method !== 'POST' || !['/v1/chat/completions','/v1/completions','/v1/responses','/v1/messages'].includes(path)) throw error(404, '接口不存在');
      if (!tokenManager.configured) throw error(503, '请配置 GENAI_TOKEN 或 CAS 账号');
      let rawInput = await readBody(req,config.requestLimit);
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) throw error(400, '请求必须是 JSON 对象');
      let conversationId,conversationItems=[];
      if(path==='/v1/responses'&&rawInput.conversation!==undefined){
        if(rawInput.previous_response_id)throw error(400,'conversation 与 previous_response_id 不能同时使用');
        conversationId=typeof rawInput.conversation==='string'?rawInput.conversation:rawInput.conversation?.id;
        if(typeof conversationId!=='string'||!conversationId)throw error(400,'conversation 必须是非空 ID 或包含 id 的对象');
        const conversation=conversationStore.get(conversationId);conversationItems=responseInputItems(rawInput);
        rawInput={...rawInput,input:[...conversation.items,...conversationItems]};
      }
      const media=extractImages(path,rawInput);
      const input = normalizeRequest(path,media.input);
      let previous;
      if(path==='/v1/responses'&&media.input.previous_response_id){previous=responseStore.get(media.input.previous_response_id);if(!['completed','incomplete'].includes(previous.response.status))throw error(409,'previous_response_id 尚未完成');input.messages=[...previous.messages,...input.messages];}
      const formatPolicy=outputPolicy(path,media.input);
      const legacy=path==='/v1/completions';
      const adapter = path === '/v1/responses'||path==='/v1/messages' ? new ProtocolOutput(path,input,async frame=>{
        if (!res.headersSent) res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no' });
        await write(res,frame);
      },media.input) : null;
      const policy = toolPolicy(input.tools,input.tool_choice,input.parallel_tool_calls);
      const catalogue = await models();
      if (!catalogue.length) throw error(503, '模型目录没有已确认的自部署国内模型');
      const selected=catalogue.find(model=>model.id===(input.model??'qwen-instruct'));
      if(!selected)throw error(400,`模型不可用：${input.model}`);
      if(media.images.length&&!selected.capabilities?.vision)throw error(400,`模型 ${selected.id} 未确认支持图片输入`);
      if(path==='/v1/responses'&&media.input.background===true){
        if(!(config.responseStoreSize??128))throw error(400,'background 模式需要启用响应存储');
        pruneBackground();
        const backgroundRaw={...rawInput,conversation:undefined},queued=adapter.response([],'queued',null),inputItems=conversationId?conversationItems:responseInputItems(backgroundRaw),log={events:[],waiters:new Set(),done:false,version:0,nextSequence:0,expires:Date.now()+(config.responseStoreTtl??3600000)},job={controller:new AbortController(),deleted:false,terminal:false,messages:structuredClone(input.messages),inputItems,store:media.input.store===true,log,conversationId,conversationItems};
        addBackgroundEvent(log,'response.queued',{response:queued});backgroundStreams.set(queued.id,log);pruneBackground();
        responseStore.set(queued.id,{response:queued,messages:job.messages,input_items:inputItems});backgroundJobs.set(queued.id,job);
        setImmediate(()=>void runBackground(queued.id,backgroundRaw,job));
        if(media.input.stream===true)return streamBackground(req,res,log,-1);
        return json(res,200,queued);
      }
      controller = new AbortController();
      res.on('close', () => {if(!res.writableEnded)controller.abort();});
      release=await queue.acquire(controller.signal);
      timer = setTimeout(() => controller.abort(), config.timeout);
      const accessToken=await tokenManager.get();
      const imagePayload=await prepareImages(media.images,config,accessToken,controller.signal,imageFetcher,frontendFetcher);
      const body = upstreamBody(input, config, catalogue, formatPolicy,imagePayload);
      const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream',
        'x-access-token': accessToken, Origin: 'https://genai.shanghaitech.edu.cn',
        Referer: 'https://genai.shanghaitech.edu.cn/dashboard/analysis' };
      if (config.cookie) headers.Cookie = config.cookie;
      const source=authenticatedEvents(fetcher,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal,redirect:'error'},tokenManager,config.upstreamRetries??2);
      const sourceEvents=input.stream&&(policy||formatPolicy)?withHeartbeats(source):source;
      const legacyId=`cmpl-${randomUUID()}`;
      let text = '', reasoning = '', responseBytes = 0, last, finished = false, seen = false;
      const suppressReasoning=input.thinking?.type==='disabled';
      const nativeCalls=new Map();
      for await (const item of sourceEvents) {
        if(item===null){if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});await write(res,': keep-alive\n\n');continue;}
        if (item.data === '[DONE]') { finished = true; break; }
        if (item.event === 'error') throw error(502, '上游返回错误事件');
        let chunk; try { chunk = JSON.parse(item.data); } catch { throw error(502, '上游 SSE 包含无效 JSON'); }
        if (chunk.error) throw error(502, '上游返回错误');
        if(!Array.isArray(chunk.choices)){
          if(chunk.other!==undefined||chunk.usage!==undefined){last={...last,...chunk,choices:last?.choices};continue;}
          throw error(502, '未知上游 SSE 格式');
        }
        if(!chunk.choices.length){last={...last,...chunk,choices:last?.choices};continue;}
        if (chunk.choices.length > 1 || chunk.choices.some(c => c.index !== 0)) throw error(502, '上游返回了不支持的多个候选');
        const choice = chunk.choices[0];
        if (choice?.delta?.content != null && typeof choice.delta.content !== 'string') throw error(502, '上游返回非文本内容');
        if(choice?.delta?.tool_calls!==undefined){
          if(!policy||!Array.isArray(choice.delta.tool_calls))throw error(502,'上游返回了未请求或无效的工具调用');
          for(const fragment of choice.delta.tool_calls){
            if(!Number.isInteger(fragment?.index)||fragment.index<0||fragment.index>=64)throw error(502,'上游工具调用索引无效');
            const current=nativeCalls.get(fragment.index)||{id:'',name:'',arguments:''};
            if(fragment.id!==undefined){if(typeof fragment.id!=='string')throw error(502,'上游工具调用 ID 无效');current.id ||= fragment.id;}
            if(fragment.function?.name!==undefined){if(typeof fragment.function.name!=='string')throw error(502,'上游工具名称无效');current.name+=fragment.function.name;}
            if(fragment.function?.arguments!==undefined){if(typeof fragment.function.arguments!=='string')throw error(502,'上游工具参数无效');current.arguments+=fragment.function.arguments;responseBytes+=Buffer.byteLength(fragment.function.arguments);}
            nativeCalls.set(fragment.index,current);
          }
        }
        if(choice?.delta?.function_call!==undefined){
          if(!policy||!choice.delta.function_call||typeof choice.delta.function_call!=='object')throw error(502,'上游返回了未请求或无效的旧版函数调用');
          const fragment=choice.delta.function_call,current=nativeCalls.get(0)||{id:'',name:'',arguments:''};
          if(fragment.name!==undefined){if(typeof fragment.name!=='string')throw error(502,'上游函数名称无效');current.name+=fragment.name;}
          if(fragment.arguments!==undefined){if(typeof fragment.arguments!=='string')throw error(502,'上游函数参数无效');current.arguments+=fragment.arguments;responseBytes+=Buffer.byteLength(fragment.arguments);}
          nativeCalls.set(0,current);
        }
        if (choice) seen = true;
        const content = choice?.delta?.content || '';
        const upstreamThought = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? choice?.delta?.thinking ?? '';
        const thought=suppressReasoning?'':upstreamThought;
        if (typeof upstreamThought !== 'string') throw error(502, '上游返回无效推理字段');
        responseBytes += Buffer.byteLength(content) + Buffer.byteLength(upstreamThought);
        if (responseBytes > 8 * 1024 * 1024) throw error(502, '上游响应超过 8 MiB');
        if (!input.stream || policy || formatPolicy) text += content;
        if (!input.stream || policy || formatPolicy) reasoning += thought;
        if (choice?.finish_reason != null) finished = true;
        last = { ...last, ...chunk, choices: choice ? chunk.choices : last?.choices };
        if (input.stream && !policy && !formatPolicy) {
          if (adapter) { await adapter.reasoningDelta(thought); await adapter.delta(content); }
          else {
            if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
            const publicChunk=suppressReasoning?{...chunk,choices:chunk.choices.map(value=>{const delta={...value.delta};delete delta.reasoning_content;delete delta.reasoning;delete delta.thinking;return{...value,delta};})}:chunk;
            const outbound=legacy?{id:chunk.id?.replace(/^chatcmpl-/,'cmpl-')||legacyId,object:'text_completion',created:chunk.created||Math.floor(Date.now()/1000),model:input.model||chunk.model||'qwen-instruct',choices:chunk.choices.map(value=>({index:value.index,text:value.delta?.content||'',logprobs:null,finish_reason:value.finish_reason})),...(input.stream_options?.include_usage?{usage:null}:{})}
              :input.stream_options?.include_usage?{...publicChunk,usage:null}:publicChunk;
            await write(res, `data: ${JSON.stringify(outbound)}\n\n`);
          }
        }
      }
      if (!seen || !finished) throw error(502, '上游流意外结束，未收到完成标记');
      const bufferedText=adapter && input.stream && !policy && !formatPolicy ? adapter.text : text;
      const nativePayload=nativeCalls.size?JSON.stringify({tool_calls:[...nativeCalls].sort((a,b)=>a[0]-b[0]).map(([,call])=>({id:call.id||undefined,name:call.name,arguments:call.arguments}))}):null;
      const parsed = parseToolCalls(nativePayload??bufferedText,policy,()=>`call_${randomUUID().replaceAll('-','')}`);
      if(nativePayload&&bufferedText.trim())parsed.content=bufferedText.trim();
      if(input.parallel_tool_calls===false&&parsed.tool_calls.length>1)throw error(502,'模型返回了多个工具调用，但 parallel_tool_calls=false');
      if(!parsed.tool_calls.length) parsed.content=parseStructured(parsed.content,formatPolicy);
      const finish = parsed.tool_calls.length ? 'tool_calls' : last.choices?.[0]?.finish_reason || 'stop';
      const finalReasoning=adapter && input.stream && !policy && !formatPolicy ? adapter.reasoning : reasoning;
      const promptEstimate=Math.ceil(Buffer.byteLength(JSON.stringify(input.messages))/3);
      const completionEstimate=Math.ceil(responseBytes/3);
      const normalizedUsage=chatUsage(last.usage,promptEstimate,completionEstimate);
      const completion = { id: last.id || `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: last.created || Math.floor(Date.now()/1000), model: input.model || last.model || 'qwen-instruct', choices: [{ index: 0, message: { role: 'assistant', content: parsed.content, ...(finalReasoning ? { reasoning_content: finalReasoning } : {}), ...(parsed.tool_calls.length?{tool_calls:parsed.tool_calls}:{}) }, finish_reason: finish }], usage: normalizedUsage };
      if (adapter) {
        const result = await adapter.finish(completion,input.stream);
        if(path==='/v1/responses'&&conversationId)appendConversation(conversationId,[...conversationItems,...result.output]);
        if(path==='/v1/responses'&&media.input.store===true){
          const assistant={role:'assistant',content:completion.choices[0].message.content,tool_calls:completion.choices[0].message.tool_calls};
          const inputItems=responseInputItems(media.input);
          responseStore.set(result.id,{response:result,messages:[...input.messages,assistant],input_items:inputItems});
        }
        if (input.stream) res.end();
        else { res.setHeader('X-Usage-Source',last.usage ? 'upstream' : 'estimate'); json(res,200,result); }
        return;
      }
      if (input.stream && (policy || formatPolicy)) {
        res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no' });
        const delta = { role:'assistant', ...(parsed.content ? {content:parsed.content}:{}), ...(reasoning?{reasoning_content:reasoning}:{}), ...(parsed.tool_calls.length?{tool_calls:parsed.tool_calls.map((t,index)=>({...t,index}))}:{}) };
        const streamBase=input.stream_options?.include_usage?{...last,usage:null}:last;
        await write(res,`data: ${JSON.stringify({...streamBase,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
        await write(res,`data: ${JSON.stringify({...streamBase,choices:[{index:0,delta:{},finish_reason:finish}]})}\n\n`);
      }
      if(input.stream&&!adapter&&input.stream_options?.include_usage) {
        const usage=chatUsage(last.usage,promptEstimate,completionEstimate);
        const usageFrame=legacy?{id:last.id?.replace(/^chatcmpl-/,'cmpl-')||legacyId,object:'text_completion',created:last.created||Math.floor(Date.now()/1000),model:input.model||last.model||'qwen-instruct',choices:[],usage}:{...last,choices:[],usage};
        await write(res,`data: ${JSON.stringify(usageFrame)}\n\n`);
      }
      if (input.stream) { await write(res, 'data: [DONE]\n\n'); res.end(); }
      else {
        res.setHeader('X-Usage-Source',last.usage ? 'upstream' : 'estimate');
        const result=legacy?{id:completion.id.replace(/^chatcmpl-/,'cmpl-'),object:'text_completion',created:completion.created,model:completion.model,choices:[{index:0,text:parsed.content||'',logprobs:null,finish_reason:finish}],usage:normalizedUsage}:completion;
        json(res,200,result);
      }
    } catch (e) {
      const status = e.status || (controller?.signal.aborted ? 504 : 502);
      const payload = { ...(path === '/v1/messages' ? {type:'error'} : {}), error: { message: e.status ? e.message : status === 504 ? '上游请求超时或已取消' : '无法连接上游服务', type: status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : 'api_error', code: status } };
      if (!res.destroyed) {
        if(res.headersSent){
          if(['/v1/chat/completions','/v1/completions'].includes(path))res.end(`data: ${JSON.stringify(payload)}\n\n`);
          else if(path==='/v1/responses')res.end(`event: error\ndata: ${JSON.stringify({type:'error',code:String(status),message:payload.error.message,param:null})}\n\n`);
          else res.end(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
        } else {if(status===401)res.setHeader('WWW-Authenticate','Bearer');if(status===429)res.setHeader('Retry-After',Math.max(1,Math.ceil((config.queueTimeout??120000)/1000)));json(res, status, payload);}
      }
    } finally { clearTimeout(timer); controller?.abort(); release?.(); }
  });
  return server;
}
export function startServer(config = configuration()) {
  if (!config.key) throw new Error('请在 .env 中设置 API_KEY');
  if (!['127.0.0.1', '::1', 'localhost', '0.0.0.0'].includes(config.host)) throw new Error('HOST 必须是本机回环地址或 Docker 使用的 0.0.0.0');
  if (!Number.isFinite(config.timeout) || config.timeout <= 0) throw new Error('GENAI_TIMEOUT_MS 必须为正数');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT 必须为 1–65535 的整数');
  if (!Number.isFinite(config.modelTtl) || config.modelTtl < 0) throw new Error('GENAI_MODEL_TTL_MS 必须为非负数');
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) throw new Error('GENAI_CONCURRENCY 必须为正整数');
  if (!Number.isInteger(config.queueSize) || config.queueSize < 0) throw new Error('GENAI_QUEUE_SIZE 必须为非负整数');
  if (!Number.isFinite(config.queueTimeout) || config.queueTimeout <= 0) throw new Error('GENAI_QUEUE_TIMEOUT_MS 必须为正数');
  if (!Number.isFinite(config.requestLimit) || config.requestLimit < 1048576 || config.requestLimit > 256*1048576) throw new Error('GENAI_REQUEST_LIMIT_MB 必须为 1–256');
  if (!Number.isInteger(config.responseStoreSize) || config.responseStoreSize < 0 || config.responseStoreSize > 10000) throw new Error('GENAI_RESPONSE_STORE_SIZE 必须为 0–10000 的整数');
  if (!Number.isFinite(config.responseStoreTtl) || config.responseStoreTtl <= 0) throw new Error('GENAI_RESPONSE_STORE_TTL_MS 必须为正数');
  if (!Number.isInteger(config.upstreamRetries) || config.upstreamRetries < 0 || config.upstreamRetries > 5) throw new Error('GENAI_UPSTREAM_RETRIES 必须为 0–5 的整数');
  if (config.corsOrigin && config.corsOrigin!=='*') { let origin;try{origin=new URL(config.corsOrigin);}catch{throw new Error('CORS_ORIGIN 必须是完整来源或 *');}if(origin.origin!==config.corsOrigin)throw new Error('CORS_ORIGIN 只能包含协议、主机和端口'); }
  const server=createServer(config);
  server.listen(config.port, config.host, () => console.log(`Webchat API: http://${config.host}:${config.port}/v1`));
  const stop=()=>shutdown(server).then(()=>process.exit(0),()=>process.exit(1));
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
  return server;
}
