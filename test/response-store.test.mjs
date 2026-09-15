import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseStore } from '../src/response-store.mjs';

test('响应存储隔离副本、限制数量并支持删除',()=>{
  const store=new ResponseStore(1,1000),value={response:{id:'resp_1'}};
  store.set('resp_1',value);value.response.id='changed';assert.equal(store.get('resp_1').response.id,'resp_1');
  store.set('resp_2',{response:{id:'resp_2'}});assert.throws(()=>store.get('resp_1'),/不存在/);
  store.delete('resp_2');assert.equal(store.size,0);assert.throws(()=>store.get('resp_2'),/不存在/);
});
