import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, events } from '../src/server.mjs';
import { normalizeRequest, ProtocolOutput } from '../src/protocols.mjs';
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

test('Chat 接受 Pi AI 的 store:false；不假装支持保存完成结果',async()=>{
  await fixture(async call=>{
    const body={messages:[{role:'user',content:'你好'}],store:false};
    assert.equal((await call('/v1/chat/completions',body)).status,200);
    for(const store of [true,null,'false']){
      const response=await call('/v1/chat/completions',{...body,store});
      assert.equal(response.status,400);assert.equal((await response.json()).error.param,'store');
    }
  });
});
test('Responses 与 Anthropic 400 错误标明具体参数',async()=>{
  await fixture(async call=>{
    for(const [path,body,param] of [
      ['/v1/responses',{input:42},'input'],
      ['/v1/responses',{input:'你好',reasoning:{effort:'invalid'}},'reasoning.effort'],
      ['/v1/responses',{input:'你好',background:'yes'},'background'],
      ['/v1/messages',{max_tokens:0,messages:[{role:'user',content:'你好'}]},'max_tokens'],
      ['/v1/messages',{max_tokens:64,messages:[{role:'tool',content:'你好'}]},'messages[0].role'],
      ['/v1/messages',{max_tokens:64,messages:[{role:'user',content:'你好'}],tool_choice:{type:'invalid'}},'tool_choice']
    ]){
      const response=await call(path,{model:'qwen-instruct',...body});
      assert.equal(response.status,400,`${path} ${param}`);
      assert.equal((await response.json()).error.param,param,`${path} ${param}`);
    }
  });
});
test('Anthropic 混合工具结果保留文本段落和错误状态',()=>{
  const value=normalizeRequest('/v1/messages',{model:'qwen-instruct',max_tokens:64,messages:[
    {role:'assistant',content:[{type:'tool_use',id:'tool_1',name:'shell',input:{command:'pwd'}}]},
    {role:'user',content:[{type:'text',text:'检查输出'},{type:'tool_result',tool_use_id:'tool_1',is_error:true,content:[{type:'text',text:'exit 1'},{type:'text',text:'permission denied'}]},{type:'text',text:'换个目录重试'}]}
  ]});
  assert.equal(value.messages[1].role,'tool');
  assert.equal(value.messages[1].content,'Tool error: exit 1\npermission denied');
  assert.equal(value.messages[2].content,'检查输出\n换个目录重试');
  assert.throws(()=>normalizeRequest('/v1/messages',{max_tokens:64,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'tool_1',is_error:'false',content:'x'}]}]}),/is_error/);
});
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
test('Responses 可回放 OpenCode shell、补丁、程序和电脑工具历史',()=>{
  const input=[
    {type:'local_shell_call',call_id:'call_shell',action:{command:['git','status']}},
    {type:'local_shell_call_output',id:'call_shell',output:'clean'},
    {type:'apply_patch_call',call_id:'call_patch',operation:{type:'update_file',path:'a.js',diff:'@@'}},
    {type:'apply_patch_call_output',call_id:'call_patch',status:'completed',output:'Done'},
    {type:'program',id:'prog_1',call_id:'call_program',code:'return 1',fingerprint:'fp'},
    {type:'program_output',id:'out_1',call_id:'call_program',result:'1',status:'completed'},
    {type:'computer_call',call_id:'call_computer',action:{type:'screenshot'}},
    {type:'computer_call_output',call_id:'call_computer',output:{type:'computer_screenshot'}},
    {type:'configuration_update',reasoning:{effort:'high'}},
    {type:'compaction_trigger'},
    {role:'user',content:'继续'}
  ];
  const value=normalizeRequest('/v1/responses',{input});
  assert.equal(value.messages.filter(message=>message.tool_calls).length,4);
  assert.equal(value.messages.find(message=>message.tool_calls?.[0].id==='call_patch').tool_calls[0].function.name,'__openai_apply_patch');
  assert.equal(value.messages.find(message=>message.tool_call_id==='call_program').content,'1');
  assert.equal(value.messages.find(message=>message.tool_call_id==='call_shell').content,'clean');
  assert.match(value.messages.find(message=>message.role==='system').content,/high/);
  assert.equal(value.messages.at(-1).content,'继续');
});
test('Responses shell 输出回放保留 stdout、stderr、退出状态和额外字段',()=>{
  const input=[
    {type:'shell_call',call_id:'call_test',action:{commands:['npm test']}},
    {type:'shell_call_output',call_id:'call_test',status:'incomplete',output:[{stdout:'running tests',stderr:'ERROR: failed',outcome:{type:'exit',exit_code:1},source:'runner'}]}
  ];
  const value=normalizeRequest('/v1/responses',{input});
  const result=value.messages.at(-1).content;
  for(const detail of ['Tool incomplete:','stdout:\nrunning tests','stderr:\nERROR: failed','Exit code: 1','"source":"runner"'])assert.ok(result.includes(detail));
});
test('Responses local shell 结构化结果便于模型读取失败原因',()=>{
  const input=[
    {type:'local_shell_call',call_id:'call_test',action:{command:['npm','test']}},
    {type:'local_shell_call_output',call_id:'call_test',status:'failed',output:{stdout:'running tests',stderr:'ERROR: failed',outcome:{type:'exit',exit_code:1},duration_ms:1200}}
  ];
  const result=normalizeRequest('/v1/responses',{input}).messages.at(-1).content;
  for(const detail of ['Tool failed:','stdout:\nrunning tests','stderr:\nERROR: failed','Exit code: 1','"duration_ms":1200'])assert.ok(result.includes(detail));
  const json={...input[1],output:JSON.stringify({stdout:'running tests',stderr:'ERROR: failed',exit_code:1,duration_ms:1200})};
  const fromJson=normalizeRequest('/v1/responses',{input:[input[0],json]}).messages.at(-1).content;
  for(const detail of ['stdout:\nrunning tests','stderr:\nERROR: failed','Exit code: 1','"duration_ms":1200'])assert.ok(fromJson.includes(detail));
  const plain=normalizeRequest('/v1/responses',{input:[input[0],{...input[1],output:'clean'}]}).messages.at(-1).content;
  assert.equal(plain,'Tool failed: clean');
});
test('Responses Agent 工具声明映射为上游函数并支持选择',()=>{
  const tools=[{type:'local_shell'},{type:'apply_patch'},{type:'computer'},{type:'programmatic_tool_calling'}];
  const value=normalizeRequest('/v1/responses',{input:'修复项目',tools,tool_choice:{type:'apply_patch'}});
  assert.deepEqual(value.tools.map(tool=>tool.function.name),['__openai_local_shell','__openai_apply_patch','__openai_computer','__openai_program']);
  assert.deepEqual(value.tools[0].function.parameters.properties.action.required,['command']);
  assert.equal(value.tool_choice.function.name,'__openai_apply_patch');
  const allowed=normalizeRequest('/v1/responses',{input:'检查',tools,tool_choice:{type:'allowed_tools',mode:'required',tools:[{type:'local_shell'},{type:'computer'}]}});
  assert.equal(allowed.tool_choice,'required');assert.deepEqual(allowed.tools.map(tool=>tool.function.name),['__openai_local_shell','__openai_computer']);
});
test('Responses Agent 工具调用输出原生项目及流生命周期',async()=>{
  const tagged='<api_tool_call>{"name":"__openai_local_shell","arguments":{"action":{"command":["git","status"]}}}</api_tool_call>';
  await fixture(async call=>{
    const body={input:'检查',tools:[{type:'local_shell'}]};
    const result=await(await call('/v1/responses',body)).json(),item=result.output[0];
    assert.equal(item.type,'local_shell_call');assert.equal(item.action.command[1],'status');assert.equal(item.action.type,'exec');assert.deepEqual(item.action.env,{});assert.equal(item.status,'completed');
    const frames=(await Array.fromAsync(events((await call('/v1/responses',{...body,stream:true})).body))).map(frame=>JSON.parse(frame.data));
    assert.ok(frames.some(frame=>frame.type==='response.output_item.added'&&frame.item.type==='local_shell_call'&&frame.item.status==='in_progress'));
    assert.ok(frames.some(frame=>frame.type==='response.output_item.done'&&frame.item.type==='local_shell_call'&&frame.item.status==='completed'));
    assert.equal(frames.some(frame=>frame.type.startsWith('response.function_call_arguments.')),false);
  },tagged);
});
test('Responses Agent 工具输出项保留各自协议字段',()=>{
  const original={tools:[{type:'local_shell'},{type:'shell',environment:{type:'local'}},{type:'apply_patch'},{type:'computer'},{type:'programmatic_tool_calling'}]};
  const output=new ProtocolOutput('/v1/responses',{},async()=>{},original);
  const call=(name,args)=>output.callItem({id:`call_${name}`,type:'function',function:{name:`__openai_${name}`,arguments:JSON.stringify(args)}});
  const shell=call('shell',{action:{commands:['pwd']},environment:{type:'container'},caller:{type:'program',caller_id:'fake'}});assert.equal(shell.type,'shell_call');assert.equal(shell.environment.type,'local');assert.equal(shell.caller,undefined);
  const patch=call('apply_patch',{operation:{type:'delete_file',path:'old.txt'}});assert.equal(patch.operation.path,'old.txt');
  const computer=call('computer',{action:{type:'screenshot'}});assert.deepEqual(computer.pending_safety_checks,[]);
  assert.deepEqual(call('computer',{action:{type:'click',x:10,y:20}}).action,{type:'click',x:10,y:20,button:'left'});
  assert.equal(call('computer',{action:{type:'scroll',x:10,y:20,scroll_x:0,scroll_y:-300}}).action.scroll_y,-300);
  assert.equal(call('computer',{action:{type:'drag',path:[{x:0,y:0},{x:10,y:10}]}}).action.path.length,2);
  for(const action of [{type:'click',x:10},{type:'drag',path:[{x:0,y:0}]},{type:'keypress',keys:[]},{type:'scroll',x:0,y:0,scroll_y:10},{type:'type'}])assert.throws(()=>call('computer',{action}),/computer.action/);
  const program=call('program',{code:'return 1'});assert.equal(program.type,'program');assert.match(program.fingerprint,/^fp_/);assert.equal(program.status,undefined);
  const local=call('local_shell',{action:{command:['git','status']}});assert.equal(local.action.type,'exec');assert.deepEqual(local.action.env,{});
  assert.equal(call('local_shell',{action:{command:['git','status'],timeout_ms:1000,working_directory:'/workspace'}}).action.timeout_ms,1000);
  assert.equal(call('shell',{action:{commands:['pwd'],timeout_ms:1000,max_output_length:4096}}).action.max_output_length,4096);
  assert.throws(()=>call('shell',{action:{commands:[]}}),/shell.action/);
  assert.throws(()=>call('local_shell',{action:{command:['git','status'],timeout_ms:'1000'}}),/local_shell.action/);
  assert.throws(()=>call('local_shell',{action:{command:['git','status'],working_directory:[]}}),/local_shell.action/);
  assert.throws(()=>call('shell',{action:{commands:['pwd'],max_output_length:-1}}),/shell.action/);
  assert.throws(()=>call('apply_patch',{operation:{type:'update_file',path:'a.txt'}}),/apply_patch.operation/);
});
test('Responses shell 命令流事件包含命令索引和完整内容',async()=>{
  const frames=[];
  const output=new ProtocolOutput('/v1/responses',{},frame=>{frames.push(JSON.parse(frame.split('data: ')[1]));},{tools:[{type:'shell'}]});
  await output.toolCall({id:'call_shell',type:'function',function:{name:'__openai_shell',arguments:JSON.stringify({action:{commands:['pwd','git status']}})}});
  assert.deepEqual(frames.filter(frame=>frame.type==='response.shell_call_command.done').map(frame=>[frame.command_index,frame.command]),[[0,'pwd'],[1,'git status']]);
  assert.equal(frames.filter(frame=>frame.type==='response.output_item.done').length,1);
});
test('Responses 本地文件检索输出完整流式状态事件',async()=>{
  const frames=[],item={id:'fs_1',type:'file_search_call',status:'completed',queries:['retry limit'],results:[{file_id:'file_1',filename:'README.md'}]};
  const output=new ProtocolOutput('/v1/responses',{model:'qwen-instruct'},frame=>{frames.push(JSON.parse(frame.split('data: ')[1]));},{},{fileSearchItem:item});
  await output.start();
  assert.deepEqual(frames.map(frame=>frame.type).slice(2),[
    'response.output_item.added','response.file_search_call.in_progress','response.file_search_call.searching','response.file_search_call.completed','response.output_item.done'
  ]);
  assert.equal(frames[2].item.results,undefined);
  assert.deepEqual(frames.at(-1).item.results,item.results);
  assert.deepEqual(frames.map(frame=>frame.sequence_number),frames.map((_,index)=>index));
});
test('Responses Agent 结果保留失败状态与结构化 shell 输出',()=>{
  const input=[
    {type:'shell_call',call_id:'call_shell',action:{commands:['npm test']}},
    {type:'shell_call_output',call_id:'call_shell',status:'incomplete',output:[{stdout:'partial',stderr:'',outcome:{type:'timeout'}}]},
    {type:'apply_patch_call',call_id:'call_patch',operation:{type:'update_file',path:'a.js',diff:'@@'}},
    {type:'apply_patch_call_output',call_id:'call_patch',status:'failed',output:'conflict'},
    {type:'program',call_id:'call_program',code:'return 1'},
    {type:'program_output',call_id:'call_program',status:'failed',result:{error:'compilation failed'}},
    {type:'computer_call',call_id:'call_computer',action:{type:'screenshot'}},
    {type:'computer_call_output',call_id:'call_computer',status:'failed',output:'capture denied'},
    {role:'user',content:'下一步'}
  ];
  const messages=normalizeRequest('/v1/responses',{input}).messages;
  const shellResult=messages.find(message=>message.tool_call_id==='call_shell').content;
  assert.match(shellResult,/^Tool incomplete: Command 1:/);
  assert.match(shellResult,/stdout:\npartial/);
  assert.match(shellResult,/Command timed out\./);
  assert.equal(messages.find(message=>message.tool_call_id==='call_patch').content,'Tool failed: conflict');
  assert.equal(messages.find(message=>message.tool_call_id==='call_program').content,'Tool failed: {"error":"compilation failed"}');
  assert.equal(messages.find(message=>message.tool_call_id==='call_computer').content,'Tool failed: capture denied');
  const failedFunction=normalizeRequest('/v1/responses',{input:[
    {type:'function_call',call_id:'call_read',name:'read_file',arguments:'{}'},
    {type:'function_call_output',call_id:'call_read',status:'failed',output:[{type:'output_text',text:'permission denied'}]}
  ]}).messages;
  assert.equal(failedFunction.at(-1).content,'Tool failed: permission denied');
});
test('Responses Agent 工具结果展开文本内容块并保留未知块',()=>{
  const input=[
    {type:'apply_patch_call',call_id:'call_patch',operation:{type:'update_file',path:'a.js',diff:'@@'}},
    {type:'apply_patch_call_output',call_id:'call_patch',output:[{type:'output_text',text:'已修改 a.js'},{type:'custom',value:{lines:2}}]},
    {type:'program',call_id:'call_program',code:'return 1'},
    {type:'program_output',call_id:'call_program',result:[{type:'text',text:'编译成功'},{type:'output_text',text:'测试通过'}]}
  ];
  const messages=normalizeRequest('/v1/responses',{input}).messages;
  assert.equal(messages.find(message=>message.tool_call_id==='call_patch').content,'已修改 a.js\n{"type":"custom","value":{"lines":2}}');
  assert.equal(messages.find(message=>message.tool_call_id==='call_program').content,'编译成功\n测试通过');
});
test('Responses allowed_tools 只向上游暴露允许的工具',()=>{
  const normalized=normalizeRequest('/v1/responses',{input:'x',tools:[{type:'function',name:'a',parameters:{}},{type:'custom',name:'patch'}],tool_choice:{type:'allowed_tools',mode:'required',tools:[{type:'custom',name:'patch'}]}});
  assert.equal(normalized.tool_choice,'required');assert.equal(normalized.tools.length,1);assert.equal(normalized.tools[0].function.name,'patch');assert.equal(normalized.tools[0].custom,true);
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',tools:[{type:'function',name:'a'}],tool_choice:{type:'allowed_tools',mode:'auto',tools:[{type:'function',name:'missing'}]}}),/未知/);
  const search=normalizeRequest('/v1/responses',{input:'查资料',tools:[{type:'web_search'},{type:'file_search',vector_store_ids:['vs_test']},{type:'function',name:'lookup',parameters:{type:'object'}}],tool_choice:{type:'allowed_tools',mode:'required',tools:[{type:'web_search'},{type:'function',name:'lookup'}]}});
  assert.equal(search.net_go,true);assert.equal(search.tool_choice,'auto');assert.deepEqual(search.tools.map(tool=>tool.function.name),['lookup']);
  const files=normalizeRequest('/v1/responses',{input:'查文档',tools:[{type:'web_search'},{type:'file_search',vector_store_ids:['vs_test']}],tool_choice:{type:'allowed_tools',mode:'required',tools:[{type:'file_search'}]}});
  assert.equal(files.net_go,false);assert.equal(files.tool_choice,'auto');assert.deepEqual(files.tools,[]);
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',tools:[{type:'web_search'}],tool_choice:{type:'allowed_tools',mode:'auto',tools:[{type:'file_search'}]}}),/未知/);
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',tools:[{type:'web_search'}],tool_choice:{type:'file_search'}}),/未知/);
});
test('Responses function tool 保留 strict 参数校验语义',()=>{
  const value=normalizeRequest('/v1/responses',{input:'x',tools:[{type:'function',name:'lookup',strict:false,parameters:{type:'object',required:['query']}}]});
  assert.equal(value.tools[0].function.strict,false);
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
  assert.equal(normalizeRequest('/v1/responses',{input:'x',conversation:'conv_x'}).messages[0].content,'x');
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',previous_response_id:''}),/非空字符串/);
  assert.throws(()=>normalizeRequest('/v1/responses',{input:[{role:'user',content:[{type:'input_image',image_url:'https://example.com'}]}]}),/内容块/);
  const anthropic=normalizeRequest('/v1/messages',{messages:[],max_tokens:1,temperature:1,top_p:.8,top_k:20,stop_sequences:['END']});
  assert.equal(anthropic.temperature,1);assert.deepEqual(anthropic.stop,['END']);
});

test('Responses background 参数接受流式和禁用存储',()=>{
  assert.equal(normalizeRequest('/v1/responses',{input:'x',background:true}).messages[0].content,'x');
  assert.equal(normalizeRequest('/v1/responses',{input:'x',background:true,stream:true}).stream,true);
  assert.equal(normalizeRequest('/v1/responses',{input:'x',background:true,store:false}).messages[0].content,'x');
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',background:'yes'}),/布尔值/);
});

test('Responses 接受上下文裁剪配置并拒绝无效阈值',()=>{
  const value=normalizeRequest('/v1/responses',{input:'x',truncation:'auto',context_management:[{type:'compaction',compact_threshold:1000}]});
  assert.equal(value.messages[0].content,'x');
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',truncation:'drop'}),/truncation/);
  assert.throws(()=>normalizeRequest('/v1/responses',{input:'x',context_management:[{type:'compaction',compact_threshold:0}]}),/context_management/);
});

test('Chat 兼容旧版 functions/function_call，Responses 接受常用选项',()=>{
  const chat=normalizeRequest('/v1/chat/completions',{messages:[{role:'user',content:'x'}],functions:[{name:'run',parameters:{type:'object'}}],function_call:{name:'run'}});
  assert.equal(chat.tools[0].function.name,'run');assert.equal(chat.tool_choice.function.name,'run');assert.equal(chat.functions,undefined);
  const response=normalizeRequest('/v1/responses',{input:'x',temperature:.5,top_p:.9,service_tier:'auto',safety_identifier:'local'});
  assert.equal(response.temperature,.5);assert.equal(response.top_p,.9);
});
test('Responses 校验长尾字段并保留工具调用上限',()=>{
  const value=normalizeRequest('/v1/responses',{input:'x',stream:true,stream_options:{include_obfuscation:false},max_output_tokens:32,max_tool_calls:2,metadata:{task:'code'},reasoning:{effort:'high',summary:'concise'},text:{verbosity:'low'},service_tier:'default',safety_identifier:'local-user',prompt_cache_key:'workspace'});
  assert.equal(value.max_tokens,32);assert.equal(value.max_tool_calls,2);assert.equal(value.verbosity,'low');
  for(const request of [
    {input:'x',stream_options:{include_obfuscation:false}},
    {input:'x',max_tool_calls:0},
    {input:'x',metadata:{task:1}},
    {input:'x',reasoning:{summary:'short'}},
    {input:'x',text:{verbosity:'verbose'}},
    {input:'x',service_tier:'unknown'}
  ])assert.throws(()=>normalizeRequest('/v1/responses',request));
});
test('Responses 长尾字段回显，流选项可生成混淆填充',async()=>{
  await fixture(async call=>{
    const body={input:'x',stream:true,stream_options:{include_obfuscation:true},max_tool_calls:2,metadata:{task:'code'},reasoning:{summary:'concise'},text:{verbosity:'low'},service_tier:'default',safety_identifier:'local-user',prompt_cache_key:'workspace'};
    const frames=(await Array.fromAsync(events((await call('/v1/responses',body)).body))).map(frame=>JSON.parse(frame.data));
    assert.ok(frames.every(frame=>typeof frame.obfuscation==='string'&&frame.obfuscation.length>0));
    const response=frames.at(-1).response;assert.equal(response.max_tool_calls,2);assert.deepEqual(response.metadata,{task:'code'});assert.equal(response.reasoning.summary,'concise');assert.equal(response.safety_identifier,'local-user');assert.equal(response.prompt_cache_key,'workspace');
  });
});
test('Responses reasoning 与 Anthropic thinking 转成推理强度',()=>{
  assert.equal(normalizeRequest('/v1/responses',{input:'x',reasoning:{effort:'high'}}).reasoning_effort,'high');
  assert.equal(normalizeRequest('/v1/messages',{messages:[{role:'user',content:'x'}],max_tokens:32,thinking:{type:'enabled',budget_tokens:16}}).reasoning_effort,'high');
  assert.equal(normalizeRequest('/v1/messages',{messages:[{role:'user',content:'x'}],max_tokens:32,thinking:{type:'disabled'}}).reasoning_effort,'none');
  assert.equal(normalizeRequest('/v1/messages',{messages:[{role:'user',content:'x'}],max_tokens:32,thinking:{type:'disabled'},output_config:{effort:'max'}}).reasoning_effort,'none');
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
  assert.equal(normalizeRequest('/v1/chat/completions',{...base,reasoning_effort:'none',temperature:0.6}).temperature,0.6);
  assert.equal(normalizeRequest('/v1/chat/completions',{...base,thinking:{type:'enabled'},reasoning_effort:'none',temperature:0.8}).temperature,0.8);
  for(const body of [
    {...base,temperature:1.1},{...base,thinking:{type:'disabled'},temperature:0},
    {...base,reasoning_effort:'none',temperature:0},
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
  assert.equal(normalizeRequest('/v1/responses',{input:'新闻',tools:[{type:'web_search'}],tool_choice:'none'}).net_go,false);
  assert.equal(normalizeRequest('/v1/responses',{input:'新闻',tools:[{type:'web_search'},{type:'function',name:'lookup',parameters:{type:'object'}}],tool_choice:{type:'function',name:'lookup'}}).net_go,false);
  assert.equal(normalizeRequest('/v1/responses',{input:'新闻',tools:[{type:'web_search'}],tool_choice:'required'}).tool_choice,'auto');
  assert.equal(normalizeRequest('/v1/responses',{input:'文档',tools:[{type:'file_search',vector_store_ids:['vs_test']}],tool_choice:'required'}).tool_choice,'auto');
  assert.equal(normalizeRequest('/v1/messages',{messages:[{role:'user',content:'新闻'}],max_tokens:32,tools:[{type:'web_search_20250305',name:'web_search'}],tool_choice:{type:'none'}}).net_go,false);
  assert.equal(normalizeRequest('/v1/messages',{messages:[{role:'user',content:'新闻'}],max_tokens:32,tools:[{type:'web_search_20250305',name:'web_search'}],tool_choice:{type:'any'}}).tool_choice,'auto');
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

test('三个协议在上游结束前发送完整工具调用',async()=>{
  const cases=[
    ['/v1/chat/completions',{model:'qwen-instruct',messages:[{role:'user',content:'天气'}],tools:[{type:'function',function:{name:'weather',parameters:{type:'object'}}}],tool_choice:'required'},value=>value.choices?.[0]?.delta?.tool_calls?.[0]],
    ['/v1/responses',{model:'qwen-instruct',input:'天气',tools:[{type:'function',name:'weather',parameters:{type:'object'}}],tool_choice:'required'},value=>value.type==='response.output_item.done'&&value.item?.type==='function_call'?value.item:null],
    ['/v1/messages',{model:'qwen-instruct',messages:[{role:'user',content:'天气'}],max_tokens:64,tools:[{name:'weather',input_schema:{type:'object'}}],tool_choice:{type:'any'}},value=>value.type==='content_block_start'&&value.content_block?.type==='tool_use'?value.content_block:null]
  ];
  const encoder=new TextEncoder(),frame=(content,finish_reason=null)=>encoder.encode(`data: ${JSON.stringify({choices:[{index:0,delta:{content},finish_reason}]})}\n\n`);
  for(const [path,body,select] of cases) {
    let upstreamController;
    const server=createServer({key:'test',token:'token',group:'g',timeout:2000},async()=>new Response(new ReadableStream({start(controller){upstreamController=controller;controller.enqueue(frame('<api_tool_'));controller.enqueue(frame('call>{"name":"weather","arguments":{"city":"上海"}}</api_tool_call>'));}}),{headers:{'content-type':'text/event-stream'}}),confirmedModels);
    await listenForFetch(server);
    try {
      const headers={'content-type':'application/json',...(path==='/v1/messages'?{'x-api-key':'test'}:{authorization:'Bearer test'})};
      const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers,body:JSON.stringify({...body,stream:true}),signal:AbortSignal.timeout(2000)});
      const iterator=events(response.body)[Symbol.asyncIterator]();let call;
      while(!call){const next=await iterator.next();assert.equal(next.done,false);call=select(JSON.parse(next.value.data));}
      assert.equal(call.name||call.function?.name,'weather');
      upstreamController.enqueue(frame('','stop'));upstreamController.close();
      while(!(await iterator.next()).done) {}
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
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
          assert.match(json.output[0].encrypted_content,/^enc_/);assert.equal(json.store,false);
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
          const added=frames.find(x=>x.type==='response.output_item.added').item;assert.equal(added.type,'reasoning');assert.equal(added.encrypted_content,undefined);
          assert.match(frames.find(x=>x.type==='response.output_item.done'&&x.item.type==='reasoning').item.encrypted_content,/^enc_v1_/);
          assert.deepEqual(frames.at(-1).response.output.map(x=>x.type),['reasoning','message']);
        } else {
          assert.equal(frames.find(x=>x.delta?.type==='thinking_delta').delta.thinking,'先思考');
          assert.deepEqual(frames.at(-2).usage.output_tokens>=0,true);
        }
      }
    } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
  }
});
test('Responses 未指定 store 时默认保存',async()=>{
  await fixture(async call=>{
    const result=await(await call('/v1/responses',{input:'默认保存'})).json();assert.equal(result.store,true);
  },'已保存');
});
