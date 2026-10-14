import { validateSchemaValue } from './structured.mjs';

const invalid = (message,param) => Object.assign(new Error(message), { status: 400, ...(param ? {param} : {}) });
const upstreamError = message => Object.assign(new Error(message), { status: 502 });
export function toolPolicy(tools, choice = 'auto', parallel = true, maxCalls = 64) {
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 64) throw invalid('max_tool_calls 必须是 1–64 的整数','max_tool_calls');
  if (tools === undefined) {
    if (choice !== 'auto' && choice !== 'none') throw invalid('tool_choice 需要 tools','tool_choice');
    return null;
  }
  if (!Array.isArray(tools) || tools.length > 64) throw invalid('tools 必须为数组，最多 64 个','tools');
  const names = new Set();
  for (const tool of tools) {
    const f = tool?.function;
    if (tool?.type !== 'function' || typeof f?.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,255}$/.test(f.name) || names.has(f.name)) throw invalid('工具必须具有唯一且有效的 function.name','tools');
    if (f.parameters !== undefined && (!f.parameters || typeof f.parameters !== 'object' || Array.isArray(f.parameters))) throw invalid('工具 parameters 必须是 JSON Schema 对象','tools');
    if(f.strict!==undefined&&typeof f.strict!=='boolean')throw invalid('工具 strict 必须是布尔值','tools');
    names.add(f.name);
  }
  let required = choice === 'required', allowed = names;
  if (choice && typeof choice === 'object') {
    if (choice.type !== 'function' || !names.has(choice.function?.name)) throw invalid('tool_choice 指定了未知工具','tool_choice');
    allowed = new Set([choice.function.name]); required = true;
  } else if (!['auto','none','required'].includes(choice)) throw invalid('无效 tool_choice','tool_choice');
  if (required && !names.size) throw invalid('required 至少需要一个工具','tools');
  if (choice === 'none' || !names.size) return null;
  return { tools: tools.filter(t=>allowed.has(t.function.name)), allowed, required,parallel:parallel!==false,maxCalls:parallel===false?1:maxCalls,
    custom:new Set(tools.filter(t=>t.custom&&allowed.has(t.function.name)).map(t=>t.function.name)) };
}
export function toolPrompt(policy) {
  if (!policy) return '';
  return `You may request external tools by writing literal text blocks in this format:\n<api_tool_call>{"name":"tool_name","arguments":{}}</api_tool_call>\nUse only the declared tools and JSON objects for arguments. Do not claim to have executed tools. ${policy.required ? 'You must write at least one api_tool_call block.' : 'If no tool is needed, reply normally.'} ${policy.parallel?`You may request up to ${policy.maxCalls} independent tools.`:'Request at most one tool.'}\nTool declarations:\n${JSON.stringify(policy.tools.map(t=>t.function))}`;
}

// Repair only a common serialization mistake outside JSON strings. Broader
// rewriting could change tool arguments and is deliberately rejected.
function parseModelJson(value) {
  const source=String(value).replace(/^\uFEFF/,'').trim();
  try{return JSON.parse(source);}catch{}
  let repaired='',quoted=false,escaped=false;
  for(let index=0;index<source.length;index++){
    const character=source[index];
    if(quoted){repaired+=character;if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;continue;}
    if(character==='"'){quoted=true;repaired+=character;continue;}
    if(character===','){
      let next=index+1;while(/\s/.test(source[next]||''))next++;
      if(source[next]==='}'||source[next]===']')continue;
    }
    repaired+=character;
  }
  return JSON.parse(repaired);
}
function addToolCall(parsed,policy,makeId,calls) {
  const value=parsed?.function?{id:parsed.id,name:parsed.function.name,arguments:parsed.function.arguments}:parsed;
  if (!policy.allowed.has(value?.name)) return false;
  let args=value.arguments;
  if(args===undefined)args=policy.custom?.has(value.name)&&typeof value.input==='string'?{input:value.input}:{};
  if(typeof args==='string'){try{args=parseModelJson(args);}catch{throw upstreamError('模型输出了无法解析的工具参数');}}
  if(!args||typeof args!=='object'||Array.isArray(args))throw upstreamError('模型输出了无效工具参数');
  if(policy.custom?.has(value.name)&&typeof args.input!=='string')throw upstreamError('模型输出了无效的 custom 工具文本参数');
  const declaration=policy.tools.find(tool=>tool.function.name===value.name);
  if(declaration?.function?.parameters&&declaration.function.strict!==false)try{validateSchemaValue(args,declaration.function.parameters);}catch(cause){throw upstreamError(`模型输出的工具参数不符合 ${value.name} 的 JSON Schema：${cause.message}`);}
  const suppliedId=typeof value.id==='string'&&value.id;
  let callId=suppliedId?value.id:makeId();
  if(calls.some(call=>call.id===callId)){
    if(suppliedId)throw upstreamError('模型输出了重复的工具调用 ID');
    const base=callId;let suffix=calls.length;
    do{callId=`${base}_${suffix++}`;}while(calls.some(call=>call.id===callId));
  }
  calls.push({id:callId,type:'function',function:{name:value.name,arguments:JSON.stringify(args)}});
  if(calls.length>policy.maxCalls)throw upstreamError(`模型工具调用数量超过 max_tool_calls=${policy.maxCalls}`);
  return true;
}
const toolValues=parsed=>Array.isArray(parsed)?parsed:Array.isArray(parsed?.tool_calls)?parsed.tool_calls:[parsed];
function jsonFence(source,from){
  const opening=/```(?:json)?[ \t]*\r?\n/gi;opening.lastIndex=from;
  const match=opening.exec(source);if(!match)return null;
  let quoted=false,escaped=false;
  for(let index=opening.lastIndex;index<source.length;index++){
    const character=source[index];
    if(quoted){
      if(escaped)escaped=false;
      else if(character==='\\')escaped=true;
      else if(character==='"')quoted=false;
    }else if(character==='"')quoted=true;
    else if(source.startsWith('```',index)){
      const end=index+3;
      return{index:match.index,end,body:source.slice(opening.lastIndex,index).replace(/\r?\n$/,'')};
    }
  }
  return{index:match.index,incomplete:true};
}
function closingTag(source,state,tag){
  const closing=new RegExp(`^<\\s*\\/\\s*${tag}\\s*>`,'i');
  for(let index=state.scanAt;index<source.length;index++){
    const character=source[index];
    if(state.quoted){
      if(state.escaped)state.escaped=false;
      else if(character==='\\')state.escaped=true;
      else if(character==='"')state.quoted=false;
    }else if(character==='"')state.quoted=true;
    else if(character==='<'){
      const match=closing.exec(source.slice(index));
      if(match)return{index,end:index+match[0].length};
      state.scanAt=index;return null;
    }
  }
  state.scanAt=source.length;return null;
}
function taggedText(source,onBlock){
  const opening=/<\s*(api_tool_call|tool_call)\s*>/gi;
  let cursor=0,content='';
  while(true){
    opening.lastIndex=cursor;
    const match=opening.exec(source);if(!match)break;
    const close=closingTag(source,{scanAt:opening.lastIndex,quoted:false,escaped:false},match[1]);
    if(!close)break;
    content+=source.slice(cursor,match.index);
    onBlock?.(source.slice(opening.lastIndex,close.index));
    cursor=close.end;
  }
  return content+source.slice(cursor);
}
export function parseToolCalls(text, policy, makeId) {
  if (!policy) return { content: text, tool_calls: [] };
  const calls = [];
  const add=parsed=>addToolCall(parsed,policy,makeId,calls);
  const content = taggedText(text,raw=>{
    let parsed;
    try { parsed=parseModelJson(raw); } catch { throw upstreamError('模型输出了无法解析的工具调用'); }
    const values=toolValues(parsed);
    if(!values.length||values.some(value=>!add(value)))throw upstreamError('模型输出了不允许的工具');
  }).trim();
  if (/<\s*\/?\s*(?:api_tool_call|tool_call)\b/i.test(content)) throw upstreamError('工具调用块未完整结束');
  let remaining=content;
  if(!calls.length){
    const fenced=[...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match=>match[1]);
    const candidates=[content,content.replace(/^```(?:json)?\s*|\s*```$/gi,''),...fenced];
    for(const candidate of candidates){
      let parsed;try{parsed=parseModelJson(candidate);}catch{continue;}
      const values=toolValues(parsed);
      if(values.length&&values.every(value=>policy.allowed.has(value?.name||value?.function?.name))){for(const value of values)add(value);remaining='';break;}
    }
  }
  if (policy.required && !calls.length) throw upstreamError('模型未遵循 required 工具调用约束');
  return { content: remaining || null, tool_calls: calls };
}
export function createToolCallStream(policy,makeId) {
  let source='',scanFrom=0,textCursor=0,pending=null,readyText='',emittedText='',jsonToolEnd=null,plainJson=false;
  const calls=[],hiddenFences=[];
  const jsonCandidate=()=>{
    const value=source.replace(/^[\s\uFEFF]*/,'');
    return value.startsWith('{')||/^\[\s*(?:\{|$)/.test(value)||/^```(?:json\b|\s*$)/i.test(value);
  };
  const safeTextEnd=()=>{
    const names=['<api_tool_call>','<tool_call>'];
    let end=source.length;
    for(let index=source.lastIndexOf('<');index>=textCursor;index=source.lastIndexOf('<',index-1)){
      const suffix=source.slice(index).replace(/\s/g,'').toLowerCase();
      if(names.some(name=>name.startsWith(suffix)||suffix.startsWith(name.slice(0,-1))))end=index;
    }
    for(let index=source.lastIndexOf('`');index>=textCursor;index=source.lastIndexOf('`',index-1)){
      const suffix=source.slice(index).toLowerCase();
      if('```json'.startsWith(suffix)||/^```(?:json\b|\s)/.test(suffix))end=Math.min(end,index);
    }
    return end;
  };
  return {
    push(value) {
      if(!value)return [];
      source+=value;
      const added=[];
      while(true) {
        if(!pending) {
          const opening=/<\s*(api_tool_call|tool_call)\s*>/gi;opening.lastIndex=scanFrom;
          const match=opening.exec(source);
          const fenced=jsonFence(source,scanFrom);
          if(fenced&&(!match||fenced.index<match.index)){
            if(fenced.incomplete){
              if(fenced.index>textCursor){readyText+=source.slice(textCursor,fenced.index);textCursor=fenced.index;}
              scanFrom=fenced.index;break;
            }
            let parsed;try{parsed=parseModelJson(fenced.body);}catch{}
            const values=parsed===undefined?[]:toolValues(parsed);
            if(values.length&&values.every(item=>policy.allowed.has(item?.name||item?.function?.name))){
              if(fenced.index>textCursor)readyText+=source.slice(textCursor,fenced.index);
              const before=calls.length;
              for(const item of values)addToolCall(item,policy,makeId,calls);
              added.push(...calls.slice(before));
              hiddenFences.push({start:fenced.index,end:fenced.end});
              scanFrom=textCursor=fenced.end;
              continue;
            }
            if(!policy.required){
              readyText+=source.slice(textCursor,fenced.end);
              scanFrom=textCursor=fenced.end;
              continue;
            }
          }
          if(!match){
            if(!calls.length&&!plainJson&&jsonCandidate()){
              let parsed,complete=false;try{parsed=parseModelJson(source);complete=true;}catch{}
              const values=parsed===undefined?[]:toolValues(parsed);
              if(values.length&&values.every(item=>policy.allowed.has(item?.name||item?.function?.name))){
                const before=calls.length;
                for(const item of values)addToolCall(item,policy,makeId,calls);
                added.push(...calls.slice(before));
                jsonToolEnd=source.length;scanFrom=textCursor=jsonToolEnd;
                break;
              }
              if(complete&&!policy.required)plainJson=true;
            }
            const end=safeTextEnd();
            if((jsonToolEnd!==null||plainJson||!jsonCandidate())&&end>textCursor){readyText+=source.slice(textCursor,end);textCursor=end;}
            scanFrom=end;break;
          }
          if(match.index>textCursor){readyText+=source.slice(textCursor,match.index);textCursor=match.index;}
          pending={tag:match[1].toLowerCase(),bodyStart:opening.lastIndex,scanAt:opening.lastIndex,quoted:false,escaped:false};
        }
        const close=closingTag(source,pending,pending.tag);
        if(!close)break;
        let parsed;try{parsed=parseModelJson(source.slice(pending.bodyStart,close.index));}catch{throw upstreamError('模型输出了无法解析的工具调用');}
        const values=toolValues(parsed),before=calls.length;
        if(!values.length||values.some(item=>!addToolCall(item,policy,makeId,calls)))throw upstreamError('模型输出了不允许的工具');
        added.push(...calls.slice(before));
        scanFrom=close.end;textCursor=close.end;pending=null;
      }
      return added;
    },
    takeText() {const value=readyText;readyText='';emittedText+=value;return value;},
    finish() {
      const parsed=!calls.length?parseToolCalls(source,policy,makeId):null;
      let withoutFences=source;
      if(hiddenFences.length){let cursor=0;const fragments=[];for(const fence of hiddenFences){fragments.push(source.slice(cursor,fence.start));cursor=fence.end;}fragments.push(source.slice(cursor));withoutFences=fragments.join('');}
      const content=hiddenFences.length?taggedText(withoutFences):jsonToolEnd!==null?taggedText(source.slice(jsonToolEnd)):calls.length?taggedText(source):parsed.tool_calls.length?emittedText+readyText:source;
      if (/<\s*\/?\s*(?:api_tool_call|tool_call)\b/i.test(content)) throw upstreamError('工具调用块未完整结束');
      if(policy.required&&!(calls.length||parsed?.tool_calls.length))throw upstreamError('模型未遵循 required 工具调用约束');
      const committed=emittedText+readyText;
      if(content.startsWith(committed))readyText+=content.slice(committed.length);
      return {content:content||null,tool_calls:calls.length?calls:parsed.tool_calls};
    }
  };
}
export function normalizeMessages(messages, policy) {
  if (!Array.isArray(messages) || !messages.length) throw invalid('messages 必须是非空数组');
  const result=[]; const pending=new Set();
  for(const [index,m] of messages.entries()) {
    if(!m || !['user','assistant','system','developer','tool'].includes(m.role)) throw invalid('不支持的消息角色');
    if(m.role==='tool') {
      if(typeof m.content!=='string' || !pending.delete(m.tool_call_id)) throw invalid('tool 消息没有匹配的 tool_call_id');
      result.push({role:'user',content:`Tool result (${m.tool_call_id}):\n${m.content}`});continue;
    }
    if(pending.size) throw invalid('必须先返回所有待处理工具结果');
    if(m.content!=null && typeof m.content!=='string') throw invalid('当前仅支持文本消息');
    if(m.reasoning_content!==undefined&&(m.role!=='assistant'||typeof m.reasoning_content!=='string'))throw invalid('reasoning_content 仅适用于 assistant 文本');
    if(m.partial!==undefined&&(m.role!=='assistant'||typeof m.partial!=='boolean'||!m.partial||index!==messages.length-1))throw invalid('partial=true 仅适用于最后一条 assistant 消息');
    if(m.tools!==undefined&&(m.role!=='system'||!Array.isArray(m.tools)||!m.tools.length||(m.content!=null&&m.content!=='')))throw invalid('动态 tools 仅适用于空 content 的 system 消息');
    let content=m.content||'';
    if(m.tools!==undefined)content=`Dynamic tool declarations:\n${JSON.stringify(m.tools.map(tool=>tool.function))}`;
    if(m.tool_calls!==undefined) {
      if(m.role!=='assistant' || !Array.isArray(m.tool_calls)) throw invalid('tool_calls 仅适用于 assistant');
      for(const tc of m.tool_calls) {
        if(typeof tc.id!=='string' || pending.has(tc.id) || tc.type!=='function' || typeof tc.function?.name!=='string') throw invalid('无效的历史 tool_calls');
        let args;try{args=JSON.parse(tc.function.arguments);}catch{throw invalid('历史工具参数必须是 JSON');}
        pending.add(tc.id);content+=`\n<api_tool_call>${JSON.stringify({name:tc.function.name,arguments:args})}</api_tool_call>`;
      }
    }
    result.push({role:m.role==='developer'?'system':m.role,content,...(m.reasoning_content?{reasoning_content:m.reasoning_content}:{}),...(m.partial?{partial:true}:{}),...(m.tools?{dynamic:true}:{})});
  }
  if(pending.size) throw invalid('缺少工具调用结果');
  return result;
}
