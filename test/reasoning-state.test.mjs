import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReasoning, sealReasoning } from '../src/reasoning-state.mjs';

test('推理状态可跨请求回放且绑定本地 API Key',()=>{
  const state=sealReasoning('检查仓库结构和测试错误','local-key');
  assert.match(state,/^enc_v1_/);
  assert.doesNotMatch(state,/检查仓库/);
  assert.equal(openReasoning(state,'local-key'),'检查仓库结构和测试错误');
  assert.throws(()=>openReasoning(state,'other-key'),/无法解密/);
  assert.throws(()=>openReasoning('enc_v1_invalid','local-key'),/无法解密/);
});
