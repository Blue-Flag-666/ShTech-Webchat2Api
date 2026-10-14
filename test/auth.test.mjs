import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCas, TokenManager, encryptPassword, refreshRejectedToken } from '../src/auth.mjs';
import { createDecipheriv } from 'node:crypto';

test('CAS 加密前缀和 IV 保持 ASCII，解密后密码字符边界不变',()=>{
  for(let i=0;i<20;i++) {
    const cipher=encryptPassword('密码-test','1234567890123456');
    const decrypt=createDecipheriv('aes-128-cbc',Buffer.from('1234567890123456'),Buffer.from('0000000000000000'));
    const plain=Buffer.concat([decrypt.update(Buffer.from(cipher,'base64')),decrypt.final()]).toString('utf8');
    assert.equal(plain.slice(64),'密码-test');
  }
});

test('学校 OAuth 跳转链取得 token，不向外部域名发送凭据',async()=>{
  const redirects=[
    'https://genai.shanghaitech.edu.cn/htk/oauth/callback',
    'https://ids.shanghaitech.edu.cn/authserver/oauth2.0/authorize',
    'https://ids.shanghaitech.edu.cn/authserver/login',
    null,
    'https://ids.shanghaitech.edu.cn/authserver/oauth2.0/callbackAuthorize',
    'https://ids.shanghaitech.edu.cn/authserver/oauth2.0/authorize',
    'https://genai.shanghaitech.edu.cn/htk/oauth/callback',
    'https://genai.shanghaitech.edu.cn/dashboard/analysis?token=mock-oauth-token'
  ];
  let index=0;
  const token=await loginCas('user','password',async(url,options)=>{
    assert.ok(['genai.shanghaitech.edu.cn','ids.shanghaitech.edu.cn'].includes(new URL(url).hostname));
    const location=redirects[index++];
    if(location)return new Response(null,{status:302,headers:{location}});
    return new Response('<input id="pwdEncryptSalt" value="1234567890123456"><input name="execution" value="e1">');
  });
  assert.equal(token,'mock-oauth-token');assert.equal(index,8);
});
test('CAS 重定向携带本站 cookie 并提取 token',async()=>{
  let calls=0;
  const token=await loginCas('user','password',async(url,options)=>{
    calls++;
    if(calls===1)return new Response(null,{status:302,headers:{location:'https://ids.shanghaitech.edu.cn/authserver/login?service=test'}});
    if(calls===2)return new Response('<input id="pwdEncryptSalt" value="1234567890123456"><input name="execution" value="e1">',{headers:{'set-cookie':'session=test; HttpOnly; Secure'}});
    assert.equal(options.headers.Cookie,'session=test');assert.equal(options.method,'POST');
    const form=new URLSearchParams(options.body);assert.equal(form.get('username'),'user');assert.notEqual(form.get('password'),'password');
    return new Response(null,{status:302,headers:{location:'https://genai.shanghaitech.edu.cn/?token=jwt-test'}});
  });
  assert.equal(token,'jwt-test');assert.equal(calls,3);
});
test('CAS 拒绝跳往外部域名且不泄露密码',async()=>{
  let calls=0;
  await assert.rejects(loginCas('user','private-password',async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://attacker.example/login'}});}),/未允许/);
  assert.equal(calls,1);
});
test('过期 token 并发只登录一次，静态 token 不伪造续期',async()=>{
  let calls=0;
  const expired='header.'+Buffer.from(JSON.stringify({exp:1})).toString('base64url')+'.signature';
  const manager=new TokenManager({token:expired,username:'u',password:'p'},async()=>{calls++;return 'new-token';});
  assert.deepEqual(await Promise.all([manager.get(),manager.get(),manager.get()]),['new-token','new-token','new-token']);assert.equal(calls,1);
  await assert.rejects(new TokenManager({token:expired}).get(),/失效/);
});

test('取消单个请求的 token 等待不会中断其他请求共用的登录',async()=>{
  let finish,calls=0;
  const manager=new TokenManager({username:'u',password:'p'},async()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const controller=new AbortController();
  const cancelled=manager.get(false,controller.signal);
  const waiting=manager.get();
  controller.abort();
  await assert.rejects(cancelled,/取消/);
  assert.equal(calls,1);
  finish('shared-token');
  assert.equal(await waiting,'shared-token');
  assert.equal(await manager.get(),'shared-token');
  assert.equal(calls,1);
});

test('并发 CAS 登录只记录一次结果，缓存命中不重复记录，强制续期另行记录',async()=>{
  const messages=[];let calls=0;
  const manager=new TokenManager({username:'private-user',password:'private-password'},async()=>`private-token-${++calls}`,(event,message)=>messages.push({event,message}));
  await Promise.all([manager.get(),manager.get(),manager.get()]);
  await manager.get();
  assert.equal(calls,1);
  assert.deepEqual(messages.map(item=>item.event),['start','success']);
  await manager.get(true);
  assert.deepEqual(messages.map(item=>item.event),['start','success','start','success']);
  assert.match(messages[3].message,/续期成功/);
  assert.doesNotMatch(JSON.stringify(messages),/private-/);
});

test('CAS 失败日志不包含异常中的凭据，失败后可以重新登录',async()=>{
  const messages=[];let calls=0;
  const manager=new TokenManager({username:'private-user',password:'private-password'},()=>{
    if(++calls===1)throw new Error('private-password token=private-token\nforged log');
    return Promise.resolve('private-token');
  },(event,message)=>messages.push({event,message}));
  await assert.rejects(manager.get(),/private-password/);
  assert.deepEqual(messages.map(item=>item.event),['start','failure']);
  assert.doesNotMatch(JSON.stringify(messages),/private-|forged/);
  assert.equal(await manager.get(),'private-token');
  assert.equal(messages.at(-1).event,'success');
});

test('CAS 空 token 记录失败，日志回调故障不影响认证',async()=>{
  const messages=[];
  const manager=new TokenManager({username:'u',password:'p'},async()=>'',(event,message)=>messages.push({event,message}));
  await assert.rejects(manager.get(),/空 token/);
  assert.deepEqual(messages.map(item=>item.event),['start','failure']);
  assert.match(messages.at(-1).message,/空 token/);
  assert.equal(await new TokenManager({username:'u',password:'p'},async()=>'token',()=>{throw new Error('logger failed');}).get(),'token');
});

test('另一个请求已更换 token 时，迟到的 401 不再次登录',async()=>{
  let logins=0;
  const manager=new TokenManager({token:'old',username:'u',password:'p'},async()=>`new-${++logins}`,()=>{});
  assert.equal(await refreshRejectedToken(manager,'old'),'new-1');
  assert.equal(await refreshRejectedToken(manager,'old'),'new-1');
  assert.equal(await refreshRejectedToken(manager,'old'),'new-1');
  assert.equal(logins,1);
  assert.equal(await refreshRejectedToken(manager,'new-1'),'new-2');
  assert.equal(logins,2);
});
