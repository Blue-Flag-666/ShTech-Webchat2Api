import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJsonLimited } from './transport.mjs';

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
