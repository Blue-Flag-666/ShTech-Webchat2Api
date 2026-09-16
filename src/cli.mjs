#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { configuration, startServer } from './server.mjs';

const VERSION = '0.3.0';
const sea = isSea();
const defaultConfig = sea ? join(dirname(process.execPath), '.env') : resolve('.env');

function usage() {
  console.log(`ShTech Webchat API ${VERSION}

用法:
  shtech-webchat2api [start] [--config <文件>]
  shtech-webchat2api init [--config <文件>] [--force]
  shtech-webchat2api status|models|doctor [--config <文件>]
  shtech-webchat2api --help

直接运行时默认读取可执行文件旁的 .env；若文件不存在，会进入首次配置。`);
}

function argumentsOf(argv) {
  const result = { command: 'start', config: defaultConfig, force: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (['start','init','status','models','doctor'].includes(value) && i === 0) result.command = value;
    else if (value === '--config') {
      if (!argv[i + 1]) throw new Error('--config 后需要文件路径');
      result.config = resolve(argv[++i]);
    } else if (value === '--force') result.force = true;
    else if (['--help','-h'].includes(value)) result.help = true;
    else if (['--version','-v'].includes(value)) result.version = true;
    else throw new Error(`未知参数：${value}`);
  }
  return result;
}

function terminal() {
  const output = new Writable({ write(chunk, encoding, callback) { process.stdout.write(chunk, encoding, callback); } });
  return createInterface({ input: process.stdin, output, terminal: true });
}

async function ask(rl, question, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : '';
  const value = (await rl.question(`${question}${suffix}: `)).trim();
  return value || fallback;
}

async function hidden(rl, question) {
  const original = rl._writeToOutput;
  rl._writeToOutput = function(value) {
    if (value.includes(question)) process.stdout.write(value);
    else if (/\r|\n/.test(value)) process.stdout.write(value);
    else process.stdout.write('*');
  };
  try { return (await rl.question(`${question}: `)).trim(); }
  finally { rl._writeToOutput = original; }
}

function envValue(value) {
  if (/^[A-Za-z0-9_./:@+\-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

async function configure(path, force = false) {
  if (existsSync(path) && !force) throw new Error(`配置文件已存在：${path}\n如需覆盖，请使用 init --force`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('首次配置需要交互式终端，也可以手动创建 .env');
  console.log(`首次配置，内容将保存到：${path}`);
  const rl = terminal();
  try {
    const username = await ask(rl, 'CAS 学号');
    const password = await hidden(rl, 'CAS 密码');
    const key = await ask(rl, '本地 API Key', randomBytes(24).toString('base64url'));
    if (!username || !password || !key) throw new Error('学号、密码和 API Key 均不能为空');
    for (const value of [username,password,key]) if (/\r|\n/.test(value)) throw new Error('配置值不能包含换行符');
    const content = [
      'HOST=127.0.0.1', 'PORT=8787',
      `GENAI_USERNAME=${envValue(username)}`,
      `GENAI_PASSWORD=${envValue(password)}`,
      `API_KEY=${envValue(key)}`,
      'GENAI_NET_GO=false', 'GENAI_TIMEOUT_MS=120000', ''
    ].join('\n');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: force ? 'w' : 'wx' });
    try { chmodSync(path, 0o600); } catch {}
    console.log('配置已保存。请妥善保管 .env，不要上传或分享。');
    console.log(`本地 API Key: ${key}`);
  } finally { rl.close(); }
}

function configured(env) {
  const value = name => Boolean(env[name] || env[`${name}_FILE`]);
  return value('API_KEY') && (value('GENAI_TOKEN') || (value('GENAI_USERNAME') && value('GENAI_PASSWORD')));
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  if (options.help) return usage();
  if (options.version) return console.log(VERSION);
  if (options.command === 'init') return configure(options.config, options.force);
  if (existsSync(options.config)) process.loadEnvFile(options.config);
  else if (!configured(process.env) && options.command==='start') {
    await configure(options.config);
    process.loadEnvFile(options.config);
  }
  if(!configured(process.env))throw new Error(`配置不完整：${options.config}`);
  if(options.command!=='start')return inspect(options.command,options.config);
  const server = startServer();
  server.on('listening', () => {
    const address = server.address();
    console.log(`配置文件: ${options.config}`);
    console.log(`按 Ctrl+C 停止服务。端口: ${typeof address === 'object' ? address.port : process.env.PORT || 8787}`);
  });
}

async function inspect(command,path) {
  const config=configuration(),host=['0.0.0.0','::1','localhost'].includes(config.host)?'127.0.0.1':config.host;
  const base=`http://${host}:${config.port}`,headers={Authorization:`Bearer ${config.key}`},signal=AbortSignal.timeout(5000);
  if(command==='doctor'){
    console.log(`版本: ${VERSION}  平台: ${process.platform}-${process.arch}`);
    console.log(`配置: ${path}`);
    console.log(`登录: ${config.username?'CAS 自动刷新':config.token?'静态 Token':'未配置'}`);
    console.log(`图片: ${config.uploadToken?'使用配置的上传 Token':'自动读取网页上传凭据'}`);
  }
  const endpoint=command==='models'?'/v1/models':'/health';
  let response;try{response=await fetch(base+endpoint,{headers,signal});}catch{throw new Error(`无法连接 ${base}，请先启动服务`);}
  if(!response.ok)throw new Error(`本地服务返回 HTTP ${response.status}`);
  const value=await response.json();
  if(command==='models')for(const model of value.data||[])console.log(`${model.id}\t${JSON.stringify(model.capabilities||{})}`);
  else console.log(JSON.stringify(value,null,2));
}

main().catch(async error => {
  console.error(`启动失败：${error.message}`);
  if (sea && process.stdin.isTTY) {
    const rl = terminal();
    try { await rl.question('按 Enter 退出...'); } finally { rl.close(); }
  }
  process.exitCode = 1;
});
