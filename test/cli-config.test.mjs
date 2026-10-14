import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { envValue, inspectionTimeout } from '../src/cli-config.mjs';

test('CLI 目录查询等待一次完整续登，普通状态查询保持短超时',()=>{
  for(const command of ['models','opencode','opencode-v2','doctor']){
    assert.equal(inspectionTimeout(command),95000);
    assert.equal(inspectionTimeout(command,2000),13000);
  }
  assert.equal(inspectionTimeout('status'),5000);
});

test('首次配置原样保存密码中的引号、反斜杠、注释符和空格',()=>{
  const values=['simple_123','',String.raw`literal\n\t\password`,' leading and trailing ',
    'with#comment','with"double','with\'single','both\'"quotes',
    'all\'"`quotes','contains=equals','中文密码',String.raw`"quoted\n"#comment`,
    "'first quote # with double\"quote",'\ttab\t'];
  for(const value of values)assert.equal(parseEnv(`GENAI_PASSWORD=${envValue(value)}\n`).GENAI_PASSWORD,value);
});

test('配置拒绝换行与空字符，错误不包含凭据',()=>{
  for(const value of ['private\nvalue','private\rvalue','private\0value']){
    assert.throws(()=>envValue(value),cause=>!cause.message.includes('private')&&/配置值/.test(cause.message));
  }
});
