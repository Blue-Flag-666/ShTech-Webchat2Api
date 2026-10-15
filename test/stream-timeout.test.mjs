import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withStreamTimeout } from '../src/stream-timeout.mjs';

test('持续到来的事件可以超过空闲上限的总时长',async()=>{
  const source=(async function*(){for(let i=0;i<10;i++){await delay(30);yield i;}})();
  assert.deepEqual(await Array.fromAsync(withStreamTimeout(source,150)),[0,1,2,3,4,5,6,7,8,9]);
});

test('消费端停顿不占用上游等待时间',async()=>{
  const stream=withStreamTimeout((async function*(){yield 'first';yield 'second';})(),50);
  assert.equal((await stream.next()).value,'first');
  await delay(100);
  assert.equal((await stream.next()).value,'second');
  assert.equal((await stream.next()).done,true);
});

test('永不返回的上游会超时，不等待其 return 完成才能报错',async()=>{
  let returned=0;
  const source={ [Symbol.asyncIterator](){return this;},next(){return new Promise(()=>{});},return(){returned++;return new Promise(()=>{});} };
  await assert.rejects(Array.fromAsync(withStreamTimeout(source,30)),cause=>cause.status===504&&/有效响应数据/.test(cause.message));
  assert.equal(returned,1);
});
