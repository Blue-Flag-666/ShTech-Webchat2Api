import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { casFetch } from './transport.mjs';

const GENAI = 'https://genai.shanghaitech.edu.cn';
const IDS = 'https://ids.shanghaitech.edu.cn';
const fail = message => Object.assign(new Error(message), { status: 401 });
export function secret(env, name) {
  if (env[`${name}_FILE`]) return readFileSync(env[`${name}_FILE`], 'utf8').trimEnd();
  return env[name] || '';
}
export function encryptPassword(password, salt) {
  const key = Buffer.from(salt);
  if (![16, 24, 32].includes(key.length)) throw fail('CAS 密码加密参数无效');
  // The browser uses ASCII random strings. Preserve character counts when the
  // CAS server decodes and discards the 64-character prefix after decryption.
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.from(randomBytes(8).toString('hex')));
  const prefix=Buffer.from(randomBytes(32).toString('hex'));
  return Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(password)])), cipher.final()]).toString('base64');
}
function field(html, name) {
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), m[3]]));
    if (attrs.name === name || attrs.id === name) return attrs.value || '';
  }
  return '';
}
function destination(value, base) {
  const url = new URL(value, base);
  if (![GENAI, IDS].includes(url.origin) || url.username || url.password) throw fail('CAS 重定向到了未允许的域名');
  return url;
}
export async function loginCas(username, password, fetcher = casFetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const jars = new Map();
  async function request(url, init = {}) {
    const target = destination(url, GENAI);
    const jar = jars.get(target.origin) || new Map(); jars.set(target.origin, jar);
    const headers = { Accept: 'text/html', ...init.headers };
    if (jar.size) headers.Cookie = [...jar].map(([k,v])=>`${k}=${v}`).join('; ');
    const response = await fetcher(target.href, { ...init, headers, redirect: 'manual', signal: controller.signal });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';',1)[0], index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0,index),pair.slice(index+1));
    }
    return response;
  }
  try {
    let url = new URL('/htk/user/login',GENAI), response = await request(url), html = '';
    for (let i=0; i<10; i++) {
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel(); url = destination(location,url); response = await request(url); continue;
      }
      html = await response.text(); break;
    }
    if (url.origin !== IDS) {
      const service = html.match(/var\s+service\s*=\s*\[\s*["']([^"']+)/)?.[1];
      if (!service) throw fail('无法找到 CAS 登录入口');
      destination(service,GENAI);
      url = new URL('/authserver/login',IDS); url.searchParams.set('service',service);
      response = await request(url); html = await response.text();
    }
    const salt=field(html,'pwdEncryptSalt'), execution=field(html,'execution');
    if (!salt || !execution) throw fail('CAS 登录页缺少必要参数，可能需要人工验证');
    const body = new URLSearchParams({username,password:encryptPassword(password,salt),lt:field(html,'lt'),execution,dllt:'generalLogin',_eventId:'submit',rmShown:'1'});
    response = await request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
    for(let i=0;i<10;i++) {
      const location=response.headers.get('location');
      if (!(response.status>=300 && response.status<400 && location)) break;
      await response.body?.cancel(); url=destination(location,url);
      if(url.origin===GENAI && url.searchParams.get('token')) return url.searchParams.get('token');
      response=await request(url);
    }
    await response.body?.cancel();
    throw fail('CAS 登录未返回 token，请检查账号或在网页完成人工验证');
  } catch(e) { if(e.status) throw e; throw fail('CAS 登录连接失败或超时'); }
  finally { clearTimeout(timeout); }
}
export class TokenManager {
  constructor(config, login = loginCas) {
    this.token=config.token || ''; this.username=config.username || ''; this.password=config.password || ''; this.login=login;
  }
  get configured() { return Boolean(this.token || (this.username && this.password)); }
  get renewable() { return Boolean(this.username && this.password); }
  async get(force=false) {
    let expires=Infinity;
    try { const payload=JSON.parse(Buffer.from(this.token.split('.')[1],'base64url')); if(Number.isFinite(payload.exp)) expires=payload.exp*1000; } catch {}
    if(!force && this.token && expires>Date.now()+60000) return this.token;
    if(!this.renewable) { if(this.token && !force && expires>Date.now()) return this.token; throw fail('登录 token 已失效，请更新 GENAI_TOKEN 或配置 CAS 账号'); }
    if(this.pending) return this.pending;
    this.pending=this.login(this.username,this.password).then(token=>{if(!token)throw fail('CAS 返回空 token');this.token=token;return token;});
    try{return await this.pending;}finally{this.pending=undefined;}
  }
}
