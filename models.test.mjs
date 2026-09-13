import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelDirectory, isDomesticSelfHosted } from './models.mjs';
test('国内模型同时要求明确的自部署路由',()=>{
  for(const aiType of ['qwen-instruct','deepseek-pro','chatglm','glm-5','MiniMax-M1','kimi-k3']) assert.equal(isDomesticSelfHosted({aiType,rootAiType:'xinference'}),true);
  for(const aiType of ['gpt-5','claude','gemini','llama-4','unknown','qwen-gpt']) assert.equal(isDomesticSelfHosted({aiType,rootAiType:'xinference'}),false);
  for(const rootAiType of ['azure','openai',undefined,'']) assert.equal(isDomesticSelfHosted({aiType:'qwen-instruct',rootAiType}),false);
});
test('筛选结果为空也保留空目录，不复活被移除的模型',()=>{
  assert.deepEqual(modelDirectory([{aiType:'gpt-5',rootAiType:'azure'}]),[]);
});
