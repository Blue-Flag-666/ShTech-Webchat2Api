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
export function normalizeRequest(path, input) {
  if (path === '/v1/chat/completions') return input;
  const out = { model: input.model, stream: input.stream, messages: [] };
  if (path === '/v1/responses') {
    keys(input, ['model','input','instructions','stream','max_output_tokens','tools','tool_choice','store','previous_response_id','metadata']);
    if (input.store === true || input.previous_response_id != null) throw bad('当前 Responses 为无状态接口，请使用 store:false 并传入完整历史');
    if (input.store !== undefined && typeof input.store !== 'boolean') throw bad('store 必须为布尔值');
    if (input.instructions != null) out.messages.push({role:'system',content:text(input.instructions)});
    const items = typeof input.input === 'string' ? [{role:'user',content:input.input}] : input.input;
    if (!Array.isArray(items)) throw bad('input 必须为字符串或输入项数组');
    for (const item of items) {
      if (item?.type === 'function_call') {
        const call = {id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}};
        const previous = out.messages.at(-1);
        if (previous?.role === 'assistant' && previous.tool_calls) previous.tool_calls.push(call);
        else out.messages.push({role:'assistant',content:null,tool_calls:[call]});
      } else if (item?.type === 'function_call_output') out.messages.push({role:'tool',tool_call_id:item.call_id,content:text(item.output)});
      else if (item && (!item.type || item.type === 'message')) out.messages.push({role:item.role,content:text(item.content)});
      else throw bad('不支持的 Responses 输入项');
    }
    if (input.tools !== undefined) {
      if (!Array.isArray(input.tools)) throw bad('tools 必须为数组');
      out.tools = input.tools.map(t => {
        if (t?.type !== 'function') throw bad('当前仅支持 function 工具');
        return {type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}};
      });
    }
    out.tool_choice = typeof input.tool_choice === 'object' && input.tool_choice !== null
      ? {type:input.tool_choice.type,function:{name:input.tool_choice.name}} : input.tool_choice;
    out.max_tokens = input.max_output_tokens;
  } else {
    keys(input, ['model','messages','system','stream','max_tokens','tools','tool_choice','metadata']);
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
    this.messageId=id('msg'); this.created=Math.floor(Date.now()/1000);
    this.text=''; this.started=false; this.block=false;
    this.metadata=original.metadata || {};
  }
  async event(type, data={}) {
    const value={type,...data,...(this.path === '/v1/responses' ? {sequence_number:this.sequence++} : {})};
    await this.emit(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  response(output=[],status='in_progress',usage=null) {
    return {id:this.id,object:'response',created_at:this.created,status,error:null,
      incomplete_details:status === 'incomplete' ? {reason:'max_output_tokens'} : null,
      model:this.input.model || 'qwen-instruct',output,usage,store:false,parallel_tool_calls:true,
      tool_choice:typeof this.input.tool_choice === 'object' ? {type:'function',name:this.input.tool_choice.function.name} : this.input.tool_choice || 'auto',
      tools:(this.input.tools || []).map(t=>({type:'function',...t.function})),metadata:this.metadata};
  }
  message(content=[],stop_reason=null,usage={input_tokens:0,output_tokens:0}) {
    return {id:this.id,type:'message',role:'assistant',model:this.input.model || 'qwen-instruct',content,stop_reason,stop_sequence:null,usage};
  }
  part(value) { return {type:'output_text',text:value,annotations:[],logprobs:[]}; }
  item(value,status='completed') { return {id:this.messageId,type:'message',status,role:'assistant',content:[this.part(value)]}; }
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
    if (!this.block) {
      this.block=true;
      if (response) {
        await this.event('response.output_item.added',{output_index:0,item:{...this.item('','in_progress'),content:[]}});
        await this.event('response.content_part.added',{item_id:this.messageId,output_index:0,content_index:0,part:this.part('')});
      } else await this.event('content_block_start',{index:0,content_block:{type:'text',text:''}});
    }
    this.text+=value;
    if (response) await this.event('response.output_text.delta',{item_id:this.messageId,output_index:0,content_index:0,delta:value,logprobs:[]});
    else await this.event('content_block_delta',{index:0,delta:{type:'text_delta',text:value}});
  }
  async finish(completion, stream) {
    const message=completion.choices[0].message, calls=message.tool_calls || [];
    const usage=tokenUsage(completion,this.input), limited=completion.choices[0].finish_reason === 'length';
    const response=this.path === '/v1/responses';
    const output=[];
    if (message.content) output.push(response ? this.item(message.content,limited?'incomplete':'completed') : {type:'text',text:message.content});
    for (const call of calls) output.push(response
      ? {id:id('fc'),type:'function_call',status:'completed',call_id:call.id,name:call.function.name,arguments:call.function.arguments}
      : {type:'tool_use',id:call.id,name:call.function.name,input:JSON.parse(call.function.arguments)});
    const result=response ? this.response(output,limited?'incomplete':'completed',usage)
      : this.message(output,calls.length?'tool_use':limited?'max_tokens':'end_turn',{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens});
    if (!stream) return result;
    await this.start();
    if (!this.block && message.content) await this.delta(message.content);
    if (this.block) {
      if (response) {
        const loc={item_id:this.messageId,output_index:0,content_index:0};
        await this.event('response.output_text.done',{...loc,text:this.text,logprobs:[]});
        await this.event('response.content_part.done',{...loc,part:this.part(this.text)});
        await this.event('response.output_item.done',{output_index:0,item:output[0]});
      } else await this.event('content_block_stop',{index:0});
    }
    for (let index=this.block?1:0;index<output.length;index++) {
      const item=output[index];
      if (response) {
        await this.event('response.output_item.added',{output_index:index,item:{...item,status:'in_progress',arguments:''}});
        await this.event('response.function_call_arguments.delta',{item_id:item.id,output_index:index,delta:item.arguments});
        await this.event('response.function_call_arguments.done',{item_id:item.id,output_index:index,arguments:item.arguments});
        await this.event('response.output_item.done',{output_index:index,item});
      } else {
        await this.event('content_block_start',{index,content_block:{...item,input:{}}});
        await this.event('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(item.input)}});
        await this.event('content_block_stop',{index});
      }
    }
    if (response) await this.event(limited?'response.incomplete':'response.completed',{response:result});
    else {
      await this.event('message_delta',{delta:{stop_reason:result.stop_reason,stop_sequence:null},usage:{output_tokens:usage.output_tokens}});
      await this.event('message_stop');
    }
    return result;
  }
}
