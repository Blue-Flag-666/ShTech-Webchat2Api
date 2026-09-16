import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, events } from '../src/server.mjs';
import { normalizeRequest } from '../src/protocols.mjs';
import { listenForFetch, confirmedModels } from './fixtures.mjs';

async function fixture(fn, answer='你好', finish='stop') {
  const server=createServer({key:'test',token:'token',group:'g',timeout:2000},async(_,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.rootAiType,'xinference');
    const chunks=[...answer].map(content=>({choices:[{index:0,delta:{content},finish_reason:null}]}));
    if (finish) chunks.push({choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:3}});
    return new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  },confirmedModels);
  await listenForFetch(server);
  const call=(path,body,key='test')=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'content-type':'application/json',...(path==='/v1/messages'?{'x-api-key':key}:{authorization:`Bearer ${key}`})},body:JSON.stringify(body)});
  try {await fn(call,`http://127.0.0.1:${server.address().port}`);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const requests=[['/v1/responses',{input:'你好',store:false}],['/v1/messages',{messages:[{role:'user',content:'你好'}],max_tokens:64}]];
test('两个协议非流式返回结构、鉴权和上游 usage',async()=>{
  await fixture(async call=>{
    for(const [path,body] of requests){
      assert.equal((await call(path,body,'wrong')).status,401);
      const res=await call(path,body);assert.equal(res.status,200);
      const json=await res.json();assert.equal(json.usage.input_tokens,10);assert.equal(json.usage.output_tokens,3);
      if(path==='/v1/responses')assert.equal(json.usage.input_tokens_details.cached_tokens,0);
      assert.equal(path==='/v1/responses'?json.output[0].content[0].text:json.content[0].text,'你好');
      if(path==='/v1/responses')assert.equal(json.output_text,'你好');
    }
  });
});
test('协议流式增量重建完整回答，事件索引一致且结束唯一',async()=>{
  await fixture(async call=>{
    for(const [path,body] of requests){
      const res=await call(path,{...body,stream:true});assert.equal(res.status,200);
      const frames=(await Array.fromAsync(events(res.body))).map(x=>JSON.parse(x.data));
      if(path==='/v1/responses'){
        assert.equal(frames[0].type,'response.created');
        assert.deepEqual(frames.map(x=>x.sequence_number),frames.map((_,i)=>i));
        assert.equal(frames.filter(x=>x.type==='response.output_text.delta').map(x=>x.delta).join(''),'你好');
        assert.equal(frames.at(-1).type,'response.completed');
        assert.equal(frames.at(-1).response.output[0].content[0].text,'你好');
        const item=frames.find(x=>x.type==='response.output_item.added').item;
        assert.ok(frames.filter(x=>x.item_id).every(x=>x.item_id===item.id));
      }else{
        assert.equal(frames[0].type,'message_start');assert.equal(frames.at(-1).type,'message_stop');
        assert.equal(frames.filter(x=>x.type==='content_block_delta').map(x=>x.delta.text).join(''),'你好');
        assert.equal(frames.at(-2).delta.stop_reason,'end_turn');
      }
    }
  });
});
test('Responses 可保存、续接、读取输入项和删除',async()=>{
  await fixture(async(call,base)=>{
    const first=await(await call('/v1/responses',{input:'第一问',store:true})).json();assert.equal(first.store,true);
    const headers={authorization:'Bearer test'};
    const saved=await fetch(`${base}/v1/responses/${first.id}`,{headers});assert.equal(saved.status,200);assert.equal((await saved.json()).id,first.id);
    const items=await fetch(`${base}/v1/responses/${first.id}/input_items`,{headers});assert.equal((await items.json()).data[0].content[0].text,'第一问');
    const next=await call('/v1/responses',{input:'第二问',previous_response_id:first.id,store:true});assert.equal(next.status,200);
    const removed=await fetch(`${base}/v1/responses/${first.id}`,{method:'DELETE',headers});assert.equal((await removed.json()).deleted,true);
    assert.equal((await fetch(`${base}/v1/responses/${first.id}`,{headers})).status,404);
  });
});
test('协议工具调用可回传历史并对应 call ID',async()=>{
  for(const stream of [false,true]) await fixture(async call=>{
    const body={input:'天气',tools:[{type:'function',name:'weather',parameters:{type:'object'}}],stream};
    const res=await call('/v1/responses',body);assert.equal(res.status,200);
    const result=stream?(await Array.fromAsync(events(res.body))).map(x=>JSON.parse(x.data)).at(-1).response:await res.json();
    assert.equal(result.output[0].type,'function_call');
    const callItem=result.output[0];assert.deepEqual(JSON.parse(callItem.arguments),{city:'上海'});
    const normalized=normalizeRequest('/v1/responses',{input:[{role:'user',content:'天气'},callItem,{type:'function_call_output',call_id:callItem.call_id,output:'晴'}]});
    assert.equal(normalized.messages.at(-1).tool_call_id,callItem.call_id);
    const anthropic=await call('/v1/messages',{messages:[{role:'user',content:'天气'}],max_tokens:64,tools:[{name:'weather',input_schema:{type:'object'}}],stream});
    assert.equal(anthropic.status,200);
    if(stream){
      const frames=(await Array.fromAsync(events(anthropic.body))).map(x=>JSON.parse(x.data));
      assert.deepEqual(JSON.parse(frames.find(x=>x.delta?.type==='input_json_delta').delta.partial_json),{city:'上海'});
      assert.equal(frames.at(-2).delta.stop_reason,'tool_use');
    }else assert.equal((await anthropic.json()).content[0].type,'tool_use');
  },'<tool_call>{"name":"weather","arguments":{"city":"上海"}}</tool_call>');
});
test('Responses custom 与 namespace 工具支持自由文本、流事件和历史结果',async()=>{
  for(const stream of [false,true]) await fixture(async call=>{
    const body={input:'修改文件',stream,parallel_tool_calls:false,tools:[{type:'namespace',name:'workspace',tools:[
      {type:'function',name:'read_file',parameters:{type:'object'}},
      {type:'custom',name:'apply_patch',description:'应用补丁',format:{type:'grammar',syntax:'lark',definition:'start: patch'}}
    ]}],tool_choice:{type:'allowed_tools',mode:'required',tools:[{type:'custom',name:'apply_patch'}]}};
    const res=await call('/v1/responses',body);assert.equal(res.status,200);
    const frames=stream?(await Array.fromAsync(events(res.body))).map(x=>JSON.parse(x.data)):null;
    const result=stream?frames.at(-1).response:await res.json();
    assert.equal(result.parallel_tool_calls,false);assert.deepEqual(result.tools,body.tools);assert.deepEqual(result.tool_choice,body.tool_choice);
    const item=result.output[0];assert.equal(item.type,'custom_tool_call');assert.equal(item.name,'apply_patch');assert.equal(item.input,'*** Begin Patch\n*** End Patch');
    if(stream) {
      assert.equal(frames.find(x=>x.type==='response.custom_tool_call_input.delta').delta,item.input);
      assert.equal(frames.find(x=>x.type==='response.custom_tool_call_input.done').input,item.input);
    }
    const normalized=normalizeRequest('/v1/responses',{input:[{role:'user',content:'修改'},item,{type:'custom_tool_call_output',call_id:item.call_id,output:'Done'}]});
    assert.deepEqual(JSON.parse(normalized.messages.at(-2).tool_calls[0].function.arguments),{input:item.input});
    assert.equal(normalized.messages.at(-1).tool_call_id,item.call_id);
  },'<api_tool_call>{"name":"apply_patch","arguments":{"input":"*** Begin Patch\\n*** End Patch"}}</api_tool_call>');
});
test('Responses allowed_tools 只向上游暴露允许的工具',()=>{
  const normalized=normalizeRequest('/v1/responses',{input:'x',tools:[{type:'function',name:'a',parameters:{}},{type:'custom',name:'patch'}],tool_choice:{type:'allowed_tools',mode:'required',tools:[{type:'custom',name:'patch'}]}});
  assert.equal(normalized.tool_choice,'required');assert.equal(normalized.tools.length,1);assert.equal(normalized.tools[0].function.name,'patch');assert.equal(normalized.tools[0].custom,true);
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',tools:[{type:'function',name:'a'}],tool_choice:{type:'allowed_tools',mode:'auto',tools:[{type:'function',name:'missing'}]}}),/未知/);
});
test('截断流不会产生协议成功结束事件，长度截断标记 incomplete',async()=>{
  await fixture(async call=>{
    for(const [path,body] of requests){
      const res=await call(path,{...body,stream:true});const output=await res.text();
      assert.match(output,/event: error/);assert.doesNotMatch(output,/response.completed|message_stop/);
    }
  },'部分内容',null);
  await fixture(async call=>{
    const res=await call('/v1/responses',{input:'你好',stream:true});const frames=await Array.fromAsync(events(res.body));
    assert.equal(frames.at(-1).event,'response.incomplete');
    assert.equal(JSON.parse(frames.at(-1).data).response.incomplete_details.reason,'max_output_tokens');
  },'部分','length');
});
test('接受本地 Responses 状态参数并拒绝无效内容能力',()=>{
  assert.equal(normalizeRequest('/v1/responses',{input:'x',store:true}).messages[0].content,'x');
  assert.equal(normalizeRequest('/v1/responses',{input:'x',previous_response_id:'resp_x'}).messages[0].content,'x');
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',previous_response_id:''}),/非空字符串/);
  assert.throws(()=>normalizeRequest('/v1/responses',{input:[{role:'user',content:[{type:'input_image',image_url:'https://example.com'}]}]}),/内容块/);
  const anthropic=normalizeRequest('/v1/messages',{messages:[],max_tokens:1,temperature:1,top_p:.8,top_k:20,stop_sequences:['END']});
  assert.equal(anthropic.temperature,1);assert.deepEqual(anthropic.stop,['END']);
});

test('Responses background 参数拒绝流式和禁用存储',()=>{
  assert.equal(normalizeRequest('/v1/responses',{input:'x',background:true}).messages[0].content,'x');
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',background:true,stream:true}),/stream/);
  assert.equal(normalizeRequest('/v1/responses',{input:'x',background:true,store:false}).messages[0].content,'x');
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',background:'yes'}),/布尔值/);
});

test('Chat 兼容旧版 functions/function_call，Responses 接受常用选项',()=>{
  const chat=normalizeRequest('/v1/chat/completions',{messages:[{role:'user',content:'x'}],functions:[{name:'run',parameters:{type:'object'}}],function_call:{name:'run'}});
  assert.equal(chat.tools[0].function.name,'run');assert.equal(chat.tool_choice.function.name,'run');assert.equal(chat.functions,undefined);
  const response=normalizeRequest('/v1/responses',{input:'x',temperature:.5,top_p:.9,service_tier:'auto',safety_identifier:'local'});
  assert.equal(response.temperature,.5);assert.equal(response.top_p,.9);
});
test('Responses reasoning 与 Anthropic thinking 转成推理强度',()=>{
  assert.equal(normalizeRequest('/v1/responses',{input:'x',reasoning:{effort:'high'}}).reasoning_effort,'high');
  assert.equal(normalizeRequest('/v1/messages',{messages:[{role:'user',content:'x'}],max_tokens:32,thinking:{type:'enabled',budget_tokens:16}}).reasoning_effort,'high');
  assert.equal(normalizeRequest('/v1/responses',{input:'x',reasoning:{effort:'max'}}).reasoning_effort,'max');
  assert.equal(normalizeRequest('/v1/messages',{messages:[{role:'user',content:'x'}],max_tokens:32,output_config:{effort:'max'}}).reasoning_effort,'max');
});
test('Kimi 动态工具、Responses additional_tools 与 reasoning content 可回放',()=>{
  const tool={type:'function',function:{name:'calculate',description:'计算',parameters:{type:'object'}}};
  const chat=normalizeRequest('/v1/chat/completions',{model:'kimi-k3',messages:[{role:'user',content:'算数'},{role:'system',content:'',tools:[tool]}],thinking:{keep:'all',effort:'high'}});
  assert.equal(chat.tools[0].function.name,'calculate');assert.deepEqual(chat.messages[1].tools,[tool]);
  assert.deepEqual(chat.thinking,{type:'enabled',keep:'all',effort:'high'});
  assert.throws(()=>normalizeRequest('/v1/chat/completions',{messages:[{role:'system',content:'x',tools:[tool]},{role:'user',content:'x'}]}),/空 content/);
  assert.throws(()=>normalizeRequest('/v1/chat/completions',{tools:[tool],messages:[{role:'system',content:'',tools:[tool]},{role:'user',content:'x'}]}),/重复定义/);
  assert.throws(()=>normalizeRequest('/v1/chat/completions',{messages:[{role:'user',content:'x'}],thinking:{type:'enabled',keep:'none'}}),/仅支持 all/);
  const responses=normalizeRequest('/v1/responses',{model:'kimi-k3',input:[
    {type:'reasoning',content:[{type:'reasoning_text',text:'保留思路'}]},
    {type:'additional_tools',role:'developer',tools:[{type:'function',name:'calculate',parameters:{type:'object'}}]},
    {type:'message',role:'user',content:'继续'}
  ],include:['reasoning.encrypted_content','web_search_call.action.sources']});
  assert.match(responses.messages[0].content,/保留思路/);assert.equal(responses.tools[0].function.name,'calculate');
});
test('Kimi Messages 最后一条 assistant 自动转换为 Partial Mode',()=>{
  const value=normalizeRequest('/v1/messages',{model:'kimi-k3',max_tokens:64,messages:[{role:'user',content:'写结论'},{role:'assistant',content:'Conclusion: '}]});
  assert.equal(value.messages.at(-1).partial,true);
});

test('Kimi K3 Chat 执行官方固定采样参数约束',()=>{
  const base={model:'kimi-k3',messages:[{role:'user',content:'x'}]};
  for(const temperature of [0,0.6,1])assert.equal(normalizeRequest('/v1/chat/completions',{...base,temperature}).temperature,temperature);
  assert.equal(normalizeRequest('/v1/chat/completions',{...base,thinking:{type:'disabled'},temperature:0.6,top_p:0.95,presence_penalty:0,frequency_penalty:0,n:1}).temperature,0.6);
  for(const body of [
    {...base,temperature:1.1},{...base,thinking:{type:'disabled'},temperature:0},
    {...base,top_p:0.8},{...base,presence_penalty:0.5},{...base,frequency_penalty:0.5},{...base,n:2}
  ])assert.throws(()=>normalizeRequest('/v1/chat/completions',body),/Kimi K3/);
});
test('Anthropic 可关闭并行工具调用',()=>{
  const value=normalizeRequest('/v1/messages',{messages:[{role:'user',content:'x'}],max_tokens:32,tools:[{name:'a',input_schema:{type:'object'}}],tool_choice:{type:'auto',disable_parallel_tool_use:true}});
  assert.equal(value.parallel_tool_calls,false);
});
test('三种协议的服务端搜索映射到 netGo',()=>{
  assert.equal(normalizeRequest('/v1/chat/completions',{messages:[{role:'user',content:'新闻'}],web_search_options:{}}).net_go,true);
  const response=normalizeRequest('/v1/responses',{input:'新闻',tools:[{type:'web_search'}]});assert.equal(response.net_go,true);assert.deepEqual(response.tools,[]);
  const message=normalizeRequest('/v1/messages',{messages:[{role:'user',content:'新闻'}],max_tokens:32,tools:[{type:'web_search_20250305',name:'web_search'}]});assert.equal(message.net_go,true);assert.deepEqual(message.tools,[]);
});

test('Legacy Completions 转成单轮续写并拒绝不可兑现选项',()=>{
  const value=normalizeRequest('/v1/completions',{model:'qwen-code',prompt:'const x = ',suffix:';\n',max_tokens:32,n:1,echo:false});
  assert.equal(value.messages.at(-1).role,'user');assert.match(value.messages.at(-1).content,/PREFIX/);assert.equal(value.max_tokens,32);
  assert.throws(()=>normalizeRequest('/v1/completions',{prompt:['a','b']}),/单个字符串/);
  assert.throws(()=>normalizeRequest('/v1/completions',{prompt:'a',n:2}),/n 仅支持 1/);
});

test('两个协议在上游结束前发送首个文本增量',async()=>{
  for(const [path,body] of requests) {
    let upstreamController;
    const encoder=new TextEncoder();
    const frame=(content,finish_reason=null)=>encoder.encode(`data: ${JSON.stringify({choices:[{index:0,delta:{content},finish_reason}]})}\n\n`);
    const server=createServer({key:'test',token:'token',group:'g',timeout:2000},async()=>new Response(new ReadableStream({start(controller){upstreamController=controller;controller.enqueue(frame('首块'));}}),{headers:{'content-type':'text/event-stream'}}),confirmedModels);
    await listenForFetch(server);
    try {
      const res=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({...body,stream:true}),signal:AbortSignal.timeout(2000)});
      const iterator=events(res.body)[Symbol.asyncIterator]();
      let first;
      while(!first) {
        const next=await iterator.next();assert.equal(next.done,false);
        const value=JSON.parse(next.value.data);
        if(value.type==='response.output_text.delta'||value.delta?.type==='text_delta') first=value;
      }
      assert.equal(first.delta?.text || first.delta,'首块');
      // Only release upstream completion after observing the downstream text.
      upstreamController.enqueue(frame('','stop'));upstreamController.close();
      while(!(await iterator.next()).done) {}
    }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
  }
});

test('Responses reasoning summary 与 Messages thinking 同时支持 JSON、SSE 和历史回传',async()=>{
  const encoder=new TextEncoder();
  for(const [path,body] of requests) for(const stream of [false,true]) {
    const server=createServer({key:'test',token:'token',group:'g',timeout:2000},async()=>{
      const chunks=[
        {choices:[{index:0,delta:{reasoning_content:'先思考'},finish_reason:null}]},
        {choices:[{index:0,delta:{content:'后回答'},finish_reason:null}]},
        {choices:[{index:0,delta:{},finish_reason:'stop'}]}
      ];
      return new Response(chunks.map(x=>`data: ${JSON.stringify(x)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    },confirmedModels);
    await listenForFetch(server);
    try {
      const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({...body,stream})});
      assert.equal(response.status,200);
      if(!stream) {
        const json=await response.json();
        if(path==='/v1/responses') {
          assert.equal(json.output[0].type,'reasoning');assert.equal(json.output[0].summary[0].text,'先思考');
          assert.equal(json.output[1].content[0].text,'后回答');
          const history=normalizeRequest(path,{input:[{type:'reasoning',summary:json.output[0].summary},{role:'assistant',content:json.output[1].content},{role:'user',content:'继续'}]});
          assert.match(history.messages[0].content,/先思考/);
        } else {
          assert.equal(json.content[0].type,'thinking');assert.equal(json.content[0].thinking,'先思考');
          assert.equal(json.content[1].text,'后回答');
          const history=normalizeRequest(path,{messages:[{role:'assistant',content:json.content},{role:'user',content:'继续'}],max_tokens:64});
          assert.match(history.messages[0].content,/先思考/);
        }
      } else {
        const frames=(await Array.fromAsync(events(response.body))).map(x=>JSON.parse(x.data));
        if(path==='/v1/responses') {
          assert.equal(frames.filter(x=>x.type==='response.reasoning_summary_text.delta').map(x=>x.delta).join(''),'先思考');
          assert.equal(frames.find(x=>x.type==='response.output_item.added').item.type,'reasoning');
          assert.deepEqual(frames.at(-1).response.output.map(x=>x.type),['reasoning','message']);
        } else {
          assert.equal(frames.find(x=>x.delta?.type==='thinking_delta').delta.thinking,'先思考');
          assert.deepEqual(frames.at(-2).usage.output_tokens>=0,true);
        }
      }
    } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
  }
});
