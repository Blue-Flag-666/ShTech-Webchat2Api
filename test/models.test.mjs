import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelDirectory, isDomesticSelfHosted } from '../src/models.mjs';
test('国内模型同时要求明确的自部署路由',()=>{
  for(const aiType of ['qwen-instruct','deepseek-pro','chatglm','glm-5','MiniMax-M1','kimi-k3','baichuan-4','ernie-5','doubao-2','hunyuan-t1','step-3','internlm-3']) assert.equal(isDomesticSelfHosted({aiType,rootAiType:'xinference'}),true);
  for(const aiType of ['gpt-5','claude','gemini','llama-4','unknown','qwen-gpt']) assert.equal(isDomesticSelfHosted({aiType,rootAiType:'xinference'}),false);
  assert.equal(isDomesticSelfHosted({aiType:'qwen-instruct',simpleName:'GPT compatibility',rootAiType:'xinference'}),false);
  for(const rootAiType of ['azure','openai',undefined,'']) assert.equal(isDomesticSelfHosted({aiType:'qwen-instruct',rootAiType}),false);
});
test('筛选结果为空也保留空目录，不复活被移除的模型',()=>{
  assert.deepEqual(modelDirectory([{aiType:'gpt-5',rootAiType:'azure'}]),[]);
});
test('为已发现的国内模型添加真实上游别名和能力',()=>{
  const models=modelDirectory([{aiType:'deepseek-v3:671b',aiName:'DeepSeek-V3.2',rootAiType:'xinference'},{aiType:'qwen-instruct',aiName:'Qwen3.5-397B-A17B',rootAiType:'xinference'},{aiType:'qwen-code',aiName:'Qwen3 Coder Next',rootAiType:'xinference'}]);
  assert.equal(models.find(x=>x.id==='deepseek-v3').upstream_id,'deepseek-v3:671b');
  assert.equal(models.find(x=>x.id==='qwen-instruct').capabilities.vision,true);
  assert.equal(models.find(x=>x.id==='qwen3.5-397b-a17b').upstream_id,'qwen-instruct');
  assert.equal(models.find(x=>x.id==='qwen3-coder').upstream_id,'qwen-code');
  assert.ok(models.every(x=>x.root_ai_type==='xinference'));
});
test('Kimi K3 暴露稳定别名、学校上下文和原生能力',()=>{
  const models=modelDirectory([{aiType:'Kimi-k3',simpleName:'Kimi-K3',descInfo:'国产最先进2.8万亿参数大模型',maxToken:800000,rootAiType:'xinference'}]);
  const model=models.find(x=>x.id==='kimi-k3');
  assert.equal(model.upstream_id,'Kimi-k3');assert.equal(model.context_window,800000);assert.equal(model.max_tokens,800000);
  assert.deepEqual(model.capabilities,{text:true,vision:true,tools:'emulated',reasoning:true,partial:true});
});
