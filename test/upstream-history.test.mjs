import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textHistoryRequest } from '../src/upstream-history.mjs';

test('历史恢复保留工具结果、思考、原请求参数和文件引用，不修改原对象',()=>{
  const request={messages:[{role:'system',content:'规则'},{role:'assistant',content:'<api_tool_call>{"name":"read"}</api_tool_call>',reasoning_content:'思考'},{role:'user',content:'Tool result: stdout stderr exit_code=7'}],chatInfo:'当前问题和工具定义',maxToken:2876,thinking:false,aiType:'deepseek-pro',chatGroupId:'old',fileIds:['file-1']};
  const original=structuredClone(request),next=textHistoryRequest(request,'new');
  assert.deepEqual(request,original);assert.deepEqual(next.messages,[request.messages[0]]);
  assert.ok(next.chatInfo.includes(JSON.stringify(request.messages)));assert.ok(next.chatInfo.endsWith(request.chatInfo));
  for(const key of ['maxToken','thinking','aiType','fileIds'])assert.deepEqual(next[key],request[key]);
  assert.equal(next.chatGroupId,'new');
  assert.equal(textHistoryRequest({...request,messages:[]}),null);
});
