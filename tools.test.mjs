import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessages, parseToolCalls, toolPolicy } from './tools.mjs';
const tools=[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'}}}}}];
test('工具调用解析保留标识与 JSON 参数',()=>{
  const policy=toolPolicy(tools,'required');
  const result=parseToolCalls('<api_tool_call>{"name":"weather","arguments":{"city":"上海"}}</api_tool_call>',policy,()=> 'call_test');
  assert.equal(result.content,null);assert.equal(result.tool_calls[0].id,'call_test');
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments),{city:'上海'});
});
test('不允许的工具、损坏参数、未完成块、required 未遵循均拒绝',()=>{
  const policy=toolPolicy(tools,'required');
  for(const text of ['普通回答','<tool_call>{bad}</tool_call>','<tool_call>{"name":"shell","arguments":{}}</tool_call>','<tool_call>{"name":"weather","arguments":[]}</tool_call>','<tool_call>{']) assert.throws(()=>parseToolCalls(text,policy,()=> 'call_test'));
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
