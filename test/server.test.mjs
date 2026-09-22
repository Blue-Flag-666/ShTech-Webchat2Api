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
  const server = createServer({...config,...overrides}, fetcher, overrides.modelFetcher || confirmedModels, overrides.tokenManager, overrides.imageFetcher,overrides.frontendFetcher);
  await listenForFetch(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (body = request, key = config.key) => fetch(`${base}/v1/chat/completions`, {method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try { await fn(call, base); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
test('错误响应提供请求 ID、稳定错误码和鉴权头',async()=>{
  await withServer(async()=>{throw new Error('不应调用上游');},async(_call,base)=>{
    const unauthorized=await fetch(`${base}/v1/models`,{headers:{'x-request-id':'client-request-1'}}),body=await unauthorized.json();
    assert.equal(unauthorized.status,401);assert.equal(unauthorized.headers.get('x-request-id'),'client-request-1');assert.match(unauthorized.headers.get('www-authenticate'),/Bearer/);
    assert.equal(body.error.type,'authentication_error');assert.equal(body.error.code,'invalid_api_key');assert.equal(body.error.param,null);
    const generated=await fetch(`${base}/missing`,{headers:{authorization:`Bearer ${config.key}`}});assert.match(generated.headers.get('x-request-id'),/^req_[a-f0-9]+$/);
    const missing=await generated.json();assert.equal(missing.error.code,'not_found');
  });
});
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
test('Vector Stores API 为 Responses file_search 注入检索结果',async()=>{
  await withServer(async(_url,options)=>{
    const body=JSON.parse(options.body);assert.ok(body.messages.some(message=>message.role==='system'&&message.content.includes('blue-green deployment')));assert.equal(body.chatInfo,'How should production be deployed?');
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
    assert.match(JSON.stringify(body.messages),/Reasoning summary/);assert.match(JSON.stringify(body.messages),/先检查项目结构/);
    return new Response(sse([chunk('第二轮完成','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const first=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:'开始'})})).json();
    assert.equal(first.store,true);const reasoning=first.output.find(item=>item.type==='reasoning');assert.match(reasoning.encrypted_content,/^enc_/);
    assert.equal((await fetch(`${base}/v1/responses/${first.id}`,{headers})).status,200);
    const second=await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:[{type:'item_reference',id:reasoning.id},{type:'message',role:'user',content:'继续'}]})});
    assert.equal(second.status,200);assert.equal((await second.json()).output_text,'第二轮完成');assert.equal(calls,2);
  });
});
test('Responses store false 返回可回放 reasoning，过期引用不会中断当前请求',async()=>{
  let calls=0;
  await withServer(async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);
    if(calls===1){const thought=chunk('');thought.choices[0].delta.reasoning_content='无状态推理';return new Response(sse([thought,chunk('结果','stop')]),{headers:{'content-type':'text/event-stream'}});}
    if(calls===2){assert.match(JSON.stringify(body.messages),/无状态推理/);return new Response(sse([chunk('已回放','stop')]),{headers:{'content-type':'text/event-stream'}});}
    assert.doesNotMatch(JSON.stringify(body.messages),/rs_missing/);return new Response(sse([chunk('已恢复','stop')]),{headers:{'content-type':'text/event-stream'}});
  },async(_call,base)=>{
    const headers={authorization:`Bearer ${config.key}`,'content-type':'application/json'};
    const first=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',input:'开始',store:false})})).json();
    assert.equal(first.store,false);const reasoning=first.output.find(item=>item.type==='reasoning');assert.match(reasoning.encrypted_content,/^enc_/);
    assert.equal((await fetch(`${base}/v1/responses/${first.id}`,{headers})).status,404);
    const replay={...reasoning};delete replay.id;
    const second=await(await fetch(`${base}/v1/responses`,{method:'POST',headers,body:JSON.stringify({model:'qwen-instruct',store:false,input:[replay,{type:'message',role:'user',content:'继续'}]})})).json();
    assert.equal(second.output_text,'已回放');
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
