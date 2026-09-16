import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, events, upstreamBody } from '../src/server.mjs';
import { TokenManager } from '../src/auth.mjs';
import { listenForFetch, confirmedModels } from './fixtures.mjs';

const config = { key: 'local-test', token: 'upstream-test', group: 'test-group', timeout: 2000, netGo: false };
const request = { model: 'qwen-instruct', messages: [{role:'user',content:'你好'}] };
const chunk = (content, finish = null) => ({ id:'chatcmpl-test', object:'chat.completion.chunk', model:'qwen-instruct', created:123, choices:[{index:0,delta:{content},finish_reason:finish}] });
const sse = values => values.map(v => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`).join('');
async function withServer(fetcher, fn, overrides = {}) {
  const server = createServer({...config,...overrides}, fetcher, overrides.modelFetcher || confirmedModels, overrides.tokenManager, overrides.imageFetcher);
  await listenForFetch(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (body = request, key = config.key) => fetch(`${base}/v1/chat/completions`, {method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try { await fn(call, base); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
test('图片输入上传后转换为 Webchat 图片字段',async()=>{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  let uploads=0;
  await withServer(async(_,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.chatInfo,'看图');assert.equal(body.imageUrl,'https://genaipic.shanghaitech.edu.cn/sys/common/static/test.png');assert.deepEqual(body.imageUrls,[body.imageUrl]);
    return new Response(sse([chunk('图片','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const response=await call({...request,messages:[{role:'user',content:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:`data:image/png;base64,${png}`}}]}]});assert.equal(response.status,200);
  },{uploadToken:'upload-token',imageFetcher:async()=>{uploads++;return new Response(JSON.stringify({success:true,result:{url:'test.png',width:1,height:1}}),{headers:{'content-type':'application/json'}});}});
  assert.equal(uploads,1);
});
test('转换当前输入与历史，保留配置', () => {
  const body = upstreamBody({...request,messages:[{role:'user',content:'旧问题'},{role:'assistant',content:'旧回答'},...request.messages]},config);
  assert.equal(body.chatInfo,'你好'); assert.equal(body.messages.length,2); assert.equal(body.netGo,false); assert.equal(body.chatGroupId,'test-group');
  assert.throws(()=>upstreamBody({...request,tools:[{}]},config),/function/);
  assert.equal(upstreamBody({...request,messages:[{role:'system',content:'指令'},...request.messages]},config).messages[0].role,'system');
  assert.equal('chatGroupId' in upstreamBody(request,{...config,group:''}),false);
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
    const text=await res.text(); assert.equal(text.split('[DONE]').length,2); assert.match(text,/chat.completion.chunk/);
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
test('Kimi 原生 thinking 配置优先于 reasoning_effort',()=>{
  const catalogue=[{id:'kimi-k3',upstream_id:'Kimi-k3',root_ai_type:'xinference',max_tokens:800000}];
  const body=upstreamBody({model:'kimi-k3',messages:[{role:'user',content:'推理'}],thinking:{type:'enabled',keep:'all',effort:'low'},reasoning_effort:'max'},config,catalogue);
  assert.match(body.chatInfo,/low reasoning effort/);assert.doesNotMatch(body.chatInfo,/max reasoning effort/);
});

test('Anthropic token 计数支持 x-api-key 且不访问上游',async()=>{
  await withServer(async()=>{throw new Error('不应访问上游');},async(call,base)=>{
    const response=await fetch(base+'/v1/messages/count_tokens',{method:'POST',headers:{'x-api-key':config.key,'content-type':'application/json'},body:JSON.stringify({model:'qwen-instruct',messages:[{role:'user',content:'你好'}]})});
    assert.equal(response.status,200);assert.ok((await response.json()).input_tokens>0);
  });
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
test('thinking disabled 在 JSON 和 SSE 中隐藏上游推理',async()=>{
  await withServer(async()=>{
    const reasoning=chunk('');reasoning.choices[0].delta.reasoning_content='内部思考';
    return new Response(sse([reasoning,chunk('回答','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async call=>{
    const base={...request,thinking:{type:'disabled',keep:'none',effort:'high'}};
    const json=await(await call(base)).json();assert.equal(json.choices[0].message.content,'回答');assert.equal(json.choices[0].message.reasoning_content,undefined);
    const streamed=await(await call({...base,stream:true})).text();assert.match(streamed,/回答/);assert.doesNotMatch(streamed,/内部思考|reasoning_content/);
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
test('parallel_tool_calls=false 拒绝多个模型工具调用',async()=>{
  const tools=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
  await withServer(async()=>new Response(sse([chunk('<tool_call>[{"name":"weather","arguments":{}},{"name":"weather","arguments":{}}]</tool_call>','stop')]),{headers:{'content-type':'text/event-stream'}}),async call=>{
    assert.equal((await call({...request,tools,parallel_tool_calls:false})).status,502);
  });
});
