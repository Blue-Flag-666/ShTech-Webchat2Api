import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opencodeConfig, opencodeV2Config } from '../src/opencode.mjs';
import { modelDirectory } from '../src/models.mjs';

test('两版 OpenCode 的四种模型均保留上下文空间而不将整窗用作输出',()=>{
  const models=modelDirectory([
    {aiType:'Kimi-k3',maxToken:1048576},
    {aiType:'chatglm',maxToken:524288},
    {aiType:'deepseek-pro',maxToken:524288},
    {aiType:'qwen-instruct',maxToken:524288}
  ].map(record=>({...record,rootAiType:'xinference'})));
  const v1=opencodeConfig(models,'http://127.0.0.1:8787/v1','test');
  const v2=opencodeV2Config(models,'http://127.0.0.1:8787/v1','test');
  for(const model of models.filter(model=>model.primary)){
    const expected=model.id==='kimi-k3'?{context:1048576,output:131072}:{context:524288,output:16384};
    assert.deepEqual(v1.provider.shtech.models[model.id].limit,expected);
    assert.deepEqual(v2.providers.shtech.models[model.id].limit,expected);
  }
});

test('Kimi 路由 ID 更新后两版 OpenCode 仍使用规范 ID 和 Kimi 输出预算',()=>{
  const models=modelDirectory([
    {aiType:'cloud-kimi',aiName:'Kimi-K3',rootAiType:'azure',maxToken:1048576},
    {aiType:'qwen-instruct',aiName:'Qwen-3.8',rootAiType:'xinference',maxToken:524288},
    {aiType:'school-kimi-route',aiName:'Kimi-K3',rootAiType:'xinference',maxToken:1048576}
  ]);
  for(const config of [opencodeConfig(models,'http://localhost/v1','key'),opencodeV2Config(models,'http://localhost/v1','key')]){
    assert.equal(config.model,'shtech/school-kimi-route');
    const entries=(config.provider||config.providers).shtech.models;
    assert.deepEqual(Object.keys(entries),['qwen-instruct','school-kimi-route']);
    assert.deepEqual(entries['school-kimi-route'].limit,{context:1048576,output:131072});
  }
});

test('OpenCode 配置只包含校内部署模型并优先使用 Kimi K3', () => {
  const config = opencodeConfig([
    { id: 'gpt-6', owned_by: 'shanghaitech', root_ai_type: 'azure' },
    { id: 'qwen-instruct', display_name: 'Qwen-3.8', owned_by: 'shanghaitech', root_ai_type: 'xinference', context_window: 524288 },
    { id: 'kimi-k3', owned_by: 'shanghaitech', root_ai_type: 'xinference', context_window: 1048576 }
  ], 'http://127.0.0.1:8787/v1', 'local-key');
  assert.equal(config.model, 'shtech/kimi-k3');
  assert.deepEqual(Object.keys(config.provider.shtech.models), ['qwen-instruct', 'kimi-k3']);
  assert.deepEqual(config.provider.shtech.models['kimi-k3'].limit, { context: 1048576, output: 131072 });
  assert.equal(config.provider.shtech.models['qwen-instruct'].name,'Qwen-3.8 (qwen-instruct)');
  assert.equal(config.provider.shtech.options.baseURL, 'http://127.0.0.1:8787/v1');
  assert.equal(config.provider.shtech.options.apiKey, 'local-key');
});

test('无校内部署模型时不生成 OpenCode 配置', () => {
  assert.throws(() => opencodeConfig([{ id: 'gpt-6', root_ai_type: 'azure', owned_by: 'shanghaitech' }], 'http://localhost/v1', 'key'), /没有可用/);
  assert.throws(() => opencodeV2Config([{ id: 'gpt-6', root_ai_type: 'azure', owned_by: 'shanghaitech' }], 'http://localhost/v1', 'key'), /没有可用/);
});

test('OpenCode 两版配置为小窗口和缺少窗口信息的模型保留输入预算',()=>{
  const models=[
    {id:'code-small',root_ai_type:'xinference',owned_by:'shanghaitech',context_window:8192},
    {id:'code-unknown',root_ai_type:'xinference',owned_by:'shanghaitech'}
  ];
  const first=opencodeConfig(models,'http://localhost/v1','key').provider.shtech.models;
  const second=opencodeV2Config(models,'http://localhost/v1','key').providers.shtech.models;
  for(const entries of [first,second]){
    assert.deepEqual(entries['code-small'].limit,{context:8192,output:2048});
    assert.deepEqual(entries['code-unknown'].limit,{context:16384,output:4096});
  }
});

test('带下划线或路径的学校模型也能生成 OpenCode 配置',()=>{
  const models=modelDirectory([{aiType:'vendor/code_v2',rootAiType:'xinference',status:3}]);
  const config=opencodeConfig(models,'http://127.0.0.1:8787/v1','local-key');
  assert.deepEqual(Object.keys(config.provider.shtech.models),['vendor/code_v2']);
  assert.equal(config.provider.shtech.models['vendor/code_v2'].name,'vendor/code_v2');
});

test('OpenCode 只列出每个学校模型的规范 ID，API 别名仍由模型目录保留',()=>{
  const models=modelDirectory([
    {aiType:'Kimi-k3',aiName:'Kimi-K3',rootAiType:'xinference'},
    {aiType:'qwen-instruct',aiName:'Qwen-3.8',rootAiType:'xinference'}
  ]);
  const config=opencodeConfig(models,'http://127.0.0.1:8787/v1','local-key');
  assert.deepEqual(Object.keys(config.provider.shtech.models),['kimi-k3','qwen-instruct']);
  assert.ok(models.some(model=>model.id==='Kimi-k3'));
  assert.ok(models.some(model=>model.id==='qwen-3.8'));
});

test('OpenCode V2 配置使用原生兼容包并声明各模型实际能力', () => {
  const config = opencodeV2Config([
    { id: 'gpt-6', owned_by: 'shanghaitech', root_ai_type: 'azure' },
    { id: 'qwen-instruct', owned_by: 'shanghaitech', root_ai_type: 'xinference', context_window: 524288, capabilities: { tools: 'emulated', vision: false } },
    { id: 'kimi-k3', display_name: 'Kimi-K3', owned_by: 'shanghaitech', root_ai_type: 'xinference', context_window: 1048576, capabilities: { tools: 'emulated', vision: true } }
  ], 'http://127.0.0.1:8787/v1', 'local-key');
  assert.equal(config.model, 'shtech/kimi-k3');
  assert.equal(config.providers.shtech.package, '@opencode/ai/providers/openai-compatible');
  assert.deepEqual(config.providers.shtech.settings, { baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'local-key' });
  assert.deepEqual(Object.keys(config.providers.shtech.models), ['qwen-instruct', 'kimi-k3']);
  assert.equal(config.providers.shtech.models['kimi-k3'].name,'Kimi-K3');
  assert.deepEqual(config.providers.shtech.models['qwen-instruct'].capabilities, { tools: true, input: ['text'], output: ['text'] });
  assert.deepEqual(config.providers.shtech.models['kimi-k3'].capabilities, { tools: true, input: ['text', 'image'], output: ['text'] });
  assert.deepEqual(config.providers.shtech.models['kimi-k3'].limit, { context: 1048576, output: 131072 });
});
