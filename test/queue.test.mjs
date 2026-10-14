import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue } from '../src/queue.mjs';

test('请求队列按顺序交接并在满载时返回 429',async()=>{
  const queue=new RequestQueue(1,1,1000),first=await queue.acquire();
  const second=queue.acquire();
  await assert.rejects(()=>queue.acquire(),error=>error.status===429);
  first();const release=await second;assert.equal(queue.active,1);assert.equal(queue.depth,0);release();assert.equal(queue.active,0);
});

test('等待中的请求可以取消',async()=>{
  const queue=new RequestQueue(1,1,1000),release=await queue.acquire(),controller=new AbortController();
  const waiting=queue.acquire(controller.signal);controller.abort();
  await assert.rejects(()=>waiting,error=>error.status===499);release();
});

test('模型并发和队列上限不占用其他模型的空闲全局槽位',async()=>{
  const queue=new RequestQueue(2,3,1000,{'kimi-k3':{concurrency:1,queue:1}});
  const kimi=await queue.acquire(undefined,'kimi-k3');
  const waiting=queue.acquire(undefined,'kimi-k3');
  await assert.rejects(()=>queue.acquire(undefined,'kimi-k3'),error=>error.status===429);
  const qwen=await queue.acquire(undefined,'qwen-instruct');
  assert.equal(queue.active,2);assert.equal(queue.depth,1);
  qwen();assert.equal(queue.active,1);
  const deepseek=await queue.acquire(undefined,'deepseek-v3');assert.equal(queue.active,2);
  kimi();const resumed=await waiting;assert.equal(queue.active,2);
  resumed();deepseek();assert.equal(queue.active,0);
});

test('释放槽位时跳过模型已满的队首请求',async()=>{
  const queue=new RequestQueue(2,3,1000,{'kimi-k3':{concurrency:1}});
  const kimi=await queue.acquire(undefined,'kimi-k3');
  const qwen=await queue.acquire(undefined,'qwen-instruct');
  const waitingKimi=queue.acquire(undefined,'kimi-k3');
  const waitingDeepseek=queue.acquire(undefined,'deepseek-v3');
  qwen();const deepseek=await waitingDeepseek;
  assert.equal(queue.active,2);assert.equal(queue.depth,1);
  kimi();const nextKimi=await waitingKimi;
  nextKimi();deepseek();assert.equal(queue.active,0);
});

test('路径式学校模型 ID 可单独限制并发和排队',async()=>{
  const model='vendor/code_v2';
  const queue=new RequestQueue(2,2,1000,{[model]:{concurrency:1,queue:1}});
  const first=await queue.acquire(undefined,model);
  const waiting=queue.acquire(undefined,model);
  await assert.rejects(()=>queue.acquire(undefined,model),cause=>cause.status===429);
  const other=await queue.acquire(undefined,'kimi-k3');
  first();const second=await waiting;
  second();other();assert.equal(queue.active,0);
});
