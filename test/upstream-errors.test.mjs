import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upstreamBusinessFailure, upstreamDiagnostic } from '../src/upstream-errors.mjs';

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

test('读取嵌套错误字段，并将请求频繁作为限流而非模型故障',()=>{
  const value={success:false,code:500,result:{errorMessage:'请求过于频繁，请稍后再试'}};
  const failure=upstreamBusinessFailure(value,'chatglm');
  assert.equal(failure.status,429);assert.equal(failure.category,'rate_limit');
  assert.deepEqual(upstreamDiagnostic(value),{business_code:500,errors:['请求过于频繁，请稍后再试']});
});

test('调试信息仅包含错误字段，凭据脱敏并限制输出长度和行数',()=>{
  const secret='private-password-123',jwt='eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoicHJpdmF0ZSJ9.signature';
  const value={code:500,message:`error ${secret}\nBearer api-secret token="unlisted-secret" ${jwt}`,
    result:{msg:'x'.repeat(3000)},messages:[{content:'private request body'}],chatInfo:'private prompt'};
  const result=upstreamDiagnostic(value,[secret,'api-secret']);
  assert.equal(result.business_code,500);assert.equal(result.errors.length,2);
  assert.equal(result.errors[1].length,1024);
  const encoded=JSON.stringify(result);
  for(const excluded of [secret,jwt,'api-secret','unlisted-secret','private request body','private prompt'])assert.ok(!encoded.includes(excluded));
  assert.equal(encoded.includes('\n'),false);assert.match(encoded,/redacted/);
});
