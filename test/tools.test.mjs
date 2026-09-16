import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessages, parseToolCalls, toolPolicy } from '../src/tools.mjs';
const tools=[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}}];
test('工具调用解析保留标识与 JSON 参数',()=>{
  const policy=toolPolicy(tools,'required');
  const result=parseToolCalls('<api_tool_call>{"name":"weather","arguments":{"city":"上海"}}</api_tool_call>',policy,()=> 'call_test');
  assert.equal(result.content,null);assert.equal(result.tool_calls[0].id,'call_test');
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments),{city:'上海'});
});
test('工具调用兼容纯 JSON、代码围栏和 OpenAI function 结构',()=>{
  const policy=toolPolicy(tools,'required');
  for(const value of ['{"name":"weather","arguments":{"city":"上海"}}','```json\n{"function":{"name":"weather","arguments":"{\\"city\\":\\"上海\\"}"}}\n```']){
    const result=parseToolCalls(value,policy,()=> 'call_json');assert.equal(result.content,null);assert.equal(result.tool_calls[0].function.name,'weather');
  }
});
test('工具调用兼容围栏前说明和单块多调用',()=>{
  const policy=toolPolicy(tools,'required');
  const fenced=parseToolCalls('调用工具：\n```json\n{"name":"weather","arguments":{"city":"上海"}}\n```',policy,()=> 'call_fenced');assert.equal(fenced.tool_calls.length,1);
  const multiple=parseToolCalls('<tool_call>[{"name":"weather","arguments":{"city":"上海"}},{"name":"weather","arguments":{"city":"北京"}}]</tool_call>',policy,()=> 'call_multi');assert.equal(multiple.tool_calls.length,2);
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
