import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upstreamBusinessFailure } from '../src/upstream-errors.mjs';

test('上游业务错误按安全分类区分请求问题、认证与真实服务故障',()=>{
  for(const [value,status,category] of [
    [{code:500,message:'参数不合法 password=private'},400,'invalid_request'],
    [{code:500,message:'maximum context window exceeded private'},400,'context_length_exceeded'],
    [{code:'401',msg:'private'},401,'authentication'],
    [{error:{code:403,message:'private'}},403,'permission'],
    [{code:500,message:'额度不足 private'},429,'quota'],
    [{message:'rate limit exceeded private'},429,'rate_limit'],
    [{code:500,message:'模型繁忙 private'},503,'busy'],
    [{code:500,message:'处理超时 private'},504,'timeout'],
    [{code:500,message:'private upstream details'},502,'unknown']
  ]){
    const failure=upstreamBusinessFailure(value,'chatglm');
    assert.equal(failure.status,status);assert.equal(failure.category,category);
    assert.match(failure.message,/chatglm/);assert.doesNotMatch(failure.message,/private|password/);
    if(category==='context_length_exceeded')assert.equal(failure.code,category);
  }
});

test('错误码字段不输出任意文本，业务码与分类可安全用于日志',()=>{
  const failure=upstreamBusinessFailure({code:'private-token',message:'private answer'},'chatglm');
  assert.match(failure.message,/业务码 未提供/);assert.match(failure.message,/分类 unknown/);
  assert.doesNotMatch(failure.message,/private/);
});
