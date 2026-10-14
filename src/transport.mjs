import https from 'node:https';
import { Readable } from 'node:stream';

const origin = 'https://genai.shanghaitech.edu.cn';
const endpoint = `${origin}/htk/chat/start/chat`;
// 学校聊天接口的 CSP 响应头含裸换行。兼容仅限固定上游、单次连接；
// 不影响本地 HTTP 服务解析，不关闭 TLS 校验，不复用连接或跟随重定向。
export function upstreamFetch(url, options) {
  const target = new URL(url);
  if (target.origin !== origin || target.username || target.password || !['/htk/chat/start/chat', '/htk/ai/aiModel/list', '/htk/chat/upload/chat/file'].includes(target.pathname)) throw new Error('Unsupported upstream URL');
  return transportRequest(url,options);
}

export function casFetch(url,options={}) {
  const target=new URL(url);
  const valid=target.origin===origin && (target.pathname.startsWith('/htk/user/') || target.pathname==='/htk/oauth/callback')
    || target.origin==='https://ids.shanghaitech.edu.cn' && ['/authserver/login','/authserver/oauth2.0/authorize','/authserver/oauth2.0/callbackAuthorize'].includes(target.pathname);
  if(!valid || target.username || target.password) throw new Error('Unsupported CAS URL');
  return transportRequest(url,options,true);
}

export const frontendScriptPath=path=>/^\/(?:js|assets)\/[a-z0-9._-]+\.m?js$/i.test(path);
export function frontendFetch(url,options={}) {
  const target=new URL(url,origin);
  const valid=target.origin===origin && (['/','/dashboard/analysis'].includes(target.pathname) || frontendScriptPath(target.pathname));
  if(!valid || target.username || target.password)throw new Error('Unsupported frontend URL');
  return transportRequest(target.href,{method:'GET',...options});
}

function transportRequest(url,options,auth=false) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method, headers: { ...options.headers, Connection: 'close', 'Accept-Encoding': 'identity' },
      signal: options.signal, agent: false, insecureHTTPParser: true,
    }, incoming => {
      // 不向客户端传播 Cookie、CSP 或其他不规范的上游头。
      try {
        const headers=upstreamResponseHeaders(incoming.headers,auth);
        const empty = [204, 205, 304].includes(incoming.statusCode);
        if (empty) incoming.resume();
        resolve(new Response(empty ? null : Readable.toWeb(incoming), {
          status: incoming.statusCode,
          headers,
        }));
      } catch (e) { incoming.destroy(); reject(e); }
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

// Forward only headers used by the bridge. The upstream can send malformed
// browser security headers, so its complete header set must not be copied.
export function upstreamResponseHeaders(incoming,auth=false) {
  const headers=new Headers({'content-type':incoming['content-type'] || 'application/octet-stream'});
  const retryAfter=incoming['retry-after'];
  if(typeof retryAfter==='string'&&retryAfter.length<=128)headers.set('retry-after',retryAfter);
  if(auth){
    if(incoming.location)headers.set('location',incoming.location);
    for(const cookie of incoming['set-cookie']||[])headers.append('set-cookie',cookie);
  }
  return headers;
}

export async function fetchModelList(token, signal, fetcher=upstreamFetch) {
  const response = await fetcher(`${origin}/htk/ai/aiModel/list?pageNo=1&pageSize=999&showStatusList=2%2C3`, {
    method: 'GET', headers: { Accept: 'application/json', 'x-access-token': token,
      Origin: origin, Referer: `${origin}/dashboard/analysis` }, signal,
  });
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`model list HTTP ${response.status}`),{status:response.status}); }
  const result=await readJsonLimited(response);
  if(Number(result?.code)===401)throw Object.assign(new Error('Model catalogue login expired'),{status:401});
  return result;
}

export async function readJsonLimited(response, limit=2*1024*1024) {
  let size=0; const chunks=[];
  for await (const chunk of response.body) {
    size+=chunk.byteLength;
    if (size>limit) throw new Error('Model catalogue exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
