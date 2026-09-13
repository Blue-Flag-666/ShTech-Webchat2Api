import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCas, TokenManager } from './auth.mjs';
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
