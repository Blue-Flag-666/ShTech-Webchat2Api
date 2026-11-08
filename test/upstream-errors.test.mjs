import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upstreamBusinessFailure, upstreamHttpFailure, upstreamDiagnostic } from '../src/upstream-errors.mjs';

test('上游业务错误保留实际状态码和脱敏消息，分类仅用于恢复',()=>{
  for(const [value,status,category] of [
    [{code:500,message:'参数不合法 password=private'},500,'invalid_request'],
    [{code:500,message:'maximum context window exceeded private'},500,'context_length_exceeded'],
    [{code:'401',msg:'private'},401,'authentication'],
    [{error:{code:403,message:'private'}},403,'permission'],
    [{code:500,message:'额度不足 private'},500,'quota'],
    [{message:'rate limit exceeded private'},429,'rate_limit'],
    [{code:500,message:'模型繁忙 private'},500,'busy'],
    [{code:500,message:'处理超时 private'},500,'timeout'],
    [{code:500,message:'private upstream details'},500,'unknown']
  ]){
    const failure=upstreamBusinessFailure(value,'chatglm');
    assert.equal(failure.status,status);assert.equal(failure.category,category);
    assert.equal(failure.message,upstreamDiagnostic(value).errors.join('; '));assert.ok(!failure.message.includes('password=private'));assert.equal(failure.code,Number(value.code??value.error?.code)||undefined);
    if(category==='context_length_exceeded')assert.equal(failure.code,500);
  }
});

test('错误码字段不输出任意文本，业务码与分类可安全用于日志',()=>{
  const failure=upstreamBusinessFailure({code:'private-token',message:'private answer'},'chatglm');
  assert.equal(failure.message,'private answer');assert.equal(failure.category,'unknown');
  assert.match(failure.message,/private answer/);assert.doesNotMatch(failure.message,/private-token/);
});

test('读取嵌套错误字段，并将请求频繁作为限流而非模型故障',()=>{
  const value={success:false,code:500,result:{errorMessage:'请求过于频繁，请稍后再试'}};
  const failure=upstreamBusinessFailure(value,'chatglm');
  assert.equal(failure.status,500);assert.equal(failure.category,'rate_limit');
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

test('HTTP 错误保留状态码、嵌套错误码和消息，凭据脱敏',async()=>{
  const failure=await upstreamHttpFailure(new Response(JSON.stringify({error:{code:'worker_failed',message:'backend refused token=private-secret'}}),{status:500}),'deepseek-pro',['private-secret']);
  assert.equal(failure.status,500);assert.equal(failure.code,'worker_failed');
  assert.match(failure.message,/backend refused/);assert.doesNotMatch(failure.message,/private-secret/);
  const plain=await upstreamHttpFailure(new Response('maintenance',{status:503}),'deepseek-pro');
  assert.equal(plain.status,503);assert.equal(plain.message,'maintenance');
});
