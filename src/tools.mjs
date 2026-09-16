import { validateSchemaValue } from './structured.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const upstreamError = message => Object.assign(new Error(message), { status: 502 });
export function toolPolicy(tools, choice = 'auto', parallel = true) {
  if (tools === undefined) {
    if (choice !== 'auto' && choice !== 'none') throw invalid('tool_choice 需要 tools');
    return null;
  }
  if (!Array.isArray(tools) || tools.length > 64) throw invalid('tools 必须为数组，最多 64 个');
  const names = new Set();
  for (const tool of tools) {
    const f = tool?.function;
    if (tool?.type !== 'function' || typeof f?.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,255}$/.test(f.name) || names.has(f.name)) throw invalid('工具必须具有唯一且有效的 function.name');
    if (f.parameters !== undefined && (!f.parameters || typeof f.parameters !== 'object' || Array.isArray(f.parameters))) throw invalid('工具 parameters 必须是 JSON Schema 对象');
    if(f.strict!==undefined&&typeof f.strict!=='boolean')throw invalid('工具 strict 必须是布尔值');
    names.add(f.name);
  }
  let required = choice === 'required', allowed = names;
  if (choice && typeof choice === 'object') {
    if (choice.type !== 'function' || !names.has(choice.function?.name)) throw invalid('tool_choice 指定了未知工具');
    allowed = new Set([choice.function.name]); required = true;
  } else if (!['auto','none','required'].includes(choice)) throw invalid('无效 tool_choice');
  if (required && !names.size) throw invalid('required 至少需要一个工具');
  if (choice === 'none' || !names.size) return null;
  return { tools: tools.filter(t=>allowed.has(t.function.name)), allowed, required,parallel:parallel!==false,
    custom:new Set(tools.filter(t=>t.custom&&allowed.has(t.function.name)).map(t=>t.function.name)) };
}
export function toolPrompt(policy) {
  if (!policy) return '';
  return `You may request external tools by writing literal text blocks in this format:\n<api_tool_call>{"name":"tool_name","arguments":{}}</api_tool_call>\nUse only the declared tools and JSON objects for arguments. Do not claim to have executed tools. ${policy.required ? 'You must write at least one api_tool_call block.' : 'If no tool is needed, reply normally.'} ${policy.parallel?'You may request multiple independent tools.':'Request at most one tool.'}\nTool declarations:\n${JSON.stringify(policy.tools.map(t=>t.function))}`;
}
export function parseToolCalls(text, policy, makeId) {
  if (!policy) return { content: text, tool_calls: [] };
  const calls = [];
  const add=parsed=>{
    const value=parsed?.function?{name:parsed.function.name,arguments:parsed.function.arguments}:parsed;
    if (!policy.allowed.has(value?.name)) return false;
    let args=value.arguments;
    if(typeof args==='string'){try{args=JSON.parse(args);}catch{throw upstreamError('模型输出了无法解析的工具参数');}}
    if(!args||typeof args!=='object'||Array.isArray(args))throw upstreamError('模型输出了无效工具参数');
    if(policy.custom?.has(value.name)&&typeof args.input!=='string')throw upstreamError('模型输出了无效的 custom 工具文本参数');
    const declaration=policy.tools.find(tool=>tool.function.name===value.name);
    if(declaration?.function?.parameters&&declaration.function.strict!==false)try{validateSchemaValue(args,declaration.function.parameters);}catch{throw upstreamError(`模型输出的工具参数不符合 ${value.name} 的 JSON Schema`);}
    const suppliedId=typeof value.id==='string'&&value.id;
    let callId=suppliedId?value.id:makeId();
    if(calls.some(call=>call.id===callId)){
      if(suppliedId)throw upstreamError('模型输出了重复的工具调用 ID');
      const base=callId;let suffix=calls.length;
      do{callId=`${base}_${suffix++}`;}while(calls.some(call=>call.id===callId));
    }
    calls.push({id:callId,type:'function',function:{name:value.name,arguments:JSON.stringify(args)}});
    if(calls.length>64)throw upstreamError('模型工具调用数量超过限制');
    return true;
  };
  const content = text.replace(/<(api_tool_call|tool_call)>([\s\S]*?)<\/\1>/g, (_,tag,raw)=>{
    let parsed;
    try { parsed=JSON.parse(raw); } catch { throw upstreamError('模型输出了无法解析的工具调用'); }
    const values=Array.isArray(parsed)?parsed:[parsed];
    if(!values.length||values.some(value=>!add(value)))throw upstreamError('模型输出了不允许的工具');
    return '';
  }).trim();
  if (/<\/?(?:api_tool_call|tool_call)>/.test(content)) throw upstreamError('工具调用块未完整结束');
  let remaining=content;
  if(!calls.length){
    const fenced=[...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match=>match[1]);
    const candidates=[content,content.replace(/^```(?:json)?\s*|\s*```$/gi,''),...fenced];
    for(const candidate of candidates){
      let parsed;try{parsed=JSON.parse(candidate);}catch{continue;}
      const values=Array.isArray(parsed)?parsed:Array.isArray(parsed?.tool_calls)?parsed.tool_calls:[parsed];
      if(values.length&&values.every(value=>policy.allowed.has(value?.name||value?.function?.name))){for(const value of values)add(value);remaining='';break;}
    }
  }
  if (policy.required && !calls.length) throw upstreamError('模型未遵循 required 工具调用约束');
  return { content: remaining || null, tool_calls: calls };
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
