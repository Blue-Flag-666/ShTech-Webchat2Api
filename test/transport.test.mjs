import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJsonLimited, upstreamResponseHeaders, frontendScriptPath, fetchModelList } from '../src/transport.mjs';

test('模型目录保留 HTTP 鉴权状态，也识别 JSON 登录过期状态',async()=>{
  for(const status of [401,403,503])await assert.rejects(fetchModelList('token',undefined,async()=>new Response('rejected',{status})),cause=>cause.status===status);
  await assert.rejects(fetchModelList('token',undefined,async()=>Response.json({success:false,code:401})),cause=>cause.status===401);
  const catalogue={success:true,result:{records:[]}};
  assert.deepEqual(await fetchModelList('token',undefined,async()=>Response.json(catalogue)),catalogue);
});

test('前端脚本路径兼容 assets 构建目录，同时保持路径白名单',()=>{
  for(const path of ['/js/app.abc.js','/assets/index-ABC_123.js','/assets/upload.mjs'])assert.equal(frontendScriptPath(path),true,path);
  for(const path of ['/htk/user/list','/assets/nested/app.js','/js/app.js/extra','/assets/app.js%00','/js/app.json'])assert.equal(frontendScriptPath(path),false,path);
});

test('真实上游响应仅保留重试头和必要的内容类型',()=>{
  const source={'content-type':'text/event-stream','retry-after':'Wed, 30 Sep 2026 00:00:00 GMT','content-security-policy':'invalid\npolicy','set-cookie':['secret=private'],'x-access-token':'secret'};
  const headers=upstreamResponseHeaders(source);
  assert.equal(headers.get('content-type'),'text/event-stream');
  assert.equal(headers.get('retry-after'),source['retry-after']);
  assert.equal(headers.get('content-security-policy'),null);
  assert.equal(headers.get('set-cookie'),null);
  assert.equal(headers.get('x-access-token'),null);
  assert.equal(upstreamResponseHeaders({'retry-after':'x'.repeat(129)}).get('retry-after'),null);
  assert.equal(upstreamResponseHeaders(source,true).get('set-cookie'),'secret=private');
});

test('模型目录在字节上限内解码中文，超限时取消读取',async()=>{
  const bytes=new TextEncoder().encode('{"name":"通义千问"}');
  const stream=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
  assert.deepEqual(await readJsonLimited(new Response(stream),bytes.length),{name:'通义千问'});
  let cancelled=false;
  const oversized=new ReadableStream({pull(c){c.enqueue(new Uint8Array(64));},cancel(){cancelled=true;}});
  await assert.rejects(readJsonLimited(new Response(oversized),100),/size limit/);
  assert.equal(cancelled,true);
  await assert.rejects(readJsonLimited(new Response('not JSON')),SyntaxError);
});
