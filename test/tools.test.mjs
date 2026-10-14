import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolCallStream, normalizeMessages, parseToolCalls, toolPolicy } from '../src/tools.mjs';
const tools=[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}}];

test('第零位的标签或围栏前缀不会让向前扫描陷入死循环',()=>{
  for(const prefix of ['<','`','``','<not-a-tool>','`plain text']){
    const stream=createToolCallStream(toolPolicy(tools),()=> 'call_boundary');
    assert.deepEqual(stream.push(prefix),[]);
    stream.push('普通后续文本');
    assert.equal(stream.finish().content,prefix+'普通后续文本');
  }
});
test('工具调用解析保留标识与 JSON 参数',()=>{
  const policy=toolPolicy(tools,'required');
  const result=parseToolCalls('<api_tool_call>{"name":"weather","arguments":{"city":"上海"}}</api_tool_call>',policy,()=> 'call_test');
  assert.equal(result.content,null);assert.equal(result.tool_calls[0].id,'call_test');
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments),{city:'上海'});
});
test('流式工具解析器跨分片后立即返回完整调用',()=>{
  let next=0;const stream=createToolCallStream(toolPolicy(tools,'required'),()=>`call_${++next}`);
  assert.deepEqual(stream.push('<api_tool_'),[]);
  assert.deepEqual(stream.push('call>{"name":"weather","arguments":{"city":"上海"}}'),[]);
  const calls=stream.push('</api_tool_call>等待上游结束');
  assert.equal(calls.length,1);assert.equal(calls[0].id,'call_1');
  assert.deepEqual(JSON.parse(calls[0].function.arguments),{city:'上海'});
  const result=stream.finish();assert.equal(result.content,'等待上游结束');assert.deepEqual(result.tool_calls,calls);
});
test('流式工具解析器即时释放普通文本并隐藏跨分片标签',()=>{
  const stream=createToolCallStream(toolPolicy(tools),()=> 'call_live');
  assert.deepEqual(stream.push('先说明<api_tool_'),[]);
  assert.equal(stream.takeText(),'先说明');
  assert.deepEqual(stream.push('call>{"name":"weather","arguments":{"city":"上海"}}'),[]);
  assert.equal(stream.takeText(),'');
  const calls=stream.push('</api_tool_call>再说明');
  assert.equal(stream.takeText(),'再说明');
  assert.equal(calls[0].function.name,'weather');
  assert.deepEqual(stream.finish(),{content:'先说明再说明',tool_calls:calls});
  assert.equal(stream.takeText(),'');
});
test('JSON 字符串中的结束标签不提前终止工具调用',()=>{
  const policy=toolPolicy([{type:'function',custom:true,function:{name:'patch',parameters:{type:'object',properties:{input:{type:'string'}},required:['input']}}}],'required');
  const input='before </api_tool_call> after';
  const block=`<api_tool_call>${JSON.stringify({name:'patch',arguments:{input}})}</api_tool_call>`;
  const expected=parseToolCalls(`前${block}后`,policy,()=> 'call_patch');
  assert.equal(expected.content,'前后');
  assert.equal(JSON.parse(expected.tool_calls[0].function.arguments).input,input);
  const stream=createToolCallStream(policy,()=> 'call_patch');
  const boundary=block.indexOf('</api_tool_call>');
  stream.push(`前${block.slice(0,boundary+7)}`);assert.equal(stream.takeText(),'前');
  const calls=stream.push(`${block.slice(boundary+7)}后`);
  assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].function.arguments).input,input);
  assert.equal(stream.takeText(),'后');assert.equal(stream.finish().content,'前后');
});
test('流式纯 JSON 工具调用在最终解析前不泄漏为文本',()=>{
  const stream=createToolCallStream(toolPolicy(tools,'required'),()=> 'call_json');
  stream.push('{"name":"weather",');assert.equal(stream.takeText(),'');
  stream.push('"arguments":{"city":"上海"}}');assert.equal(stream.takeText(),'');
  const result=stream.finish();assert.equal(result.content,null);assert.equal(result.tool_calls[0].function.name,'weather');
  assert.equal(stream.takeText(),'');
});
test('纯 JSON 工具调用闭合后立即发出，后续文本不重复包含参数',()=>{
  const stream=createToolCallStream(toolPolicy(tools,'required'),()=> 'call_json_live');
  assert.deepEqual(stream.push('{"name":"weather","arguments":{"city":"上海"}'),[]);
  assert.equal(stream.takeText(),'');
  const calls=stream.push('}');
  assert.equal(calls.length,1);assert.equal(calls[0].id,'call_json_live');
  assert.equal(stream.takeText(),'');
  assert.deepEqual(stream.push('查询完成'),[]);
  assert.equal(stream.takeText(),'查询完成');
  assert.deepEqual(stream.finish(),{content:'查询完成',tool_calls:calls});
  assert.equal(stream.takeText(),'');
});
test('普通 JSON 回答一旦确认不是工具调用就立即输出',()=>{
  const stream=createToolCallStream(toolPolicy(tools),()=> 'call_unused');
  stream.push('{"summary":');assert.equal(stream.takeText(),'');
  assert.deepEqual(stream.push('"done"}'),[]);
  assert.equal(stream.takeText(),'{"summary":"done"}');
  stream.push(' 后续说明');assert.equal(stream.takeText(),' 后续说明');
  assert.deepEqual(stream.finish(),{content:'{"summary":"done"} 后续说明',tool_calls:[]});
});
test('required 工具模式不提前输出违反约束的普通 JSON',()=>{
  const stream=createToolCallStream(toolPolicy(tools,'required'),()=> 'call_unused');
  stream.push('{"summary":"done"}');
  assert.equal(stream.takeText(),'');
  assert.throws(()=>stream.finish(),/required/);
});
test('说明文字后的 JSON 围栏工具调用只提前释放说明文字',()=>{
  const stream=createToolCallStream(toolPolicy(tools,'required'),()=> 'call_fenced');
  stream.push('先查天气：\n``');assert.equal(stream.takeText(),'先查天气：\n');
  const calls=stream.push('`json\n{"name":"weather","arguments":{"city":"上海"}}\n```');assert.equal(stream.takeText(),'');
  assert.equal(calls.length,1);assert.equal(calls[0].function.name,'weather');
  const result=stream.finish();assert.equal(result.content,'先查天气：\n');assert.equal(result.tool_calls[0].function.name,'weather');
});
test('围栏工具调用完整到达后立即发出且后续普通文本不重复',()=>{
  const stream=createToolCallStream(toolPolicy(tools,'required'),()=> 'call_fenced_live');
  assert.deepEqual(stream.push('开始\n```json\n{"name":"weather","arguments":{"city":"上海"}}\n``'),[]);
  assert.equal(stream.takeText(),'开始\n');
  const calls=stream.push('`结束');
  assert.equal(calls.length,1);assert.equal(stream.takeText(),'结束');
  assert.deepEqual(stream.finish(),{content:'开始\n结束',tool_calls:calls});
});
test('JSON 工具围栏不要求结束标记前有换行',()=>{
  const stream=createToolCallStream(toolPolicy(tools,'required'),()=> 'call_tight_fence');
  assert.deepEqual(stream.push('准备\n```json\n{"name":"weather","arguments":{"city":"上海"}}``'),[]);
  assert.equal(stream.takeText(),'准备\n');
  const calls=stream.push('`完成');
  assert.equal(calls.length,1);assert.equal(calls[0].id,'call_tight_fence');
  assert.equal(stream.takeText(),'完成');
  assert.deepEqual(stream.finish(),{content:'准备\n完成',tool_calls:calls});
});
test('JSON 字符串内的反引号和工具标签不提前结束围栏',()=>{
  const declarations=[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'},note:{type:'string'}},required:['city'],additionalProperties:false}}}];
  const stream=createToolCallStream(toolPolicy(declarations,'required'),()=> 'call_fence_string');
  const argumentsValue={city:'上海',note:'例子 ``` <api_tool_call> 只是文本'};
  const json=JSON.stringify({name:'weather',arguments:argumentsValue});
  const boundary=json.indexOf('```')+2;
  assert.deepEqual(stream.push(`说明\n\`\`\`json\n${json.slice(0,boundary)}`),[]);
  assert.equal(stream.takeText(),'说明\n');
  const calls=stream.push(`${json.slice(boundary)}\n\`\`\`结尾`);
  assert.equal(calls.length,1);
  assert.deepEqual(JSON.parse(calls[0].function.arguments),argumentsValue);
  assert.equal(stream.takeText(),'结尾');
  assert.deepEqual(stream.finish(),{content:'说明\n结尾',tool_calls:calls});
});
test('非工具 JSON 围栏闭合后立即作为普通文本输出',()=>{
  const stream=createToolCallStream(toolPolicy(tools),()=> 'call_unused');
  assert.deepEqual(stream.push('结果：\n```json\n{"summary":"done"}\n``'),[]);
  assert.equal(stream.takeText(),'结果：\n');
  assert.deepEqual(stream.push('` 后续'),[]);
  assert.equal(stream.takeText(),'```json\n{"summary":"done"}\n``` 后续');
  assert.deepEqual(stream.finish(),{content:'结果：\n```json\n{"summary":"done"}\n``` 后续',tool_calls:[]});
});
test('工具调用兼容纯 JSON、代码围栏和 OpenAI function 结构',()=>{
  const policy=toolPolicy(tools,'required');
  for(const value of ['{"name":"weather","arguments":{"city":"上海"}}','```json\n{"function":{"name":"weather","arguments":"{\\"city\\":\\"上海\\"}"}}\n```']){
    const result=parseToolCalls(value,policy,()=> 'call_json');assert.equal(result.content,null);assert.equal(result.tool_calls[0].function.name,'weather');
  }
});
test('标签内兼容 tool_calls 包装、无参数工具和 custom 顶层 input',()=>{
  const wrapped=parseToolCalls('<tool_call>{"tool_calls":[{"name":"weather","arguments":{"city":"上海"}}]}</tool_call>',toolPolicy(tools,'required'),()=> 'call_wrapped');
  assert.equal(wrapped.tool_calls[0].function.name,'weather');
  const noArgs=[{type:'function',function:{name:'ping',parameters:{type:'object',additionalProperties:false}}}];
  assert.deepEqual(JSON.parse(parseToolCalls('<tool_call>{"name":"ping"}</tool_call>',toolPolicy(noArgs,'required'),()=> 'call_ping').tool_calls[0].function.arguments),{});
  const custom=toolPolicy([{type:'function',custom:true,function:{name:'patch',parameters:{type:'object'}}}],'required');
  assert.deepEqual(JSON.parse(parseToolCalls('<tool_call>{"name":"patch","input":"diff"}</tool_call>',custom,()=> 'call_patch').tool_calls[0].function.arguments),{input:'diff'});
});
test('工具调用兼容围栏前说明和单块多调用',()=>{
  const policy=toolPolicy(tools,'required');
  const fenced=parseToolCalls('调用工具：\n```json\n{"name":"weather","arguments":{"city":"上海"}}\n```',policy,()=> 'call_fenced');assert.equal(fenced.tool_calls.length,1);
  const multiple=parseToolCalls('<tool_call>[{"name":"weather","arguments":{"city":"上海"}},{"name":"weather","arguments":{"city":"北京"}}]</tool_call>',policy,()=> 'call_multi');assert.equal(multiple.tool_calls.length,2);
});
test('工具调用有限修复尾随逗号并遵守 max_tool_calls',()=>{
  const repaired=parseToolCalls('<API_TOOL_CALL>\uFEFF{"name":"weather","arguments":{"city":"上海",},}</API_TOOL_CALL>',toolPolicy(tools,'required',true,2),()=> 'call_fixed');
  assert.equal(JSON.parse(repaired.tool_calls[0].function.arguments).city,'上海');
  const two='<tool_call>[{"name":"weather","arguments":{"city":"上海"}},{"name":"weather","arguments":{"city":"北京"}}]</tool_call>';
  assert.throws(()=>parseToolCalls(two,toolPolicy(tools,'required',true,1),()=> 'call_limited'),/max_tool_calls=1/);
  assert.throws(()=>parseToolCalls(two,toolPolicy(tools,'required',false,2),()=> 'call_serial'),/max_tool_calls=1/);
  for(const limit of [0,65,1.5])assert.throws(()=>toolPolicy(tools,'auto',true,limit),/max_tool_calls/);
});
test('原生工具调用可保留上游 ID',()=>{
  const result=parseToolCalls('{"tool_calls":[{"id":"call_upstream","name":"weather","arguments":"{\\"city\\":\\"上海\\"}"}]}',toolPolicy(tools,'required'),()=> 'call_local');
  assert.equal(result.tool_calls[0].id,'call_upstream');
});
test('不允许的工具、损坏参数、未完成块、required 未遵循均拒绝',()=>{
  const policy=toolPolicy(tools,'required');
  for(const text of ['普通回答','<tool_call>{bad}</tool_call>','<tool_call>{"name":"shell","arguments":{}}</tool_call>','<tool_call>{"name":"weather","arguments":[]}</tool_call>','<tool_call>{']) assert.throws(()=>parseToolCalls(text,policy,()=> 'call_test'));
});
test('工具参数必须符合声明的 JSON Schema',()=>{
  const policy=toolPolicy(tools,'required');
  for(const text of ['<tool_call>{"name":"weather","arguments":{}}</tool_call>','<tool_call>{"name":"weather","arguments":{"city":1}}</tool_call>','<tool_call>{"name":"weather","arguments":{"city":"上海","extra":true}}</tool_call>'])assert.throws(()=>parseToolCalls(text,policy,()=> 'call_test'),/JSON Schema/);
});

test('工具 strict=false 放宽参数 Schema，名称遵循 Kimi K3 规则',()=>{
  const loose=[{type:'function',function:{name:'weather',strict:false,parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}}];
  assert.equal(parseToolCalls('<tool_call>{"name":"weather","arguments":{"other":1}}</tool_call>',toolPolicy(loose,'required'),()=> 'call').tool_calls.length,1);
  assert.doesNotThrow(()=>toolPolicy([{type:'function',function:{name:'a'.repeat(256),parameters:{type:'object'}}}]));
  for(const name of ['1bad','bad@name','a'.repeat(257)])assert.throws(()=>toolPolicy([{type:'function',function:{name}}]),/function.name/);
  assert.throws(()=>toolPolicy([{type:'function',function:{name:'valid',strict:'yes'}}]),/strict/);
});
test('工具结果必须对应历史调用；全部工具结果进入文本历史',()=>{
  const messages=[{role:'user',content:'天气'},{role:'assistant',content:null,tool_calls:[{id:'call_test',type:'function',function:{name:'weather',arguments:'{}'}}]},{role:'tool',tool_call_id:'call_test',content:'晴天'}];
  assert.match(normalizeMessages(messages,toolPolicy(tools)).at(-1).content,/晴天/);
  assert.throws(()=>normalizeMessages(messages.slice(0,-1),null),/缺少/);
  assert.throws(()=>normalizeMessages([{role:'tool',tool_call_id:'bad',content:'结果'}],null),/匹配/);
});
test('custom 工具只接受 input 自由文本参数',()=>{
  const custom=toolPolicy([{type:'function',custom:true,function:{name:'patch',parameters:{type:'object'}}}],'required');
  assert.equal(parseToolCalls('<api_tool_call>{"name":"patch","arguments":{"input":"diff"}}</api_tool_call>',custom,()=> 'call_x').tool_calls.length,1);
  assert.throws(()=>parseToolCalls('<api_tool_call>{"name":"patch","arguments":{}}</api_tool_call>',custom,()=> 'call_x'),/custom/);
});
test('Kimi 历史保留 reasoning_content、partial 和动态工具声明',()=>{
  const dynamic=[{type:'function',function:{name:'weather',parameters:{type:'object'}}}];
  const result=normalizeMessages([{role:'system',tools:dynamic},{role:'user',content:'问题'},{role:'assistant',content:'前缀',reasoning_content:'思考',partial:true}],toolPolicy(dynamic));
  assert.match(result[0].content,/Dynamic tool declarations/);assert.equal(result.at(-1).reasoning_content,'思考');assert.equal(result.at(-1).partial,true);
  assert.throws(()=>normalizeMessages([{role:'assistant',content:'x',partial:true},{role:'user',content:'y'}],null),/partial/);
});
