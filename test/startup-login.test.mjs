import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, configuration, checkStartupLogin } from '../src/server.mjs';
import { TokenManager } from '../src/auth.mjs';
import { listenForFetch, confirmedModels } from './fixtures.mjs';

async function check(config, login, catalogue, run) {
  const manager=new TokenManager(config,login,()=>{});
  const server=createServer({...config,key:'test',timeout:1000,modelTtl:0},undefined,catalogue,manager);
  await listenForFetch(server);
  const messages=[];
  try {
    await checkStartupLogin(server,(event,message)=>messages.push({event,message}));
    await run(messages,manager);
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
}

test('默认启用启动检查，仅明确 false 时禁用',()=>{
  assert.equal(configuration({}).startupCheck,true);
  assert.equal(configuration({GENAI_STARTUP_CHECK:'false'}).startupCheck,false);
});

test('启动检查完成 CAS 登录并读取自部署模型，后续请求复用 token',async()=>{
  let logins=0,reads=0;
  await check({username:'private-user',password:'private-password'},async()=>{logins++;return 'private-token';},async token=>{
    reads++;assert.equal(token,'private-token');return confirmedModels();
  },async(messages,manager)=>{
    assert.deepEqual(messages.map(item=>item.event),['start','success']);
    assert.match(messages.at(-1).message,/1 个自部署模型/);
    assert.doesNotMatch(JSON.stringify(messages),/private-/);
    assert.equal(await manager.get(),'private-token');assert.equal(logins,1);assert.equal(reads,1);
  });
});

test('启动检查验证静态 token，上游拒绝时不报告成功',async()=>{
  await check({token:'private-token'},async()=>{throw new Error('must not login');},async()=>{
    throw Object.assign(new Error('secret upstream body'),{status:401});
  },async messages=>{
    assert.deepEqual(messages.map(item=>item.event),['start','failure']);
    assert.match(messages.at(-1).message,/认证失败/);
    assert.doesNotMatch(JSON.stringify(messages),/private-|secret/);
  });
});

test('网络故障、未配置和无可用模型均明确报告启动检查失败',async()=>{
  for(const [config,catalogue,reason] of [
    [{token:'t'},async()=>{throw new Error('offline');},/校内网络/],
    [{},async()=>{throw new Error('must not fetch');},/未配置/],
    [{token:'t'},async()=>({success:true,result:{records:[]}}),/模型目录/]
  ]) await check(config,async()=>{throw new Error('must not login');},catalogue,async messages=>{
    assert.deepEqual(messages.map(item=>item.event),['start','failure']);assert.match(messages.at(-1).message,reason);
  });
});
