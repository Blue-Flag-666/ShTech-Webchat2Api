import { randomUUID } from 'node:crypto';
import { sealReasoning } from './reasoning-state.mjs';

const bad = (message,param) => Object.assign(new Error(message), { status: 400, ...(param ? {param} : {}) });
const badUpstream = message => Object.assign(new Error(message), { status: 502 });
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
function text(value, types = ['text','input_text','output_text']) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw bad('content 必须为文本或文本块数组');
  return value.map(part => {
    if (!types.includes(part?.type) || typeof part.text !== 'string') throw bad('当前接口不支持此内容块');
    return part.text;
  }).join('\n');
}
function keys(input, allowed) {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw bad(`暂不支持参数 ${key}`,key);
}
const agentToolTypes={local_shell:'action',shell:'action',apply_patch:'operation',computer:'action',program:'program',programmatic_tool_calling:'program'};
const agentCalls={local_shell_call:'local_shell',shell_call:'shell',apply_patch_call:'apply_patch',computer_call:'computer',program:'program'};
const agentOutputs={local_shell_call_output:'local_shell',shell_call_output:'shell',apply_patch_call_output:'apply_patch',computer_call_output:'computer',program_output:'program'};
const agentOutputType=type=>type==='programmatic_tool_calling'?'program':type;
const agentToolName=type=>`__openai_${agentOutputType(type)}`;
function agentTool(tool) {
  const field=agentToolTypes[tool.type];
  if(!field)return null;
  const type=agentOutputType(tool.type);
  const descriptions={
    local_shell:'Run a command in the local shell. Return the action to execute.',
    shell:'Run a shell command. Return the action to execute.',
    apply_patch:'Apply a patch to workspace files. Return the patch operation.',
    computer:'Interact with the computer. Return the computer action to perform.',
    program:'Run a program. Return its code and optional fingerprint.'
  };
  const actions={
    local_shell:{type:'object',properties:{type:{type:'string',const:'exec'},command:{type:'array',items:{type:'string'}},env:{type:'object',additionalProperties:{type:'string'}},timeout_ms:{type:'integer'},user:{type:'string'},working_directory:{type:'string'}},required:['command'],additionalProperties:true},
    shell:{type:'object',properties:{commands:{type:'array',items:{type:'string'}},max_output_length:{type:'integer'},timeout_ms:{type:'integer'}},required:['commands'],additionalProperties:true},
    apply_patch:{type:'object',properties:{type:{type:'string',enum:['create_file','delete_file','update_file']},path:{type:'string'},diff:{type:'string'}},required:['type','path'],additionalProperties:true},
    computer:{oneOf:[
      {type:'object',properties:{type:{const:'click'},x:{type:'integer'},y:{type:'integer'},button:{type:'string',enum:['left','right','wheel','back','forward']}},required:['type','x','y']},
      {type:'object',properties:{type:{const:'double_click'},x:{type:'integer'},y:{type:'integer'}},required:['type','x','y']},
      {type:'object',properties:{type:{const:'drag'},path:{type:'array',minItems:2,items:{type:'object',properties:{x:{type:'integer'},y:{type:'integer'}},required:['x','y']}}},required:['type','path']},
      {type:'object',properties:{type:{const:'keypress'},keys:{type:'array',minItems:1,items:{type:'string'}}},required:['type','keys']},
      {type:'object',properties:{type:{const:'move'},x:{type:'integer'},y:{type:'integer'}},required:['type','x','y']},
      {type:'object',properties:{type:{const:'screenshot'}},required:['type']},
      {type:'object',properties:{type:{const:'scroll'},x:{type:'integer'},y:{type:'integer'},scroll_x:{type:'integer'},scroll_y:{type:'integer'}},required:['type','x','y','scroll_x','scroll_y']},
      {type:'object',properties:{type:{const:'type'},text:{type:'string'}},required:['type','text']},
      {type:'object',properties:{type:{const:'wait'}},required:['type']}
    ]}
  };
  const parameters=type==='program'
    ? {type:'object',properties:{code:{type:'string'},fingerprint:{type:'string'}},required:['code'],additionalProperties:true}
    : {type:'object',properties:{[field]:actions[type]},required:[field],additionalProperties:true};
  return {type:'function',function:{name:agentToolName(tool.type),description:tool.description||descriptions[type],parameters,strict:false}};
}
function responseTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw bad('tools 必须为数组','tools');
  const result=[];
  const add=(tool,depth=0)=>{
    if(depth>4)throw bad('namespace 工具嵌套过深','tools');
    if (!tool || typeof tool!=='object' || Array.isArray(tool)) throw bad('无效 Responses 工具声明','tools');
    if(['web_search','web_search_preview','file_search'].includes(tool.type))return;
    if (tool.type==='namespace') {
      if (!Array.isArray(tool.tools)) throw bad('namespace.tools 必须为数组','tools');
      for (const child of tool.tools) add(child,depth+1);
      return;
    }
    const agent=agentTool(tool);
    if(agent){result.push(agent);return;}
    if (!['function','custom'].includes(tool.type)) throw bad('当前不支持此 Responses 工具类型','tools');
    if (tool.type==='function') {
      result.push({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters,strict:tool.strict}});
      return;
    }
    if (tool.format!==undefined && (!tool.format || typeof tool.format!=='object' || Array.isArray(tool.format))) throw bad('custom tool format 必须是对象','tools');
    const definition=tool.format?.definition;
    if (definition!==undefined && typeof definition!=='string') throw bad('custom tool format.definition 必须是字符串','tools');
    const description=[tool.description,definition&&`自由文本格式定义：\n${definition}`].filter(Boolean).join('\n\n');
    result.push({type:'function',custom:true,function:{name:tool.name,description,parameters:{type:'object',properties:{input:{type:'string',description:'该工具的完整自由文本输入'}},required:['input'],additionalProperties:false}}});
  };
  for (const tool of tools) add(tool);
  return result;
}
function searchAllowed(choice, types) {
  if(choice===undefined||choice==='auto'||choice==='required')return true;
  if(choice==='none'||!choice||typeof choice!=='object')return false;
  if(types.includes(choice.type))return true;
  return choice.type==='allowed_tools'&&Array.isArray(choice.tools)
    &&choice.tools.some(tool=>types.includes(tool?.type));
}
function responseToolChoice(choice, tools, sourceTools = []) {
  if (choice===undefined || typeof choice==='string') return {choice,tools};
  if (!choice || typeof choice!=='object' || Array.isArray(choice)) throw bad('无效 tool_choice','tool_choice');
  if (['function','custom'].includes(choice.type)) return {choice:{type:'function',function:{name:choice.name}},tools};
  if(agentToolTypes[choice.type])return{choice:{type:'function',function:{name:agentToolName(choice.type)}},tools};
  if(['web_search','web_search_preview','file_search'].includes(choice.type)){
    if(!sourceTools.some(tool=>tool?.type===choice.type))throw bad('tool_choice 指定了未知工具','tool_choice');
    return{choice:'auto',tools};
  }
  if (choice.type!=='allowed_tools' || !['auto','required'].includes(choice.mode) || !Array.isArray(choice.tools) || !choice.tools.length) throw bad('无效 tool_choice','tool_choice');
  const allowed=new Set(choice.tools.map(tool=>{
    if (!tool || typeof tool!=='object') throw bad('allowed_tools 包含无效工具','tool_choice');
    if(['web_search','web_search_preview','file_search'].includes(tool.type)){
      if(!sourceTools.some(source=>source?.type===tool.type))throw bad('allowed_tools 指定了未知工具','tool_choice');
      return null;
    }
    if(agentToolTypes[tool.type])return agentToolName(tool.type);
    if (!['function','custom'].includes(tool.type) || typeof tool.name!=='string') throw bad('allowed_tools 包含无效工具','tool_choice');
    return tool.name;
  }));
  const available=new Set((tools || []).map(tool=>tool.function?.name));
  if ([...allowed].some(name=>name!==null&&!available.has(name))) throw bad('allowed_tools 指定了未知工具','tool_choice');
  return {choice:choice.mode,tools:(tools || []).filter(tool=>allowed.has(tool.function.name))};
}
function agentArguments(item){
  if(item.type==='program')return{code:item.code,fingerprint:item.fingerprint};
  if(item.type==='apply_patch_call')return{operation:item.operation,...(item.caller?{caller:item.caller}:{})};
  if(['local_shell_call','shell_call','computer_call'].includes(item.type))return{action:item.action,...(item.caller?{caller:item.caller}:{}),...(item.environment?{environment:item.environment}:{}),...(item.pending_safety_checks?{pending_safety_checks:item.pending_safety_checks}:{})};
  return item.input??{};
}
function agentResult(item){
  const commandOutput=(chunk,index)=>{
    if(!chunk||typeof chunk!=='object'||Array.isArray(chunk))return JSON.stringify(chunk);
    const lines=[`Command ${index+1}:`];
    if(typeof chunk.stdout==='string'&&chunk.stdout)lines.push(`stdout:\n${chunk.stdout}`);
    if(typeof chunk.stderr==='string'&&chunk.stderr)lines.push(`stderr:\n${chunk.stderr}`);
    if(chunk.outcome?.type==='exit'&&Number.isInteger(chunk.outcome.exit_code))lines.push(`Exit code: ${chunk.outcome.exit_code}`);
    else if(Number.isInteger(chunk.exit_code??chunk.exitCode))lines.push(`Exit code: ${chunk.exit_code??chunk.exitCode}`);
    else if(chunk.outcome?.type==='timeout')lines.push('Command timed out.');
    else if(chunk.outcome!==undefined)lines.push(`Outcome: ${JSON.stringify(chunk.outcome)}`);
    if(chunk.outcome&&typeof chunk.outcome==='object'){
      const details=Object.fromEntries(Object.entries(chunk.outcome).filter(([key])=>!['type','exit_code'].includes(key)));
      if(Object.keys(details).length)lines.push(`Outcome details: ${JSON.stringify(details)}`);
    }
    const extra=Object.fromEntries(Object.entries(chunk).filter(([key])=>!['stdout','stderr','outcome','exit_code','exitCode'].includes(key)));
    if(Object.keys(extra).length)lines.push(`Additional output: ${JSON.stringify(extra)}`);
    if(lines.length===1)lines.push(JSON.stringify(chunk));
    return lines.join('\n');
  };
  let localShell=item.output;
  if(item.type==='local_shell_call_output'&&typeof localShell==='string'&&localShell.trimStart().startsWith('{')){
    try{const parsed=JSON.parse(localShell);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&['stdout','stderr','outcome','exit_code','exitCode'].some(key=>key in parsed))localShell=parsed;}catch{}
  }
  const structuredShell=item.type==='shell_call_output'&&Array.isArray(item.output)
    ? item.output.map(commandOutput).join('\n\n')
    :item.type==='local_shell_call_output'&&localShell&&typeof localShell==='object'&&!Array.isArray(localShell)
      ? commandOutput(localShell,0):null;
  const output=structuredShell??(item.type==='program_output'?item.result??''
    :item.type==='computer_call_output'&&item.output?.type==='computer_screenshot'?`Computer screenshot captured. ${item.output.image_marker||''}`.trim()
    :item.output??'');
  const render=value=>{
    if(typeof value==='string')return value;
    if(Array.isArray(value))return value.map(part=>{
      if(['text','input_text','output_text'].includes(part?.type)&&typeof part.text==='string')return part.text;
      return JSON.stringify(part);
    }).join('\n');
    return JSON.stringify(value);
  };
  const result=render(output);
  if(item.status==='failed'||item.status==='incomplete')return `Tool ${item.status}: ${result}`;
  return result;
}
function validComputerAction(value){
  const point=point=>Number.isInteger(point?.x)&&Number.isInteger(point?.y);
  if(['click','double_click','move'].includes(value.type))return point(value)&&(
    value.type!=='click'||value.button===undefined||['left','right','wheel','back','forward'].includes(value.button));
  if(value.type==='drag')return Array.isArray(value.path)&&value.path.length>=2&&value.path.every(point);
  if(value.type==='keypress')return Array.isArray(value.keys)&&value.keys.length>0&&value.keys.every(key=>typeof key==='string'&&key.length>0);
  if(value.type==='scroll')return point(value)&&Number.isInteger(value.scroll_x)&&Number.isInteger(value.scroll_y);
  if(value.type==='type')return typeof value.text==='string';
  return['screenshot','wait'].includes(value.type);
}
function agentCallItem(type,call,raw,declaration){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw badUpstream(`模型输出了无效的 ${type} 工具参数`);
  const common={id:id('item'),type:type==='program'?'program':`${type}_call`,call_id:call.id};
  if(type==='program'){
    if(typeof raw.code!=='string'||!raw.code)throw badUpstream('模型输出了无效的 program.code');
    if(raw.fingerprint!==undefined&&typeof raw.fingerprint!=='string')throw badUpstream('模型输出了无效的 program.fingerprint');
    return{...common,code:raw.code,fingerprint:raw.fingerprint||`fp_${randomUUID().replaceAll('-','')}`};
  }
  const field=agentToolTypes[type],value=raw[field]??raw;
  if(!value||typeof value!=='object'||Array.isArray(value))throw badUpstream(`模型输出了无效的 ${type}.${field}`);
  if(type==='local_shell'){
    if(!Array.isArray(value.command)||!value.command.length||value.command.some(x=>typeof x!=='string'||!x)||value.type!==undefined&&value.type!=='exec'||value.env!==undefined&&(!value.env||typeof value.env!=='object'||Array.isArray(value.env)||Object.values(value.env).some(x=>typeof x!=='string'))||value.timeout_ms!==undefined&&(!Number.isInteger(value.timeout_ms)||value.timeout_ms<0)||value.user!==undefined&&typeof value.user!=='string'||value.working_directory!==undefined&&typeof value.working_directory!=='string')throw badUpstream('模型输出了无效的 local_shell.action');
    return{...common,status:'completed',action:{...value,type:'exec',env:value.env??{}}};
  }
  if(type==='shell'){
    if(!Array.isArray(value.commands)||!value.commands.length||value.commands.some(x=>typeof x!=='string'||!x)||value.max_output_length!==undefined&&(!Number.isInteger(value.max_output_length)||value.max_output_length<0)||value.timeout_ms!==undefined&&(!Number.isInteger(value.timeout_ms)||value.timeout_ms<0))throw badUpstream('模型输出了无效的 shell.action');
    return{...common,status:'completed',action:value,...(declaration.environment?{environment:declaration.environment}:{})};
  }
  if(type==='apply_patch'){
    if(!['create_file','delete_file','update_file'].includes(value.type)||typeof value.path!=='string'||!value.path||value.type!=='delete_file'&&typeof value.diff!=='string')throw badUpstream('模型输出了无效的 apply_patch.operation');
    return{...common,status:'completed',operation:value};
  }
  if(typeof value.type!=='string'||!validComputerAction(value))throw badUpstream('模型输出了无效的 computer.action');
  return{...common,status:'completed',action:value.type==='click'&&value.button===undefined?{...value,button:'left'}:value,pending_safety_checks:[]};
}
export function normalizeRequest(path, input) {
  if(path==='/v1/completions'){
    keys(input,['model','prompt','suffix','max_tokens','temperature','top_p','frequency_penalty','presence_penalty','stop','seed','stream','stream_options','n','best_of','echo','logprobs','user']);
    const prompts=Array.isArray(input.prompt)?input.prompt:[input.prompt];
    if(prompts.length!==1||typeof prompts[0]!=='string')throw bad('prompt 目前只支持单个字符串','prompt');
    if(input.suffix!==undefined&&typeof input.suffix!=='string')throw bad('suffix 必须是字符串');
    if(input.n!==undefined&&input.n!==1)throw bad('n 仅支持 1');
    if(input.best_of!==undefined&&input.best_of!==1)throw bad('best_of 仅支持 1');
    if(input.echo!==undefined&&input.echo!==false)throw bad('echo 仅支持 false');
    if(input.logprobs!==undefined&&input.logprobs!==null&&input.logprobs!==0)throw bad('暂不支持 logprobs');
    const instruction=input.suffix===undefined
      ? 'Continue the supplied text or code. Return only the continuation without Markdown fences or commentary.'
      : 'Fill the gap between PREFIX and SUFFIX. Return only the missing text or code without Markdown fences or commentary.';
    const content=input.suffix===undefined?prompts[0]:`PREFIX:\n${prompts[0]}\n\nSUFFIX:\n${input.suffix}`;
    return Object.fromEntries(Object.entries({model:input.model,stream:input.stream,stream_options:input.stream_options,max_tokens:input.max_tokens,
      temperature:input.temperature,top_p:input.top_p,frequency_penalty:input.frequency_penalty,presence_penalty:input.presence_penalty,
      stop:input.stop,seed:input.seed,user:input.user,messages:[{role:'system',content:instruction},{role:'user',content}]}).filter(([,value])=>value!==undefined));
  }
  if (path === '/v1/chat/completions') {
    const out={...input};
    if(out.tools!==undefined&&!Array.isArray(out.tools))throw bad('tools 必须为数组','tools');
    if(out.thinking!==undefined){
      if(!out.thinking||typeof out.thinking!=='object'||Array.isArray(out.thinking))throw bad('thinking 必须是对象','thinking');
      const type=out.thinking.type??'enabled';
      if(!['enabled','disabled'].includes(type))throw bad('thinking.type 无效','thinking.type');
      if(type==='enabled'&&out.thinking.keep!==undefined&&out.thinking.keep!=='all')throw bad('thinking.keep 仅支持 all');
      if(type==='enabled'&&out.thinking.effort!==undefined&&!['low','high','max'].includes(out.thinking.effort))throw bad('thinking.effort 无效');
      out.thinking={...out.thinking,type};
    }
    if(out.web_search_options!==undefined){
      if(!out.web_search_options||typeof out.web_search_options!=='object'||Array.isArray(out.web_search_options))throw bad('web_search_options 必须是对象','web_search_options');
      out.net_go=true;delete out.web_search_options;
    }
    if(out.functions!==undefined){
      if(out.tools!==undefined)throw bad('functions 与 tools 不能同时使用');
      if(!Array.isArray(out.functions))throw bad('functions 必须为数组');
      out.tools=out.functions.map(fn=>({type:'function',function:fn}));delete out.functions;
    }
    if(out.function_call!==undefined){
      if(out.tool_choice!==undefined)throw bad('function_call 与 tool_choice 不能同时使用');
      out.tool_choice=typeof out.function_call==='object'?{type:'function',function:{name:out.function_call.name}}:out.function_call==='none'?'none':'auto';delete out.function_call;
    }
    if(Array.isArray(out.messages)){
      const merged=[...(out.tools||[])],names=new Set();
      for(const tool of merged){
        const name=tool?.function?.name;
        if(typeof name==='string'&&names.has(name))throw bad(`工具 ${name} 重复定义`);
        if(typeof name==='string')names.add(name);
      }
      for(const message of out.messages)if(message?.tools!==undefined){
        if(message.role!=='system'||(message.content!=null&&message.content!=='')||!Array.isArray(message.tools)||!message.tools.length)throw bad('动态 tools 仅适用于空 content 的 system 消息');
        for(const tool of message.tools){
          if(tool?.type!=='function'||typeof tool.function?.name!=='string')throw bad('动态工具必须是 function');
          if(names.has(tool.function.name))throw bad(`工具 ${tool.function.name} 重复定义`);
          merged.push(tool);names.add(tool.function.name);
        }
      }
      if(merged.length)out.tools=merged;
    }
    if(/kimi[-_ ]?k3/i.test(out.model||'')){
      const thinking=out.thinking?.type==='enabled'||(out.thinking?.type!=='disabled'&&out.reasoning_effort!=='none');
      if(out.temperature!==undefined&&(thinking?(out.temperature<0||out.temperature>1):out.temperature!==0.6))throw bad(thinking?'Kimi K3 思考模式 temperature 必须为 0–1':'Kimi K3 非思考模式 temperature 必须为 0.6');
      if(out.top_p!==undefined&&out.top_p!==0.95)throw bad('Kimi K3 top_p 必须为 0.95');
      if(out.presence_penalty!==undefined&&out.presence_penalty!==0)throw bad('Kimi K3 presence_penalty 必须为 0');
      if(out.frequency_penalty!==undefined&&out.frequency_penalty!==0)throw bad('Kimi K3 frequency_penalty 必须为 0');
      if(out.n!==undefined&&out.n!==1)throw bad('Kimi K3 n 必须为 1');
    }
    return out;
  }
  const out = { model: input.model, stream: input.stream, messages: [] };
  if (path === '/v1/responses') {
    keys(input, ['model','input','instructions','stream','stream_options','max_output_tokens','max_tool_calls','tools','tool_choice','store','previous_response_id','metadata','reasoning','text','parallel_tool_calls','include','temperature','top_p','service_tier','safety_identifier','prompt_cache_key','user','background','conversation','truncation','context_management']);
    if (input.store !== undefined && typeof input.store !== 'boolean') throw bad('store 必须为布尔值','store');
    if(input.stream!==undefined&&typeof input.stream!=='boolean')throw bad('stream 必须为布尔值','stream');
    if(input.stream_options!==undefined&&(!input.stream||!input.stream_options||typeof input.stream_options!=='object'||Array.isArray(input.stream_options)||Object.keys(input.stream_options).some(key=>key!=='include_obfuscation')||typeof input.stream_options.include_obfuscation!=='boolean'))throw bad('stream_options 仅支持流式 include_obfuscation 布尔值','stream_options');
    if(input.max_output_tokens!==undefined&&(!Number.isInteger(input.max_output_tokens)||input.max_output_tokens<1))throw bad('max_output_tokens 必须为正整数','max_output_tokens');
    if(input.max_tool_calls!==undefined&&(!Number.isInteger(input.max_tool_calls)||input.max_tool_calls<1||input.max_tool_calls>64))throw bad('max_tool_calls 必须是 1–64 的整数','max_tool_calls');
    if(input.background!==undefined&&typeof input.background!=='boolean')throw bad('background 必须为布尔值','background');
    if(input.truncation!==undefined&&!['auto','disabled'].includes(input.truncation))throw bad('truncation 必须为 auto 或 disabled','truncation');
    if(input.context_management!==undefined&&(!Array.isArray(input.context_management)||input.context_management.some(item=>!item||item.type!=='compaction'||item.compact_threshold!==undefined&&(!Number.isInteger(item.compact_threshold)||item.compact_threshold<1))))throw bad('context_management 仅支持 compaction 和正整数 compact_threshold','context_management');
    if (input.previous_response_id !== undefined && (typeof input.previous_response_id!=='string'||!input.previous_response_id)) throw bad('previous_response_id 必须是非空字符串','previous_response_id');
    if(input.metadata!==undefined&&(!input.metadata||typeof input.metadata!=='object'||Array.isArray(input.metadata)||Object.keys(input.metadata).length>16||Object.entries(input.metadata).some(([key,value])=>!key||key.length>64||typeof value!=='string'||value.length>512)))throw bad('metadata 必须是最多 16 个短字符串键值','metadata');
    for(const key of ['safety_identifier','prompt_cache_key'])if(input[key]!==undefined&&(typeof input[key]!=='string'||!input[key]||input[key].length>64))throw bad(`${key} 必须是 1–64 字符字符串`,key);
    if(input.service_tier!==undefined&&!['auto','default','flex','priority'].includes(input.service_tier))throw bad('service_tier 无效','service_tier');
    if (input.instructions != null) out.messages.push({role:'system',content:text(input.instructions)});
    const items = typeof input.input === 'string' ? [{role:'user',content:input.input}] : input.input;
    if (!Array.isArray(items)) throw bad('input 必须为字符串或输入项数组','input');
    for (const item of items) {
      if (item?.type === 'reasoning') {
        const source=Array.isArray(item.content)&&item.content.length?item.content:item.summary;
        if (!Array.isArray(source)) throw bad('reasoning.content 或 reasoning.summary 必须为数组');
        const summary=text(source,['reasoning_text','summary_text']);
        if (summary) out.messages.push({role:'assistant',content:`[Reasoning summary]\n${summary}`});
      } else if(['web_search_call','file_search_call'].includes(item?.type)) {
        continue;
      } else if(item?.type==='item_reference') {
        continue;
      } else if(item?.type==='additional_tools') {
        if(item.role!=='developer'||!Array.isArray(item.tools)||!item.tools.length)throw bad('additional_tools 必须包含 developer tools');
        const added=responseTools(item.tools)||[];
        out.tools=[...(out.tools||[]),...added];
      } else if (item?.type === 'function_call') {
        const call = {id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}};
        const previous = out.messages.at(-1);
        if (previous?.role === 'assistant' && previous.tool_calls) previous.tool_calls.push(call);
        else out.messages.push({role:'assistant',content:null,tool_calls:[call]});
      } else if (item?.type === 'custom_tool_call') {
        if (typeof item.input!=='string') throw bad('custom_tool_call.input 必须是字符串');
        const call={id:item.call_id,type:'function',function:{name:item.name,arguments:JSON.stringify({input:item.input})}};
        const previous=out.messages.at(-1);
        if (previous?.role==='assistant'&&previous.tool_calls) previous.tool_calls.push(call);
        else out.messages.push({role:'assistant',content:null,tool_calls:[call]});
      } else if(agentCalls[item?.type]) {
        if(typeof item.call_id!=='string'||!item.call_id)throw bad(`${item.type}.call_id 无效`);
        const call={id:item.call_id,type:'function',function:{name:`__openai_${agentCalls[item.type]}`,arguments:JSON.stringify(agentArguments(item))}};
        const previous=out.messages.at(-1);
        if(previous?.role==='assistant'&&previous.tool_calls)previous.tool_calls.push(call);else out.messages.push({role:'assistant',content:null,tool_calls:[call]});
      } else if(agentOutputs[item?.type]) {
        const callId=item.type==='local_shell_call_output'?(item.call_id??item.id):item.call_id;
        if(typeof callId!=='string'||!callId)throw bad(`${item.type} 缺少工具调用 ID`);
        const result=agentResult(item);out.messages.push({role:'tool',tool_call_id:callId,content:typeof result==='string'?result:JSON.stringify(result)});
      } else if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
        const result=text(item.output);
        out.messages.push({role:'tool',tool_call_id:item.call_id,content:['failed','incomplete'].includes(item.status)?`Tool ${item.status}: ${result}`:result});
      }
      else if(item?.type==='configuration_update'){
        const effort=item.reasoning?.effort;if(!['low','medium','high','xhigh','max'].includes(effort))throw bad('configuration_update.reasoning.effort 无效');
        out.messages.push({role:'system',content:`Reasoning effort is now ${effort}.`});
      } else if(item?.type==='compaction_trigger')continue;
      else if (item && (!item.type || item.type === 'message')) out.messages.push({role:item.role,content:text(item.content)});
      else throw bad('不支持的 Responses 输入项');
    }
    const normalizedTools=[...(out.tools||[]),...(responseTools(input.tools)||[])];
    const webSearch=Array.isArray(input.tools)&&input.tools.some(tool=>['web_search','web_search_preview'].includes(tool?.type));
    const selected=responseToolChoice(input.tool_choice,normalizedTools,input.tools);
    out.tools=selected.tools;out.tool_choice=selected.choice;
    out.net_go=webSearch&&searchAllowed(input.tool_choice,['web_search','web_search_preview']);
    const fileSearch=Array.isArray(input.tools)&&input.tools.some(tool=>tool?.type==='file_search');
    const fileSearchEnabled=fileSearch&&searchAllowed(input.tool_choice,['file_search']);
    if(out.tool_choice==='required'&&(out.net_go||fileSearchEnabled))out.tool_choice='auto';
    if (input.parallel_tool_calls!==undefined && typeof input.parallel_tool_calls!=='boolean') throw bad('parallel_tool_calls 必须为布尔值','parallel_tool_calls');
    if (input.include!==undefined && (!Array.isArray(input.include) || input.include.some(value=>!['reasoning.encrypted_content','web_search_call.results','web_search_call.action.sources','file_search_call.results'].includes(value)))) throw bad('include 包含不支持的字段','include');
    out.parallel_tool_calls=input.parallel_tool_calls;
    out.max_tool_calls=input.max_tool_calls;
    out.max_tokens = input.max_output_tokens;
    out.temperature=input.temperature;out.top_p=input.top_p;out.service_tier=input.service_tier;out.user=input.user;
    if(input.reasoning!==undefined){
      if(!input.reasoning||typeof input.reasoning!=='object'||Array.isArray(input.reasoning))throw bad('reasoning 必须是对象','reasoning');
      if(Object.keys(input.reasoning).some(key=>!['effort','summary'].includes(key)))throw bad('reasoning 包含不支持的字段','reasoning');
      if(input.reasoning.effort!==undefined&&!['none','minimal','low','medium','high','xhigh','max'].includes(input.reasoning.effort))throw bad('reasoning.effort 无效','reasoning.effort');
      if(input.reasoning.summary!==undefined&&!['auto','concise','detailed'].includes(input.reasoning.summary))throw bad('reasoning.summary 无效','reasoning.summary');
      out.reasoning_effort=input.reasoning.effort;
    }
    if(input.text!==undefined){
      if(!input.text||typeof input.text!=='object'||Array.isArray(input.text)||Object.keys(input.text).some(key=>!['format','verbosity'].includes(key)))throw bad('text 配置无效','text');
      if(input.text.verbosity!==undefined&&!['low','medium','high'].includes(input.text.verbosity))throw bad('text.verbosity 无效','text.verbosity');
      out.verbosity=input.text.verbosity;
    }
  } else {
    keys(input, ['model','messages','system','stream','max_tokens','tools','tool_choice','metadata','thinking','output_config','temperature','top_p','top_k','stop_sequences']);
    if (!Number.isInteger(input.max_tokens) || input.max_tokens < 1) throw bad('max_tokens 必须为正整数','max_tokens');
    out.max_tokens = input.max_tokens;
    if (input.system != null) out.messages.push({role:'system',content:text(input.system,['text'])});
    out.temperature=input.temperature;out.top_p=input.top_p;out.top_k=input.top_k;out.stop=input.stop_sequences;
    if(input.thinking!==undefined){
      if(!input.thinking||typeof input.thinking!=='object'||!['enabled','disabled','adaptive'].includes(input.thinking.type))throw bad('thinking 配置无效','thinking');
      if(input.thinking.budget_tokens!==undefined&&(!Number.isInteger(input.thinking.budget_tokens)||input.thinking.budget_tokens<1))throw bad('thinking.budget_tokens 必须为正整数','thinking.budget_tokens');
      if(input.thinking.type!=='disabled')out.reasoning_effort=input.thinking.type==='adaptive'?'medium':'high';
    }
    if(input.output_config?.effort!==undefined){
      if(!['low','high','max'].includes(input.output_config.effort))throw bad('output_config.effort 无效','output_config.effort');
      out.reasoning_effort=input.output_config.effort;
    }
    if(input.thinking?.type==='disabled')out.reasoning_effort='none';
    if (!Array.isArray(input.messages)) throw bad('messages 必须为数组','messages');
    for (const [messageIndex,message] of input.messages.entries()) {
      if (!['user','assistant'].includes(message?.role)) throw bad('Messages 仅接受 user/assistant 历史',`messages[${messageIndex}].role`);
      if (typeof message.content === 'string') { out.messages.push({...message,...(message.role==='assistant'&&messageIndex===input.messages.length-1?{partial:true}:{})}); continue; }
      if (!Array.isArray(message.content)) throw bad('content 必须为字符串或数组',`messages[${messageIndex}].content`);
      const m = {role:message.role,content:''}, results = [];
      for (const block of message.content) {
        if (block?.type === 'text') m.content += `${m.content?'\n':''}${text([block],['text'])}`;
        else if (block?.type === 'thinking' && message.role === 'assistant' && typeof block.thinking === 'string') m.content += `${m.content?'\n':''}[Reasoning summary]\n${block.thinking}`;
        else if (block?.type === 'tool_use' && message.role === 'assistant') {
          if(typeof block.id!=='string'||!block.id||typeof block.name!=='string'||!block.name||!block.input||typeof block.input!=='object'||Array.isArray(block.input))throw bad('tool_use 需要 id、name 和对象 input');
          (m.tool_calls ||= []).push({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.input)}});
        } else if (block?.type === 'tool_result' && message.role === 'user') {
          if(typeof block.tool_use_id!=='string'||!block.tool_use_id)throw bad('tool_result 缺少 tool_use_id');
          if(block.is_error!==undefined&&typeof block.is_error!=='boolean')throw bad('tool_result.is_error 必须是布尔值');
          results.push({role:'tool',tool_call_id:block.tool_use_id,content:(block.is_error ? 'Tool error: ' : '') + text(block.content,['text'])});
        } else throw bad('不支持的 Messages 内容块');
      }
      out.messages.push(...results);
      if (m.content || m.tool_calls || !results.length) out.messages.push({...m,...(message.role==='assistant'&&messageIndex===input.messages.length-1?{partial:true}:{})});
    }
    if (input.tools !== undefined) {
      if (!Array.isArray(input.tools)) throw bad('tools 必须为数组','tools');
      out.net_go=input.tools.some(t=>typeof t?.type==='string'&&t.type.startsWith('web_search_'))
        &&!['none','tool'].includes(input.tool_choice?.type);
      out.tools = input.tools.filter(t=>!(typeof t?.type==='string'&&t.type.startsWith('web_search_'))).map(t=>{
        if (!t || typeof t !== 'object') throw bad('无效工具声明');
        return {type:'function',function:{name:t.name,description:t.description,parameters:t.input_schema}};
      });
    }
    const choice = input.tool_choice;
    if (choice !== undefined) {
      if (!choice || !['auto','any','none','tool'].includes(choice.type)) throw bad('无效 tool_choice','tool_choice');
      if(choice.disable_parallel_tool_use!==undefined&&typeof choice.disable_parallel_tool_use!=='boolean')throw bad('disable_parallel_tool_use 必须是布尔值','tool_choice.disable_parallel_tool_use');
      out.tool_choice = choice.type === 'tool' ? {type:'function',function:{name:choice.name}} : choice.type === 'any' ? 'required' : choice.type;
      out.parallel_tool_calls=choice.disable_parallel_tool_use!==true;
    }
    if(out.net_go&&out.tool_choice==='required')out.tool_choice='auto';
  }
  return Object.fromEntries(Object.entries(out).filter(([,v])=>v !== undefined));
}

export function tokenUsage(completion, input) {
  // Lightweight estimate only when the upstream does not provide token counts.
  const estimate = value => Math.ceil(Buffer.byteLength(value || '') / 3);
  const prompt = completion.usage?.prompt_tokens ?? estimate(JSON.stringify(input.messages));
  const output = completion.usage?.completion_tokens ?? estimate(JSON.stringify(completion.choices[0].message));
  return {input_tokens:prompt,input_tokens_details:completion.usage?.prompt_tokens_details||completion.usage?.input_tokens_details||{cached_tokens:0},
    output_tokens:output,output_tokens_details:completion.usage?.completion_tokens_details||completion.usage?.output_tokens_details||{reasoning_tokens:estimate(completion.choices[0].message.reasoning_content)},total_tokens:prompt+output};
}
export class ProtocolOutput {
  constructor(path, input, emit, original = {}, context = {}) {
    this.path=path; this.input=input; this.emit=emit; this.sequence=0;
    this.id=id(path === '/v1/responses' ? 'resp' : 'msg');
    this.messageId=id('msg'); this.reasoningId=id('rs'); this.created=Math.floor(Date.now()/1000);
    this.reasoningEncryptedContent=null;
    this.reasoningSecret=context.reasoningSecret;
    this.text=''; this.reasoning=''; this.started=false; this.textIndex=null; this.reasoningIndex=null; this.nextIndex=0;
    this.fileSearchItem=context.fileSearchItem||null;this.fileSearchIndex=null;
    this.callIndexes=new Map();this.callItems=new Map();
    this.metadata=original.metadata || {};this.original=original;this.customTools=new Set();this.agentTools=new Map();
    const collect=tools=>{for(const tool of tools || [])if(tool?.type==='namespace')collect(tool.tools);else if(tool?.type==='custom'&&typeof tool.name==='string')this.customTools.add(tool.name);else if(agentToolTypes[tool?.type])this.agentTools.set(agentToolName(tool.type),tool);};
    collect(original.tools);
    if(Array.isArray(original.input))for(const item of original.input)if(item?.type==='additional_tools')collect(item.tools);
  }
  async event(type, data={}) {
    const value={type,...data,...(this.path === '/v1/responses' ? {sequence_number:this.sequence++,...(this.original.stream_options?.include_obfuscation===true?{obfuscation:randomUUID().replaceAll('-','')}: {})} : {})};
    await this.emit(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  response(output=[],status='in_progress',usage=null) {
    const outputText=output.filter(item=>item?.type==='message').flatMap(item=>item.content||[]).filter(part=>part?.type==='output_text').map(part=>part.text||'').join('');
    return {id:this.id,object:'response',created_at:this.created,status,error:null,
      completed_at:['completed','incomplete'].includes(status)?Math.floor(Date.now()/1000):null,
      incomplete_details:status === 'incomplete' ? {reason:'max_output_tokens'} : null,
      model:this.input.model || 'qwen-instruct',output,usage,store:this.original.store!==false,parallel_tool_calls:this.original.parallel_tool_calls ?? true,
      tool_choice:this.original.tool_choice ?? 'auto',tools:this.original.tools || [],metadata:this.metadata,
      reasoning:{effort:this.original.reasoning?.effort??null,summary:this.original.reasoning?.summary??(this.reasoning?'auto':null)},output_text:outputText,
      instructions:this.original.instructions??null,max_output_tokens:this.original.max_output_tokens??null,max_tool_calls:this.original.max_tool_calls??null,
      text:this.original.text??null,temperature:this.original.temperature??null,top_p:this.original.top_p??null,
      previous_response_id:this.original.previous_response_id??null,prompt_cache_key:this.original.prompt_cache_key??null,safety_identifier:this.original.safety_identifier??null,
      background:this.original.background===true,conversation:this.original.conversation?{id:typeof this.original.conversation==='string'?this.original.conversation:this.original.conversation.id}:null,service_tier:this.original.service_tier??null,truncation:this.original.truncation??'disabled'};
  }
  message(content=[],stop_reason=null,usage={input_tokens:0,output_tokens:0}) {
    return {id:this.id,type:'message',role:'assistant',model:this.input.model || 'qwen-instruct',content,stop_reason,stop_sequence:null,usage:{cache_creation_input_tokens:0,cache_read_input_tokens:0,...usage}};
  }
  part(value) { return {type:'output_text',text:value,annotations:[],logprobs:[]}; }
  item(value,status='completed') { return {id:this.messageId,type:'message',status,role:'assistant',content:[this.part(value)]}; }
  reasoningItem(status='completed') { return {id:this.reasoningId,type:'reasoning',status,summary:[{type:'summary_text',text:this.reasoning}],content:[],...(this.reasoningEncryptedContent?{encrypted_content:this.reasoningEncryptedContent}:{})}; }
  async start() {
    if (this.started) return;
    this.started=true;
    if (this.path === '/v1/responses') {
      await this.event('response.created',{response:this.response()});
      await this.event('response.in_progress',{response:this.response()});
      if(this.fileSearchItem){
        this.fileSearchIndex=this.nextIndex++;
        const location={item_id:this.fileSearchItem.id,output_index:this.fileSearchIndex};
        const pendingItem={...this.fileSearchItem};delete pendingItem.results;
        await this.event('response.output_item.added',{output_index:this.fileSearchIndex,item:{...pendingItem,status:'in_progress'}});
        await this.event('response.file_search_call.in_progress',location);
        await this.event('response.file_search_call.searching',location);
        await this.event('response.file_search_call.completed',location);
        await this.event('response.output_item.done',{output_index:this.fileSearchIndex,item:this.fileSearchItem});
      }
    } else await this.event('message_start',{message:this.message([],null,{input_tokens:tokenUsage({choices:[{message:{}}]},this.input).input_tokens,output_tokens:0})});
  }
  async delta(value) {
    if (!value) return;
    await this.start();
    const response=this.path === '/v1/responses';
    if (this.textIndex===null) {
      this.textIndex=this.nextIndex++;
      if (response) {
        await this.event('response.output_item.added',{output_index:this.textIndex,item:{...this.item('','in_progress'),content:[]}});
        await this.event('response.content_part.added',{item_id:this.messageId,output_index:this.textIndex,content_index:0,part:this.part('')});
      } else await this.event('content_block_start',{index:this.textIndex,content_block:{type:'text',text:''}});
    }
    this.text+=value;
    if (response) await this.event('response.output_text.delta',{item_id:this.messageId,output_index:this.textIndex,content_index:0,delta:value,logprobs:[]});
    else await this.event('content_block_delta',{index:this.textIndex,delta:{type:'text_delta',text:value}});
  }
  async reasoningDelta(value) {
    if (!value) return;
    await this.start();
    const response=this.path === '/v1/responses';
    if (this.reasoningIndex===null) {
      this.reasoningIndex=this.nextIndex++;
      if(response) {
        await this.event('response.output_item.added',{output_index:this.reasoningIndex,item:{id:this.reasoningId,type:'reasoning',status:'in_progress',summary:[]}});
        await this.event('response.reasoning_summary_part.added',{item_id:this.reasoningId,output_index:this.reasoningIndex,summary_index:0,part:{type:'summary_text',text:''}});
      } else await this.event('content_block_start',{index:this.reasoningIndex,content_block:{type:'thinking',thinking:'',signature:''}});
    }
    this.reasoning+=value;
    if(response) await this.event('response.reasoning_summary_text.delta',{item_id:this.reasoningId,output_index:this.reasoningIndex,summary_index:0,delta:value});
    else await this.event('content_block_delta',{index:this.reasoningIndex,delta:{type:'thinking_delta',thinking:value}});
  }
  callItem(call) {
    if(this.path==='/v1/responses'){
      const declaration=this.agentTools.get(call.function.name);
      if(declaration){
        const agentType=agentOutputType(declaration.type);
        let parsed;try{parsed=JSON.parse(call.function.arguments||'{}');}catch{throw badUpstream(`模型输出了无效的 ${agentType} 工具 JSON`);}
        return agentCallItem(agentType,call,parsed,declaration);
      }
      return this.customTools.has(call.function.name)
        ? {id:id('ctc'),type:'custom_tool_call',status:'completed',call_id:call.id,name:call.function.name,input:(()=>{const value=JSON.parse(call.function.arguments).input;return typeof value==='string'?value:JSON.stringify(value);})()}
        : {id:id('fc'),type:'function_call',status:'completed',call_id:call.id,name:call.function.name,arguments:call.function.arguments};
    }
    return {type:'tool_use',id:call.id,name:call.function.name,input:JSON.parse(call.function.arguments)};
  }
  async agentCallEvents(item,index) {
    await this.event('response.output_item.added',{output_index:index,item:item.type==='program'?item:{...item,status:'in_progress'}});
    if(item.type==='shell_call')for(const [command_index,command] of item.action.commands.entries()){
      await this.event('response.shell_call_command.added',{output_index:index,command_index,command:''});
      await this.event('response.shell_call_command.delta',{output_index:index,command_index,delta:command});
      await this.event('response.shell_call_command.done',{output_index:index,command_index,command});
    }
    await this.event('response.output_item.done',{output_index:index,item});
  }
  async toolCall(call) {
    if(this.callIndexes.has(call.id))return;
    await this.start();
    const response=this.path==='/v1/responses',item=this.callItem(call),index=this.nextIndex++;
    this.callIndexes.set(call.id,index);this.callItems.set(call.id,item);
    if(response) {
      if(agentCalls[item.type]){
        await this.agentCallEvents(item,index);
        return;
      }
      const custom=item.type==='custom_tool_call',field=custom?'input':'arguments';
      await this.event('response.output_item.added',{output_index:index,item:{...item,status:'in_progress',[field]:''}});
      await this.event(custom?'response.custom_tool_call_input.delta':'response.function_call_arguments.delta',{item_id:item.id,output_index:index,delta:item[field]});
      await this.event(custom?'response.custom_tool_call_input.done':'response.function_call_arguments.done',{item_id:item.id,output_index:index,[field]:item[field]});
      await this.event('response.output_item.done',{output_index:index,item});
    } else {
      await this.event('content_block_start',{index,content_block:{...item,input:{}}});
      await this.event('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(item.input)}});
      await this.event('content_block_stop',{index});
    }
  }
  async finish(completion, stream) {
    const message=completion.choices[0].message, calls=message.tool_calls || [];
    const usage=tokenUsage(completion,this.input), limited=completion.choices[0].finish_reason === 'length';
    const response=this.path === '/v1/responses';
    if(message.reasoning_content && !this.reasoning) this.reasoning=message.reasoning_content;
    if(response&&this.reasoning&&this.reasoningSecret)this.reasoningEncryptedContent=sealReasoning(this.reasoning,this.reasoningSecret);
    const reasoningItem=response ? this.reasoningItem(limited?'incomplete':'completed') : {type:'thinking',thinking:this.reasoning,signature:''};
    const messageItem=response ? this.item(message.content,limited?'incomplete':'completed') : {type:'text',text:message.content};
    const callItems=calls.map(call=>this.callItems.get(call.id)||this.callItem(call));
    let output=[];
    if(!stream) output=[...(this.fileSearchItem?[this.fileSearchItem]:[]),...(this.reasoning?[reasoningItem]:[]),...(message.content?[messageItem]:[]),...callItems];
    const result=response ? this.response(output,limited?'incomplete':'completed',usage)
      : this.message(output,calls.length?'tool_use':limited?'max_tokens':'end_turn',{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,output_tokens_details:{thinking_tokens:usage.output_tokens_details?.reasoning_tokens||0}});
    if (!stream) return result;
    await this.start();
    if (this.reasoningIndex===null && this.reasoning) { const value=this.reasoning;this.reasoning='';await this.reasoningDelta(value); }
    if (this.textIndex===null && message.content) await this.delta(message.content);
    const indexed=this.fileSearchItem?[[this.fileSearchIndex,this.fileSearchItem]]:[];
    if (this.reasoningIndex!==null) {
      indexed.push([this.reasoningIndex,reasoningItem]);
      if(response) {
        const loc={item_id:this.reasoningId,output_index:this.reasoningIndex,summary_index:0};
        await this.event('response.reasoning_summary_text.done',{...loc,text:this.reasoning});
        await this.event('response.reasoning_summary_part.done',{...loc,part:{type:'summary_text',text:this.reasoning}});
        await this.event('response.output_item.done',{output_index:this.reasoningIndex,item:reasoningItem});
      } else await this.event('content_block_stop',{index:this.reasoningIndex});
    }
    if (this.textIndex!==null) {
      indexed.push([this.textIndex,messageItem]);
      if (response) {
        const loc={item_id:this.messageId,output_index:this.textIndex,content_index:0};
        await this.event('response.output_text.done',{...loc,text:this.text,logprobs:[]});
        await this.event('response.content_part.done',{...loc,part:this.part(this.text)});
        await this.event('response.output_item.done',{output_index:this.textIndex,item:messageItem});
      } else await this.event('content_block_stop',{index:this.textIndex});
    }
    for (let callIndex=0;callIndex<callItems.length;callIndex++) {
      const item=callItems[callIndex],call=calls[callIndex],existing=this.callIndexes.get(call.id),index=existing??this.nextIndex++;indexed.push([index,item]);
      if(existing!==undefined)continue;
      if (response) {
        if(agentCalls[item.type]){
          await this.agentCallEvents(item,index);
          continue;
        }
        const custom=item.type==='custom_tool_call',field=custom?'input':'arguments';
        await this.event('response.output_item.added',{output_index:index,item:{...item,status:'in_progress',[field]:''}});
        await this.event(custom?'response.custom_tool_call_input.delta':'response.function_call_arguments.delta',{item_id:item.id,output_index:index,delta:item[field]});
        await this.event(custom?'response.custom_tool_call_input.done':'response.function_call_arguments.done',{item_id:item.id,output_index:index,[field]:item[field]});
        await this.event('response.output_item.done',{output_index:index,item});
      } else {
        await this.event('content_block_start',{index,content_block:{...item,input:{}}});
        await this.event('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(item.input)}});
        await this.event('content_block_stop',{index});
      }
    }
    output=indexed.sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
    if(response) Object.assign(result,{output,output_text:message.content||''}); else Object.assign(result,{content:output});
    if (response) await this.event(limited?'response.incomplete':'response.completed',{response:result});
    else {
      await this.event('message_delta',{delta:{stop_reason:result.stop_reason,stop_sequence:null},usage:{output_tokens:usage.output_tokens,output_tokens_details:{thinking_tokens:usage.output_tokens_details?.reasoning_tokens||0}}});
      await this.event('message_stop');
    }
    return result;
  }
}
