import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstreamEvent } from '../src/upstream-sse.mjs';

const event=value=>({event:'message',data:JSON.stringify(value)});
const decode=value=>JSON.parse(normalizeUpstreamEvent(event(value)).data);

test('包装与双重编码响应保留用量、原生工具调用和结束原因',()=>{
  const chunk={id:'chat-1',choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'read',arguments:'{}'}}]},finish_reason:'tool_calls'}]};
  for(const value of [chunk,{data:chunk},{success:true,result:chunk},{data:JSON.stringify(chunk)},JSON.stringify(chunk)]){
    const parsed=decode(value);assert.equal(parsed.choices[0].index,0);
    assert.deepEqual(parsed.choices[0].delta,chunk.choices[0].delta);
    assert.equal(parsed.choices[0].finish_reason,'tool_calls');
  }
  const parsed=decode({usage:{completion_tokens:2},result:chunk});
  assert.equal(parsed.usage.completion_tokens,2);assert.equal(parsed.id,'chat-1');
});

test('兼容消息式和旧版文本选择项，不覆盖已提供的增量内容',()=>{
  assert.equal(decode({choices:[{message:{role:'assistant',content:'完整回答'},finish_reason:'stop'}]}).choices[0].delta.content,'完整回答');
  assert.equal(decode({choices:[{text:'回答'}]}).choices[0].delta.content,'回答');
  assert.equal(decode({choices:[{delta:{content:'增量'},message:{content:'不要重复'}}]}).choices[0].delta.content,'增量');
});

test('识别控制消息，同时保留真实业务失败及 token 失效信息',()=>{
  for(const value of [{},{type:'ping'},{event:'heartbeat'},{heartbeat:123},{status:'running'},{request_id:'request-1',conversation_id:'c'},{id:'request-1',model:'m'},{success:true,code:200,result:null},{code:'200',msg:'ok',data:null}])assert.equal(normalizeUpstreamEvent(event(value)),null);
  assert.equal(normalizeUpstreamEvent({event:'ping',data:'1700000000'}),null);
  assert.equal(normalizeUpstreamEvent({event:'message',data:'[DONE]'}).data,'[DONE]');
  for(const value of [{success:false,message:'denied'},{code:401,msg:'expired'},{code:503,message:'busy'},{error:{message:'denied'}}])assert.deepEqual(decode({result:value}),value);
});

test('未知正文、异常状态、过深包装不当作成功，诊断不泄露内容',()=>{
  for(const value of [{message:'private response'},{status:'failed',message:'private error'},{content:'private text'},{result:{data:{result:{data:{result:{choices:[]}}}}}},['private text'],null]){
    assert.throws(()=>normalizeUpstreamEvent(event(value)),cause=>{
      assert.equal(cause.status,502);assert.equal(cause.upstreamProtocol,true);
      assert.doesNotMatch(cause.message,/private/);return true;
    });
  }
});
