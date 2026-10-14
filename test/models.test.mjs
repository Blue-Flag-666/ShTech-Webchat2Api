import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelDirectory, isSelfHostedChatModel, isKimiK3Model, modelBudget } from '../src/models.mjs';
test('Kimi 家族识别接受显示名称但不混淆 K30，也不改变自部署判断',()=>{
  const model={id:'school-route',display_name:'Kimi-K3',context_window:1048576};
  assert.equal(isKimiK3Model(model),true);
  assert.equal(isKimiK3Model({id:'kimi-k30'}),false);
  assert.deepEqual(modelBudget(model),{context:1048576,output:131072});
  assert.equal(isSelfHostedChatModel({aiType:'school-route',aiName:'Kimi-K3',rootAiType:'azure'}),false);
});
test('只要求明确的自部署路由，不根据模型名称或介绍推断',()=>{
  for(const aiType of ['qwen-instruct','deepseek-pro','Kimi-k3','campus-code','llama-4','gpt-5','vendor/code_v2','model@2026+09']) assert.equal(isSelfHostedChatModel({aiType,rootAiType:'xinference'}),true);
  assert.equal(isSelfHostedChatModel({aiType:'qwen-instruct',simpleName:'GPT compatibility',rootAiType:'xinference'}),true);
  for(const aiType of ['','bad model','/invalid']) assert.equal(isSelfHostedChatModel({aiType,rootAiType:'xinference'}),false);
  for(const rootAiType of ['azure','openai',undefined,'']) assert.equal(isSelfHostedChatModel({aiType:'qwen-instruct',rootAiType}),false);
});
test('筛选结果为空也保留空目录，不复活被移除的模型',()=>{
  assert.deepEqual(modelDirectory([{aiType:'gpt-5',rootAiType:'azure'}]),[]);
});
test('网页非聊天状态的模型不会出现在 Chat 模型目录',()=>{
  const records=[
    {aiType:'qwen-image',rootAiType:'xinference',status:'2'},
    {aiType:'qwen-instruct',rootAiType:'xinference',status:'3'},
    {aiType:'Kimi-k3',rootAiType:'xinference',status:1}
  ];
  assert.equal(isSelfHostedChatModel(records[0]),false);
  assert.deepEqual(new Set(modelDirectory(records).map(model=>model.upstream_id)),new Set(['qwen-instruct','Kimi-k3']));
});
test('保留所有学校自部署聊天模型，并优先解析真实上游 ID',()=>{
  const models=modelDirectory([
    {aiType:'campus-code',aiName:'GPT Compatible',rootAiType:'xinference',status:3},
    {aiType:'gpt-compatible',aiName:'Campus Code',rootAiType:'xinference',status:3},
    {aiType:'hosted-cloud',rootAiType:'azure',status:3},
  ]);
  assert.equal(models.find(x=>x.id==='campus-code').upstream_id,'campus-code');
  assert.equal(models.find(x=>x.id==='gpt-compatible').upstream_id,'gpt-compatible');
  assert.ok(!models.some(x=>x.upstream_id==='hosted-cloud'));
});
test('仅大小写不同的两个上游 ID 不会被合并',()=>{
  const models=modelDirectory([
    {aiType:'Code-V2',aiName:'代码模型 A',rootAiType:'xinference',status:3},
    {aiType:'code-v2',aiName:'代码模型 B',rootAiType:'xinference',status:3},
  ]);
  assert.equal(models.find(model=>model.id==='Code-V2').upstream_id,'Code-V2');
  assert.equal(models.find(model=>model.id==='code-v2').upstream_id,'code-v2');
  assert.deepEqual(models.filter(model=>model.primary).map(model=>model.id),['Code-V2','code-v2']);
});
test('重复的同一上游 ID 不会改变其规范 ID',()=>{
  const models=modelDirectory([
    {aiType:'Kimi-k3',rootAiType:'xinference',status:3},
    {aiType:'Kimi-k3',rootAiType:'xinference',status:3},
  ]);
  assert.deepEqual(models.filter(model=>model.primary).map(model=>model.id),['kimi-k3']);
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
test('仅为网页声明支持深度思考的模型暴露开关',()=>{
  const models=modelDirectory([{aiType:'Kimi-k3',rootAiType:'xinference',enableDeepThink:1},{aiType:'chatglm',aiName:'GLM-5.3-Flash',rootAiType:'xinference',enableDeepThink:1},{aiType:'deepseek-pro',aiName:'DeepSeek-V4.1-Flash',rootAiType:'xinference',enableDeepThink:1},{aiType:'qwen-instruct',aiName:'Qwen-3.8',rootAiType:'xinference',enableDeepThink:0}]);
  assert.equal(models.find(x=>x.id==='kimi-k3').webchat_thinking,true);
  assert.equal(models.find(x=>x.id==='glm-5.3-flash').capabilities.reasoning,true);
  assert.equal(models.find(x=>x.id==='deepseek-v4.1-flash').capabilities.reasoning,true);
  assert.equal(models.find(x=>x.id==='qwen-3.8').capabilities.reasoning,false);
  assert.equal(models.find(x=>x.id==='qwen-instruct').webchat_thinking,undefined);
});

test('学校 2026-09 模型目录的四个国内聊天模型均可由兼容 API 选择',()=>{
  const records=[
    {aiType:'GPT-6-Sol',aiName:'GPT-6-Sol',rootAiType:'azure',status:3,maxToken:1},
    {aiType:'gpt-6-astra',aiName:'GPT-6-Astra',rootAiType:'azure',status:3,maxToken:1},
    {aiType:'GPT-6-Luna',aiName:'GPT-6-Luna',rootAiType:'azure',status:3,maxToken:1},
    {aiType:'chatglm',aiName:'GLM-5.3-Flash',rootAiType:'xinference',status:3,maxToken:524288,enableDeepThink:1},
    {aiType:'qwen-instruct',aiName:'Qwen-3.8',rootAiType:'xinference',status:3,maxToken:524288,enableDeepThink:0},
    {aiType:'deepseek-pro',aiName:'DeepSeek-V4.1-Flash',rootAiType:'xinference',status:3,maxToken:524288,enableDeepThink:1},
    {aiType:'Kimi-k3',aiName:'Kimi-K3',rootAiType:'xinference',status:3,maxToken:1048576,enableDeepThink:1}
  ];
  const models=modelDirectory(records),upstream=new Set(models.map(model=>model.upstream_id));
  assert.deepEqual(upstream,new Set(['chatglm','qwen-instruct','deepseek-pro','Kimi-k3']));
  for(const id of ['glm-5.3-flash','qwen-3.8','deepseek-v4.1-flash','kimi-k3'])assert.ok(models.some(model=>model.id===id),id);
  assert.equal(models.find(model=>model.id==='kimi-k3').context_window,1048576);
  assert.equal(models.find(model=>model.id==='kimi-k3').display_name,'Kimi-K3');
  assert.equal(models.find(model=>model.id==='qwen-instruct').display_name,'Qwen-3.8');
  assert.equal(models.find(model=>model.id==='kimi-k3').primary,true);
  assert.equal(models.find(model=>model.id==='Kimi-k3').primary,false);
  assert.equal(models.find(model=>model.id==='qwen-3.8').webchat_thinking,undefined);
});
