import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, events } from './server.mjs';
import { normalizeRequest } from './protocols.mjs';
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
  try {await fn(call);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const requests=[['/v1/responses',{input:'你好',store:false}],['/v1/messages',{messages:[{role:'user',content:'你好'}],max_tokens:64}]];
test('两个协议非流式返回结构、鉴权和上游 usage',async()=>{
  await fixture(async call=>{
    for(const [path,body] of requests){
      assert.equal((await call(path,body,'wrong')).status,401);
      const res=await call(path,body);assert.equal(res.status,200);
      const json=await res.json();assert.equal(json.usage.input_tokens,10);assert.equal(json.usage.output_tokens,3);
      assert.equal(path==='/v1/responses'?json.output[0].content[0].text:json.content[0].text,'你好');
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
test('拒绝不可兑现的状态和内容能力',()=>{
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',store:true}),/无状态/);
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',previous_response_id:'resp_x'}),/无状态/);
  assert.throws(()=>normalizeRequest('/v1/responses',{input:[{role:'user',content:[{type:'input_image',image_url:'https://example.com'}]}]}),/内容块/);
  assert.throws(()=>normalizeRequest('/v1/messages',{messages:[],max_tokens:1,temperature:1}),/temperature/);
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
