import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { shutdown } from './lifecycle.mjs';
import { listenForFetch } from './fixtures.mjs';

test('停止服务后允许已接收请求完成，多次关闭共享结果',async()=>{
  let release;
  const server=http.createServer((req,res)=>{release=()=>res.end('complete');});
  await listenForFetch(server);
  const received=once(server,'request');
  const response=fetch(`http://127.0.0.1:${server.address().port}`);
  await received;
  const closing=shutdown(server,1000);
  assert.equal(server.listening,false);assert.equal(shutdown(server),closing);
  release();assert.equal(await (await response).text(),'complete');
  assert.deepEqual(await closing,{forced:false});
});

test('超过关闭宽限期强制断开活动流',async()=>{
  let closed;
  const server=http.createServer((req,res)=>{closed=once(res,'close');res.write('partial');});
  await listenForFetch(server);
  const response=await fetch(`http://127.0.0.1:${server.address().port}`);
  const reading=response.text();const rejected=assert.rejects(reading);
  assert.deepEqual(await shutdown(server,20),{forced:true});
  await closed;await rejected;
});
