import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IdempotencyStore } from '../src/idempotency.mjs';

class PendingResponse extends EventEmitter {
  destroyed=false;
  writableFinished=false;
  headersSent=false;
  write(){return true;}
  end(){}
  writeHead(){return this;}
  getHeader(){return undefined;}
}

test('等待幂等重放的客户端断开时立即退出等待',async()=>{
  const store=new IdempotencyStore(),body={model:'kimi-k3',messages:[{role:'user',content:'你好'}]};
  const first=new PendingResponse(),second=new PendingResponse();
  assert.equal(await store.begin('same-request','/v1/chat/completions',body,first),false);
  const waiting=store.begin('same-request','/v1/chat/completions',body,second);
  second.destroyed=true;second.emit('close');
  await assert.rejects(waiting,cause=>cause.status===499);
  first.destroyed=true;first.emit('close');
  assert.equal(store.entries.size,0);
});
