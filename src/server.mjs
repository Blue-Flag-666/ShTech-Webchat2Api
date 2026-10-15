import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fetchModelList, upstreamFetch } from './transport.mjs';
import { modelDirectory, modelBudget, isKimiK3Model } from './models.mjs';
import { TokenManager, secret, refreshRejectedToken } from './auth.mjs';
import { toolPolicy, toolPrompt, normalizeMessages, parseToolCalls, createToolCallStream } from './tools.mjs';
import { normalizeRequest, ProtocolOutput } from './protocols.mjs';
import { shutdown } from './lifecycle.mjs';
import { outputPolicy, outputPrompt, parseStructured } from './structured.mjs';
import { RequestQueue } from './queue.mjs';
import { UpstreamCircuit } from './circuit.mjs';
import { extractImages, retainedImages, prepareImages } from './images.mjs';
import { openReasoning } from './reasoning-state.mjs';
import { uploadNativeFiles } from './native-files.mjs';
import { ResponseStore } from './response-store.mjs';
import { FileStore, expandInputFiles, prepareInputFiles, parseMultipart, readRawBody, uploadedFile } from './files.mjs';
import { UploadStore, uploadPart } from './uploads.mjs';
import { BatchStore } from './batches.mjs';
import { VectorStore } from './vector-stores.mjs';
import { DiskState } from './persistence.mjs';
import { Metrics } from './metrics.mjs';
import { IdempotencyStore } from './idempotency.mjs';
import { RequestLogger } from './request-log.mjs';
import { normalizeUpstreamEvent, protocolFailure } from './upstream-sse.mjs';
import { upstreamBusinessFailure, upstreamDiagnostic } from './upstream-errors.mjs';
import { textHistoryRequest } from './upstream-history.mjs';

const UPSTREAM = 'https://genai.shanghaitech.edu.cn/htk/chat/start/chat';
const GROUP_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';
const newChatGroupId = () => [...randomBytes(21)].map(byte => GROUP_ALPHABET[byte & 63]).join('');
const error = (status, message, param) => Object.assign(new Error(message), { status, ...(param ? { param } : {}) });
const bool = value => value === 'true';
function modelLimitsConfig(value){try{return JSON.parse(value||'{}');}catch{throw new Error('GENAI_MODEL_LIMITS 必须是 JSON 对象');}}
export function configuration(env = process.env) {
  return { host: env.HOST || '127.0.0.1', port: Number(env.PORT || 8787),
    token: secret(env,'GENAI_TOKEN'), cookie: secret(env,'GENAI_COOKIE'),
    username: secret(env,'GENAI_USERNAME'), password: secret(env,'GENAI_PASSWORD'),
    group: env.GENAI_CHAT_GROUP_ID || '', key: secret(env,'API_KEY'), uploadToken:secret(env,'GENAI_UPLOAD_TOKEN'),
    startupCheck: env.GENAI_STARTUP_CHECK !== 'false',
    debugUpstream: env.GENAI_DEBUG_UPSTREAM === 'true',
    historyFallback: env.GENAI_HISTORY_FALLBACK !== 'false',
    netGo: bool(env.GENAI_NET_GO), timeout: Number(env.GENAI_TIMEOUT_MS || 120000), modelTtl: Number(env.GENAI_MODEL_TTL_MS || 300000),logFile:env.GENAI_LOG_FILE || '',
    concurrency:Number(env.GENAI_CONCURRENCY || 1),queueSize:Number(env.GENAI_QUEUE_SIZE || 32),queueTimeout:Number(env.GENAI_QUEUE_TIMEOUT_MS || 120000),modelLimits:modelLimitsConfig(env.GENAI_MODEL_LIMITS),
    requestLimit:Number(env.GENAI_REQUEST_LIMIT_MB || 144)*1024*1024,
    responseStoreSize:Number(env.GENAI_RESPONSE_STORE_SIZE || 128),responseStoreTtl:Number(env.GENAI_RESPONSE_STORE_TTL_MS || 3600000),
    fileStoreSize:Number(env.GENAI_FILE_STORE_SIZE || 32),fileStoreTtl:Number(env.GENAI_FILE_STORE_TTL_MS || 3600000),fileMaxBytes:Number(env.GENAI_FILE_MAX_MB || 10)*1024*1024,pdfMaxPages:Number(env.GENAI_PDF_MAX_PAGES || 200),nativeFileUpload:bool(env.GENAI_NATIVE_FILE_UPLOAD),
    batchStoreSize:Number(env.GENAI_BATCH_STORE_SIZE || 32),batchStoreTtl:Number(env.GENAI_BATCH_STORE_TTL_MS || 3600000),
    vectorStoreSize:Number(env.GENAI_VECTOR_STORE_SIZE || 32),vectorStoreTtl:Number(env.GENAI_VECTOR_STORE_TTL_MS || 3600000),vectorStoreMaxFiles:Number(env.GENAI_VECTOR_STORE_MAX_FILES || 100),
    upstreamRetries:Number(env.GENAI_UPSTREAM_RETRIES ?? 2),breakerFailures:Number(env.GENAI_BREAKER_FAILURES ?? 3),breakerCooldown:Number(env.GENAI_BREAKER_COOLDOWN_MS ?? 30000),outputRepair:bool(env.GENAI_OUTPUT_REPAIR),contextAuto:env.GENAI_CONTEXT_AUTO!=='false',contextStrategy:env.GENAI_CONTEXT_STRATEGY || 'agent',corsOrigin:env.CORS_ORIGIN || '',dataDir:env.GENAI_DATA_DIR || '',dataQuotaBytes:Number(env.GENAI_DATA_QUOTA_MB||0)*1024*1024 };
}

export function upstreamBody(input, config, supportedModels, formatPolicy=null,media={}) {
  const allowed = supportedModels?.length ? supportedModels : [{ id: 'qwen-instruct', root_ai_type: 'xinference' }];
  const selected = allowed.find(x => (typeof x === 'string' ? x : x.id) === (input.model ?? 'qwen-instruct'));
  if (!selected) throw error(400, `模型不可用：${input.model}`, 'model');
  const messages = normalizeMessages(input.messages, toolPolicy(input.tools,input.tool_choice,input.parallel_tool_calls,input.max_tool_calls));
  const partial=messages.at(-1).role==='assistant'&&messages.at(-1).partial===true;
  const dynamicTail=messages.at(-1).role==='system'&&messages.at(-1).dynamic===true&&messages.some(message=>message.role==='user');
  if (messages.at(-1).role !== 'user'&&!partial&&!dynamicTail) throw error(400, '最后一条消息必须为 user、工具结果、动态工具或 partial assistant', 'messages');
  for (const key of Object.keys(input)) if (!['model','messages','stream','max_tokens','max_completion_tokens','max_tool_calls','chat_group_id','net_go','tools','tool_choice','response_format','parallel_tool_calls','stream_options','temperature','top_p','top_k','min_p','presence_penalty','frequency_penalty','repetition_penalty','stop','seed','n','logprobs','top_logprobs','user','service_tier','reasoning_effort','verbosity','thinking'].includes(key)) throw error(400, `暂不支持参数 ${key}`, key);
  if (input.stream !== undefined && typeof input.stream !== 'boolean') throw error(400, 'stream 必须是布尔值', 'stream');
  if (input.net_go !== undefined && typeof input.net_go !== 'boolean') throw error(400, 'net_go 必须是布尔值', 'net_go');
  if (input.parallel_tool_calls !== undefined && typeof input.parallel_tool_calls !== 'boolean') throw error(400, 'parallel_tool_calls 必须是布尔值', 'parallel_tool_calls');
  if(input.max_tokens!==undefined&&input.max_completion_tokens!==undefined&&input.max_tokens!==input.max_completion_tokens)throw error(400,'max_tokens 与 max_completion_tokens 不能冲突','max_completion_tokens');
  for(const key of ['temperature','top_p','top_k','min_p','presence_penalty','frequency_penalty','repetition_penalty']) if(input[key]!==undefined&&typeof input[key]!=='number')throw error(400,`${key} 必须是数字`,key);
  if(input.temperature!==undefined&&(input.temperature<0||input.temperature>2))throw error(400,'temperature 必须为 0–2','temperature');
  for(const key of ['top_p','min_p'])if(input[key]!==undefined&&(input[key]<0||input[key]>1))throw error(400,`${key} 必须为 0–1`,key);
  if(input.top_k!==undefined&&(!Number.isInteger(input.top_k)||input.top_k<0))throw error(400,'top_k 必须为非负整数','top_k');
  for(const key of ['presence_penalty','frequency_penalty'])if(input[key]!==undefined&&(input[key]<-2||input[key]>2))throw error(400,`${key} 必须为 -2–2`,key);
  if(input.repetition_penalty!==undefined&&input.repetition_penalty<=0)throw error(400,'repetition_penalty 必须大于 0','repetition_penalty');
  if(input.seed!==undefined&&!Number.isInteger(input.seed))throw error(400,'seed 必须是整数','seed');
  if(input.n!==undefined&&input.n!==1)throw error(400,'当前 n 仅支持 1','n');
  if(input.logprobs!==undefined&&input.logprobs!==false&&input.logprobs!==null)throw error(400,'当前不支持 logprobs=true','logprobs');
  if(input.top_logprobs!==undefined&&input.top_logprobs!==0&&input.top_logprobs!==null)throw error(400,'当前不支持 top_logprobs','top_logprobs');
  if(input.reasoning_effort!==undefined&&!['none','minimal','low','medium','high','xhigh','max'].includes(input.reasoning_effort))throw error(400,'reasoning_effort 无效','reasoning_effort');
  if(input.verbosity!==undefined&&!['low','medium','high'].includes(input.verbosity))throw error(400,'verbosity 无效','verbosity');
  if(input.stop!==undefined&&typeof input.stop!=='string'&&(!Array.isArray(input.stop)||input.stop.some(x=>typeof x!=='string')))throw error(400,'stop 必须是字符串或字符串数组','stop');
  if(input.stream_options!==undefined) {
    if(!input.stream || !input.stream_options || typeof input.stream_options!=='object' || Array.isArray(input.stream_options) || Object.keys(input.stream_options).some(key=>key!=='include_usage') || typeof input.stream_options.include_usage!=='boolean') throw error(400,'stream_options 仅支持流式 include_usage 布尔值','stream_options');
  }
  const kimiK3=isKimiK3Model(selected);
  const modelLimit=typeof selected==='object'&&Number.isInteger(selected.max_tokens)&&selected.max_tokens>0?selected.max_tokens:16384;
  const max = input.max_tokens ?? input.max_completion_tokens ?? (kimiK3?Math.min(131072,modelLimit):Math.min(16384,modelLimit));
  if (!Number.isInteger(max) || max < 1 || max > modelLimit) throw error(400, `max_tokens 必须是 1–${modelLimit} 的整数`,input.max_tokens!==undefined?'max_tokens':'max_completion_tokens');
  const group = input.chat_group_id ?? config.group;
  if (typeof group !== 'string') throw error(400, 'chat_group_id 必须是字符串','chat_group_id');
  const thinkingDisabled=input.thinking?.type==='disabled'||(input.thinking?.type!=='enabled'&&input.reasoning_effort==='none');
  const requestedEffort=thinkingDisabled?undefined:input.thinking?.effort??(input.reasoning_effort==='none'?undefined:input.reasoning_effort)??(kimiK3?'max':undefined);
  const effectiveEffort=kimiK3?({none:'low',minimal:'low',medium:'high',xhigh:'max'}[requestedEffort]||requestedEffort):requestedEffort;
  const webchatThinking=selected.webchat_thinking&&(input.thinking?.type==='enabled'||input.thinking?.type==='disabled'||input.reasoning_effort!==undefined)
    ? {thinking:!thinkingDisabled} : {};
  const behavior=[effectiveEffort&&effectiveEffort!=='none'?`Use ${effectiveEffort} reasoning effort.`:'',input.verbosity?`Use ${input.verbosity} response verbosity.`:'',partial?'Continue from the final assistant prefix. Return only the new continuation; do not repeat the prefix.':'',dynamicTail?'Answer the most recent user request using the dynamically loaded tools when appropriate.':''].filter(Boolean).join(' ');
  const instructions=[behavior,toolPrompt(toolPolicy(input.tools,input.tool_choice,input.parallel_tool_calls,input.max_tool_calls)),outputPrompt(formatPolicy)].filter(Boolean).join('\n\n');
  const chatInfo=partial?(instructions||'Continue from the final assistant prefix and return only the continuation.')
    :dynamicTail?(instructions||'Answer the most recent user request using the dynamically loaded tools when appropriate.')
    :(instructions ? `${instructions}\n\nUser request:\n${messages.at(-1).content}` : messages.at(-1).content);
  const history=(partial||dynamicTail?messages:messages.slice(0,-1)).map(({partial,dynamic,...message})=>message);
  return { chatInfo, messages:history,
    type: '3', stream: true, aiType: selected.upstream_id || input.model || 'qwen-instruct', aiSecType: '1',
    ...(group.trim()?{chatGroupId:group}:{}),promptTokens: 0, imageUrl: '', imageUrls: [], width: '', height: '',
    rootAiType: selected.root_ai_type || 'xinference', maxToken: max, netGo: input.net_go ?? config.netGo,...webchatThinking,...media,
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
function chatUsage(value,promptEstimate,completionEstimate,reasoningEstimate=0) {
  const count=(...keys)=>{for(const key of keys){const number=value?.[key];if(Number.isInteger(number)&&number>=0)return number;}};
  const suppliedPrompt=count('prompt_tokens','input_tokens'),suppliedCompletion=count('completion_tokens','output_tokens');
  const prompt_tokens=suppliedPrompt??promptEstimate;
  const completion_tokens=suppliedCompletion??completionEstimate;
  const total_tokens=count('total_tokens') ?? prompt_tokens+completion_tokens;
  const estimated=suppliedPrompt===undefined||suppliedCompletion===undefined;
  return {...(value || {}),prompt_tokens,completion_tokens,total_tokens,...(estimated?{prompt_tokens_details:value?.prompt_tokens_details??{cached_tokens:0},completion_tokens_details:value?.completion_tokens_details??{reasoning_tokens:reasoningEstimate}}:{})};
}
function responseInputItems(input) {
  if(input.input===undefined)return [];
  return Array.isArray(input.input)?structuredClone(input.input).map(item=>item&&typeof item==='object'&&!Array.isArray(item)?{...item,id:item.id||`item_${randomUUID().replaceAll('-','')}`}:{id:`item_${randomUUID().replaceAll('-','')}`,type:'input_text',text:String(item)})
    :[{id:`msg_${randomUUID().replaceAll('-','')}`,type:'message',role:'user',content:[{type:'input_text',text:input.input}]}];
}
function itemPage(items,{limit=20,order='desc',after,before}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100||!['asc','desc'].includes(order)||after&&before||after===''||before==='')throw error(400,'分页参数无效');
  let data=order==='asc'?[...items]:[...items].reverse();
  const cursor=after||before;
  if(cursor){const index=data.findIndex(item=>item.id===cursor);if(index<0)throw error(400,'分页游标不存在');data=after?data.slice(index+1):data.slice(0,index);}
  const has_more=data.length>limit;data=before?data.slice(-limit):data.slice(0,limit);
  return{object:'list',data,first_id:data[0]?.id??null,last_id:data.at(-1)?.id??null,has_more};
}
function responseAssistant(response) {
  const messages=(response.output||[]).filter(item=>item?.type==='message');
  const content=messages.flatMap(item=>item.content||[]).filter(part=>part?.type==='output_text').map(part=>part.text||'').join('')||null;
  const reasoning_content=(response.output||[]).filter(item=>item?.type==='reasoning').flatMap(item=>item.summary||[]).filter(part=>part?.type==='summary_text').map(part=>part.text||'').join('\n');
  const agentCalls={local_shell_call:'local_shell',shell_call:'shell',apply_patch_call:'apply_patch',computer_call:'computer',program:'program'};
  const tool_calls=(response.output||[]).filter(item=>['function_call','custom_tool_call'].includes(item?.type)||agentCalls[item?.type]).map(item=>{
    if(agentCalls[item.type]){
      const args=item.type==='program'?{code:item.code,fingerprint:item.fingerprint}
        :item.type==='apply_patch_call'?{operation:item.operation,...(item.caller?{caller:item.caller}:{})}
        :{action:item.action,...(item.caller?{caller:item.caller}:{}),...(item.environment?{environment:item.environment}:{}),...(item.pending_safety_checks?{pending_safety_checks:item.pending_safety_checks}:{})};
      return{id:item.call_id,type:'function',function:{name:`__openai_${agentCalls[item.type]}`,arguments:JSON.stringify(args)}};
    }
    return{id:item.call_id,type:'function',function:{name:item.name,arguments:item.type==='custom_tool_call'?JSON.stringify({input:item.input}):item.arguments}};
  });
  return {role:'assistant',content,...(reasoning_content?{reasoning_content}:{}),...(tool_calls.length?{tool_calls}:{})};
}
function estimateTokens(value) {
  let images=0;
  const serialized=JSON.stringify(value,(_key,item)=>{
    if(typeof item==='string'&&/^data:image\//i.test(item)){images++;return '[image]';}
    if(typeof item==='string'){
      const markers=item.match(/\[shtech-image-[0-9a-f-]{36}\]/g);
      if(markers){images+=markers.length;return item.replaceAll(/\[shtech-image-[0-9a-f-]{36}\]/g,'[image]');}
    }
    return item;
  });
  return Math.ceil(Buffer.byteLength(serialized||'')/3)+images*1024;
}
function compactToolText(content,limit) {
  if(content.length<=limit)return content;
  const diagnostic=/\b(?:error|failed|failure|exception|traceback|assertion|diff --git|updated file|begin patch)\b|错误|失败|异常|补丁|已修改/i;
  const found=content.split(/\r?\n/).filter(line=>diagnostic.test(line)).slice(-12).join('\n');
  const head=content.slice(0,Math.floor(limit*.2));
  const details=found.slice(-Math.floor(limit*.35));
  const tail=content.slice(-Math.floor(limit*.3));
  return `${head}\n[${content.length} characters; middle omitted]\n${details}\n${tail}`;
}
export function manageContextMessages(messages,threshold,strategy='agent') {
  if(!Number.isInteger(threshold)||threshold<1||!['agent','recent'].includes(strategy)||estimateTokens(messages)<=threshold)return messages;
  const protectedRoles=new Set(['system','developer']);
  const system=messages.filter(message=>protectedRoles.has(message.role)),turns=[];
  let current=[];
  for(const message of messages) {
    if(protectedRoles.has(message.role))continue;
    if(message.role==='user'&&current.some(item=>item.role==='assistant'||item.role==='tool')){turns.push(current);current=[];}
    current.push(message);
  }
  if(current.length)turns.push(current);
  if(!turns.length)return system;
  const limit=Math.max(1024,Math.min(8192,Math.floor(threshold*1.5)));
  const latestOriginal=[...turns.at(-1)];
  if(strategy==='agent')turns.forEach(turn=>turn.forEach((message,index)=>{
    if(message.role==='tool'&&typeof message.content==='string'&&message.content.length>limit)turn[index]={...message,content:compactToolText(message.content,limit)};
  }));
  if(strategy==='agent'&&latestOriginal.some(message=>message.role==='tool')&&estimateTokens([...system,...turns.at(-1)])>threshold){
    let cap=Math.min(limit,4096);
    while(cap>=128){
      const compacted=latestOriginal.map(message=>message.role==='tool'&&typeof message.content==='string'&&message.content.length>cap
        ? {...message,content:compactToolText(message.content,cap)}:message);
      turns[turns.length-1]=compacted;
      if(estimateTokens([...system,...compacted])<=threshold)break;
      cap=Math.floor(cap/2);
    }
  }
  const selected=new Set([turns.length-1]);
  const important=/\b(?:error|failed|failure|exception|traceback|assertion|diff --git|updated file|begin patch|git status|apply_patch)\b|错误|失败|异常|补丁|已修改/i;
  const candidates=Array.from({length:turns.length-1},(_,index)=>index).reverse();
  if(strategy==='agent')candidates.sort((a,b)=>Number(turns[b].some(message=>important.test(message.content||'')))-Number(turns[a].some(message=>important.test(message.content||'')))||b-a);
  for(const index of candidates){
    const trial=[...system,...[...selected,index].sort((a,b)=>a-b).flatMap(value=>turns[value])];
    if(estimateTokens(trial)<=threshold)selected.add(index);
    else if(strategy==='recent')break;
  }
  return [...system,...[...selected].sort((a,b)=>a-b).flatMap(index=>turns[index])];
}
async function readBody(req,limit=144*1024*1024) {
  const body=await readRawBody(req,limit);
  try { return JSON.parse(body.toString('utf8')); } catch { throw error(400, '无效 JSON','body'); }
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
async function timedUpstream(work,milliseconds){
  const controller=new AbortController();let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('上游阶段超时'));},Math.max(1,Math.floor(milliseconds)));});
  try{return await Promise.race([work(controller.signal),timeout]);}
  finally{clearTimeout(timer);}
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
export function parseRetryAfter(value,now=Date.now()) {
  if(typeof value!=='string'||!value.trim())return null;
  const text=value.trim();
  if(/^\d+(?:\.\d+)?$/.test(text)){
    const seconds=Number(text);
    return Number.isFinite(seconds)?Math.max(0,Math.ceil(seconds*1000)):null;
  }
  const date=Date.parse(text);
  return Number.isFinite(date)?Math.max(0,date-now):null;
}
function upstreamBackoff(status,attempt) {
  const base={429:1000,502:500,503:1000,504:1250}[status]??1000;
  return Math.min(base*2**attempt,8000);
}
const retryableNetworkCodes=new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','EPIPE','ETIMEDOUT','EAI_AGAIN','EHOSTUNREACH','ENETUNREACH','ERR_STREAM_PREMATURE_CLOSE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']);
const retryableNetworkError=cause=>retryableNetworkCodes.has(cause?.code??cause?.cause?.code);
async function* authenticatedEvents(fetcher, options, tokenManager, retries=2, onDispatch, diagnostics, recovery) {
  let renewed=false,attempt=0;
  const request=JSON.parse(options.body),model=request.aiType,trace=randomUUID().slice(0,8);
  let dispatches=0,historyRecovered=false;
  while(true) {
    let response;
    try{dispatches++;onDispatch?.();response=await fetcher(UPSTREAM,options);}catch(cause){
      if(options.signal?.aborted||!retryableNetworkError(cause)||attempt>=retries)throw cause;
      await delay(upstreamBackoff(502,attempt++),options.signal);
      continue;
    }
    if(response.status===401 && !renewed && tokenManager.renewable) {
      await response.body?.cancel();
      options.headers['x-access-token']=await refreshRejectedToken(tokenManager,options.headers['x-access-token'],options.signal);renewed=true;continue;
    }
    const serverDelay=parseRetryAfter(response.headers.get('retry-after'));
    if([429,502,503,504].includes(response.status)&&attempt<retries){
      const pause=serverDelay??upstreamBackoff(response.status,attempt);
      if(pause<=30000){attempt++;await response.body?.cancel();await delay(pause,options.signal);continue;}
    }
    if(!response.ok) {
      await response.body?.cancel();
      const status=[401,403,429,502,503,504].includes(response.status)?response.status:502;
      const failure=error(status,`上游 HTTP ${response.status}`);
      if(serverDelay!==null&&[429,502,503,504].includes(status))failure.retryAfter=Math.max(1,Math.ceil(serverDelay/1000));
      throw failure;
    }
    if(!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel();throw error(502,'上游没有返回 SSE，可能登录已失效');
    }
    let emitted=false,retry=false,retryFailure,seenChoice=false,finished=false,pending=[],pendingBytes=0,ignored=0;
    try{
      for await(const rawItem of events(response.body)) {
        if(rawItem.event==='error')throw error(502,'上游返回错误事件');
        const item=normalizeUpstreamEvent(rawItem);
        if(!item){if(++ignored>1024)throw protocolFailure('上游发送过多 SSE 控制消息');continue;}
        if(item.data==='[DONE]'){
          if(!seenChoice)throw error(502,'上游 SSE 缺少响应选择项');
          finished=true;emitted=true;yield item;continue;
        }
        if(item.event==='error')throw error(502,'上游返回错误事件');
        let value;try{value=JSON.parse(item.data);}catch{throw error(502,'上游 SSE 包含无效 JSON');}
        if(value?.error||value?.success===false||Number(value?.code)>=400){
          const failure=upstreamBusinessFailure(value,model);
          console.warn(`[上游业务] ${failure.message}`);
          if(diagnostics)console.warn(`[上游诊断] ${JSON.stringify({trace,attempt:dispatches,model,category:failure.category,
            max_output_tokens:request.maxToken,history_messages:request.messages?.length??0,
            history_mode:historyRecovered?'text':'structured',
            estimated_input_tokens:estimateTokens({messages:request.messages,chatInfo:request.chatInfo}),
            history_roles:request.messages.map(message=>['system','user','assistant'].includes(message.role)?message.role:'other'),
            thinking:request.thinking??null,session:diagnostics.group?'configured':'per-request',
            ...upstreamDiagnostic(value,[diagnostics.key,diagnostics.cookie,tokenManager.username,tokenManager.password,tokenManager.token,options.headers['x-access-token']])})}`);
          if(failure.status===401&&!emitted&&!renewed&&tokenManager.renewable){retry=true;break;}
          if(!emitted&&failure.category==='unknown'&&Number(value.code??value.error?.code)===500&&recovery&&request.messages.length){
            const group=recovery.resetSession&&!request.fileIds?.length?newChatGroupId():request.chatGroupId;
            const fallback=textHistoryRequest(request,group);
            const estimate=estimateTokens({messages:fallback.messages,chatInfo:fallback.chatInfo})+fallback.maxToken;
            if(!historyRecovered&&attempt<retries&&estimate<=recovery.contextWindow){
              console.warn(`[上游恢复] 模型 ${model} 将 ${request.messages.length} 条历史保留为文本，重试一次`);
              Object.assign(request,fallback);options.body=JSON.stringify(request);historyRecovered=true;
              retryFailure=failure;break;
            }
            throw failure;
          }
          if(historyRecovered&&failure.category==='unknown')throw failure;
          if(!emitted&&[502,503,504].includes(failure.status)&&attempt<retries){retryFailure=failure;break;}
          throw failure;
        }
        if(!Array.isArray(value?.choices)&&value?.other===undefined&&value?.usage===undefined)throw protocolFailure('未知上游 SSE 格式');
        if(Array.isArray(value?.choices)&&value.choices.length){
          seenChoice=true;
          if(value.choices[0]?.finish_reason!=null)finished=true;
        }
        if(!seenChoice){
          pendingBytes+=Buffer.byteLength(item.data);
          if(pending.length>=64||pendingBytes>65536)throw error(502,'上游在正文前发送过多元数据');
          pending.push(item);continue;
        }
        for(const held of pending){emitted=true;yield held;}
        pending=[];
        emitted=true;yield item;
      }
    }catch(cause){
      if(cause.upstreamProtocol)console.warn(`[上游协议] ${cause.message}`);
      if(!emitted&&!options.signal?.aborted&&cause.upstreamProtocol&&attempt<Math.min(retries,1)){
        await delay(upstreamBackoff(502,attempt++),options.signal);continue;
      }
      if(emitted||options.signal?.aborted||!retryableNetworkError(cause)||attempt>=retries)throw cause;
      await delay(upstreamBackoff(502,attempt++),options.signal);
      continue;
    }
    if(retryFailure){await delay(upstreamBackoff(retryFailure.status,attempt++),options.signal);continue;}
    if(!retry&&!emitted&&attempt<retries){
      await delay(upstreamBackoff(502,attempt++),options.signal);
      continue;
    }
    if(!retry&&!emitted)throw error(502,'上游返回空 SSE');
    if(!retry&&!seenChoice)throw error(502,'上游 SSE 缺少响应选择项');
    if(!retry&&!finished)throw error(502,'上游流意外结束，未收到完成标记');
    if(!retry)return;
    // No output was exposed; the rejected stream has been closed before retry.
    options.headers['x-access-token']=await refreshRejectedToken(tokenManager,options.headers['x-access-token'],options.signal);renewed=true;
  }
}
export async function* guardedEvents(source,circuit,model,signal) {
  const retryAfter=circuit.enter(model);
  if(retryAfter){const failure=error(503,`模型 ${model} 的上游暂时不可用`);failure.retryAfter=retryAfter;throw failure;}
  let failed=false,completed=false;
  try{yield* source;completed=true;}
  catch(cause){
    failed=true;
    if(!signal?.aborted&&!cause.upstreamProtocol&&(!cause.status||[502,503,504].includes(cause.status)))circuit.failure(model);
    else circuit.release(model);
    throw cause;
  }finally{if(!failed){if(completed)circuit.success(model);else circuit.release(model);}}
}
async function repairGeneratedOutput(fetcher,tokenManager,config,circuit,model,headers,body,invalidText,reason,policy,formatPolicy,signal,contextWindow,recovery) {
  const prompt=[`The previous answer failed validation: ${String(reason).slice(0,500)}. Correct it and return the complete answer again.`,
    policy?toolPrompt(policy):outputPrompt(formatPolicy)].filter(Boolean).join('\n\n');
  const correction={...body,chatInfo:prompt};
  const promptSize=()=>estimateTokens({messages:correction.messages,chatInfo:correction.chatInfo});
  let excerptLimit=32768;
  while(true){
    const excerpt=invalidText.length<=excerptLimit?invalidText
      :`${invalidText.slice(0,Math.floor(excerptLimit/2))}\n[invalid answer excerpt; middle omitted]\n${invalidText.slice(-Math.floor(excerptLimit/2))}`;
    correction.messages=[...body.messages,{role:'user',content:body.chatInfo},{role:'assistant',content:excerpt}];
    if(config.contextAuto!==false)correction.messages=manageContextMessages(correction.messages,
      Math.max(1,contextWindow-body.maxToken-estimateTokens(prompt)-32),config.contextStrategy??'agent');
    if(promptSize()+body.maxToken<=contextWindow)break;
    if(excerptLimit<=512)throw error(502,'无效答案的修复请求超过模型上下文窗口；请缩短输入或降低输出 token 上限');
    excerptLimit=Math.max(512,Math.floor(excerptLimit/2));
  }
  let text='',reasoning='',last,seen=false,finished=false;
  const source=guardedEvents(authenticatedEvents(fetcher,{method:'POST',headers:{...headers},body:JSON.stringify(correction),signal,redirect:'error'},tokenManager,config.upstreamRetries??2,undefined,config.debugUpstream?config:null,recovery),circuit,model,signal);
  for await(const item of source) {
    if(item.data==='[DONE]')break;
    if(item.event==='error')throw error(502,'修复请求收到上游错误事件');
    let chunk;try{chunk=JSON.parse(item.data);}catch{throw error(502,'修复请求返回无效 SSE JSON');}
    if(chunk.error)throw error(502,'修复请求被上游拒绝');
    if(!Array.isArray(chunk.choices)){
      if(chunk.other!==undefined||chunk.usage!==undefined){last={...last,...chunk,choices:last?.choices};continue;}
      throw error(502,'修复请求返回未知 SSE 格式');
    }
    if(!chunk.choices.length){last={...last,...chunk,choices:last?.choices};continue;}
    if(chunk.choices.length!==1||chunk.choices[0].index!==0)throw error(502,'修复请求返回多个候选');
    const choice=chunk.choices[0],part=choice.delta?.content??'',thought=choice.delta?.reasoning_content??choice.delta?.reasoning??choice.delta?.thinking??'';
    if(typeof part!=='string'||typeof thought!=='string')throw error(502,'修复请求返回非文本内容');
    text+=part;reasoning+=thought;seen=true;
    if(Buffer.byteLength(text)+Buffer.byteLength(reasoning)>8*1024*1024)throw error(502,'修复请求响应超过 8 MiB');
    if(choice.finish_reason!=null)finished=true;
    last={...last,...chunk};
  }
  if(!seen||!finished)throw error(502,'修复请求意外结束');
  return{text,reasoning,last,promptBytes:Buffer.byteLength(JSON.stringify(correction.messages))+Buffer.byteLength(prompt)};
}
export function createServer(config = configuration(), fetcher = upstreamFetch, modelFetcher = fetchModelList, tokenManager = new TokenManager(config), imageFetcher=fetch, frontendFetcher) {
  const disk=config.dataDir?new DiskState(config.dataDir,config.dataQuotaBytes??0):null;
  const releaseDisk=disk?.acquireLock();
  try{
  const persisted=(name,options)=>disk?.map(name,options)??new Map();
  const queue=new RequestQueue(config.concurrency??1,config.queueSize??32,config.queueTimeout??120000,config.modelLimits??{});
  const metrics=new Metrics();
  const idempotency=new IdempotencyStore();
  const requestLogger=new RequestLogger(config.logFile||'');
  const circuit=new UpstreamCircuit(config.breakerFailures??3,config.breakerCooldown??30000);
  const responseStore=new ResponseStore(config.responseStoreSize??128,config.responseStoreTtl??3600000);
  const conversationStore=new ResponseStore(config.responseStoreSize??128,config.responseStoreTtl??3600000,'对话',persisted('conversations'));
  const compactionStore=new ResponseStore(config.responseStoreSize??128,config.responseStoreTtl??3600000,'压缩状态');
  const itemReferenceStore=new ResponseStore(config.responseStoreSize??128,config.responseStoreTtl??3600000,'响应项');
  const fileStore=new FileStore(config.fileStoreSize??32,config.fileStoreTtl??3600000,config.fileMaxBytes??10*1024*1024,persisted('files'));
  const uploadStore=new UploadStore(fileStore,config.fileStoreSize??32,3600000,persisted('uploads'));
  let server;
  async function dispatchBatch(url,body,signal,requestId){
    const address=server?.address();if(!address||typeof address!=='object')throw new Error('本地服务尚未监听');
    const host=address.family==='IPv6'?'[::1]':'127.0.0.1';
    const payload={...body,stream:false,...(url==='/v1/responses'?{background:false}:{})};
    const response=await fetch(`http://${host}:${address.port}${url}`,{method:'POST',headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json','X-Shtech-Batch-Request-Id':requestId},body:JSON.stringify(payload),signal});
    const text=await response.text();let value;try{value=JSON.parse(text);}catch{value={error:{message:text||`HTTP ${response.status}`}};}
    return{status:response.status,requestId:response.headers.get('x-request-id')||requestId,body:value};
  }
  const batchEntries=persisted('batches',{encode:entry=>{const {controller,...saved}=entry;return saved;},decode:entry=>({...entry,controller:new AbortController()})});
  const batchStore=new BatchStore(fileStore,dispatchBatch,{maximum:config.batchStoreSize??32,ttl:config.batchStoreTtl??3600000,entries:batchEntries});
  const vectorStore=new VectorStore(fileStore,{maximum:config.vectorStoreSize??32,ttl:config.vectorStoreTtl??3600000,maxFiles:config.vectorStoreMaxFiles??100,pdfMaxPages:config.pdfMaxPages??200,entries:persisted('vector-stores')});
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
  function rememberResponseItems(response){
    if(response?.store===false)return;
    for(const item of response?.output||[])if(typeof item?.id==='string'&&item.id)itemReferenceStore.set(item.id,item);
  }
  function expandResponseState(input){
    if(!Array.isArray(input))return input;
    return input.map(item=>{
      if(item?.type==='compaction'){
        if(typeof item.encrypted_content!=='string'||!item.encrypted_content)throw error(400,'compaction item 缺少 encrypted_content');
        const value=compactionStore.get(item.encrypted_content);
        return {id:item.id||`cmp_${randomUUID().replaceAll('-','')}`,type:'message',role:'developer',content:[{type:'input_text',text:`Compacted conversation state:\n${value.summary}`}]};
      }
      if(item?.type==='item_reference'){
        if(typeof item.id!=='string'||!item.id)throw error(400,'item_reference 缺少 id');
        try{return itemReferenceStore.get(item.id);}catch(cause){
          if(cause?.status===404)return {type:'message',role:'developer',content:'A previous response item is unavailable or expired. Its context is missing; continue using the supplied messages and ask for missing details if needed.'};
          throw cause;
        }
      }
      if(item?.type==='reasoning'&&item.encrypted_content&&!item.content?.length&&!item.summary?.length){
        return {...item,summary:[{type:'summary_text',text:openReasoning(item.encrypted_content,config.key)}]};
      }
      return item;
    });
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
  let modelCache = { at: 0, data: [], confirmed: false };
  let modelRetryAfter = 0;
  let modelPending;
  let healthProbeCache={at:0,result:null},healthProbePending;
  async function loadModelCatalogue(){
    let token=await timedUpstream(signal=>tokenManager.get(false,signal),Math.min(config.timeout??120000,35000));
    const read=()=>timedUpstream(signal=>modelFetcher(token,signal),Math.min(config.timeout??120000,10000));
    try{return await read();}
    catch(cause){
      if(cause?.status!==401||!tokenManager.renewable)throw cause;
      token=await timedUpstream(signal=>refreshRejectedToken(tokenManager,token,signal),Math.min(config.timeout??120000,35000));
      return read();
    }
  }
  async function probeUpstream(){
    if(!tokenManager.configured)return{upstream_status:'unconfigured',upstream_models:0};
    if(healthProbeCache.result&&Date.now()-healthProbeCache.at<30000)return healthProbeCache.result;
    if(healthProbePending)return healthProbePending;
    healthProbePending=(async()=>{
      const started=Date.now();let result;
      try{
        const raw=await loadModelCatalogue();
        const records=raw?.result?.records||raw?.data?.records||raw?.data||[];
        if(raw?.success===false||!Array.isArray(records))throw new Error('Invalid model directory');
        const count=new Set(modelDirectory(records).map(model=>model.upstream_id)).size;
        if(!count)throw new Error('No usable models');
        result={upstream_status:'ok',upstream_models:count,upstream_latency_ms:Date.now()-started};
      }catch(cause){result={upstream_status:'unavailable',upstream_models:0,upstream_latency_ms:Date.now()-started,upstream_error:cause?.status===401?'authentication_failed':'connection_or_catalogue_failed'};}
      healthProbeCache={at:Date.now(),result};return result;
    })();
    try{return await healthProbePending;}finally{healthProbePending=undefined;}
  }
  async function models() {
    if (!tokenManager.configured || Date.now() < modelRetryAfter || Date.now() - modelCache.at < (config.modelTtl ?? 300000)) return modelCache.data;
    if (modelPending) return modelPending;
    modelPending = (async () => { try {
      const raw=await loadModelCatalogue();
      const records = raw?.result?.records || raw?.data?.records || raw?.data || [];
      if (!Array.isArray(records) || raw?.success === false) throw new Error('Invalid model directory');
      const list = modelDirectory(records);
      if (raw?.success !== true && !records.length) throw new Error('Unrecognized model directory');
      modelCache = { at: Date.now(), data: list, confirmed: true };
      modelRetryAfter = 0;
    } catch {
      // Retry outages sooner than the normal TTL without hammering the school.
      modelRetryAfter = Date.now() + Math.min(config.modelTtl ?? 300000, 10000);
    }
    return modelCache.data;
    })();
    try { return await modelPending; } finally { modelPending = undefined; }
  }
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
            terminal=emitted.response;stored.messages=[...job.messages,responseAssistant(terminal)];rememberResponseItems(terminal);
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
    let controller, timer, release, path=req.url,requestUrl,timedOut=false,requestId='';
    const started=process.hrtime.bigint();let measured=false;
    const measure=status=>{if(measured)return;measured=true;const seconds=Number(process.hrtime.bigint()-started)/1e9;metrics.observe(req.method,status,seconds);requestLogger.observe({requestId,method:req.method,path,status,durationMs:seconds*1000});};
    res.once('finish',()=>measure(res.statusCode));
    res.once('close',()=>measure(499));
    try {
      const suppliedRequestId=Array.isArray(req.headers['x-request-id'])?req.headers['x-request-id'][0]:req.headers['x-request-id'];
      requestId=typeof suppliedRequestId==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)?suppliedRequestId:`req_${randomUUID().replaceAll('-','')}`;
      res.setHeader('X-Request-Id',requestId);
      requestUrl=new URL(req.url,'http://localhost');path=requestUrl.pathname;
      if(['/chat/completions','/models','/tokenizers/estimate-token-count'].includes(path)||path.startsWith('/models/'))path=`/v1${path}`;
      if(path==='/anthropic/v1/messages')path='/v1/messages';
      if(path==='/anthropic/v1/messages/count_tokens')path='/v1/messages/count_tokens';
      // Anthropic SDK reads request-id; OpenAI clients read x-request-id.
      if(path==='/v1/messages'||path==='/v1/messages/count_tokens')res.setHeader('Request-Id',requestId);
      const origin=req.headers.origin,allowed=config.corsOrigin==='*'||config.corsOrigin&&origin===config.corsOrigin;
      if(allowed){res.setHeader('Access-Control-Allow-Origin',config.corsOrigin==='*'?'*':origin);res.setHeader('Access-Control-Expose-Headers','X-Request-Id, Request-Id, X-Usage-Source, Retry-After');res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){
        if(!allowed)throw error(403,'未允许该浏览器来源');
        res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'Accept, Authorization, Content-Type, X-API-Key, API-Key, X-Request-Id, Idempotency-Key, Anthropic-Version, Anthropic-Beta, OpenAI-Organization, OpenAI-Project','Access-Control-Max-Age':'600'});return res.end();
      }
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok' });
      if (!config.key || !authorized(req, config.key, path)) throw error(401, '需要有效的本地 API Bearer 密钥');
      if(req.method==='GET'&&path==='/metrics'){
        const body=metrics.render({queueActive:queue.active,queueDepth:queue.depth,backgroundRequests:backgroundJobs.size,storedFiles:fileStore.size,vectorStores:vectorStore.size,dataUsedBytes:disk?.usageBytes()??0});
        res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8','Cache-Control':'no-store'});return res.end(body);
      }
      if (req.method === 'GET' && path === '/health') {
        const probe=requestUrl.searchParams.get('upstream');
        if(probe!==null&&!['0','1','false','true'].includes(probe))throw error(400,'upstream 仅支持 0 或 1');
        const live=probe==='1'||probe==='true'?await probeUpstream():null;
        return json(res,live&&live.upstream_status!=='ok'?503:200,{status:live&&live.upstream_status!=='ok'?'degraded':'ok',upstream_configured:tokenManager.configured,...(live||{}),persistence_enabled:Boolean(disk),persistence_corrupt_resources:disk?.corruptResources.length??0,persistence_recovered_resources:disk?.recoveredResources.length??0,data_used_bytes:disk?.usageBytes()??0,data_quota_bytes:disk?.quotaBytes??0,active_requests:queue.active,queued_requests:queue.depth,background_requests:backgroundJobs.size,active_batches:batchStore.active,stored_batches:batchStore.size,stored_responses:responseStore.size,stored_conversations:conversationStore.size,stored_compactions:compactionStore.size,stored_items:itemReferenceStore.size,stored_files:fileStore.size,pending_uploads:uploadStore.size,stored_vector_stores:vectorStore.size,indexed_vector_files:vectorStore.fileCount});
      }
      if(req.method==='POST'&&path==='/v1/uploads')return json(res,200,uploadStore.create(await readBody(req,config.requestLimit)));
      const uploadMatch=/^\/v1\/uploads\/([^/]+)\/(parts|complete|cancel)$/.exec(path);
      if(uploadMatch){
        let uploadId;try{uploadId=decodeURIComponent(uploadMatch[1]);}catch{throw error(400,'Upload ID 编码无效');}
        if(req.method!=='POST')throw error(405,'Upload 资源只支持 POST');
        if(uploadMatch[2]==='parts'){
          const parts=parseMultipart(await readRawBody(req,config.requestLimit),req.headers['content-type']);
          return json(res,200,uploadStore.addPart(uploadId,uploadPart(parts)));
        }
        if(uploadMatch[2]==='complete')return json(res,200,uploadStore.complete(uploadId,await readBody(req,config.requestLimit)));
        return json(res,200,uploadStore.cancel(uploadId));
      }
      if(path==='/v1/files'){
        if(req.method==='POST'){
          const body=await readRawBody(req,config.requestLimit),parts=parseMultipart(body,req.headers['content-type']);
          return json(res,200,fileStore.create(uploadedFile(parts)));
        }
        if(req.method==='GET'){
          const order=requestUrl.searchParams.get('order')||'desc',limit=Number(requestUrl.searchParams.get('limit')||10000),after=requestUrl.searchParams.get('after')||undefined,purpose=requestUrl.searchParams.get('purpose')||undefined;
          if(!['asc','desc'].includes(order)||!Number.isInteger(limit)||limit<1||limit>10000||[...requestUrl.searchParams.keys()].some(key=>!['order','limit','after','purpose'].includes(key)))throw error(400,'文件分页参数无效');
          return json(res,200,fileStore.list({order,limit,after,purpose}));
        }
        throw error(405,'文件集合不支持此方法');
      }
      const fileMatch=/^\/v1\/files\/([^/]+)(\/content)?$/.exec(path);
      if(fileMatch){
        let fileId;try{fileId=decodeURIComponent(fileMatch[1]);}catch{throw error(400,'文件 ID 编码无效');}
        if(req.method==='GET'&&fileMatch[2]){const file=fileStore.get(fileId,true);res.writeHead(200,{'Content-Type':file.mime,'Content-Length':file.bytes.length,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'Cache-Control':'no-store'});return res.end(file.bytes);}
        if(req.method==='GET')return json(res,200,fileStore.get(fileId));
        if(req.method==='DELETE'&&!fileMatch[2]){fileStore.delete(fileId);return json(res,200,{id:fileId,object:'file',deleted:true});}
        throw error(405,'文件资源不支持此方法');
      }
      if(path==='/v1/vector_stores'){
        if(req.method==='POST')return json(res,200,await vectorStore.create(await readBody(req,config.requestLimit)));
        if(req.method==='GET'){
          const options={limit:Number(requestUrl.searchParams.get('limit')||20),order:requestUrl.searchParams.get('order')||'desc',after:requestUrl.searchParams.get('after')||undefined,before:requestUrl.searchParams.get('before')||undefined};
          if([...requestUrl.searchParams.keys()].some(key=>!['limit','order','after','before'].includes(key)))throw error(400,'向量库分页参数无效');return json(res,200,vectorStore.list(options));
        }
        throw error(405,'向量库集合不支持此方法');
      }
      const vectorFileMatch=/^\/v1\/vector_stores\/([^/]+)\/files\/([^/]+)(\/content)?$/.exec(path);
      if(vectorFileMatch){
        let storeId,fileId;try{storeId=decodeURIComponent(vectorFileMatch[1]);fileId=decodeURIComponent(vectorFileMatch[2]);}catch{throw error(400,'向量库文件 ID 编码无效');}
        if(req.method==='GET'&&vectorFileMatch[3])return json(res,200,vectorStore.content(storeId,fileId));
        if(req.method==='GET')return json(res,200,vectorStore.getFile(storeId,fileId));
        if(req.method==='POST'&&!vectorFileMatch[3])return json(res,200,vectorStore.updateFile(storeId,fileId,await readBody(req,config.requestLimit)));
        if(req.method==='DELETE'&&!vectorFileMatch[3])return json(res,200,vectorStore.deleteFile(storeId,fileId));
        throw error(405,'向量库文件资源不支持此方法');
      }
      const vectorBatchMatch=/^\/v1\/vector_stores\/([^/]+)\/file_batches\/([^/]+)(\/(?:cancel|files))?$/.exec(path);
      if(vectorBatchMatch){
        let storeId,batchId;try{storeId=decodeURIComponent(vectorBatchMatch[1]);batchId=decodeURIComponent(vectorBatchMatch[2]);}catch{throw error(400,'向量库批次 ID 编码无效');}
        if(req.method==='GET'&&vectorBatchMatch[3]==='/files'){
          const options={limit:Number(requestUrl.searchParams.get('limit')||20),order:requestUrl.searchParams.get('order')||'desc',after:requestUrl.searchParams.get('after')||undefined,before:requestUrl.searchParams.get('before')||undefined,filter:requestUrl.searchParams.get('filter')||undefined};
          if([...requestUrl.searchParams.keys()].some(key=>!['limit','order','after','before','filter'].includes(key)))throw error(400,'向量库批次文件分页参数无效');return json(res,200,vectorStore.listBatchFiles(storeId,batchId,options));
        }
        if(req.method==='GET'&&!vectorBatchMatch[3])return json(res,200,vectorStore.getBatch(storeId,batchId));
        if(req.method==='POST'&&vectorBatchMatch[3]==='/cancel')return json(res,200,vectorStore.cancelBatch(storeId,batchId));
        throw error(405,'向量库批次资源不支持此方法');
      }
      const vectorChildMatch=/^\/v1\/vector_stores\/([^/]+)\/(files|file_batches|search)$/.exec(path);
      if(vectorChildMatch){
        let storeId;try{storeId=decodeURIComponent(vectorChildMatch[1]);}catch{throw error(400,'向量库 ID 编码无效');}
        if(vectorChildMatch[2]==='files'){
          if(req.method==='POST')return json(res,200,await vectorStore.attach(storeId,await readBody(req,config.requestLimit)));
          if(req.method==='GET'){
            const options={limit:Number(requestUrl.searchParams.get('limit')||20),order:requestUrl.searchParams.get('order')||'desc',after:requestUrl.searchParams.get('after')||undefined,before:requestUrl.searchParams.get('before')||undefined,filter:requestUrl.searchParams.get('filter')||undefined};
            if([...requestUrl.searchParams.keys()].some(key=>!['limit','order','after','before','filter'].includes(key)))throw error(400,'向量库文件分页参数无效');return json(res,200,vectorStore.listFiles(storeId,options));
          }
        }
        if(vectorChildMatch[2]==='file_batches'&&req.method==='POST')return json(res,200,await vectorStore.createBatch(storeId,await readBody(req,config.requestLimit)));
        if(vectorChildMatch[2]==='search'&&req.method==='POST')return json(res,200,vectorStore.search(storeId,await readBody(req,config.requestLimit)));
        throw error(405,'向量库子资源不支持此方法');
      }
      const vectorMatch=/^\/v1\/vector_stores\/([^/]+)$/.exec(path);
      if(vectorMatch){
        let storeId;try{storeId=decodeURIComponent(vectorMatch[1]);}catch{throw error(400,'向量库 ID 编码无效');}
        if(req.method==='GET')return json(res,200,vectorStore.get(storeId));
        if(req.method==='POST')return json(res,200,vectorStore.update(storeId,await readBody(req,config.requestLimit)));
        if(req.method==='DELETE')return json(res,200,vectorStore.delete(storeId));
        throw error(405,'向量库资源不支持此方法');
      }
      if(path==='/v1/batches'){
        if(req.method==='POST')return json(res,200,batchStore.create(await readBody(req,config.requestLimit)));
        if(req.method==='GET'){
          const limit=Number(requestUrl.searchParams.get('limit')||20),after=requestUrl.searchParams.get('after')||undefined;
          if([...requestUrl.searchParams.keys()].some(key=>!['limit','after'].includes(key)))throw error(400,'Batch 分页参数无效');
          return json(res,200,batchStore.list({limit,after}));
        }
        throw error(405,'Batch 集合不支持此方法');
      }
      const batchMatch=/^\/v1\/batches\/([^/]+)(\/cancel)?$/.exec(path);
      if(batchMatch){
        let batchId;try{batchId=decodeURIComponent(batchMatch[1]);}catch{throw error(400,'Batch ID 编码无效');}
        if(req.method==='GET'&&!batchMatch[2])return json(res,200,batchStore.get(batchId));
        if(req.method==='POST'&&batchMatch[2])return json(res,200,batchStore.cancel(batchId));
        throw error(405,'Batch 资源不支持此方法');
      }
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
            if([...requestUrl.searchParams.keys()].some(key=>!['order','limit','after','before'].includes(key)))throw error(400,'对话项分页参数无效');
            return json(res,200,itemPage(value.items,{order:requestUrl.searchParams.get('order')||'desc',limit:Number(requestUrl.searchParams.get('limit')||20),after:requestUrl.searchParams.get('after')??undefined,before:requestUrl.searchParams.get('before')??undefined}));
          }
        }
        throw error(405,'该对话资源不支持此方法');
      }
      const storedMatch=/^\/v1\/responses\/(?!compact$|input_tokens$)([^/]+)(\/(?:input_items|cancel))?$/.exec(path);
      if(storedMatch){
        let responseId;try{responseId=decodeURIComponent(storedMatch[1]);}catch{throw error(400,'响应 ID 编码无效');}
        if(req.method==='GET'){
          const stored=responseStore.get(responseId);
          if(storedMatch[2]==='/input_items'){
            if([...requestUrl.searchParams.keys()].some(key=>!['order','limit','after','before'].includes(key)))throw error(400,'响应输入项分页参数无效');
            return json(res,200,itemPage(stored.input_items,{order:requestUrl.searchParams.get('order')||'asc',limit:Number(requestUrl.searchParams.get('limit')||20),after:requestUrl.searchParams.get('after')??undefined,before:requestUrl.searchParams.get('before')??undefined}));
          }
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
      const publicModel=model=>{
        const {context,output}=modelBudget(model);
        return {...Object.fromEntries(Object.entries(model).filter(([key])=>key!=='upstream_id')),
          context_window:context,max_tokens:output,max_output_tokens:output,max_completion_tokens:output,
          limit:{context,output}};
      };
      if (req.method === 'GET' && path === '/v1/models') {
        const catalogue=await models();
        if(!modelCache.confirmed)throw error(503,'模型目录暂不可用');
        return json(res, 200, { object: 'list', data: catalogue.filter(model=>model.primary!==false).map(publicModel) });
      }
      if (req.method === 'GET' && path.startsWith('/v1/models/')) {
        let modelId;try{modelId=decodeURIComponent(path.slice('/v1/models/'.length));}catch{throw error(400,'模型 ID 编码无效');}
        const catalogue=await models();
        if(!modelCache.confirmed)throw error(503,'模型目录暂不可用');
        const model=catalogue.find(item=>item.id===modelId);
        if(!model)throw error(404,`模型不存在：${modelId}`);
        return json(res,200,publicModel(model));
      }
      if(req.method==='POST'&&path==='/v1/messages/count_tokens'){
        const value=await readBody(req,config.requestLimit);if(!value||typeof value!=='object'||Array.isArray(value))throw error(400,'请求必须是 JSON 对象');
        const expanded=await expandInputFiles('/v1/messages',value,fileStore,{pdfMaxPages:config.pdfMaxPages??200});
        res.setHeader('X-Usage-Source','estimate');
        return json(res,200,{input_tokens:estimateTokens(extractImages('/v1/messages',expanded).input)});
      }
      if(req.method==='POST'&&path==='/v1/tokenizers/estimate-token-count'){
        const value=await readBody(req,config.requestLimit);if(!value||typeof value!=='object'||Array.isArray(value))throw error(400,'请求必须是 JSON 对象');
        if(typeof value.model!=='string'||!Array.isArray(value.messages)||!value.messages.length)throw error(400,'model 和非空 messages 为必填项');
        const catalogue=await models();if(!catalogue.some(model=>model.id===value.model))throw error(400,`模型不可用：${value.model}`,'model');
        const expanded=await expandInputFiles('/v1/chat/completions',value,fileStore,{pdfMaxPages:config.pdfMaxPages??200});
        res.setHeader('X-Usage-Source','estimate');
        return json(res,200,{data:{total_tokens:estimateTokens(extractImages('/v1/chat/completions',expanded).input)}});
      }
      if(req.method==='POST'&&path==='/v1/responses/input_tokens'){
        let value=await readBody(req,config.requestLimit);if(!value||typeof value!=='object'||Array.isArray(value))throw error(400,'请求必须是 JSON 对象');
        let history=[];
        if(value.conversation!==undefined){
          if(value.previous_response_id)throw error(400,'conversation 与 previous_response_id 不能同时使用');
          const id=typeof value.conversation==='string'?value.conversation:value.conversation?.id;if(typeof id!=='string'||!id)throw error(400,'conversation 无效');
          value={...value,input:[...conversationStore.get(id).items,...responseInputItems(value)]};
        }
        if(value.previous_response_id){const previous=responseStore.get(value.previous_response_id);history=previous.messages;value={...value,input:responseInputItems(value)};}
        value={...value,input:expandResponseState(value.input)};
        value=await expandInputFiles('/v1/responses',value,fileStore,{pdfMaxPages:config.pdfMaxPages??200});
        res.setHeader('X-Usage-Source','estimate');
        return json(res,200,{object:'response.input_tokens',input_tokens:estimateTokens(extractImages('/v1/responses',value).input)+estimateTokens(history)});
      }
      if(req.method==='POST'&&path==='/v1/responses/compact'){
        if(!(config.responseStoreSize??128))throw error(400,'Responses compact 需要启用响应存储');
        const value=await readBody(req,config.requestLimit);if(!value||typeof value!=='object'||Array.isArray(value))throw error(400,'请求必须是 JSON 对象');
        const allowed=['model','input','instructions','previous_response_id','conversation','prompt_cache_key','service_tier'];if(Object.keys(value).some(key=>!allowed.includes(key)))throw error(400,'compact 请求包含不支持的参数');
        if(value.conversation!==undefined&&value.previous_response_id)throw error(400,'conversation 与 previous_response_id 不能同时使用');
        const originalItems=responseInputItems(value),items=Array.isArray(value.input)?value.input:value.input===undefined?[]:[{type:'message',role:'user',content:value.input}];
        const address=server.address();if(!address||typeof address!=='object')throw error(503,'本地服务尚未监听');const host=address.family==='IPv6'?'[::1]':'127.0.0.1';
        const compactPrompt='Create a compact state for continuing this work. Preserve requirements, decisions, code facts, tool results, unresolved tasks, names, identifiers, and exact constraints. Remove repetition. Return only the compact state.';
        const response=await fetch(`http://${host}:${address.port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json','X-Shtech-Internal-Compact':'1'},body:JSON.stringify({...value,input:[...items,{type:'message',role:'user',content:compactPrompt}],instructions:[value.instructions,compactPrompt].filter(Boolean).join('\n\n'),stream:false,store:false,background:false,max_output_tokens:4096})});
        const compacted=await response.json();if(!response.ok)throw error(response.status,compacted?.error?.message||'压缩请求失败');
        const token=`cmpstate_${randomUUID().replaceAll('-','')}`,item={id:`cmp_${randomUUID().replaceAll('-','')}`,type:'compaction',encrypted_content:token};compactionStore.set(token,{summary:compacted.output_text});
        const output=[...originalItems.filter(entry=>entry?.role==='user'),item];
        return json(res,200,{id:`resp_${randomUUID().replaceAll('-','')}`,object:'response.compaction',created_at:Math.floor(Date.now()/1000),output,usage:compacted.usage});
      }
      if (req.method !== 'POST' || !['/v1/chat/completions','/v1/completions','/v1/responses','/v1/messages'].includes(path)) throw error(404, '接口不存在');
      if (!tokenManager.configured) throw error(503, '请配置 GENAI_TOKEN 或 CAS 账号');
      let rawInput = await readBody(req,config.requestLimit);
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) throw error(400, '请求必须是 JSON 对象','body');
      if(await idempotency.begin(req.headers['idempotency-key'],path,rawInput,res))return;
      if(path==='/v1/responses')rawInput={...rawInput,input:expandResponseState(rawInput.input)};
      let conversationId,conversationItems=[];
      if(path==='/v1/responses'&&rawInput.conversation!==undefined){
        if(rawInput.previous_response_id)throw error(400,'conversation 与 previous_response_id 不能同时使用','conversation');
        conversationId=typeof rawInput.conversation==='string'?rawInput.conversation:rawInput.conversation?.id;
        if(typeof conversationId!=='string'||!conversationId)throw error(400,'conversation 必须是非空 ID 或包含 id 的对象','conversation');
        const conversation=conversationStore.get(conversationId);conversationItems=responseInputItems(rawInput);
        rawInput={...rawInput,input:[...conversation.items,...conversationItems]};
      }
      const preparedFiles=await prepareInputFiles(path,rawInput,fileStore,{pdfMaxPages:config.pdfMaxPages??200,native:config.nativeFileUpload===true});
      rawInput=preparedFiles.input;
      const media=extractImages(path,rawInput);
      const input = normalizeRequest(path,media.input);
      const fileSearch=path==='/v1/responses'?vectorStore.responseSearch(media.input):null;
      if(fileSearch)input.messages=[{role:'system',content:fileSearch.context},...input.messages];
      let previous;
      if(path==='/v1/responses'&&media.input.previous_response_id){previous=responseStore.get(media.input.previous_response_id);if(!['completed','incomplete'].includes(previous.response.status))throw error(409,'previous_response_id 尚未完成');input.messages=[...previous.messages,...input.messages];}
      const formatPolicy=outputPolicy(path,media.input);
      const legacy=path==='/v1/completions';
      const adapter = path === '/v1/responses'||path==='/v1/messages' ? new ProtocolOutput(path,input,async frame=>{
        if (!res.headersSent) res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no' });
        await write(res,frame);
      },media.input,{fileSearchItem:fileSearch?.item,reasoningSecret:config.key}) : null;
      const policy = toolPolicy(input.tools,input.tool_choice,input.parallel_tool_calls,input.max_tool_calls);
      const makeCallId=()=>`call_${randomUUID().replaceAll('-','')}`;
      // Repair needs an atomic answer: once a tool is emitted clients may execute it.
      const toolStream=input.stream&&policy&&!config.outputRepair?createToolCallStream(policy,makeCallId):null;
      let streamedToolCalls=0,streamedText='',streamedReasoningLength=0,toolStreamError=null;
      const catalogue = await models();
      if (!catalogue.length) throw error(503, '模型目录没有已确认的自部署聊天模型');
      const defaultModel=catalogue.find(model=>model.primary!==false&&isKimiK3Model(model))
        ||catalogue.find(model=>model.primary!==false)||catalogue[0];
      const selected=catalogue.find(model=>model.id===(input.model??defaultModel.id));
      if(!selected)throw error(400,`模型不可用：${input.model}`,'model');
      input.model??=selected.id;
      const {context:contextWindow,output:defaultOutput}=modelBudget(selected);
      const outputReserve=input.max_tokens??input.max_completion_tokens??defaultOutput;
      if(input.max_tokens===undefined&&input.max_completion_tokens===undefined)input.max_tokens=outputReserve;
      // Validate before uploads, and count the actual prompt added by the bridge.
      const preflight=upstreamBody(input,config,catalogue,formatPolicy);
      const promptSize=body=>estimateTokens({messages:body.messages,chatInfo:body.chatInfo});
      const promptOverhead=Math.max(0,promptSize(preflight)-estimateTokens(input.messages));
      const autoThreshold=Math.max(1,contextWindow-outputReserve-promptOverhead);
      if(path==='/v1/responses'){
        const configured=media.input.context_management?.find(item=>item.type==='compaction')?.compact_threshold;
        const threshold=configured??(media.input.truncation==='auto'?autoThreshold:undefined);
        if(threshold)input.messages=manageContextMessages(input.messages,Math.min(threshold,autoThreshold),config.contextStrategy??'agent');
      }else if(config.contextAuto!==false)input.messages=manageContextMessages(input.messages,autoThreshold,config.contextStrategy??'agent');
      const inputEstimate=promptSize(upstreamBody(input,config,catalogue,formatPolicy));
      if(inputEstimate+outputReserve>contextWindow)throw Object.assign(error(400,
        `输入和输出额度超过模型 ${selected.id} 的上下文窗口（context_length_exceeded）：估算输入 ${inputEstimate} tokens，预留输出 ${outputReserve} tokens，上下文上限 ${contextWindow} tokens；请缩短最新请求、工具定义或工具结果，或降低输出 token 上限`,
        path==='/v1/responses'?'input':legacy?'prompt':'messages'),{code:'context_length_exceeded'});
      const retainedImageInputs=retainedImages(media,input.messages);
      if(retainedImageInputs.length&&!selected.capabilities?.vision)throw error(400,`模型 ${selected.id} 未确认支持图片输入`,'model');
      if(path==='/v1/responses'&&media.input.background===true){
        if(!(config.responseStoreSize??128))throw error(400,'background 模式需要启用响应存储');
        pruneBackground();
        const backgroundRaw={...rawInput,conversation:undefined},queued=adapter.response([],'queued',null),inputItems=conversationId?conversationItems:responseInputItems(backgroundRaw),log={events:[],waiters:new Set(),done:false,version:0,nextSequence:0,expires:Date.now()+(config.responseStoreTtl??3600000)},job={controller:new AbortController(),deleted:false,terminal:false,messages:structuredClone(input.messages),inputItems,store:media.input.store!==false,log,conversationId,conversationItems};
        addBackgroundEvent(log,'response.queued',{response:queued});backgroundStreams.set(queued.id,log);pruneBackground();
        responseStore.set(queued.id,{response:queued,messages:job.messages,input_items:inputItems});backgroundJobs.set(queued.id,job);
        setImmediate(()=>void runBackground(queued.id,backgroundRaw,job));
        if(media.input.stream===true)return streamBackground(req,res,log,-1);
        return json(res,200,queued);
      }
      controller = new AbortController();
      res.on('close', () => {if(!res.writableEnded)controller.abort();});
      release=await queue.acquire(controller.signal,selected.upstream_id||selected.id);
      timer = setTimeout(() => {timedOut=true;controller.abort();}, config.timeout);
      const accessToken=await tokenManager.get(false,controller.signal);
      const automaticGroup=typeof (input.chat_group_id??config.group)==='string'&&!(input.chat_group_id??config.group).trim();
      if(automaticGroup)input.chat_group_id=newChatGroupId();
      const recovery=config.historyFallback===false?null:{contextWindow,resetSession:automaticGroup};
      const fileIds=await uploadNativeFiles(preparedFiles.files,{chatGroupId:input.chat_group_id??config.group,aiType:selected.upstream_id||selected.id,accessToken,cookie:config.cookie,signal:controller.signal,fetcher});
      const imagePayload=await prepareImages(retainedImageInputs,config,accessToken,controller.signal,imageFetcher,frontendFetcher);
      const body = upstreamBody(input, config, catalogue, formatPolicy,{...imagePayload,...(fileIds.length?{fileIds}:{})});
      const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream',
        'x-access-token': accessToken, Origin: 'https://genai.shanghaitech.edu.cn',
        Referer: 'https://genai.shanghaitech.edu.cn/dashboard/analysis' };
      if (config.cookie) headers.Cookie = config.cookie;
      const source=guardedEvents(authenticatedEvents(fetcher,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal,redirect:'error'},tokenManager,config.upstreamRetries??2,()=>idempotency.dispatched(res),config.debugUpstream?config:null,recovery),circuit,selected.upstream_id||selected.id,controller.signal);
      // Even an SSE heartbeat commits HTTP headers and prevents a repair error
      // from being returned with its correct status before output is accepted.
      const sourceEvents=input.stream&&(policy||formatPolicy)&&!config.outputRepair?withHeartbeats(source):source;
      const fallbackId=`chatcmpl-${randomUUID()}`;
      let streamId,streamCreated;
      const streamMeta=()=>({id:streamId||fallbackId,object:'chat.completion.chunk',created:streamCreated??Math.floor(Date.now()/1000),model:input.model||selected.id});
      const legacyId=()=>streamMeta().id.replace(/^chatcmpl-/,'cmpl-');
      const emitToolCalls=async calls=>{
        if(!calls.length||toolStreamError)return;
        if(adapter)try{for(const call of calls)adapter.callItem(call);}catch(cause){
          if(!config.outputRepair||cause.status!==502||res.headersSent)throw cause;
          toolStreamError=cause;return;
        }
        if(adapter)for(const call of calls)await adapter.toolCall(call);
        else if(!legacy){
          if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});
          const delta={role:'assistant',tool_calls:calls.map((call,offset)=>({...call,index:streamedToolCalls+offset}))};
          const frame={...streamMeta(),choices:[{index:0,delta,logprobs:null,finish_reason:null}],...(input.stream_options?.include_usage?{usage:null}:{})};
          await write(res,`data: ${JSON.stringify(frame)}\n\n`);
        }
        streamedToolCalls+=calls.length;
      };
      let text = '', reasoning = '', responseBytes = 0, last, finished = false, seen = false;
      const suppressReasoning=input.thinking?.type==='disabled'||(input.thinking?.type!=='enabled'&&input.reasoning_effort==='none');
      const nativeCalls=new Map(),emittedNative=new Set(),emittedNativeIds=new Set();
      for await (const item of sourceEvents) {
        if(item===null){if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});await write(res,': keep-alive\n\n');continue;}
        if (item.data === '[DONE]') { finished = true; break; }
        if (item.event === 'error') throw error(502, '上游返回错误事件');
        let chunk; try { chunk = JSON.parse(item.data); } catch { throw error(502, '上游 SSE 包含无效 JSON'); }
        if (chunk.error) throw error(502, '上游返回错误');
        streamId??=typeof chunk.id==='string'&&chunk.id?chunk.id:fallbackId;
        streamCreated??=Number.isInteger(chunk.created)&&chunk.created>0?chunk.created:Math.floor(Date.now()/1000);
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
            const extraArguments=fragment.function?.arguments;
            if(emittedNative.has(fragment.index)&&((fragment.id&&fragment.id!==current.id)||fragment.function?.name||extraArguments!==undefined&&(typeof extraArguments!=='string'||extraArguments.trim())))throw error(502,'上游在已发送的工具调用后追加了参数');
            if(fragment.id!==undefined){if(typeof fragment.id!=='string')throw error(502,'上游工具调用 ID 无效');current.id ||= fragment.id;}
            if(fragment.function?.name!==undefined){if(typeof fragment.function.name!=='string')throw error(502,'上游工具名称无效');current.name+=fragment.function.name;}
            if(fragment.function?.arguments!==undefined){if(typeof fragment.function.arguments!=='string')throw error(502,'上游工具参数无效');current.arguments+=fragment.function.arguments;responseBytes+=Buffer.byteLength(fragment.function.arguments);}
            nativeCalls.set(fragment.index,current);
          }
        }
        if(choice?.delta?.function_call!==undefined){
          if(!policy||!choice.delta.function_call||typeof choice.delta.function_call!=='object')throw error(502,'上游返回了未请求或无效的旧版函数调用');
          const fragment=choice.delta.function_call,current=nativeCalls.get(0)||{id:'',name:'',arguments:''};
          if(emittedNative.has(0)&&(fragment.name||fragment.arguments!==undefined&&(typeof fragment.arguments!=='string'||fragment.arguments.trim())))throw error(502,'上游在已发送的工具调用后追加了参数');
          if(fragment.name!==undefined){if(typeof fragment.name!=='string')throw error(502,'上游函数名称无效');current.name+=fragment.name;}
          if(fragment.arguments!==undefined){if(typeof fragment.arguments!=='string')throw error(502,'上游函数参数无效');current.arguments+=fragment.arguments;responseBytes+=Buffer.byteLength(fragment.arguments);}
          nativeCalls.set(0,current);
        }
        if(input.stream&&policy&&!formatPolicy&&!config.outputRepair&&nativeCalls.size){
          const ready=[];
          for(let index=emittedNative.size;nativeCalls.has(index);index++){
            if(emittedNative.has(index))continue;
            const current=nativeCalls.get(index);
            if(!policy.allowed.has(current.name))break;
            try{JSON.parse(current.arguments);}catch{break;}
            const parsed=parseToolCalls(JSON.stringify({tool_calls:[{id:current.id||undefined,name:current.name,arguments:current.arguments}]}),policy,makeCallId);
            const call=parsed.tool_calls[0];
            if(streamedToolCalls+ready.length>=policy.maxCalls)throw error(502,`模型工具调用数量超过 max_tool_calls=${policy.maxCalls}`);
            if(emittedNativeIds.has(call.id)||ready.some(item=>item.id===call.id))throw error(502,'模型输出了重复的工具调用 ID');
            current.id ||=call.id;ready.push(call);emittedNative.add(index);emittedNativeIds.add(call.id);
          }
          await emitToolCalls(ready);
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
        if(input.stream&&policy&&!formatPolicy&&!config.outputRepair&&thought){
          if(adapter)await adapter.reasoningDelta(thought);
          else if(!legacy){
            if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});
            const frame={...streamMeta(),choices:[{index:0,delta:{role:'assistant',reasoning_content:thought},logprobs:null,finish_reason:null}],...(input.stream_options?.include_usage?{usage:null}:{})};
            await write(res,`data: ${JSON.stringify(frame)}\n\n`);
          }
          streamedReasoningLength+=thought.length;
        }
        if(toolStream&&content&&!nativeCalls.size&&!toolStreamError) {
          let calls;
          try{calls=toolStream.push(content);}catch(cause){
            if(!config.outputRepair||res.headersSent)throw cause;
            toolStreamError=cause;calls=[];
          }
          const visible=toolStreamError?'':toolStream.takeText();
          if(visible&&!formatPolicy){
            if(adapter)await adapter.delta(visible);
            else if(!legacy){
              if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});
              const frame={...streamMeta(),choices:[{index:0,delta:{role:'assistant',content:visible},logprobs:null,finish_reason:null}],...(input.stream_options?.include_usage?{usage:null}:{})};
              await write(res,`data: ${JSON.stringify(frame)}\n\n`);
            }
            streamedText+=visible;
          }
          await emitToolCalls(calls);
        }
        if (choice?.finish_reason != null) finished = true;
        last = { ...last, ...chunk, choices: choice ? chunk.choices : last?.choices };
        if (input.stream && !policy && !formatPolicy) {
          if (adapter) { await adapter.reasoningDelta(thought); await adapter.delta(content); }
          else {
            if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
            const publicChunk=suppressReasoning?{...chunk,...streamMeta(),choices:chunk.choices.map(value=>{const delta={...value.delta,role:'assistant'};delete delta.reasoning_content;delete delta.reasoning;delete delta.thinking;return{...value,delta,logprobs:value.logprobs??null};})}:{...chunk,...streamMeta(),choices:chunk.choices.map(value=>({...value,delta:{...value.delta,role:'assistant'},logprobs:value.logprobs??null}))};
            const outbound=legacy?{id:legacyId(),object:'text_completion',created:streamMeta().created,model:streamMeta().model,choices:chunk.choices.map(value=>({index:value.index,text:value.delta?.content||'',logprobs:null,finish_reason:value.finish_reason})),...(input.stream_options?.include_usage?{usage:null}:{})}
              :input.stream_options?.include_usage?{...publicChunk,usage:null}:publicChunk;
            await write(res, `data: ${JSON.stringify(outbound)}\n\n`);
          }
        }
      }
      if (!seen || !finished) throw error(502, '上游流意外结束，未收到完成标记');
      const bufferedText=adapter && input.stream && !policy && !formatPolicy ? adapter.text : text;
      const nativePayload=nativeCalls.size?JSON.stringify({tool_calls:[...nativeCalls].sort((a,b)=>a[0]-b[0]).map(([,call])=>({id:call.id||undefined,name:call.name,arguments:call.arguments}))}):null;
      const validateOutput=(value)=>{
        if(input.parallel_tool_calls===false&&value.tool_calls.length>1)throw error(502,'模型返回了多个工具调用，但 parallel_tool_calls=false');
        if(adapter)for(const call of value.tool_calls)adapter.callItem(call);
        if(!value.tool_calls.length)value.content=parseStructured(value.content,formatPolicy);
        return value;
      };
      let parsed,repaired=false,repairPromptBytes=0;
      try{
        if(toolStreamError)throw toolStreamError;
        parsed=nativePayload?parseToolCalls(nativePayload,policy,makeCallId):toolStream?toolStream.finish():parseToolCalls(bufferedText,policy,makeCallId);
        if(nativePayload&&bufferedText.trim())parsed.content=bufferedText.trim();
        parsed=validateOutput(parsed);
      }catch(cause){
        if(!config.outputRepair||cause.status!==502||res.headersSent||!policy&&!formatPolicy)throw cause;
        const repair=await repairGeneratedOutput(fetcher,tokenManager,config,circuit,selected.upstream_id||selected.id,headers,body,nativePayload||bufferedText,cause.message,policy,formatPolicy,controller.signal,contextWindow,recovery);
        parsed=validateOutput(parseToolCalls(repair.text,policy,makeCallId));
        repaired=true;repairPromptBytes=repair.promptBytes;responseBytes+=Buffer.byteLength(repair.text)+Buffer.byteLength(repair.reasoning);
        reasoning=suppressReasoning?'':repair.reasoning;
        last={...repair.last,usage:undefined};
      }
      if(toolStream&&!repaired&&!nativeCalls.size&&!formatPolicy){
        const tail=toolStream.takeText();
        if(tail){
          if(adapter)await adapter.delta(tail);
          else if(!legacy){
            if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});
            const frame={...streamMeta(),choices:[{index:0,delta:{role:'assistant',content:tail},logprobs:null,finish_reason:null}],...(input.stream_options?.include_usage?{usage:null}:{})};
            await write(res,`data: ${JSON.stringify(frame)}\n\n`);
          }
          streamedText+=tail;
        }
      }
      const finish = parsed.tool_calls.length ? 'tool_calls' : last.choices?.[0]?.finish_reason || 'stop';
      const finalReasoning=adapter && input.stream && !policy && !formatPolicy ? adapter.reasoning : reasoning;
      const promptEstimate=Math.ceil((Buffer.byteLength(JSON.stringify(input.messages))+repairPromptBytes)/3);
      const completionEstimate=Math.ceil(responseBytes/3);
      const normalizedUsage=chatUsage(last.usage,promptEstimate,completionEstimate,Math.ceil(Buffer.byteLength(finalReasoning||'')/3));
      const reportedPrompt=last.usage?.prompt_tokens??last.usage?.input_tokens,reportedCompletion=last.usage?.completion_tokens??last.usage?.output_tokens;
      const usageSource=Number.isInteger(reportedPrompt)&&reportedPrompt>=0&&Number.isInteger(reportedCompletion)&&reportedCompletion>=0?'upstream':'estimate';
      const completion = { id:streamMeta().id, object: 'chat.completion', created:streamMeta().created, model:streamMeta().model, choices: [{ index: 0, message: { role: 'assistant', content: parsed.content, ...(finalReasoning ? { reasoning_content: finalReasoning } : {}), ...(parsed.tool_calls.length?{tool_calls:parsed.tool_calls}:{}) }, logprobs:null,finish_reason: finish }], usage: normalizedUsage };
      if (adapter) {
        if(input.stream&&parsed.content?.startsWith(adapter.text))await adapter.delta(parsed.content.slice(adapter.text.length));
        const result = await adapter.finish(completion,input.stream);
        if(path==='/v1/responses')rememberResponseItems(result);
        if(path==='/v1/responses'&&conversationId&&req.headers['x-shtech-internal-compact']!=='1')appendConversation(conversationId,[...conversationItems,...result.output]);
        if(path==='/v1/responses'&&media.input.store!==false){
          const assistant=responseAssistant(result);
          const inputItems=responseInputItems(media.input);
          responseStore.set(result.id,{response:result,messages:[...input.messages,assistant],input_items:inputItems});
        }
        if (input.stream) res.end();
        else { res.setHeader('X-Usage-Source',usageSource); json(res,200,result); }
        return;
      }
      if (input.stream && (policy || formatPolicy)) {
        if(!res.headersSent)res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no' });
        const remainingCalls=parsed.tool_calls.slice(streamedToolCalls);
        const remainingText=parsed.content?.startsWith(streamedText)?parsed.content.slice(streamedText.length):parsed.content;
        const remainingReasoning=reasoning.slice(streamedReasoningLength);
        const delta = { role:'assistant', ...(remainingText ? {content:remainingText}:{}), ...(remainingReasoning?{reasoning_content:remainingReasoning}:{}), ...(remainingCalls.length?{tool_calls:remainingCalls.map((t,index)=>({...t,index:index+streamedToolCalls}))}:{}) };
        const streamBase={...last,...streamMeta(),...(input.stream_options?.include_usage?{usage:null}:{})};
        await write(res,`data: ${JSON.stringify({...streamBase,choices:[{index:0,delta,logprobs:null,finish_reason:null}]})}\n\n`);
        await write(res,`data: ${JSON.stringify({...streamBase,choices:[{index:0,delta:{},logprobs:null,finish_reason:finish}]})}\n\n`);
      }
      if(input.stream&&!adapter&&input.stream_options?.include_usage) {
        const usage=normalizedUsage;
        const usageFrame=legacy?{id:legacyId(),object:'text_completion',created:streamMeta().created,model:streamMeta().model,choices:[],usage}:{...last,...streamMeta(),choices:[],usage};
        await write(res,`data: ${JSON.stringify(usageFrame)}\n\n`);
      }
      if (input.stream) { await write(res, 'data: [DONE]\n\n'); res.end(); }
      else {
        res.setHeader('X-Usage-Source',usageSource);
        const result=legacy?{id:completion.id.replace(/^chatcmpl-/,'cmpl-'),object:'text_completion',created:completion.created,model:completion.model,choices:[{index:0,text:parsed.content||'',logprobs:null,finish_reason:finish}],usage:normalizedUsage}:completion;
        json(res,200,result);
      }
    } catch (e) {
      idempotency.fail(res);
      const status = e.status || (controller?.signal.aborted ? timedOut?504:499 : 502),message=e.status?e.message:status===504?'上游请求超时':status===499?'客户端已断开':'无法连接上游服务';
      const codes={400:'invalid_request',401:'invalid_api_key',403:'permission_denied',404:'not_found',405:'method_not_allowed',409:'conflict',413:'request_too_large',429:'rate_limit_exceeded',499:'client_closed_request',502:'upstream_error',503:'service_unavailable',504:'timeout',507:'insufficient_storage'},code=e.status&&e.code?e.code:codes[status]||'server_error';
      const types={400:'invalid_request_error',401:'authentication_error',403:'permission_error',404:'not_found_error',405:'invalid_request_error',409:'conflict_error',413:'request_too_large',429:'rate_limit_error',499:'api_error',502:'api_error',503:'overloaded_error',504:'api_error',507:'api_error'};
      const payload = { ...(path === '/v1/messages' ? {type:'error'} : {}), error: { message,type:types[status]||'api_error',param:e.param??null,code } };
      if (!res.destroyed) {
        if(res.headersSent){
          if(['/v1/chat/completions','/v1/completions'].includes(path))res.end(`data: ${JSON.stringify(payload)}\n\n`);
          else if(path==='/v1/responses')res.end(`event: error\ndata: ${JSON.stringify({type:'error',code,message,param:e.param??null})}\n\n`);
          else res.end(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
        } else {if(status===401)res.setHeader('WWW-Authenticate','Bearer');if(e.retryAfter||status===429)res.setHeader('Retry-After',String(e.retryAfter??1));json(res, status, payload);}
      }
    } finally { clearTimeout(timer); controller?.abort(); release?.(); }
  });
  server.checkUpstream = probeUpstream;
  server.once('close',()=>{batchStore.close();releaseDisk?.();});
  return server;
  }catch(cause){releaseDisk?.();throw cause;}
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
  if (!Number.isInteger(config.fileStoreSize) || config.fileStoreSize < 0 || config.fileStoreSize > 1000) throw new Error('GENAI_FILE_STORE_SIZE 必须为 0–1000 的整数');
  if (!Number.isFinite(config.fileStoreTtl) || config.fileStoreTtl < 3600000 || config.fileStoreTtl > 2592000000) throw new Error('GENAI_FILE_STORE_TTL_MS 必须为 1 小时–30 天');
  if (!Number.isInteger(config.fileMaxBytes) || config.fileMaxBytes < 1024 || config.fileMaxBytes > 10*1048576) throw new Error('GENAI_FILE_MAX_MB 必须为 0.001–10');
  if (!Number.isSafeInteger(config.dataQuotaBytes??0) || (config.dataQuotaBytes??0)<0 || (config.dataQuotaBytes??0)>1024*1024*1024*1024) throw new Error('GENAI_DATA_QUOTA_MB 必须为 0–1048576');
  if (!Number.isInteger(config.pdfMaxPages) || config.pdfMaxPages < 1 || config.pdfMaxPages > 2000) throw new Error('GENAI_PDF_MAX_PAGES 必须为 1–2000 的整数');
  if (!Number.isInteger(config.batchStoreSize) || config.batchStoreSize < 0 || config.batchStoreSize > 1000) throw new Error('GENAI_BATCH_STORE_SIZE 必须为 0–1000 的整数');
  if (!Number.isFinite(config.batchStoreTtl) || config.batchStoreTtl < 3600000 || config.batchStoreTtl > 2592000000) throw new Error('GENAI_BATCH_STORE_TTL_MS 必须为 1 小时–30 天');
  if (!Number.isInteger(config.vectorStoreSize) || config.vectorStoreSize < 0 || config.vectorStoreSize > 1000) throw new Error('GENAI_VECTOR_STORE_SIZE 必须为 0–1000 的整数');
  if (!Number.isFinite(config.vectorStoreTtl) || config.vectorStoreTtl < 3600000 || config.vectorStoreTtl > 31536000000) throw new Error('GENAI_VECTOR_STORE_TTL_MS 必须为 1 小时–365 天');
  if (!Number.isInteger(config.vectorStoreMaxFiles) || config.vectorStoreMaxFiles < 1 || config.vectorStoreMaxFiles > 10000) throw new Error('GENAI_VECTOR_STORE_MAX_FILES 必须为 1–10000 的整数');
  if (!Number.isInteger(config.upstreamRetries) || config.upstreamRetries < 0 || config.upstreamRetries > 5) throw new Error('GENAI_UPSTREAM_RETRIES 必须为 0–5 的整数');
  if (!Number.isInteger(config.breakerFailures) || config.breakerFailures < 1 || config.breakerFailures > 100) throw new Error('GENAI_BREAKER_FAILURES 必须为 1–100 的整数');
  if (!Number.isInteger(config.breakerCooldown) || config.breakerCooldown < 1000 || config.breakerCooldown > 3600000) throw new Error('GENAI_BREAKER_COOLDOWN_MS 必须为 1000–3600000 的整数');
  if (typeof config.contextAuto!=='boolean') throw new Error('GENAI_CONTEXT_AUTO 必须为布尔值');
  if (!['agent','recent'].includes(config.contextStrategy)) throw new Error('GENAI_CONTEXT_STRATEGY 必须为 agent 或 recent');
  if (config.corsOrigin && config.corsOrigin!=='*') { let origin;try{origin=new URL(config.corsOrigin);}catch{throw new Error('CORS_ORIGIN 必须是完整来源或 *');}if(origin.origin!==config.corsOrigin)throw new Error('CORS_ORIGIN 只能包含协议、主机和端口'); }
  const server=createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`Webchat API: http://${config.host}:${config.port}/v1`);
    if(config.startupCheck === false) {
      console.info('[登录检查] 已禁用启动检查，上游登录状态尚未验证');
      return;
    }
    void checkStartupLogin(server);
  });
  const stop=()=>shutdown(server).then(()=>process.exit(0),()=>process.exit(1));
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
  return server;
}

export async function checkStartupLogin(server, report = (event, message) => console[event === 'failure' ? 'error' : 'info'](`[登录检查] ${message}`)) {
  report('start', '正在检查学校登录及模型访问权限…');
  try {
    const result = await server.checkUpstream();
    if(result.upstream_status === 'ok') report('success', `成功，可访问 ${result.upstream_models} 个自部署模型`);
    else if(result.upstream_status === 'unconfigured') report('failure', '失败：未配置 CAS 账号或 GENAI_TOKEN');
    else report('failure', result.upstream_error === 'authentication_failed'
      ? '失败：认证失败，请检查 CAS 账号、Token 或在网页完成人工验证；后续请求仍可重试'
      : '失败：无法访问学校平台或读取模型目录，请检查校内网络和平台状态；后续请求仍可重试');
  } catch {
    report('failure', '失败：上游检查未完成；后续请求仍可重试');
  }
}
