import { randomUUID } from 'node:crypto';

const bad = message => Object.assign(new Error(message), { status: 400 });
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
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw bad(`暂不支持参数 ${key}`);
}
function responseTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw bad('tools 必须为数组');
  const result=[];
  const add=(tool,depth=0)=>{
    if(depth>4)throw bad('namespace 工具嵌套过深');
    if (!tool || typeof tool!=='object' || Array.isArray(tool)) throw bad('无效 Responses 工具声明');
    if (tool.type==='namespace') {
      if (!Array.isArray(tool.tools)) throw bad('namespace.tools 必须为数组');
      for (const child of tool.tools) add(child,depth+1);
      return;
    }
    if (!['function','custom'].includes(tool.type)) throw bad('当前仅支持 function、custom 和 namespace 工具');
    if (tool.type==='function') {
      result.push({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}});
      return;
    }
    if (tool.format!==undefined && (!tool.format || typeof tool.format!=='object' || Array.isArray(tool.format))) throw bad('custom tool format 必须是对象');
    const definition=tool.format?.definition;
    if (definition!==undefined && typeof definition!=='string') throw bad('custom tool format.definition 必须是字符串');
    const description=[tool.description,definition&&`自由文本格式定义：\n${definition}`].filter(Boolean).join('\n\n');
    result.push({type:'function',custom:true,function:{name:tool.name,description,parameters:{type:'object',properties:{input:{type:'string',description:'该工具的完整自由文本输入'}},required:['input'],additionalProperties:false}}});
  };
  for (const tool of tools) add(tool);
  return result;
}
function responseToolChoice(choice, tools) {
  if (choice===undefined || typeof choice==='string') return {choice,tools};
  if (!choice || typeof choice!=='object' || Array.isArray(choice)) throw bad('无效 tool_choice');
  if (['function','custom'].includes(choice.type)) return {choice:{type:'function',function:{name:choice.name}},tools};
  if (choice.type!=='allowed_tools' || !['auto','required'].includes(choice.mode) || !Array.isArray(choice.tools) || !choice.tools.length) throw bad('无效 tool_choice');
  const allowed=new Set(choice.tools.map(tool=>{
    if (!tool || !['function','custom'].includes(tool.type) || typeof tool.name!=='string') throw bad('allowed_tools 包含无效工具');
    return tool.name;
  }));
  const available=new Set((tools || []).map(tool=>tool.function?.name));
  if ([...allowed].some(name=>!available.has(name))) throw bad('allowed_tools 指定了未知工具');
  return {choice:choice.mode,tools:(tools || []).filter(tool=>allowed.has(tool.function.name))};
}
export function normalizeRequest(path, input) {
  if (path === '/v1/chat/completions') return input;
  const out = { model: input.model, stream: input.stream, messages: [] };
  if (path === '/v1/responses') {
    keys(input, ['model','input','instructions','stream','max_output_tokens','tools','tool_choice','store','previous_response_id','metadata','reasoning','text','parallel_tool_calls','include']);
    if (input.store === true || input.previous_response_id != null) throw bad('当前 Responses 为无状态接口，请使用 store:false 并传入完整历史');
    if (input.store !== undefined && typeof input.store !== 'boolean') throw bad('store 必须为布尔值');
    if (input.instructions != null) out.messages.push({role:'system',content:text(input.instructions)});
    const items = typeof input.input === 'string' ? [{role:'user',content:input.input}] : input.input;
    if (!Array.isArray(items)) throw bad('input 必须为字符串或输入项数组');
    for (const item of items) {
      if (item?.type === 'reasoning') {
        if (!Array.isArray(item.summary)) throw bad('reasoning.summary 必须为数组');
        const summary=text(item.summary,['summary_text']);
        if (summary) out.messages.push({role:'assistant',content:`[Reasoning summary]\n${summary}`});
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
      } else if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') out.messages.push({role:'tool',tool_call_id:item.call_id,content:text(item.output)});
      else if (item && (!item.type || item.type === 'message')) out.messages.push({role:item.role,content:text(item.content)});
      else throw bad('不支持的 Responses 输入项');
    }
    const selected=responseToolChoice(input.tool_choice,responseTools(input.tools));
    out.tools=selected.tools;out.tool_choice=selected.choice;
    if (input.parallel_tool_calls!==undefined && typeof input.parallel_tool_calls!=='boolean') throw bad('parallel_tool_calls 必须为布尔值');
    if (input.include!==undefined && (!Array.isArray(input.include) || input.include.some(value=>value!=='reasoning.encrypted_content'))) throw bad('当前 include 仅接受 reasoning.encrypted_content');
    out.parallel_tool_calls=input.parallel_tool_calls;
    out.max_tokens = input.max_output_tokens;
  } else {
    keys(input, ['model','messages','system','stream','max_tokens','tools','tool_choice','metadata','thinking','output_config']);
    if (!Number.isInteger(input.max_tokens) || input.max_tokens < 1) throw bad('max_tokens 必须为正整数');
    out.max_tokens = input.max_tokens;
    if (input.system != null) out.messages.push({role:'system',content:text(input.system,['text'])});
    if (!Array.isArray(input.messages)) throw bad('messages 必须为数组');
    for (const message of input.messages) {
      if (!['user','assistant'].includes(message?.role)) throw bad('Messages 仅接受 user/assistant 历史');
      if (typeof message.content === 'string') { out.messages.push({...message}); continue; }
      if (!Array.isArray(message.content)) throw bad('content 必须为字符串或数组');
      const m = {role:message.role,content:''}, results = [];
      for (const block of message.content) {
        if (block?.type === 'text') m.content += text([block],['text']);
        else if (block?.type === 'thinking' && message.role === 'assistant' && typeof block.thinking === 'string') m.content += `${m.content?'\n':''}[Reasoning summary]\n${block.thinking}`;
        else if (block?.type === 'tool_use' && message.role === 'assistant') {
          (m.tool_calls ||= []).push({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.input)}});
        } else if (block?.type === 'tool_result' && message.role === 'user') {
          results.push({role:'tool',tool_call_id:block.tool_use_id,content:(block.is_error ? 'Tool error: ' : '') + text(block.content,['text'])});
        } else throw bad('不支持的 Messages 内容块');
      }
      out.messages.push(...results);
      if (m.content || m.tool_calls || !results.length) out.messages.push(m);
    }
    if (input.tools !== undefined) {
      if (!Array.isArray(input.tools)) throw bad('tools 必须为数组');
      out.tools = input.tools.map(t=>{
        if (!t || typeof t !== 'object') throw bad('无效工具声明');
        return {type:'function',function:{name:t.name,description:t.description,parameters:t.input_schema}};
      });
    }
    const choice = input.tool_choice;
    if (choice !== undefined) {
      if (!choice || !['auto','any','none','tool'].includes(choice.type)) throw bad('无效 tool_choice');
      out.tool_choice = choice.type === 'tool' ? {type:'function',function:{name:choice.name}} : choice.type === 'any' ? 'required' : choice.type;
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([,v])=>v !== undefined));
}

export function tokenUsage(completion, input) {
  // Lightweight estimate only when the upstream does not provide token counts.
  const estimate = value => Math.ceil(Buffer.byteLength(value || '') / 3);
  const prompt = completion.usage?.prompt_tokens ?? estimate(JSON.stringify(input.messages));
  const output = completion.usage?.completion_tokens ?? estimate(JSON.stringify(completion.choices[0].message));
  return {input_tokens:prompt,output_tokens:output,total_tokens:prompt+output};
}
export class ProtocolOutput {
  constructor(path, input, emit, original = {}) {
    this.path=path; this.input=input; this.emit=emit; this.sequence=0;
    this.id=id(path === '/v1/responses' ? 'resp' : 'msg');
    this.messageId=id('msg'); this.reasoningId=id('rs'); this.created=Math.floor(Date.now()/1000);
    this.text=''; this.reasoning=''; this.started=false; this.textIndex=null; this.reasoningIndex=null; this.nextIndex=0;
    this.metadata=original.metadata || {};this.original=original;this.customTools=new Set();
    const collect=tools=>{for(const tool of tools || [])if(tool?.type==='namespace')collect(tool.tools);else if(tool?.type==='custom'&&typeof tool.name==='string')this.customTools.add(tool.name);};
    collect(original.tools);
  }
  async event(type, data={}) {
    const value={type,...data,...(this.path === '/v1/responses' ? {sequence_number:this.sequence++} : {})};
    await this.emit(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  response(output=[],status='in_progress',usage=null) {
    return {id:this.id,object:'response',created_at:this.created,status,error:null,
      incomplete_details:status === 'incomplete' ? {reason:'max_output_tokens'} : null,
      model:this.input.model || 'qwen-instruct',output,usage,store:false,parallel_tool_calls:this.original.parallel_tool_calls ?? true,
      tool_choice:this.original.tool_choice ?? 'auto',tools:this.original.tools || [],metadata:this.metadata,
      reasoning:{effort:null,summary:this.reasoning? 'auto':null}};
  }
  message(content=[],stop_reason=null,usage={input_tokens:0,output_tokens:0}) {
    return {id:this.id,type:'message',role:'assistant',model:this.input.model || 'qwen-instruct',content,stop_reason,stop_sequence:null,usage};
  }
  part(value) { return {type:'output_text',text:value,annotations:[],logprobs:[]}; }
  item(value,status='completed') { return {id:this.messageId,type:'message',status,role:'assistant',content:[this.part(value)]}; }
  reasoningItem(status='completed') { return {id:this.reasoningId,type:'reasoning',status,summary:[{type:'summary_text',text:this.reasoning}],content:[],encrypted_content:null}; }
  async start() {
    if (this.started) return;
    this.started=true;
    if (this.path === '/v1/responses') {
      await this.event('response.created',{response:this.response()});
      await this.event('response.in_progress',{response:this.response()});
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
  async finish(completion, stream) {
    const message=completion.choices[0].message, calls=message.tool_calls || [];
    const usage=tokenUsage(completion,this.input), limited=completion.choices[0].finish_reason === 'length';
    const response=this.path === '/v1/responses';
    if(message.reasoning_content && !this.reasoning) this.reasoning=message.reasoning_content;
    const reasoningItem=response ? this.reasoningItem(limited?'incomplete':'completed') : {type:'thinking',thinking:this.reasoning,signature:''};
    const messageItem=response ? this.item(message.content,limited?'incomplete':'completed') : {type:'text',text:message.content};
    const callItems=calls.map(call=>response
      ? this.customTools.has(call.function.name)
        ? {id:id('ctc'),type:'custom_tool_call',status:'completed',call_id:call.id,name:call.function.name,input:(()=>{const value=JSON.parse(call.function.arguments).input;return typeof value==='string'?value:JSON.stringify(value);})()}
        : {id:id('fc'),type:'function_call',status:'completed',call_id:call.id,name:call.function.name,arguments:call.function.arguments}
      : {type:'tool_use',id:call.id,name:call.function.name,input:JSON.parse(call.function.arguments)});
    let output=[];
    if(!stream) output=[...(this.reasoning?[reasoningItem]:[]),...(message.content?[messageItem]:[]),...callItems];
    const result=response ? this.response(output,limited?'incomplete':'completed',usage)
      : this.message(output,calls.length?'tool_use':limited?'max_tokens':'end_turn',{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens});
    if (!stream) return result;
    await this.start();
    if (this.reasoningIndex===null && this.reasoning) { const value=this.reasoning;this.reasoning='';await this.reasoningDelta(value); }
    if (this.textIndex===null && message.content) await this.delta(message.content);
    const indexed=[];
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
    for (const item of callItems) {
      const index=this.nextIndex++;indexed.push([index,item]);
      if (response) {
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
    if(response) Object.assign(result,{output}); else Object.assign(result,{content:output});
    if (response) await this.event(limited?'response.incomplete':'response.completed',{response:result});
    else {
      await this.event('message_delta',{delta:{stop_reason:result.stop_reason,stop_sequence:null},usage:{output_tokens:usage.output_tokens}});
      await this.event('message_stop');
    }
    return result;
  }
}
