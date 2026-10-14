import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, events, upstreamBody, manageContextMessages, parseRetryAfter, guardedEvents } from '../src/server.mjs';
import { UpstreamCircuit } from '../src/circuit.mjs';
import { TokenManager } from '../src/auth.mjs';
import { listenForFetch, confirmedModels } from './fixtures.mjs';

const config = { key: 'local-test', token: 'upstream-test', group: 'test-group', timeout: 2000, netGo: false };
const request = { model: 'qwen-instruct', messages: [{role:'user',content:'你好'}] };
const chunk = (content, finish = null) => ({ id:'chatcmpl-test', object:'chat.completion.chunk', model:'qwen-instruct', created:123, choices:[{index:0,delta:{content},finish_reason:finish}] });
const sse = values => values.map(v => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`).join('');

test('无 v1 前缀的兼容路径保留鉴权、模型预算和跨路径幂等',async()=>{
  let calls=0;
  const server=createServer(config,async()=>{calls++;return new Response(sse([chunk('你好'),chunk('', 'stop')]),{headers:{'content-type':'text/event-stream'}});},confirmedModels);
  await listenForFetch(server);
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
  try{
    assert.equal((await fetch(`${base}/models`)).status,401);
    const listing=await(await fetch(`${base}/models`,{headers})).json();assert.equal(listing.data[0].id,'qwen-instruct');
    assert.equal(listing.data[0].max_completion_tokens,4096);
    assert.equal(listing.data[0].context_window,16384);
    assert.equal(listing.data[0].max_tokens,4096);
    assert.equal(listing.data[0].max_output_tokens,4096);
    assert.deepEqual(listing.data[0].limit,{context:16384,output:4096});
    const model=await(await fetch(`${base}/models/qwen-instruct`,{headers})).json();assert.equal(model.max_completion_tokens,4096);
    const options={method:'POST',headers:{...headers,'idempotency-key':'alias-roundtrip'},body:JSON.stringify(request)};
    const first=await(await fetch(`${base}/chat/completions`,options)).json();
    const repeated=await(await fetch(`${base}/v1/chat/completions`,options)).json();
    assert.equal(first.choices[0].message.content,'你好');assert.equal(repeated.id,first.id);assert.equal(calls,1);
    const estimate=await fetch(`${base}/tokenizers/estimate-token-count`,{method:'POST',headers,body:JSON.stringify(request)});
    assert.equal(estimate.status,200);assert.ok((await estimate.json()).data.total_tokens>0);assert.equal(calls,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('提前结束半开探测流不会清除熔断故障记录',async()=>{
  let now=1000,closed=false;
  const circuit=new UpstreamCircuit(1,1000,()=>now);
  circuit.failure('kimi-k3');now+=1000;
  const source=(async function*(){try{yield 'first';yield 'last';}finally{closed=true;}})();
  const probe=guardedEvents(source,circuit,'kimi-k3');
  assert.deepEqual(await probe.next(),{value:'first',done:false});
  await probe.return();
  assert.equal(closed,true);
  assert.equal(circuit.enter('kimi-k3'),1);
  assert.equal(circuit.enter('qwen-instruct'),0);
  now+=1000;
  const recovered=guardedEvents((async function*(){yield 'complete';})(),circuit,'kimi-k3');
  assert.deepEqual(await Array.fromAsync(recovered),['complete']);
  assert.equal(circuit.states.has('kimi-k3'),false);
});

test('提前结束普通流会保留未达到阈值的故障记录',async()=>{
  const circuit=new UpstreamCircuit(2,1000);
  circuit.failure('kimi-k3');
  const source=guardedEvents((async function*(){yield 'first';yield 'last';})(),circuit,'kimi-k3');
  await source.next();await source.return();
  circuit.failure('kimi-k3');
  assert.ok(circuit.enter('kimi-k3')>0);
});
test('上下文截断保留完整工具轮次、最近请求和关键错误',()=>{
  const messages=[
    {role:'system',content:'必须遵守仓库规则'},
    {role:'user',content:'运行测试'},
    {role:'assistant',content:null,tool_calls:[{id:'call_test',type:'function',function:{name:'shell',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'call_test',content:`开始\n${'普通日志\n'.repeat(1000)}ERROR: test failed at src/main.ts:3\n${'普通日志\n'.repeat(1000)}`},
    {role:'user',content:'继续修复'}
  ];
  const compact=manageContextMessages(messages,1200,'agent');
  assert.equal(compact[0].role,'system');assert.equal(compact.at(-1).content,'继续修复');
  assert.equal(compact.some(message=>message.role==='assistant'&&message.tool_calls),compact.some(message=>message.role==='tool'));
  assert.ok(compact.some(message=>message.role==='tool'&&message.content.includes('ERROR: test failed')));
  assert.ok(compact.some(message=>message.role==='tool'&&message.content.includes('middle omitted')));
  const recent=manageContextMessages(messages,1200,'recent');
  assert.equal(recent.some(message=>message.role==='assistant'&&message.tool_calls),recent.some(message=>message.role==='tool'));
});
test('agent 上下文策略可跳过冗长旧轮次并保留更早的测试错误',()=>{
  const messages=[{role:'system',content:'规则'},{role:'developer',content:'开发规范'},
    {role:'user',content:'ERROR: test failed at src/main.ts:3'},{role:'assistant',content:'待修复'},
    {role:'user',content:'普通背景'.repeat(1000)},{role:'assistant',content:'收到'},
    {role:'user',content:'继续'}];
  const agent=manageContextMessages(messages,200,'agent');
  const recent=manageContextMessages(messages,200,'recent');
  assert.ok(agent.some(message=>message.content?.includes('test failed')));
  assert.ok(!recent.some(message=>message.content?.includes('test failed')));
  assert.ok(agent.some(message=>message.role==='developer'&&message.content==='开发规范'));
  assert.equal(agent.at(-1).content,'继续');
});
test('最新轮次的大型工具结果会继续压缩且保留调用与错误',()=>{
  const messages=[
    {role:'system',content:'按测试错误修复'},
    {role:'user',content:'运行测试'},
    {role:'assistant',content:null,tool_calls:[{id:'call_test',type:'function',function:{name:'shell',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'call_test',content:`开始\n${'普通输出\n'.repeat(5000)}ERROR: test failed at src/main.ts:3\n${'普通输出\n'.repeat(5000)}`}
  ];
  const compact=manageContextMessages(messages,250,'agent');
  assert.equal(compact.find(message=>message.role==='assistant').tool_calls[0].id,'call_test');
  const result=compact.find(message=>message.role==='tool');
  assert.equal(result.tool_call_id,'call_test');
  assert.match(result.content,/test failed at src\/main\.ts:3/);
  assert.ok(result.content.length<512);
});
test('Chat 自动缩减长历史，关闭后明确拒绝超长输入',async()=>{
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:200}]}});
  const messages=[{role:'user',content:'旧内容'.repeat(500)},{role:'assistant',content:'旧回答'},{role:'user',content:'新问题'}];
  let calls=0;
  await withServer(async(_url,options)=>{
    calls++;
    const body=JSON.parse(options.body);
    assert.equal(body.messages.some(message=>message.content?.includes('旧内容')),false);
    assert.equal(body.chatInfo,'新问题');
    return new Response(sse([chunk('完成','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({model:'qwen-instruct',messages,max_tokens:30});assert.equal(response.status,200);
  },{modelFetcher,contextAuto:true});
  assert.equal(calls,1);
  await withServer(async()=>{calls++;throw new Error('超长请求不应调用上游');},async call=>{
    const response=await call({model:'qwen-instruct',messages,max_tokens:30});
    assert.equal(response.status,400);
    assert.equal((await response.json()).error.param,'messages');
  },{modelFetcher,contextAuto:false});
  assert.equal(calls,1);
});
test('最新请求仍超过模型窗口时明确拒绝且不调用上游',async()=>{
  let calls=0;
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:200}]}});
  await withServer(async()=>{calls++;return new Response(sse([chunk('unexpected','stop')]),{headers:{'content-type':'text/event-stream'}});},async call=>{
    const response=await call({model:'qwen-instruct',messages:[{role:'user',content:'代码'.repeat(2000)}],max_tokens:30});
    assert.equal(response.status,400);
    const payload=await response.json();
    assert.equal(payload.error.param,'messages');
    assert.match(payload.error.message,/上下文窗口/);
  },{modelFetcher});
  assert.equal(calls,0);
});
test('Retry-After 同时解析秒数和 HTTP 日期',()=>{
  const now=Date.UTC(2026,8,28,12,0,0);
  assert.equal(parseRetryAfter('2.5',now),2500);
  assert.equal(parseRetryAfter(new Date(now+5000).toUTCString(),now),5000);
  assert.equal(parseRetryAfter('invalid',now),null);
  assert.equal(parseRetryAfter(null,now),null);
});

test('上下文预算同时保留 max_completion_tokens 输出额度并截断旧历史',async()=>{
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:600}]}});
  let attempts=0;
  await withServer(async(_url,options)=>{
    attempts++;const body=JSON.parse(options.body);
    assert.equal(body.maxToken,400);assert.equal(body.messages.some(message=>message.content?.includes('旧背景')),false);
    assert.equal(body.chatInfo,'新请求');return new Response(sse([chunk('完成','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,max_completion_tokens:400,messages:[{role:'user',content:'旧背景'.repeat(80)},{role:'assistant',content:'收到'},{role:'user',content:'新请求'}]});
    assert.equal(response.status,200);
  },{modelFetcher});
  assert.equal(attempts,1);
});

test('超出窗口的工具提示词在发送上游前返回明确错误',async()=>{
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:600}]}});
  let attempts=0;
  await withServer(async()=>{attempts++;throw new Error('超出窗口不应发送上游');},async call=>{
    const response=await call({...request,max_tokens:30,tools:[{type:'function',function:{name:'inspect',description:'工具说明'.repeat(1000),parameters:{type:'object',properties:{}}}}]});
    assert.equal(response.status,400);const payload=await response.json();
    assert.equal(payload.error.param,'messages');assert.match(payload.error.message,/工具定义/);
  },{modelFetcher});
  assert.equal(attempts,0);
});

test('输入本身在窗口内但加显式输出额度超限时拒绝',async()=>{
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:600}]}});
  await withServer(async()=>{throw new Error('超出窗口不应发送上游');},async call=>{
    const response=await call({...request,max_completion_tokens:500,messages:[{role:'user',content:'代码'.repeat(100)}]});
    assert.equal(response.status,400);
    const failure=(await response.json()).error;
    assert.equal(failure.param,'messages');assert.equal(failure.code,'context_length_exceeded');
    assert.match(failure.message,/预留输出 500 tokens/);assert.match(failure.message,/上下文上限 600 tokens/);
  },{modelFetcher});
});

test('四种模型和别名均区分上下文与输出额度，按发现值请求可正常回答',async()=>{
  let calls=0;
  const records=[
    {aiType:'chatglm',aiName:'GLM-5.3-Flash',maxToken:524288},
    {aiType:'deepseek-pro',aiName:'DeepSeek-V4.1-Flash',maxToken:524288},
    {aiType:'qwen-instruct',aiName:'Qwen-3.8',maxToken:524288},
    {aiType:'Kimi-k3',aiName:'Kimi-K3',maxToken:1048576}
  ].map(record=>({...record,rootAiType:'xinference'}));
  const expected=new Map([['chatglm',[524288,16384]],['deepseek-pro',[524288,16384]],['qwen-instruct',[524288,16384]],['Kimi-k3',[1048576,131072]]]);
  const modelFetcher=async()=>({success:true,result:{records}});
  await withServer(async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);assert.equal(body.maxToken,expected.get(body.aiType)[1]);
    return new Response(sse([chunk('完成','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(call,base)=>{
    const headers={authorization:`Bearer ${config.key}`};
    const listing=await(await fetch(`${base}/v1/models`,{headers})).json();
    assert.equal(listing.data.length,4);
    for(const record of records){
      const id=record.aiType.toLowerCase(),model=listing.data.find(item=>item.id===id);
      const [context,output]=expected.get(record.aiType);
      assert.equal(model.context_window,context);
      for(const name of ['max_tokens','max_output_tokens','max_completion_tokens'])assert.equal(model[name],output);
      assert.deepEqual(model.limit,{context,output});
      const alias=record.aiName.toLowerCase();
      for(const selected of new Set([id,record.aiType,alias])){
        const detail=await(await fetch(`${base}/v1/models/${selected}`,{headers})).json();
        assert.equal(detail.context_window,context);assert.equal(detail.max_tokens,output);
        const response=await call({model:selected,messages:[{role:'user',content:'请检查项目'}],max_tokens:detail.max_tokens});
        assert.equal(response.status,200);
      }
    }
  },{modelFetcher});
  assert.equal(calls,8);
});

test('未指定输出上限时为小窗口模型保留输入空间',async()=>{
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:600}]}});
  await withServer(async(_url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.maxToken,150);
    return new Response(sse([chunk('完成','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{assert.equal((await call(request)).status,200);},{modelFetcher});
});
test('上游要求长时间限流时直接转发 Retry-After，不抢先重试',async()=>{
  let attempts=0;
  await withServer(async()=>{attempts++;return new Response('',{status:429,headers:{'retry-after':'60'}});},async call=>{
    const response=await call();assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');
  },{upstreamRetries:2,timeout:5000});
  assert.equal(attempts,1);
});
test('上游 502、503、504 的等待时间透传给客户端',async()=>{
  for(const status of [502,503,504]){
    let attempts=0;
    await withServer(async()=>{attempts++;return new Response('',{status,headers:{'retry-after':'60'}});},async call=>{
      const response=await call();assert.equal(response.status,status);assert.equal(response.headers.get('retry-after'),'60');
    },{upstreamRetries:2,timeout:5000});
    assert.equal(attempts,1);
  }
});
test('连续上游故障触发按模型熔断并返回等待时间',async()=>{
  let attempts=0;
  await withServer(async()=>{attempts++;return new Response('',{status:503});},async call=>{
    assert.equal((await call()).status,503);
    assert.equal((await call()).status,503);
    const blocked=await call();assert.equal(blocked.status,503);assert.equal(blocked.headers.get('retry-after'),'1');
  },{upstreamRetries:0,breakerFailures:2,breakerCooldown:1000});
  assert.equal(attempts,2);
});
test('损坏的上游 SSE 被计入模型熔断',async()=>{
  let attempts=0;
  await withServer(async()=>{attempts++;return new Response('data: not-json\n\n',{headers:{'content-type':'text/event-stream'}});},async call=>{
    assert.equal((await call()).status,502);
    assert.equal((await call()).status,502);
    const blocked=await call();assert.equal(blocked.status,503);
    assert.equal(blocked.headers.get('retry-after'),'1');
  },{upstreamRetries:0,breakerFailures:2,breakerCooldown:1000});
  assert.equal(attempts,2);
});
test('缺少完成标记的 SSE 被计入模型熔断',async()=>{
  let attempts=0;
  await withServer(async()=>{attempts++;return new Response(sse([chunk('未完成')]),{headers:{'content-type':'text/event-stream'}});},async call=>{
    assert.equal((await call()).status,502);
    assert.equal((await call()).status,502);
    assert.equal((await call()).status,503);
  },{upstreamRetries:0,breakerFailures:2,breakerCooldown:1000});
  assert.equal(attempts,2);
});
test('模型专属队列让其他模型在空闲全局槽位继续运行',async()=>{
  let releaseKimi,markStarted,kimiCalls=0;
  const kimiGate=new Promise(resolve=>{releaseKimi=resolve;});
  const started=new Promise(resolve=>{markStarted=resolve;});
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'Kimi-k3',rootAiType:'xinference'},{aiType:'qwen-instruct',rootAiType:'xinference'}]}});
  await withServer(async(_url,options)=>{
    const model=JSON.parse(options.body).aiType;
    if(model==='Kimi-k3'&&++kimiCalls===1){markStarted();await kimiGate;}
    return new Response(sse([chunk('完成','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(_call,base)=>{
    const send=model=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'x'}]})});
    const first=send('kimi-k3');
    try{
      await started;
      const second=send('kimi-k3');
      assert.equal((await send('qwen-instruct')).status,200);
      assert.equal(kimiCalls,1);
      releaseKimi();
      assert.equal((await first).status,200);assert.equal((await second).status,200);
    }finally{releaseKimi();}
  },{modelFetcher,concurrency:2,modelLimits:{'Kimi-k3':{concurrency:1,queue:1}}});
});
async function withServer(fetcher, fn, overrides = {}) {
  const server = createServer({...config,...overrides}, fetcher, overrides.modelFetcher || confirmedModels, overrides.tokenManager, overrides.imageFetcher,overrides.frontendFetcher);
  await listenForFetch(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (body = request, key = config.key) => fetch(`${base}/v1/chat/completions`, {method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try { await fn(call, base); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
test('未配置会话 ID 时每个请求生成网页式 ID，显式 ID 保持不变',async()=>{
  const groups=[];
  await withServer(async(_url,options)=>{
    groups.push(JSON.parse(options.body).chatGroupId);
    return new Response(sse([chunk('好','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    for(const body of [request,request,{...request,chat_group_id:'custom-group'}])assert.equal((await call(body)).status,200);
  },{group:''});
  assert.match(groups[0],/^[A-Za-z0-9_-]{21}$/);
  assert.match(groups[1],/^[A-Za-z0-9_-]{21}$/);
  assert.notEqual(groups[0],groups[1]);
  assert.equal(groups[2],'custom-group');
});
test('损坏的 JSON 指向 body，且不会请求学校模型',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;return new Response(sse([chunk('unexpected','stop')]),{headers:{'content-type':'text/event-stream'}});},async(_call,base)=>{
    const response=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json'},body:'{"model":'});
    assert.equal(response.status,400);
    const payload=await response.json();assert.equal(payload.error.param,'body');assert.equal(payload.error.code,'invalid_request');
  });
  assert.equal(calls,0);
});
test('幂等键重放同一 Chat 响应，并拒绝相同键的不同请求体',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;return new Response(sse([chunk('完成','stop')]),{headers:{'content-type':'text/event-stream'}});},async(_call,base)=>{
    const send=(body,key)=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
    const first=await send(request,'chat-retry-1');const original=await first.json();
    const second=await send(request,'chat-retry-1');const replay=await second.json();
    assert.equal(first.status,200);assert.equal(second.status,200);assert.match(second.headers.get('content-type'),/^application\/json/);assert.deepEqual(replay,original);assert.equal(calls,1);
    const reordered=await send({messages:[{content:'你好',role:'user'}],model:'qwen-instruct'},'chat-retry-1');
    assert.equal(reordered.status,200);assert.deepEqual(await reordered.json(),original);assert.equal(calls,1);
    const conflict=await send({...request,messages:[{role:'user',content:'另一个问题'}]},'chat-retry-1');
    assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.param,'Idempotency-Key');assert.equal(calls,1);
  });
});
test('并发幂等请求只调用一次上游，流式输出可重放',async()=>{
  let release,started,calls=0;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  await withServer(async()=>{calls++;started();await gate;return new Response(sse([chunk('完成','stop'),'[DONE]']),{headers:{'content-type':'text/event-stream'}});},async(_call,base)=>{
    const send=()=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json','Idempotency-Key':'stream-retry-1'},body:JSON.stringify({...request,stream:true})});
    const first=send();await entered;const second=send();
    try{release();const [original,replay]=await Promise.all([first,second]);assert.equal(original.status,200);assert.equal(replay.status,200);assert.match(replay.headers.get('content-type'),/^text\/event-stream/);assert.equal(await replay.text(),await original.text());assert.equal(calls,1);}finally{release();}
  });
});
test('流式幂等请求已输出内容后失败时拒绝再次调用模型',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;return new Response(sse([chunk('部分')]),{headers:{'content-type':'text/event-stream'}});},async(_call,base)=>{
    const send=()=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json','Idempotency-Key':'partial-failure-1'},body:JSON.stringify({...request,stream:true})});
    const first=await send();assert.equal(first.status,200);
    const output=await first.text();assert.match(output,/部分/);assert.match(output,/upstream_error/);
    const replay=await send();assert.equal(replay.status,409);
    assert.equal((await replay.json()).error.param,'Idempotency-Key');
  },{upstreamRetries:0});
  assert.equal(calls,1);
});
test('幂等请求已触达上游但响应头尚未发送时失败也不重复调用模型',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;return new Response('',{status:502});},async(_call,base)=>{
    const send=()=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json','Idempotency-Key':'upstream-failure-1'},body:JSON.stringify(request)});
    assert.equal((await send()).status,502);
    const replay=await send();assert.equal(replay.status,409);
    assert.equal((await replay.json()).error.param,'Idempotency-Key');
  },{upstreamRetries:0});
  assert.equal(calls,1);
});
test('幂等请求在响应开始前校验失败不会锁定键',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;return new Response(sse([chunk('成功','stop')]),{headers:{'content-type':'text/event-stream'}});},async(_call,base)=>{
    const send=body=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json','Idempotency-Key':'invalid-then-valid-1'},body:JSON.stringify(body)});
    assert.equal((await send({...request,stream:'yes'})).status,400);
    assert.equal((await send({...request,stream:'yes'})).status,400);
    const valid=await send(request);assert.equal(valid.status,200);
    assert.equal((await valid.json()).choices[0].message.content,'成功');
  });
  assert.equal(calls,1);
});
test('健康检查按需探测真实模型目录，并短时复用探测结果',async()=>{
  let probes=0;
  await withServer(async()=>{throw new Error('健康检查不应发送聊天请求');},async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`};
    const local=await fetch(base+'/health',{headers});assert.equal(local.status,200);assert.equal(probes,0);
    const live=await fetch(base+'/health?upstream=1',{headers});assert.equal(live.status,200);
    const result=await live.json();assert.equal(result.upstream_status,'ok');assert.equal(result.upstream_models,1);
    assert.equal((await fetch(base+'/health?upstream=1',{headers})).status,200);assert.equal(probes,1);
    assert.equal((await fetch(base+'/healthz')).status,200);
  },{modelFetcher:async()=>{probes++;return{success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference'}]}};}});
});
test('首次 CAS 登录和模型目录分别计时，避免合计超时误报不可用',async()=>{
  const slowModel=async()=>{await new Promise(resolve=>setTimeout(resolve,80));return{success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference'}]}};};
  for(const endpoint of ['/health?upstream=1','/v1/models']){
    const manager=new TokenManager({username:'student',password:'password'},async()=>{await new Promise(resolve=>setTimeout(resolve,80));return 'token';});
    await withServer(async()=>{throw new Error('无需聊天请求');},async(_call,base)=>{
      const response=await fetch(base+endpoint,{headers:{authorization:`Bearer ${config.key}`}});
      assert.equal(response.status,200);
      const body=await response.json();
      if(endpoint==='/v1/models')assert.equal(body.data[0].id,'qwen-instruct');
      else assert.equal(body.upstream_status,'ok');
    },{timeout:140,username:'student',password:'password',token:'',tokenManager:manager,modelFetcher:slowModel});
  }
});
test('上游探测失败返回降级状态且不泄露上游错误',async()=>{
  await withServer(async()=>{throw new Error('不应发送聊天请求');},async(_call,base)=>{
    const response=await fetch(base+'/health?upstream=1',{headers:{authorization:`Bearer ${config.key}`}});
    assert.equal(response.status,503);
    const body=await response.json();assert.equal(body.status,'degraded');assert.equal(body.upstream_status,'unavailable');
    assert.doesNotMatch(JSON.stringify(body),/private upstream detail/);
  },{modelFetcher:async()=>{throw new Error('private upstream detail');}});
});
test('Prometheus 指标需要本地密钥且仅含低基数标签',async()=>{
  await withServer(async()=>{throw new Error('不应访问上游');},async(_call,base)=>{
    assert.equal((await fetch(base+'/metrics')).status,401);
    await fetch(base+'/healthz');
    const response=await fetch(base+'/metrics',{headers:{authorization:`Bearer ${config.key}`}});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/plain/);
    const body=await response.text();
    assert.match(body,/shtech_http_requests_total\{method="GET",status="401"\} 1/);
    assert.match(body,/shtech_http_request_duration_seconds_bucket\{le="\+Inf"\}/);
    assert.match(body,/shtech_queue_active 0/);
    assert.doesNotMatch(body,/healthz|\/metrics|local-test|upstream-test/);
  });
});
test('错误响应提供请求 ID、稳定错误码和鉴权头',async()=>{
  await withServer(async()=>{throw new Error('不应调用上游');},async(_call,base)=>{
    const unauthorized=await fetch(`${base}/v1/models`,{headers:{'x-request-id':'client-request-1'}}),body=await unauthorized.json();
    assert.equal(unauthorized.status,401);assert.equal(unauthorized.headers.get('x-request-id'),'client-request-1');assert.match(unauthorized.headers.get('www-authenticate'),/Bearer/);
    assert.equal(body.error.type,'authentication_error');assert.equal(body.error.code,'invalid_api_key');assert.equal(body.error.param,null);
    const generated=await fetch(`${base}/missing`,{headers:{authorization:`Bearer ${config.key}`}});assert.match(generated.headers.get('x-request-id'),/^req_[a-f0-9]+$/);
    const missing=await generated.json();assert.equal(missing.error.code,'not_found');
  });
});
test('参数校验错误指出客户端需要修正的字段',async()=>{
  await withServer(async()=>{throw new Error('无效请求不应访问上游');},async(call,base)=>{
    for(const [body,param] of [
      [{...request,model:'unknown-model'},'model'],
      [{...request,stream:'yes'},'stream'],
      [{...request,tools:{}},'tools'],
      [{...request,tool_choice:'required'},'tool_choice'],
      [{...request,max_tokens:0},'max_tokens'],
      [{...request,unsupported_option:true},'unsupported_option']
    ]){
      const response=await call(body),payload=await response.json();
      assert.equal(response.status,400,JSON.stringify(body));
      assert.equal(payload.error.param,param,JSON.stringify(body));
    }
    const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json'},body:JSON.stringify({model:'qwen-instruct',input:'你好',max_output_tokens:0})});
    assert.equal(response.status,400);
    assert.equal((await response.json()).error.param,'max_output_tokens');
  });
});

test('Anthropic 路径及别名的鉴权错误提供 SDK 请求 ID 和 CORS 可见性',async()=>{
  await withServer(async()=>{throw new Error('鉴权失败不应访问上游');},async(_call,base)=>{
    for(const path of ['/v1/messages','/anthropic/v1/messages','/v1/messages/count_tokens','/anthropic/v1/messages/count_tokens']){
      const response=await fetch(`${base}${path}`,{method:'POST',headers:{'content-type':'application/json','x-request-id':'anthropic-trace-1',origin:'https://client.example'},body:'{}'});
      assert.equal(response.status,401);assert.equal(response.headers.get('request-id'),'anthropic-trace-1');
      assert.equal(response.headers.get('x-request-id'),'anthropic-trace-1');
      assert.match(response.headers.get('access-control-expose-headers'),/(?:^|,\s*)Request-Id(?:,|$)/);
    }
  },{corsOrigin:'https://client.example'});
});
test('图片输入上传后转换为 Webchat 图片字段',async()=>{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  let uploads=0;
  await withServer(async(_,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.chatInfo,'看图\n[Image attached]');assert.equal(body.imageUrl,'https://genaipic.shanghaitech.edu.cn/sys/common/static/test.png');assert.deepEqual(body.imageUrls,[body.imageUrl]);
    return new Response(sse([chunk('图片','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,messages:[{role:'user',content:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:`data:image/png;base64,${png}`}}]}]});assert.equal(response.status,200);
  },{uploadToken:'upload-token',imageFetcher:async()=>{uploads++;return new Response(JSON.stringify({success:true,result:{url:'test.png',width:1,height:1}}),{headers:{'content-type':'application/json'}});}});
  assert.equal(uploads,1);
});
test('自动缩减历史后不再上传被丢弃轮次的图片',async()=>{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:2000}]}});
  let uploads=0;
  await withServer(async(_,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.chatInfo,'查看新图\n[Image attached]');
    assert.equal(body.messages.some(message=>message.content?.includes('旧图')),false);
    assert.equal(body.imageUrls.length,1);
    return new Response(sse([chunk('已查看','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const image={type:'image_url',image_url:{url:`data:image/png;base64,${png}`}};
    const response=await call({model:'qwen-instruct',max_tokens:30,messages:[
      {role:'user',content:[{type:'text',text:'旧图'.repeat(500)},image]},
      {role:'assistant',content:'已查看旧图'},
      {role:'user',content:[{type:'text',text:'查看新图'},image]}
    ]});
    assert.equal(response.status,200);
  },{modelFetcher,uploadToken:'retained-image-test-token',imageFetcher:async()=>{
    uploads++;return new Response(JSON.stringify({success:true,result:{url:`test-${uploads}.png`}}),{headers:{'content-type':'application/json'}});
  }});
  assert.equal(uploads,1);
});
test('图片成本超过模型窗口时在上传前拒绝请求',async()=>{
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:200}]}});
  let calls=0,uploads=0;
  await withServer(async()=>{calls++;return new Response(sse([chunk('unexpected','stop')]),{headers:{'content-type':'text/event-stream'}});},async call=>{
    const response=await call({model:'qwen-instruct',max_tokens:30,messages:[{role:'user',content:[{type:'text',text:'查看图片'},{type:'image_url',image_url:'https://example.com/a.png'}]}]});
    assert.equal(response.status,400);
    assert.equal((await response.json()).error.param,'messages');
  },{modelFetcher,imageFetcher:async()=>{uploads++;throw new Error('图片不应上传');}});
  assert.equal(calls,0);assert.equal(uploads,0);
});
test('原生文件模式先上传至学校会话再提交 fileIds',async()=>{
  const calls=[];
  await withServer(async(url,options)=>{
    calls.push(new URL(url).pathname);
    if(new URL(url).pathname==='/htk/chat/upload/chat/file'){
      assert.equal(new URL(url).searchParams.get('chatGroupId'),'test-group');
      assert.equal(new URL(url).searchParams.get('aiType'),'qwen-instruct');
      assert.match(options.headers['Content-Type'],/^multipart\/form-data; boundary=/);
      assert.ok(options.body.includes(Buffer.from('source code')));
      return new Response(JSON.stringify({success:true,result:{fileId:'school-file-1'}}),{headers:{'content-type':'application/json'}});
    }
    const body=JSON.parse(options.body);
    assert.deepEqual(body.fileIds,['school-file-1']);
    assert.match(body.chatInfo,/main\.ts/);
    assert.doesNotMatch(body.chatInfo,/source code/);
    return new Response(sse([chunk('收到','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const file_data=`data:text/plain;base64,${Buffer.from('source code').toString('base64')}`;
    const response=await call({...request,messages:[{role:'user',content:[{type:'text',text:'审查附件'},{type:'file',file:{filename:'main.ts',file_data}}]}]});
    assert.equal(response.status,200);
  },{nativeFileUpload:true});
  assert.deepEqual(calls,['/htk/chat/upload/chat/file','/htk/chat/start/chat']);
});
test('Responses 后台任务可轮询完成并保留输入项',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await withServer(async()=>{await gate;return new Response(sse([chunk('后台完成','stop')]),{headers:{'content-type':'text/event-stream'}});},async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const created=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:'长任务',background:true})})).json();
    assert.equal(created.status,'queued');assert.equal(created.background,true);assert.equal(created.store,true);assert.match(created.id,/^resp_/);
    const pending=await(await fetch(`${base}/v1/responses/${created.id}`,{headers})).json();assert.ok(['queued','in_progress'].includes(pending.status));
    release();let completed;
    for(let i=0;i<100;i++){completed=await(await fetch(`${base}/v1/responses/${created.id}`,{headers})).json();if(completed.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(completed.status,'completed');assert.equal(completed.id,created.id);assert.equal(completed.background,true);assert.equal(completed.output_text,'后台完成');
    const items=await(await fetch(`${base}/v1/responses/${created.id}/input_items`,{headers})).json();assert.equal(items.data[0].content[0].text,'长任务');
  });
});

test('Responses 输入项列表支持相邻游标分页',async()=>{
  await withServer(async()=>new Response(sse([chunk('完成','stop')]),{headers:{'content-type':'text/event-stream'}}),async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const input=Array.from({length:5},(_,index)=>({role:'user',content:[{type:'input_text',text:`item ${index}`}]}));
    const response=await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input})});
    assert.equal(response.status,200);const created=await response.json();
    const url=`${base}/v1/responses/${created.id}/input_items`;
    const all=await(await fetch(`${url}?order=asc&limit=100`,{headers})).json();
    assert.equal(all.data.length,5);
    const first=await(await fetch(`${url}?order=asc&limit=2`,{headers})).json();
    assert.deepEqual(first.data.map(item=>item.id),all.data.slice(0,2).map(item=>item.id));assert.equal(first.has_more,true);
    const next=await(await fetch(`${url}?order=asc&limit=2&after=${first.last_id}`,{headers})).json();
    assert.deepEqual(next.data.map(item=>item.id),all.data.slice(2,4).map(item=>item.id));
    const previous=await(await fetch(`${url}?order=asc&limit=2&before=${all.last_id}`,{headers})).json();
    assert.deepEqual(previous.data.map(item=>item.id),all.data.slice(2,4).map(item=>item.id));
  });
});

test('Responses 后台流可在断开后按序号续传',async()=>{
  await withServer(async()=>new Response(sse([chunk('后台'),chunk('续传','stop'),'[DONE]']),{headers:{'content-type':'text/event-stream'}}),async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const response=await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:'长任务',background:true,stream:true})});
    assert.match(response.headers.get('content-type'),/text\/event-stream/);
    const iterator=events(response.body)[Symbol.asyncIterator](),received=[];
    received.push((await iterator.next()).value,(await iterator.next()).value);
    await iterator.return();
    const first=received.map(item=>JSON.parse(item.data));
    assert.equal(received[0].event,'response.queued');assert.equal(first[0].sequence_number,0);
    const after=first.at(-1).sequence_number;
    const resumed=await fetch(`${base}/v1/responses/${first[0].response.id}?stream=true&starting_after=${after}`,{headers});
    const rest=await Array.fromAsync(events(resumed.body)),values=rest.map(item=>JSON.parse(item.data));
    assert.ok(values.length);assert.ok(values.every(value=>value.sequence_number>after));
    assert.deepEqual(values.map(value=>value.sequence_number),values.map(value=>value.sequence_number).toSorted((a,b)=>a-b));
    assert.equal(rest.at(-1).event,'response.completed');assert.equal(values.at(-1).response.id,first[0].response.id);
    assert.equal(values.at(-1).response.output_text,'后台续传');assert.equal(values.at(-1).response.background,true);
    assert.equal((await fetch(`${base}/v1/responses/${first[0].response.id}?stream=true&starting_after=nope`,{headers})).status,400);
  });
});

test('Responses 后台任务可以取消和删除',async()=>{
  await withServer(async(_url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason||new Error('aborted')),{once:true})),async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const created=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:'等待',background:true})})).json();
    const cancelled=await(await fetch(`${base}/v1/responses/${created.id}/cancel`,{method:'POST',headers})).json();assert.equal(cancelled.status,'cancelled');
    const stored=await(await fetch(`${base}/v1/responses/${created.id}`,{headers})).json();assert.equal(stored.status,'cancelled');
    const frames=await Array.fromAsync(events((await fetch(`${base}/v1/responses/${created.id}?stream=true`,{headers})).body));assert.equal(frames.at(-1).event,'response.cancelled');
    assert.equal((await fetch(`${base}/v1/responses/${created.id}`,{method:'DELETE',headers})).status,200);
    assert.equal((await fetch(`${base}/v1/responses/${created.id}`,{headers})).status,404);
  });
});

test('Conversations 管理对话项并自动绑定 Responses 历史',async()=>{
  await withServer(async(_url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.chatInfo,'继续');assert.equal(body.messages[0].content,'旧问题');
    return new Response(sse([chunk('新回答','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const created=await(await fetch(`${base}/v1/conversations`,{method:'POST',headers,body:JSON.stringify({metadata:{project:'demo'},items:[{type:'message',role:'user',content:'旧问题'}]})})).json();
    assert.match(created.id,/^conv_/);assert.equal(created.metadata.project,'demo');
    const before=await(await fetch(`${base}/v1/conversations/${created.id}/items?order=asc`,{headers})).json();assert.equal(before.data.length,1);
    const response=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',conversation:created.id,input:'继续'})})).json();
    assert.equal(response.conversation.id,created.id);assert.equal(response.output_text,'新回答');
    const after=await(await fetch(`${base}/v1/conversations/${created.id}/items?order=asc`,{headers})).json();assert.equal(after.data.length,3);assert.equal(after.data.at(-1).role,'assistant');
    const item=await(await fetch(`${base}/v1/conversations/${created.id}/items/${after.data[1].id}`,{headers})).json();assert.equal(item.role,'user');
    assert.equal((await fetch(`${base}/v1/conversations/${created.id}/items/${after.data[0].id}`,{method:'DELETE',headers})).status,200);
    const updated=await(await fetch(`${base}/v1/conversations/${created.id}`,{method:'POST',headers,body:JSON.stringify({metadata:{project:'updated'}})})).json();assert.equal(updated.metadata.project,'updated');
    assert.equal((await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',conversation:created.id,previous_response_id:'resp_x',input:'x'})})).status,400);
    const removed=await(await fetch(`${base}/v1/conversations/${created.id}`,{method:'DELETE',headers})).json();assert.equal(removed.object,'conversation.deleted');
  });
});

test('Responses compact 生成可续用状态并提供输入 token 计数',async()=>{
  let calls=0;
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'Kimi-k3',simpleName:'Kimi-K3',maxToken:800000,rootAiType:'xinference'}]}});
  await withServer(async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);
    if(calls===1){assert.equal(body.aiType,'Kimi-k3');assert.match(body.chatInfo,/compact state/i);return new Response(sse([chunk('保留项目约束和未完成任务','stop')]),{headers:{'content-type':'text/event-stream'}});}
    assert.ok(body.messages.some(message=>message.role==='system'&&message.content.includes('保留项目约束')));
    return new Response(sse([chunk('已继续','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const compacted=await(await fetch(`${base}/v1/responses/compact`,{method:'POST',headers,body:JSON.stringify({input:'旧任务'})})).json();
    assert.equal(compacted.object,'response.compaction');assert.equal(compacted.output.at(-1).type,'compaction');assert.match(compacted.output.at(-1).encrypted_content,/^cmpstate_/);
    const counted=await(await fetch(`${base}/v1/responses/input_tokens`,{method:'POST',headers,body:JSON.stringify({model:'kimi-k3',input:compacted.output})})).json();
    assert.equal(counted.object,'response.input_tokens');assert.ok(counted.input_tokens>0);
    const continued=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'kimi-k3',input:[...compacted.output,{type:'message',role:'user',content:'继续'}]})})).json();
    assert.equal(continued.output_text,'已继续');assert.equal(calls,2);
  },{modelFetcher});
});

test('Responses compact 未指定模型时使用当前目录默认模型，并尊重显式选择',async()=>{
  for(const kimiAvailable of [false,true]){
    const routed=[];
    const modelFetcher=async()=>({success:true,result:{records:[
      {aiType:'cloud-kimi',aiName:'Kimi-K3',rootAiType:'azure',maxToken:1048576},
      {aiType:'campus-code',rootAiType:'xinference',maxToken:65536},
      ...(kimiAvailable?[{aiType:'school-kimi-route',aiName:'Kimi-K3',rootAiType:'xinference',maxToken:1048576}]:[])
    ]}});
    await withServer(async(_url,options)=>{
      const body=JSON.parse(options.body);routed.push(body.aiType);
      assert.equal(body.rootAiType,'xinference');
      return new Response(sse([chunk('项目状态','stop')]),{headers:{'content-type':'text/event-stream'}});
    },async(_call,base)=>{
      const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
      for(const model of [undefined,'campus-code']){
        const response=await fetch(`${base}/v1/responses/compact`,{method:'POST',headers,body:JSON.stringify({model,input:'旧任务'})});
        assert.equal(response.status,200);
        assert.equal((await response.json()).object,'response.compaction');
      }
    },{modelFetcher});
    assert.deepEqual(routed,[kimiAvailable?'school-kimi-route':'campus-code','campus-code']);
  }
});
test('Vector Stores API 为 Responses file_search 注入检索结果',async()=>{
  const searched=[];
  await withServer(async(_url,options)=>{
    const body=JSON.parse(options.body);searched.push(body.messages.some(message=>message.role==='system'&&message.content.includes('blue-green deployment')));assert.equal(body.chatInfo,'How should production be deployed?');
    return new Response(sse([chunk('Use blue-green deployment.','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(_call,base)=>{
    const auth={authorization:`Bearer ${config.key}`},jsonHeaders={...auth,'content-type':'application/json'};
    const form=new FormData();form.set('purpose','assistants');form.set('file',new File(['Production uses blue-green deployment and keeps the previous image for rollback.'],'runbook.md',{type:'text/markdown'}));
    const file=await(await fetch(`${base}/v1/files`,{method:'POST',headers:auth,body:form})).json();
    const store=await(await fetch(`${base}/v1/vector_stores`,{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'runbooks',file_ids:[file.id]})})).json();
    assert.match(store.id,/^vs_/);assert.equal(store.file_counts.completed,1);
    const search=await(await fetch(`${base}/v1/vector_stores/${store.id}/search`,{method:'POST',headers:jsonHeaders,body:JSON.stringify({query:'production deployment'})})).json();assert.equal(search.data[0].filename,'runbook.md');
    const response=await(await fetch(`${base}/v1/responses`,{method:'POST',headers:jsonHeaders,body:JSON.stringify({model:'qwen-instruct',input:'How should production be deployed?',tools:[{type:'file_search',vector_store_ids:[store.id]}],include:['file_search_call.results'],store:false})})).json();
    assert.equal(response.output_text,'Use blue-green deployment.');const call=response.output.find(item=>item.type==='file_search_call');assert.equal(call.status,'completed');assert.equal(call.results[0].file_id,file.id);
    const disabled=await(await fetch(`${base}/v1/responses`,{method:'POST',headers:jsonHeaders,body:JSON.stringify({model:'qwen-instruct',input:'How should production be deployed?',tools:[{type:'file_search',vector_store_ids:[store.id]}],tool_choice:'none',store:false})})).json();
    assert.equal(disabled.output.some(item=>item.type==='file_search_call'),false);
    const required=await(await fetch(`${base}/v1/responses`,{method:'POST',headers:jsonHeaders,body:JSON.stringify({model:'qwen-instruct',input:'How should production be deployed?',tools:[{type:'file_search',vector_store_ids:[store.id]}],tool_choice:'required',store:false})})).json();
    assert.ok(required.output.some(item=>item.type==='file_search_call'));
    assert.deepEqual(searched,[true,false,true]);
    const listed=await(await fetch(`${base}/v1/vector_stores/${store.id}/files`,{headers:auth})).json();assert.equal(listed.data[0].id,file.id);
    assert.equal((await fetch(`${base}/v1/vector_stores/${store.id}`,{method:'DELETE',headers:auth})).status,200);
  });
});
test('Responses 默认保存 reasoning，并用 item_reference 续接 OpenCode 会话',async()=>{
  let calls=0;
  await withServer(async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);
    if(calls===1){
      const thought=chunk('');thought.choices[0].delta.reasoning_content='先检查项目结构';
      return new Response(sse([thought,chunk('第一轮完成','stop')]),{headers:{'content-type':'text/event-stream'}});
    }
    if(calls===2)assert.match(JSON.stringify(body.messages),/Reasoning summary/);
    else assert.equal(body.messages.find(message=>message.reasoning_content)?.reasoning_content,'先检查项目结构');
    assert.match(JSON.stringify(body.messages),/先检查项目结构/);
    return new Response(sse([chunk('第二轮完成','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const first=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:'开始'})})).json();
    assert.equal(first.store,true);const reasoning=first.output.find(item=>item.type==='reasoning');assert.match(reasoning.encrypted_content,/^enc_/);
    assert.equal((await fetch(`${base}/v1/responses/${first.id}`,{headers})).status,200);
    const second=await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:[{type:'item_reference',id:reasoning.id},{type:'message',role:'user',content:'继续'}]})});
    assert.equal(second.status,200);assert.equal((await second.json()).output_text,'第二轮完成');assert.equal(calls,2);
    const continued=await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',previous_response_id:first.id,input:'按原思路继续'})});
    assert.equal(continued.status,200);assert.equal((await continued.json()).output_text,'第二轮完成');assert.equal(calls,3);
  });
});
test('Responses store false 返回可回放 reasoning，过期引用不会中断当前请求',async()=>{
  let calls=0;
  await withServer(async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);
    if(calls===1){const thought=chunk('');thought.choices[0].delta.reasoning_content='无状态推理';return new Response(sse([thought,chunk('结果','stop')]),{headers:{'content-type':'text/event-stream'}});}
    if(calls===2){assert.match(JSON.stringify(body.messages),/无状态推理/);return new Response(sse([chunk('已回放','stop')]),{headers:{'content-type':'text/event-stream'}});}
    assert.doesNotMatch(JSON.stringify(body.messages),/rs_missing/);
    assert.match(JSON.stringify(body.messages),/previous response item is unavailable/);
    return new Response(sse([chunk('已恢复','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const first=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:'开始',store:false})})).json();
    assert.equal(first.store,false);const reasoning=first.output.find(item=>item.type==='reasoning');assert.match(reasoning.encrypted_content,/^enc_/);
    assert.equal((await fetch(`${base}/v1/responses/${first.id}`,{headers})).status,404);
    const replay={type:'reasoning',encrypted_content:reasoning.encrypted_content};
    const second=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',store:false,input:[replay,{type:'message',role:'user',content:'继续'}]})})).json();
    assert.equal(second.output_text,'已回放');
    const editAt=20,tampered=`${reasoning.encrypted_content.slice(0,editAt)}${reasoning.encrypted_content[editAt]==='A'?'B':'A'}${reasoning.encrypted_content.slice(editAt+1)}`;
    const invalid=await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',store:false,input:[{type:'reasoning',encrypted_content:tampered},{type:'message',role:'user',content:'继续'}]})});
    assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.param,'input');
    const stale=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:[{type:'item_reference',id:'rs_missing'},{type:'message',role:'user',content:'恢复'}]})})).json();
    assert.equal(stale.output_text,'已恢复');assert.equal(calls,3);
  });
});
test('转换当前输入与历史，保留配置', () => {
  const body = upstreamBody({...request,messages:[{role:'user',content:'旧问题'},{role:'assistant',content:'旧回答'},...request.messages]},config);
  assert.equal(body.chatInfo,'你好'); assert.equal(body.messages.length,2); assert.equal(body.netGo,false); assert.equal(body.chatGroupId,'test-group');
  assert.throws(()=>upstreamBody({...request,tools:[{}]},config),/function/);
  assert.equal(upstreamBody({...request,messages:[{role:'system',content:'指令'},...request.messages]},config).messages[0].role,'system');
  assert.equal('chatGroupId' in upstreamBody(request,{...config,group:''}),false);
});

test('目录与健康探测遇到登录过期时续登一次再读取自部署模型',async()=>{
  for(const endpoint of ['/v1/models','/health?upstream=1']){
    let logins=0,reads=0;
    const manager=new TokenManager({token:'old-token',username:'student',password:'password'},async()=>{logins++;return 'new-token';});
    await withServer(async()=>{throw new Error('目录检查不应调用聊天');},async(_call,base)=>{
      const response=await fetch(base+endpoint,{headers:{authorization:`Bearer ${config.key}`}});
      assert.equal(response.status,200);
      const body=await response.json();
      if(endpoint==='/v1/models')assert.equal(body.data[0].id,'qwen-instruct');
      else assert.equal(body.upstream_status,'ok');
      assert.equal(logins,1);assert.equal(reads,2);
    },{tokenManager:manager,modelFetcher:async token=>{
      reads++;
      if(reads===1){assert.equal(token,'old-token');throw Object.assign(new Error('expired'),{status:401});}
      assert.equal(token,'new-token');return confirmedModels();
    }});
  }
});

test('模型目录续登有上限，权限错误及固定 token 不触发续登',async()=>{
  for(const [status,renewable,expectedReads,expectedLogins] of [[401,true,2,1],[403,true,1,0],[401,false,1,0]]){
    let reads=0,logins=0;
    const manager=new TokenManager({token:'old-token',...(renewable?{username:'student',password:'password'}:{})},async()=>{logins++;return 'new-token';});
    await withServer(async()=>{throw new Error('不应调用聊天');},async(_call,base)=>{
      const response=await fetch(base+'/v1/models',{headers:{authorization:`Bearer ${config.key}`}});
      assert.equal(response.status,503);assert.equal(reads,expectedReads);assert.equal(logins,expectedLogins);
    },{tokenManager:manager,modelFetcher:async()=>{reads++;throw Object.assign(new Error('rejected'),{status});}});
  }
});

test('首次目录故障不猜测模型，拒绝聊天且不访问聊天上游',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;throw new Error('must not call');},async(call,base)=>{
    const list=await fetch(`${base}/v1/models`,{headers:{authorization:`Bearer ${config.key}`}});
    assert.equal(list.status,503);assert.equal((await list.json()).error.code,'service_unavailable');
    assert.equal((await fetch(`${base}/v1/models/qwen-instruct`,{headers:{authorization:`Bearer ${config.key}`}})).status,503);
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
test('忽略上游元数据事件并保留最终 usage',async()=>{
  await withServer(async()=>new Response(sse([{other:{trace:'x'}},chunk('好','stop'),{usage:{prompt_tokens:2,completion_tokens:1}}]),{headers:{'content-type':'text/event-stream'}}),async call=>{
    const result=await(await call()).json();assert.equal(result.choices[0].message.content,'好');assert.equal(result.usage.total_tokens,3);
  });
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
    const frames=await Array.fromAsync(events(res.body));assert.equal(frames.at(-1).data,'[DONE]');
    assert.equal(frames.filter(frame=>frame.data==='[DONE]').length,1);
    assert.ok(frames.slice(0,-1).every(frame=>JSON.parse(frame.data).choices[0].delta.role==='assistant'));
    assert.equal(frames.map(frame=>frame.data).join('').includes('chat.completion.chunk'),true);
  });
});
test('Legacy Completions 支持 JSON 和 SSE 文本格式',async()=>{
  await withServer(async()=>new Response(sse([chunk('42'),chunk('','stop'),'[DONE]']),{headers:{'content-type':'text/event-stream'}}),async(call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const json=await fetch(base+'/v1/completions',{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',prompt:'answer = '})});
    const value=await json.json();assert.equal(value.object,'text_completion');assert.equal(value.choices[0].text,'42');
    const stream=await fetch(base+'/v1/completions',{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',prompt:'answer = ',stream:true})});
    const frames=await Array.fromAsync(events(stream.body));assert.equal(JSON.parse(frames[0].data).choices[0].text,'42');assert.equal(frames.at(-1).data,'[DONE]');
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
test('Chat choice 始终提供空 logprobs，缺失 usage 时标注估算详情',async()=>{
  await withServer(async()=>new Response(sse([chunk('答'),chunk('案','stop'),'[DONE]']),{headers:{'content-type':'text/event-stream'}}),async call=>{
    const json=await call({...request,logprobs:null,top_logprobs:null});
    assert.equal(json.status,200);assert.equal(json.headers.get('x-usage-source'),'estimate');
    const completion=await json.json();assert.equal(completion.choices[0].logprobs,null);
    assert.equal(completion.usage.prompt_tokens_details.cached_tokens,0);
    assert.equal(completion.usage.completion_tokens_details.reasoning_tokens,0);
    const stream=await call({...request,stream:true,stream_options:{include_usage:true}});
    const frames=(await Array.fromAsync(events(stream.body))).filter(item=>item.data!=='[DONE]').map(item=>JSON.parse(item.data));
    assert.ok(frames.filter(frame=>frame.choices.length).every(frame=>frame.choices[0].logprobs===null));
    assert.equal(frames.at(-1).usage.completion_tokens_details.reasoning_tokens,0);
  });
});
test('常见采样参数透传，兼容旧版 functions',()=>{
  const normalized={...request,temperature:.7,top_p:.8,top_k:20,min_p:0,presence_penalty:1.5,repetition_penalty:1,seed:7,n:1,logprobs:false};
  const body=upstreamBody(normalized,config);
  for(const key of ['temperature','top_p','top_k','min_p','presence_penalty','repetition_penalty','seed'])assert.equal(body[key],normalized[key]);
  assert.throws(()=>upstreamBody({...request,n:2},config),/n 仅支持 1/);
});
test('推理强度和回答长度转换为上游提示',()=>{
  const body=upstreamBody({...request,reasoning_effort:'high',verbosity:'low'},config);
  assert.match(body.chatInfo,/high reasoning effort/);assert.match(body.chatInfo,/low response verbosity/);
});
test('Kimi K3 支持 max 推理、长输出、保留思考和 Partial Mode',()=>{
  const catalogue=[{id:'kimi-k3',upstream_id:'Kimi-k3',root_ai_type:'xinference',max_tokens:800000,capabilities:{vision:true,reasoning:true,partial:true}}];
  const body=upstreamBody({model:'kimi-k3',messages:[{role:'user',content:'写结论'},{role:'assistant',content:'Conclusion: ',reasoning_content:'先归纳',partial:true}],max_completion_tokens:131072,reasoning_effort:'max'},config,catalogue);
  assert.equal(body.aiType,'Kimi-k3');assert.equal(body.maxToken,131072);assert.match(body.chatInfo,/max reasoning effort/);assert.match(body.chatInfo,/Continue from/);
  assert.equal(body.messages.at(-1).content,'Conclusion: ');assert.equal(body.messages.at(-1).reasoning_content,'先归纳');assert.equal('partial' in body.messages.at(-1),false);
  assert.throws(()=>upstreamBody({model:'kimi-k3',messages:[{role:'user',content:'x'}],max_completion_tokens:800001},config,catalogue),/800000/);
});
test('Kimi 路由 ID 更新后仍应用推理等级映射和长输出默认值',()=>{
  const catalogue=[{id:'school-kimi-route',upstream_id:'school-kimi-route',display_name:'Kimi-K3',root_ai_type:'xinference',max_tokens:1048576}];
  const body=upstreamBody({model:'school-kimi-route',messages:[{role:'user',content:'推理'}],reasoning_effort:'medium'},config,catalogue);
  assert.equal(body.aiType,'school-kimi-route');
  assert.equal(body.rootAiType,'xinference');
  assert.equal(body.maxToken,131072);
  assert.match(body.chatInfo,/high reasoning effort/);
});

test('Kimi 原生 thinking 配置优先于 reasoning_effort',()=>{
  const catalogue=[{id:'kimi-k3',upstream_id:'Kimi-k3',root_ai_type:'xinference',max_tokens:800000}];
  const body=upstreamBody({model:'kimi-k3',messages:[{role:'user',content:'推理'}],thinking:{type:'enabled',keep:'all',effort:'low'},reasoning_effort:'max'},config,catalogue);
  assert.match(body.chatInfo,/low reasoning effort/);assert.doesNotMatch(body.chatInfo,/max reasoning effort/);
});
test('网页深度思考开关仅发送给明确支持的模型',()=>{
  const messages=[{role:'user',content:'分析问题'}];
  const supported=[{id:'kimi-k3',upstream_id:'Kimi-k3',root_ai_type:'xinference',webchat_thinking:true}];
  const unsupported=[{id:'kimi-k3',upstream_id:'Kimi-k3',root_ai_type:'xinference'}];
  assert.equal(upstreamBody({model:'kimi-k3',messages,thinking:{type:'enabled'}},config,supported).thinking,true);
  assert.equal(upstreamBody({model:'kimi-k3',messages,thinking:{type:'disabled'}},config,supported).thinking,false);
  assert.equal(upstreamBody({model:'kimi-k3',messages,reasoning_effort:'none'},config,supported).thinking,false);
  assert.doesNotMatch(upstreamBody({model:'kimi-k3',messages,thinking:{type:'disabled',effort:'high'}},config,supported).chatInfo,/reasoning effort/);
  assert.doesNotMatch(upstreamBody({model:'kimi-k3',messages,reasoning_effort:'none'},config,supported).chatInfo,/reasoning effort/);
  assert.equal(upstreamBody({model:'kimi-k3',messages,thinking:{type:'enabled'},reasoning_effort:'none'},config,supported).thinking,true);
  assert.equal('thinking' in upstreamBody({model:'kimi-k3',messages},config,supported),false);
  assert.equal('thinking' in upstreamBody({model:'kimi-k3',messages,thinking:{type:'enabled'}},config,unsupported),false);
});

test('Anthropic token 计数支持 x-api-key 且不访问上游',async()=>{
  await withServer(async()=>{throw new Error('不应访问上游');},async(call,base)=>{
    const response=await fetch(base+'/v1/messages/count_tokens',{method:'POST',headers:{'x-api-key':config.key,'content-type':'application/json'},body:JSON.stringify({model:'qwen-instruct',messages:[{role:'user',content:'你好'}]})});
    assert.equal(response.status,200);assert.ok((await response.json()).input_tokens>0);
  });
});

test('token 估算读取附件正文和图片成本且不上传或调用聊天上游',async()=>{
  await withServer(async()=>{throw new Error('估算不应调用聊天上游');},async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const form=new FormData();form.append('file',new File(['x'.repeat(4000)],'large.txt',{type:'text/plain'}));
    const uploaded=await fetch(base+'/v1/files',{method:'POST',headers:{authorization:`Bearer ${config.key}`},body:form});
    assert.equal(uploaded.status,200);const file=await uploaded.json();
    const requests=[
      ['/v1/messages/count_tokens',{model:'qwen-instruct',messages:[{role:'user',content:[{type:'document',source:{type:'file',file_id:file.id}}]}]},value=>value.input_tokens],
      ['/v1/responses/input_tokens',{model:'qwen-instruct',input:[{role:'user',content:[{type:'input_file',file_id:file.id}]}]},value=>value.input_tokens],
      ['/v1/tokenizers/estimate-token-count',{model:'qwen-instruct',messages:[{role:'user',content:[{type:'file',file:{file_id:file.id}}]}]},value=>value.data.total_tokens]
    ];
    for(const [path,body,count] of requests){
      const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
      assert.equal(response.status,200);assert.equal(response.headers.get('x-usage-source'),'estimate');
      assert.ok(count(await response.json())>1000,path);
    }
    const image=await fetch(base+'/v1/messages/count_tokens',{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',messages:[{role:'user',content:[{type:'image',source:{type:'url',url:'https://example.com/a.png'}}]}]})});
    assert.equal(image.status,200);assert.ok((await image.json()).input_tokens>=1024);
  },{imageFetcher:async()=>{throw new Error('估算不应下载或上传图片');}});
});
test('Kimi token 估算端点和 Anthropic 官方路径别名可用',async()=>{
  const models={modelFetcher:async()=>({success:true,result:{records:[{aiType:'Kimi-k3',simpleName:'Kimi-K3',maxToken:800000,rootAiType:'xinference'}]}})};
  await withServer(async()=>new Response(sse([chunk('好','stop')]),{headers:{'content-type':'text/event-stream'}}),async(call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const estimate=await fetch(base+'/v1/tokenizers/estimate-token-count',{method:'POST',headers,body:JSON.stringify({model:'kimi-k3',messages:[{role:'user',content:'你好'}]})});
    assert.equal(estimate.status,200);assert.ok((await estimate.json()).data.total_tokens>0);
    const message=await fetch(base+'/anthropic/v1/messages',{method:'POST',headers:{'x-api-key':config.key,'content-type':'application/json'},body:JSON.stringify({model:'kimi-k3',max_tokens:64,messages:[{role:'user',content:'你好'}]})});
    assert.equal(message.status,200);assert.equal((await message.json()).content[0].text,'好');
  },models);
});
test('截断流不伪装成功',async()=>{
  for(const stream of [false,true]) await withServer(async()=>new Response(sse([chunk('部分内容')]),{headers:{'Content-Type':'text/event-stream'}}),async call=>{
    const res=await call({...request,stream}); const text=await res.text();
    if(stream) {assert.match(text,/"error"/);assert.doesNotMatch(text,/\[DONE\]/);} else assert.equal(res.status,502);
  });
});
test('登录失败、不正确内容类型和本地鉴权',async()=>{
  for(const response of [new Response('secret',{status:401}),new Response('<html>login</html>')]) await withServer(async()=>response,async call=>{
    const res=await call(); assert.ok([401,502].includes(res.status)); assert.doesNotMatch(await res.text(),/secret|<html>/);
  });
  await withServer(()=>{throw new Error('不应访问上游');},async call=>assert.equal((await call(request,'wrong')).status,401));
});
test('OpenAI 接口接受 api-key 本地鉴权头',async()=>{
  await withServer(async()=>new Response(sse([chunk('好','stop')]),{headers:{'content-type':'text/event-stream'}}),async(call,base)=>{
    const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'api-key':config.key,'content-type':'application/json'},body:JSON.stringify(request)});assert.equal(response.status,200);
  });
});
test('CORS 默认关闭，配置后处理浏览器预检',async()=>{
  await withServer(async()=>{throw new Error('不应访问上游');},async(call,base)=>{
    const response=await fetch(base+'/v1/chat/completions',{method:'OPTIONS',headers:{origin:'http://localhost:3000','access-control-request-method':'POST'}});
    assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),'http://localhost:3000');
  },{corsOrigin:'http://localhost:3000'});
});
test('错误事件不会被当作回答',async()=>{
  await withServer(async()=>new Response('event: error\ndata: {"message":"private upstream detail"}\n\n',{headers:{'Content-Type':'text/event-stream'}}),async call=>{
    const res=await call();assert.equal(res.status,502);assert.doesNotMatch(await res.text(),/private/);
  });
});
test('超时中断上游',async()=>{
  await withServer((url,opts)=>new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('abort')))),async call=>assert.equal((await call()).status,504),{timeout:20});
});
test('队列关闭时忙碌请求返回 429，完成后释放会话',async()=>{
  let release;
  const ready = new Promise(resolve=>{release=resolve;});
  let started;
  const entered = new Promise(resolve=>{started=resolve;});
  await withServer(async()=>{started();await ready;return new Response(sse([chunk('完成','stop')]),{headers:{'Content-Type':'text/event-stream'}});},async call=>{
    const first=call();await entered;
    assert.equal((await call()).status,429);
    release();assert.equal((await first).status,200);
    assert.equal((await call()).status,200);
  },{queueSize:0});
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
test('模型发现只列规范 ID，旧别名仍可查询和调用',async()=>{
  const modelFetcher=async()=>({success:true,result:{records:[
    {aiType:'qwen-instruct',aiName:'Qwen-3.8',rootAiType:'xinference',status:3},
    {aiType:'Kimi-k3',aiName:'Kimi-K3',rootAiType:'xinference',status:3},
    {aiType:'vendor/code_v2',rootAiType:'xinference',status:3},
    {aiType:'gpt-6-sol',rootAiType:'azure',status:3},
  ]}});
  const routed=[];
  await withServer(async(_url,options)=>{
    routed.push(JSON.parse(options.body).aiType);
    return new Response(sse([chunk('好','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(call,base)=>{
    const headers={Authorization:`Bearer ${config.key}`};
    const listing=await(await fetch(`${base}/v1/models`,{headers})).json();
    assert.deepEqual(listing.data.map(model=>model.id),['qwen-instruct','kimi-k3','vendor/code_v2']);
    assert.equal((await(await fetch(`${base}/v1/models/qwen-3.8`,{headers})).json()).id,'qwen-3.8');
    assert.equal((await(await fetch(`${base}/v1/models/vendor%2Fcode_v2`,{headers})).json()).id,'vendor/code_v2');
    assert.equal((await call({...request,model:'qwen-3.8'})).status,200);
    assert.equal((await call({...request,model:'vendor/code_v2'})).status,200);
  },{modelFetcher});
  assert.deepEqual(routed,['qwen-instruct','vendor/code_v2']);
});
test('未传模型时从已确认的学校目录选择默认模型',async()=>{
  const routed=[];
  const modelFetcher=async()=>({success:true,result:{records:[
    {aiType:'gpt-6-sol',rootAiType:'azure',status:3},
    {aiType:'vendor/code_v2',rootAiType:'xinference',status:3},
  ]}});
  await withServer(async(_url,options)=>{
    routed.push(JSON.parse(options.body).aiType);
    return new Response(sse([chunk('好','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({messages:request.messages});
    assert.equal(response.status,200);
    assert.equal((await response.json()).model,'vendor/code_v2');
  },{modelFetcher});
  assert.deepEqual(routed,['vendor/code_v2']);
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
test('上游在输出前的临时故障有限重试',async()=>{
  let attempts=0;
  await withServer(async()=>++attempts<3?new Response('',{status:503}):new Response(sse([chunk('恢复','stop')]),{headers:{'content-type':'text/event-stream'}}),async call=>{
    const response=await call();assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,'恢复');assert.equal(attempts,3);
  },{upstreamRetries:2,timeout:5000});
});
test('上游连接在响应前重置时有限重试，证书错误不重试',async()=>{
  let attempts=0;
  await withServer(async()=>{
    if(++attempts===1)throw Object.assign(new Error('connection reset'),{code:'ECONNRESET'});
    return new Response(sse([chunk('恢复','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call();assert.equal(response.status,200);
    assert.equal((await response.json()).choices[0].message.content,'恢复');
  },{upstreamRetries:2,timeout:5000});
  assert.equal(attempts,2);
  attempts=0;
  await withServer(async()=>{attempts++;throw Object.assign(new Error('certificate invalid'),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});},async call=>{
    assert.equal((await call()).status,502);
  },{upstreamRetries:2,timeout:5000});
  assert.equal(attempts,1);
});
test('SSE 首事件前断流可重试，已输出事件后不重放',async()=>{
  let attempts=0;
  await withServer(async()=>{
    if(++attempts===1)return new Response(new ReadableStream({pull(controller){controller.error(Object.assign(new Error('stream reset'),{code:'ECONNRESET'}));}}),{headers:{'content-type':'text/event-stream'}});
    return new Response(sse([chunk('恢复','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call();assert.equal(response.status,200);
    assert.equal((await response.json()).choices[0].message.content,'恢复');
  },{upstreamRetries:2,timeout:5000});
  assert.equal(attempts,2);
  attempts=0;
  let failUpstream;
  await withServer(async()=>{
    attempts++;
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode(sse([chunk('部分')])));
      failUpstream=()=>controller.error(Object.assign(new Error('stream reset'),{code:'ECONNRESET'}));
    }}),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,stream:true});assert.equal(response.status,200);
    const reader=response.body.getReader(),decoder=new TextDecoder();let output='';
    while(!output.includes('部分')){const part=await reader.read();assert.equal(part.done,false);output+=decoder.decode(part.value,{stream:true});}
    failUpstream();
    for(let part;!(part=await reader.read()).done;)output+=decoder.decode(part.value,{stream:true});
    assert.match(output,/upstream_error/);
  },{upstreamRetries:2,timeout:5000});
  assert.equal(attempts,1);
});
test('首个 choices 前只有元数据时断流可重试且不沿用旧用量',async()=>{
  let attempts=0;
  await withServer(async()=>{
    if(++attempts===1){
      let reads=0;
      return new Response(new ReadableStream({pull(controller){
        if(reads++===0)controller.enqueue(new TextEncoder().encode(sse([{usage:{prompt_tokens:999,completion_tokens:999}}])));
        else controller.error(Object.assign(new Error('stream reset'),{code:'ECONNRESET'}));
      }}),{headers:{'content-type':'text/event-stream'}});
    }
    return new Response(sse([chunk('恢复','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call();assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.choices[0].message.content,'恢复');
    assert.notEqual(result.usage.prompt_tokens,999);
  },{upstreamRetries:1,timeout:5000});
  assert.equal(attempts,2);
});
test('上游返回空 SSE 时使用同一重试预算',async()=>{
  let attempts=0;
  await withServer(async()=>++attempts===1
    ?new Response('',{headers:{'content-type':'text/event-stream'}})
    :new Response(sse([chunk('恢复','stop')]),{headers:{'content-type':'text/event-stream'}}),async call=>{
    const response=await call();assert.equal(response.status,200);
    assert.equal((await response.json()).choices[0].message.content,'恢复');
  },{upstreamRetries:1,timeout:5000});
  assert.equal(attempts,2);
  await withServer(async()=>new Response('',{headers:{'content-type':'text/event-stream'}}),async call=>{
    const response=await call();assert.equal(response.status,502);
    assert.equal((await response.json()).error.code,'upstream_error');
  },{upstreamRetries:0,timeout:5000});
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
      if(outputFirst)assert.match(output,/"error"/);else assert.equal(res.status,401);
    },{tokenManager:manager});
  }
});
test('非流式保留独立推理字段',async()=>{
  const reasoning=chunk('');reasoning.choices[0].delta.reasoning_content='思考片段';
  await withServer(async()=>new Response(sse([reasoning,chunk('回答','stop')]),{headers:{'Content-Type':'text/event-stream'}}),async call=>{
    const body=await(await call()).json();assert.equal(body.choices[0].message.reasoning_content,'思考片段');assert.equal(body.choices[0].message.content,'回答');
  });
});
test('兼容上游 reasoning 与 thinking 推理字段',async()=>{
  for(const field of ['reasoning','thinking'])await withServer(async()=>{
    const reasoning=chunk('');reasoning.choices[0].delta[field]='思考';return new Response(sse([reasoning,chunk('回答','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>assert.equal((await(await call()).json()).choices[0].message.reasoning_content,'思考'));
});
test('thinking disabled 和 reasoning_effort none 在 JSON 和 SSE 中隐藏上游推理',async()=>{
  await withServer(async()=>{
    const reasoning=chunk('');reasoning.choices[0].delta.reasoning_content='内部思考';
    return new Response(sse([reasoning,chunk('回答','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    for(const setting of [{thinking:{type:'disabled',keep:'none',effort:'high'}},{reasoning_effort:'none'}]){
      const base={...request,...setting};
      const json=await(await call(base)).json();assert.equal(json.choices[0].message.content,'回答');assert.equal(json.choices[0].message.reasoning_content,undefined);
      const streamed=await(await call({...base,stream:true})).text();assert.match(streamed,/回答/);assert.doesNotMatch(streamed,/内部思考|reasoning_content/);
    }
  });
});
test('带工具的 Chat 流即时发送推理片段且结束时不重复',async()=>{
  const first=chunk('');first.choices[0].delta.reasoning_content='先看';
  const second=chunk('');second.choices[0].delta.reasoning_content='工具';
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
  await withServer(async()=>new Response(sse([first,second,chunk('继续','stop')]),{headers:{'content-type':'text/event-stream'}}),async call=>{
    const response=await call({...request,tools,stream:true});
    const frames=(await response.text()).split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
    assert.deepEqual(frames.flatMap(frame=>frame.choices?.map(choice=>choice.delta?.reasoning_content).filter(Boolean)||[]),['先看','工具']);
    assert.equal(frames.flatMap(frame=>frame.choices?.map(choice=>choice.delta?.content).filter(Boolean)||[]).join(''),'继续');
  });
});
test('带工具的 Responses 流也逐片发送推理摘要',async()=>{
  const first=chunk('');first.choices[0].delta.reasoning_content='检查';
  const second=chunk('');second.choices[0].delta.reasoning_content='参数';
  await withServer(async()=>new Response(sse([first,second,chunk('完成','stop')]),{headers:{'content-type':'text/event-stream'}}),async(_call,base)=>{
    const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'qwen-instruct',input:'执行任务',tools:[{type:'function',name:'weather',parameters:{type:'object'}}],stream:true})});
    const frames=(await response.text()).split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
    assert.deepEqual(frames.filter(frame=>frame.type==='response.reasoning_summary_text.delta').map(frame=>frame.delta),['检查','参数']);
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
test('Chat 和 Responses 流在工具标签跨分片时先输出普通文本',async()=>{
  const values=[chunk('前<api_tool_'),chunk('call>{"name":"weather","arguments":{}}'),chunk('</api_tool_call>后','stop')];
  await withServer(async()=>new Response(sse(values),{headers:{'content-type':'text/event-stream'}}),async(call,base)=>{
    const tools=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
    const chat=await call({...request,tools,stream:true});
    const chatFrames=(await Array.fromAsync(events(chat.body))).filter(item=>item.data!=='[DONE]').map(item=>JSON.parse(item.data));
    assert.equal(chatFrames.map(item=>item.choices[0]?.delta?.content||'').join(''),'前后');
    assert.equal(chatFrames.filter(item=>item.choices[0]?.delta?.tool_calls).length,1);
    assert.ok(chatFrames.findIndex(item=>item.choices[0]?.delta?.content==='前')<chatFrames.findIndex(item=>item.choices[0]?.delta?.tool_calls));
    assert.doesNotMatch(JSON.stringify(chatFrames),/<api_tool_call>/);
    const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json'},body:JSON.stringify({model:'qwen-instruct',input:'你好',tools:[{type:'function',name:'weather',parameters:{type:'object'}}],stream:true})});
    const responseFrames=(await Array.fromAsync(events(response.body))).map(item=>JSON.parse(item.data));
    assert.equal(responseFrames.filter(item=>item.type==='response.output_text.delta').map(item=>item.delta).join(''),'前后');
    assert.ok(responseFrames.findIndex(item=>item.type==='response.output_text.delta')<responseFrames.findIndex(item=>item.type==='response.function_call_arguments.delta'));
    assert.equal(responseFrames.at(-1).type,'response.completed');
  });
});
test('Chat 和 Responses 流在 JSON 围栏闭合时立即发送工具调用',async()=>{
  const values=[chunk('先查询\n```json\n{"name":"weather","arguments":{}'),chunk('}\n```'),chunk('后续说明','stop')];
  await withServer(async()=>new Response(sse(values),{headers:{'content-type':'text/event-stream'}}),async(call,base)=>{
    const tools=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
    const chat=await call({...request,tools,stream:true});
    const chatFrames=(await Array.fromAsync(events(chat.body))).filter(item=>item.data!=='[DONE]').map(item=>JSON.parse(item.data));
    const chatCall=chatFrames.findIndex(item=>item.choices[0]?.delta?.tool_calls);
    assert.ok(chatCall>chatFrames.findIndex(item=>item.choices[0]?.delta?.content==='先查询\n'));
    assert.ok(chatCall<chatFrames.findIndex(item=>item.choices[0]?.delta?.content==='后续说明'));
    assert.equal(chatFrames.filter(item=>item.choices[0]?.delta?.tool_calls).length,1);
    const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json'},body:JSON.stringify({model:'qwen-instruct',input:'查询',tools:[{type:'function',name:'weather',parameters:{type:'object'}}],stream:true})});
    const responseFrames=(await Array.fromAsync(events(response.body))).map(item=>JSON.parse(item.data));
    const responseCall=responseFrames.findIndex(item=>item.type==='response.function_call_arguments.delta');
    assert.ok(responseCall>responseFrames.findIndex(item=>item.type==='response.output_text.delta'&&item.delta==='先查询\n'));
    assert.ok(responseCall<responseFrames.findIndex(item=>item.type==='response.output_text.delta'&&item.delta==='后续说明'));
    assert.equal(responseFrames.at(-1).type,'response.completed');
  });
});
test('Chat 流在上游缺失或变更 ID 时保持同一响应标识',async()=>{
  for(const tools of [undefined,[{type:'function',function:{name:'weather',parameters:{type:'object'}}}]]){
    const first={...chunk(tools?'前<api_tool_':'前'),id:undefined,created:undefined};
    const second={...chunk(tools?'call>{"name":"weather","arguments":{}}</api_tool_call>':'后','stop'),id:'upstream-changed',created:999};
    await withServer(async()=>new Response(sse([first,second,'[DONE]']),{headers:{'content-type':'text/event-stream'}}),async call=>{
      const response=await call({...request,...(tools?{tools}:{}),stream:true,stream_options:{include_usage:true}});
      assert.equal(response.status,200);
      const frames=(await Array.fromAsync(events(response.body))).filter(item=>item.data!=='[DONE]').map(item=>JSON.parse(item.data));
      assert.ok(frames.length>=2);
      assert.equal(new Set(frames.map(frame=>frame.id)).size,1);
      assert.equal(new Set(frames.map(frame=>frame.created)).size,1);
      assert.ok(frames[0].id.startsWith('chatcmpl-'));
      assert.ok(frames.every(frame=>frame.model==='qwen-instruct'));
      assert.deepEqual(frames.at(-1).choices,[]);
    });
  }
});
test('可选工具参数修复只额外请求上游一次',async()=>{
  let attempts=0;
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}}];
  await withServer(async(_url,options)=>{
    attempts++;
    if(attempts===2){const correction=JSON.parse(options.body);assert.match(correction.chatInfo,/JSON Schema/);assert.match(correction.messages.at(-1).content,/"city":1/);}
    const answer=attempts===1?'<api_tool_call>{"name":"weather","arguments":{"city":1}}</api_tool_call>':'<api_tool_call>{"name":"weather","arguments":{"city":"上海"}}</api_tool_call>';
    return new Response(sse([chunk(answer,'stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,tools,tool_choice:'required'});
    assert.equal(response.status,200);
    const result=await response.json();assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),{city:'上海'});
  },{outputRepair:true});
  assert.equal(attempts,2);
});
test('Responses Agent 工具字段错误在发送前修复一次',async()=>{
  for(const stream of [false,true]){
    let attempts=0;
    await withServer(async(_url,options)=>{
      attempts++;
      if(attempts===2)assert.match(JSON.parse(options.body).chatInfo,/local_shell\.action/);
      const action={type:'exec',command:['git','status'],timeout_ms:attempts===1?'forever':1000};
      const answer=`<api_tool_call>${JSON.stringify({name:'__openai_local_shell',arguments:{action}})}</api_tool_call>`;
      return new Response(sse([chunk(answer,'stop')]),{headers:{'content-type':'text/event-stream'}});
    },async(_call,base)=>{
      const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json'},body:JSON.stringify({model:'qwen-instruct',input:'检查仓库',tools:[{type:'local_shell'}],stream})});
      assert.equal(response.status,200);
      const result=stream?(await Array.fromAsync(events(response.body))).map(frame=>JSON.parse(frame.data)).at(-1).response:await response.json();
      assert.equal(result.output[0].type,'local_shell_call');
      assert.equal(result.output[0].action.timeout_ms,1000);
    },{outputRepair:true});
    assert.equal(attempts,2);
  }
});
test('流式工具修复缓冲原始文本，修复成功后才输出客户端事件',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}}];
  let attempts=0;
  await withServer(async()=>{attempts++;return new Response(sse([chunk(`<api_tool_call>{"name":"weather","arguments":{"city":${attempts===1?'1':'"上海"'}}}</api_tool_call>`,'stop')]),{headers:{'content-type':'text/event-stream'}});},async call=>{
    const response=await call({...request,tools,stream:true});
    const output=await response.text();assert.match(output,/tool_calls/);assert.match(output,/\[DONE\]/);
  },{outputRepair:true});
  assert.equal(attempts,2);
  attempts=0;
  await withServer(async()=>{attempts++;return new Response(sse(attempts===1?[chunk('原始无效答案'),chunk('<api_tool_call>{"name":"weather","arguments":{"city":1}}</api_tool_call>','stop')]:[chunk('<api_tool_call>{"name":"weather","arguments":{"city":"上海"}}</api_tool_call>','stop')]),{headers:{'content-type':'text/event-stream'}});},async call=>{
    const response=await call({...request,tools,stream:true});
    const output=await response.text();assert.doesNotMatch(output,/原始无效答案|upstream_error/);assert.match(output,/tool_calls/);assert.match(output,/\[DONE\]/);
  },{outputRepair:true});
  assert.equal(attempts,2);
});

test('流式修复不先发送有效调用再重复执行修复后的调用',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}}];
  let attempts=0;
  const valid='<api_tool_call>{"id":"call_first","name":"weather","arguments":{"city":"上海"}}</api_tool_call>';
  const invalid='<api_tool_call>{"name":"weather","arguments":{"city":1}}</api_tool_call>';
  await withServer(async()=>{
    attempts++;return new Response(sse([chunk(valid),chunk(attempts===1?invalid:'','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,tools,stream:true});assert.equal(response.status,200);
    const frames=(await Array.fromAsync(events(response.body))).filter(frame=>frame.data!=='[DONE]').map(frame=>JSON.parse(frame.data));
    const calls=frames.flatMap(frame=>frame.choices?.[0]?.delta?.tool_calls??[]);
    assert.equal(calls.length,1);assert.equal(calls[0].id,'call_first');assert.equal(calls[0].index,0);
  },{outputRepair:true});
  assert.equal(attempts,2);
});
test('可选结构化输出修复携带具体 Schema 错误',async()=>{
  let attempts=0;
  await withServer(async(_url,options)=>{
    attempts++;
    if(attempts===2)assert.match(JSON.parse(options.body).chatInfo,/\$\.name 类型错误/);
    return new Response(sse([chunk(attempts===1?'{"name":3}':'{"name":"修复"}','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,response_format:{type:'json_schema',json_schema:{name:'answer',schema:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}}}});
    assert.equal(response.status,200);assert.equal(JSON.parse((await response.json()).choices[0].message.content).name,'修复');
  },{outputRepair:true});
  assert.equal(attempts,2);
});
test('修复后的答案仍无效时不进行第三次模型调用',async()=>{
  let attempts=0;
  await withServer(async()=>{attempts++;return new Response(sse([chunk('{"name":3}','stop')]),{headers:{'content-type':'text/event-stream'}});},async call=>{
    const response=await call({...request,response_format:{type:'json_schema',json_schema:{name:'answer',schema:{type:'object',properties:{name:{type:'string'}},required:['name']}}}});
    assert.equal(response.status,502);
  },{outputRepair:true});
  assert.equal(attempts,2);
});

test('自动修复按模型窗口缩减无效答案，保留请求及校验错误',async()=>{
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:3000}]}});
  let attempts=0;
  await withServer(async(_url,options)=>{
    attempts++;const body=JSON.parse(options.body);
    if(attempts===2){
      const promptTokens=Math.ceil(Buffer.byteLength(JSON.stringify({messages:body.messages,chatInfo:body.chatInfo}))/3);
      assert.ok(promptTokens+body.maxToken<=3000);
      assert.match(body.chatInfo,/\$\.name 类型错误/);
      assert.ok(body.messages.some(message=>message.role==='user'&&message.content.includes('分析代码')));
      assert.match(body.messages.at(-1).content,/middle omitted/);
      assert.match(body.messages.at(-1).content,/"name":3/);
    }
    return new Response(sse([chunk(attempts===1?JSON.stringify({name:3,padding:'x'.repeat(30000)}):'{"name":"修复"}','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,messages:[{role:'user',content:'分析代码'}],max_tokens:100,response_format:{type:'json_schema',json_schema:{name:'answer',schema:{type:'object',properties:{name:{type:'string'}},required:['name']}}}});
    assert.equal(response.status,200);assert.equal(JSON.parse((await response.json()).choices[0].message.content).name,'修复');
  },{modelFetcher,outputRepair:true});
  assert.equal(attempts,2);
});

test('修复说明和最新请求仍超出窗口时不发送第二次上游请求',async()=>{
  const modelFetcher=async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference',maxToken:300}]}});
  let attempts=0;
  await withServer(async()=>{
    attempts++;return new Response(sse([chunk('{"name":3}','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,max_tokens:150,response_format:{type:'json_schema',json_schema:{name:'answer',schema:{type:'object',properties:{name:{type:'string'}},required:['name']}}}});
    assert.equal(response.status,502);assert.match((await response.json()).error.message,/修复请求超过模型上下文窗口/);
  },{modelFetcher,outputRepair:true});
  assert.equal(attempts,1);
});
test('聚合上游原生工具调用分片并保留 ID',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}}];
  await withServer(async()=>new Response(sse([
    {choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_native',type:'function',function:{name:'weather',arguments:'{"city"'}}]},finish_reason:null}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:':"上海"}'}}]},finish_reason:null}]},
    {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}
  ]),{headers:{'content-type':'text/event-stream'}}),async call=>{
    const response=await call({...request,tools,tool_choice:'required'});assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.choices[0].message.tool_calls[0].id,'call_native');assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),{city:'上海'});
  });
});
test('原生工具参数完整后可在上游结束前发送流式调用',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}}];
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const fragments=[
    {choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_native_early',function:{name:'weather',arguments:'{"city"'}}]},finish_reason:null}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:':"上海"}'}}]},finish_reason:null}]}
  ];
  await withServer(async()=>new Response(new ReadableStream({
    start(controller){
      controller.enqueue(new TextEncoder().encode(sse(fragments)));
      gate.then(()=>{try{controller.enqueue(new TextEncoder().encode(sse([{choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}])));controller.close();}catch{}});
    }
  }),{headers:{'content-type':'text/event-stream'}}),async call=>{
    let timer,reader;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('工具调用未在上游完成前发送')),3000);});
    try{
      const response=await Promise.race([call({...request,tools,stream:true}),timeout]);
      reader=response.body.getReader();
      let wire='';
      while(!wire.includes('call_native_early')){
        const part=await Promise.race([reader.read(),timeout]);
        if(part.done)break;
        wire+=new TextDecoder().decode(part.value);
      }
      assert.match(wire,/call_native_early/);
    }finally{clearTimeout(timer);release();await reader?.cancel();}
  });
});
test('原生工具调用已发送后允许仅含空白的参数尾片',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
  for(const legacy of [false,true]){
    const first=legacy?{function_call:{name:'weather',arguments:'{}'}}:{tool_calls:[{index:0,id:'call_native_space',function:{name:'weather',arguments:'{}'}}]};
    const tail=legacy?{function_call:{arguments:' \n'}}:{tool_calls:[{index:0,function:{arguments:' \n'}}]};
    await withServer(async()=>new Response(sse([
      {choices:[{index:0,delta:first,finish_reason:null}]},
      {choices:[{index:0,delta:tail,finish_reason:null}]},
      {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}
    ]),{headers:{'content-type':'text/event-stream'}}),async call=>{
      const response=await call({...request,tools,stream:true});assert.equal(response.status,200);
      const frames=(await Array.fromAsync(events(response.body))).filter(item=>item.data!=='[DONE]').map(item=>JSON.parse(item.data));
      assert.equal(frames.filter(item=>item.choices[0]?.delta?.tool_calls).length,1);
      assert.equal(frames.at(-1).choices[0].finish_reason,'tool_calls');
    });
  }
});
test('原生工具调用已发送后仍拒绝修改参数',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
  await withServer(async()=>new Response(sse([
    {choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_locked',function:{name:'weather',arguments:'{}'}}]},finish_reason:null}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"changed"'}}]},finish_reason:null}]}
  ]),{headers:{'content-type':'text/event-stream'}}),async call=>{
    const response=await call({...request,tools,stream:true});assert.equal(response.status,200);
    const output=await response.text();assert.match(output,/call_locked/);assert.match(output,/upstream_error/);assert.doesNotMatch(output,/data: \[DONE\]/);
  });
});
test('parallel_tool_calls=false 拒绝多个模型工具调用',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
  await withServer(async()=>new Response(sse([chunk('<tool_call>[{"name":"weather","arguments":{}},{"name":"weather","arguments":{}}]</tool_call>','stop')]),{headers:{'content-type':'text/event-stream'}}),async call=>{
    assert.equal((await call({...request,tools,parallel_tool_calls:false})).status,502);
  });
});
test('流式原生工具调用在发出事件前执行数量限制',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
  const native={choices:[{index:0,delta:{tool_calls:[
    {index:0,id:'call_first',function:{name:'weather',arguments:'{}'}},
    {index:1,id:'call_second',function:{name:'weather',arguments:'{}'}}
  ]},finish_reason:null}]};
  await withServer(async()=>new Response(sse([native,{choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}]),{headers:{'content-type':'text/event-stream'}}),async call=>{
    const response=await call({...request,tools,stream:true,parallel_tool_calls:false});
    assert.equal(response.status,502);
    const body=await response.text();
    assert.doesNotMatch(body,/call_first|call_second/);
  });
});
