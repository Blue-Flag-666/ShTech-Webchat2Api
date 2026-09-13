import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, events, upstreamBody } from './server.mjs';
import { TokenManager } from './auth.mjs';
import { listenForFetch, confirmedModels } from './fixtures.mjs';

const config = { key: 'local-test', token: 'upstream-test', group: 'test-group', timeout: 2000, netGo: false };
const request = { model: 'qwen-instruct', messages: [{role:'user',content:'你好'}] };
const chunk = (content, finish = null) => ({ id:'chatcmpl-test', object:'chat.completion.chunk', model:'qwen-instruct', created:123, choices:[{index:0,delta:{content},finish_reason:finish}] });
const sse = values => values.map(v => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`).join('');
async function withServer(fetcher, fn, overrides = {}) {
  const server = createServer({...config,...overrides}, fetcher, overrides.modelFetcher || confirmedModels, overrides.tokenManager);
  await listenForFetch(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (body = request, key = config.key) => fetch(`${base}/v1/chat/completions`, {method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try { await fn(call, base); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
test('转换当前输入与历史，保留配置', () => {
  const body = upstreamBody({...request,messages:[{role:'user',content:'旧问题'},{role:'assistant',content:'旧回答'},...request.messages]},config);
  assert.equal(body.chatInfo,'你好'); assert.equal(body.messages.length,2); assert.equal(body.netGo,false); assert.equal(body.chatGroupId,'test-group');
  assert.throws(()=>upstreamBody({...request,tools:[{}]},config),/function/);
  assert.equal(upstreamBody({...request,messages:[{role:'system',content:'指令'},...request.messages]},config).messages[0].role,'system');
});

test('首次目录故障不猜测模型，拒绝聊天且不访问聊天上游',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;throw new Error('must not call');},async(call,base)=>{
    const list=await fetch(`${base}/v1/models`,{headers:{authorization:`Bearer ${config.key}`}});
    assert.deepEqual((await list.json()).data,[]);
    assert.equal((await call()).status,503);assert.equal(calls,0);
  },{modelFetcher:async()=>{throw new Error('offline');}});
});

test('目录刷新失败保留已确认模型，恢复后删除撤下的模型',async()=>{
  let attempt=0;
  await withServer(async()=>{throw new Error('unused');},async(call,base)=>{
    const list=async()=>(await (await fetch(`${base}/v1/models`,{headers:{authorization:`Bearer ${config.key}`}})).json()).data;
    assert.equal((await list())[0].id,'qwen-instruct');
    assert.equal((await list())[0].id,'qwen-instruct');
    assert.deepEqual(await list(),[]);
    assert.equal((await call()).status,503);
  },{modelTtl:0,modelFetcher:async()=>{
    attempt++;
    if(attempt===1)return confirmedModels();
    if(attempt===2)throw new Error('temporary outage');
    return {success:true,result:{records:[{aiType:'gpt-5',rootAiType:'azure'}]}};
  }});
});
test('SSE 逐字节 UTF-8、CRLF、多行和注释', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: message\r\ndata: 你好\r\ndata: 世界\r\n\r\ndata: [DONE]\n\n');
  async function* source() { for (const byte of bytes) yield Uint8Array.of(byte); }
  assert.deepEqual(await Array.fromAsync(events(source())),[{event:'message',data:'你好\n世界'},{event:'message',data:'[DONE]'}]);
});
test('非流式完整 HTTP 往返和上游鉴权映射', async () => {
  await withServer(async (url, opts) => {
    assert.equal(url,'https://genai.shanghaitech.edu.cn/htk/chat/start/chat');
    assert.equal(opts.headers['x-access-token'],'upstream-test');
    assert.equal(JSON.parse(opts.body).chatInfo,'你好');
    return new Response(sse([chunk('你'),chunk('好','stop'),'[DONE]']),{headers:{'Content-Type':'text/event-stream'}});
  },async call => {
    const res = await call(); assert.equal(res.status,200);
    const result = await res.json(); assert.equal(result.object,'chat.completion'); assert.equal(result.choices[0].message.content,'你好');
  });
});
test('流式输出保留分块并产生单个 DONE',async () => {
  await withServer(async()=>new Response(sse([chunk('好'),chunk('','stop'),'[DONE]']),{headers:{'Content-Type':'text/event-stream'}}),async call=>{
    const res=await call({...request,stream:true}); assert.match(res.headers.get('content-type'),/text\/event-stream/);
    const text=await res.text(); assert.equal(text.split('[DONE]').length,2); assert.match(text,/chat.completion.chunk/);
  });
});
test('Chat 接受 max_completion_tokens 并按标准发送流式 usage 尾块',async()=>{
  await withServer(async(_,options)=>{
    assert.equal(JSON.parse(options.body).maxToken,32);
    return new Response(sse([{...chunk('好'),usage:{prompt_tokens:2,completion_tokens:1}},chunk('','stop'),'[DONE]']),{headers:{'Content-Type':'text/event-stream'}});
  },async call=>{
    const res=await call({...request,max_completion_tokens:32,stream:true,stream_options:{include_usage:true}});assert.equal(res.status,200);
    const frames=(await Array.fromAsync(events(res.body))).filter(item=>item.data!=='[DONE]').map(item=>JSON.parse(item.data));
    assert.ok(frames.slice(0,-1).every(frame=>frame.usage===null));assert.deepEqual(frames.at(-1).choices,[]);assert.equal(frames.at(-1).usage.total_tokens,3);
    assert.equal((await call({...request,max_tokens:1,max_completion_tokens:2})).status,400);
  });
});
test('截断流不伪装成功',async()=>{
  for(const stream of [false,true]) await withServer(async()=>new Response(sse([chunk('部分内容')]),{headers:{'Content-Type':'text/event-stream'}}),async call=>{
    const res=await call({...request,stream}); const text=await res.text();
    if(stream) {assert.match(text,/event: error/);assert.doesNotMatch(text,/\[DONE\]/);} else assert.equal(res.status,502);
  });
});
test('登录失败、不正确内容类型和本地鉴权',async()=>{
  for(const response of [new Response('secret',{status:401}),new Response('<html>login</html>')]) await withServer(async()=>response,async call=>{
    const res=await call(); assert.ok([401,502].includes(res.status)); assert.doesNotMatch(await res.text(),/secret|<html>/);
  });
  await withServer(()=>{throw new Error('不应访问上游');},async call=>assert.equal((await call(request,'wrong')).status,401));
});
test('错误事件不会被当作回答',async()=>{
  await withServer(async()=>new Response('event: error\ndata: {"message":"private upstream detail"}\n\n',{headers:{'Content-Type':'text/event-stream'}}),async call=>{
    const res=await call();assert.equal(res.status,502);assert.doesNotMatch(await res.text(),/private/);
  });
});
test('超时中断上游',async()=>{
  await withServer((url,opts)=>new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('abort')))),async call=>assert.equal((await call()).status,504),{timeout:20});
});
test('忙碌时返回 429，完成后释放会话',async()=>{
  let release;
  const ready = new Promise(resolve=>{release=resolve;});
  let started;
  const entered = new Promise(resolve=>{started=resolve;});
  await withServer(async()=>{started();await ready;return new Response(sse([chunk('完成','stop')]),{headers:{'Content-Type':'text/event-stream'}});},async call=>{
    const first=call();await entered;
    assert.equal((await call()).status,429);
    release();assert.equal((await first).status,200);
    assert.equal((await call()).status,200);
  });
});
test('客户端断开取消上游并释放会话',async()=>{
  let aborted;
  const cancelled=new Promise(resolve=>{aborted=resolve;});
  await withServer(async(url,opts)=>{
    opts.signal.addEventListener('abort',aborted,{once:true});
    return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(sse([chunk('片段')])));opts.signal.addEventListener('abort',()=>c.error(new Error('cancelled')),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,stream:true});
    const reader=response.body.getReader();await reader.read();await reader.cancel();
    await cancelled;
  });
});
test('模型目录可扩展并缓存，未知模型被拒绝', async()=>{
  await withServer(async()=>new Response(sse([chunk('好','stop'),'[DONE]']),{headers:{'Content-Type':'text/event-stream'}}),async(call,base)=>{
    const models=await fetch(base+'/v1/models',{headers:{Authorization:'Bearer '+config.key}}); assert.equal(models.status,200);
    const first=await models.json(); assert.deepEqual(first.data.map(x=>x.id),['qwen-instruct']);
    const model=await fetch(base+'/v1/models/qwen-instruct',{headers:{Authorization:'Bearer '+config.key}});assert.equal((await model.json()).id,'qwen-instruct');
    assert.equal((await fetch(base+'/v1/models/missing',{headers:{Authorization:'Bearer '+config.key}})).status,404);
    assert.equal((await call({...request,model:'not-real'})).status,400);
  });
});
test('目录选择的模型与路由真正发送到上游，模型查询只执行一次', async()=>{
  let queries=0;
  await withServer(async(url,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.aiType,'deepseek-pro');assert.equal(body.rootAiType,'xinference');
    return new Response(sse([chunk('ok','stop'),'[DONE]']),{headers:{'Content-Type':'text/event-stream'}});
  },async(call,base)=>{
    const headers={Authorization:'Bearer '+config.key};
    const responses=await Promise.all([fetch(base+'/v1/models',{headers}),fetch(base+'/v1/models',{headers})]);
    for(const response of responses) assert.equal((await response.json()).data[0].id,'deepseek-pro');
    assert.equal((await call({...request,model:'deepseek-pro'})).status,200);
    assert.equal((await call(request)).status,400);
    assert.equal(queries,1);
  },{modelFetcher:async()=>{queries++;return{success:true,result:{records:[{aiType:'deepseek-pro',rootAiType:'xinference',maxToken:8192},{aiType:'gpt-5',rootAiType:'azure'}]}};}});
});
test('上游 401 刷新凭证并仅重试一次',async()=>{
  let attempts=0,logins=0;
  const manager=new TokenManager({...config,username:'u',password:'p'},async()=>{logins++;return 'refreshed';});
  await withServer(async(url,options)=>{
    if(++attempts===1)return new Response('unauthorized',{status:401});
    assert.equal(options.headers['x-access-token'],'refreshed');
    return new Response(sse([chunk('ok','stop')]),{headers:{'Content-Type':'text/event-stream'}});
  },async call=>{assert.equal((await call()).status,200);assert.equal(attempts,2);assert.equal(logins,1);},{tokenManager:manager});
});

test('SSE 中 token 失效在输出前刷新一次，并关闭被拒绝的流',async()=>{
  let attempts=0,refreshes=0,cancelled=false;
  const manager=new TokenManager({token:'initial',username:'user',password:'mock'},async()=>{refreshes++;return 'refreshed';});
  await withServer(async(_,options)=>{
    attempts++;
    if(attempts===1)return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"success":false,"message":"Token失效，请重新登录"}\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
    assert.equal(options.headers['x-access-token'],'refreshed');
    return new Response(sse([chunk('成功','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const res=await call({...request,stream:true});assert.equal(res.status,200);
    const output=await res.text();assert.match(output,/成功/);assert.doesNotMatch(output,/Token失效/);
    assert.equal(attempts,2);assert.equal(refreshes,1);assert.equal(cancelled,true);
  },{tokenManager:manager});
});

test('HTTP 与 SSE 鉴权共用一次重试预算，输出后不重试',async()=>{
  for(const outputFirst of [false,true]) {
    let attempts=0,refreshes=0;
    const manager=new TokenManager({token:'initial',username:'user',password:'mock'},async()=>{refreshes++;return 'refreshed';});
    await withServer(async()=>{
      attempts++;
      if(!outputFirst && attempts===1)return new Response('expired',{status:401});
      return new Response(sse([...(outputFirst?[chunk('部分')]:[]),{success:false,message:'token expired'}]),{headers:{'content-type':'text/event-stream'}});
    },async call=>{
      const res=await call({...request,stream:true});const output=await res.text();
      assert.doesNotMatch(output,/\[DONE\]/);
      assert.equal(attempts,outputFirst?1:2);assert.equal(refreshes,outputFirst?0:1);
      if(outputFirst)assert.match(output,/event: error/);else assert.equal(res.status,401);
    },{tokenManager:manager});
  }
});
test('非流式保留独立推理字段',async()=>{
  const reasoning=chunk('');reasoning.choices[0].delta.reasoning_content='思考片段';
  await withServer(async()=>new Response(sse([reasoning,chunk('回答','stop')]),{headers:{'Content-Type':'text/event-stream'}}),async call=>{
    const body=await(await call()).json();assert.equal(body.choices[0].message.reasoning_content,'思考片段');assert.equal(body.choices[0].message.content,'回答');
  });
});
test('工具调用通过 HTTP 转换为 function call，流式也正常结束',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
  for(const stream of [false,true]) await withServer(async(url,options)=>{
    assert.match(JSON.parse(options.body).chatInfo,/Tool declarations/);
    return new Response(sse([chunk('<tool_call>{"name":"weather","arguments":{"city":"上海"}}</tool_call>','stop')]),{headers:{'Content-Type':'text/event-stream'}});
  },async call=>{
    const res=await call({...request,tools,tool_choice:'required',stream});assert.equal(res.status,200);
    if(stream){const output=await res.text();assert.match(output,/tool_calls/);assert.match(output,/\[DONE\]/);}
    else{const output=await res.json();assert.equal(output.choices[0].finish_reason,'tool_calls');assert.equal(output.choices[0].message.tool_calls[0].function.name,'weather');}
  });
});
