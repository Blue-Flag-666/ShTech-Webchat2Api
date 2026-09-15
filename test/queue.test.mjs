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
