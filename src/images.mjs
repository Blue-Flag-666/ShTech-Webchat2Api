import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

const MAX_IMAGES=10,MAX_BYTES=10*1024*1024;
const types=new Map([['image/jpeg','.jpg'],['image/png','.png'],['image/bmp','.bmp'],['image/gif','.gif'],['image/webp','.webp']]);
const invalid=message=>Object.assign(new Error(message),{status:400});
const upstream=message=>Object.assign(new Error(message),{status:502});
const cache=new Map();

function imageUrl(part) {
  const value=typeof part?.image_url==='string'?part.image_url:part?.image_url?.url||part?.url;
  if(typeof value!=='string'||!value)return null;
  return value;
}
function content(value,role,images,accepted=['text','input_text','output_text']) {
  if(typeof value==='string'||value==null)return value??'';
  if(!Array.isArray(value))throw invalid('content 必须是文本或内容块数组');
  const text=[];
  for(const part of value) {
    if(accepted.includes(part?.type)&&typeof part.text==='string'){text.push(part.text);continue;}
    if(['image_url','input_image'].includes(part?.type)){
      if(!['user','tool'].includes(role))throw invalid('图片只能放在 user 或 tool 消息中');
      const url=imageUrl(part);if(!url)throw invalid('图片内容块缺少 URL');images.push(url);continue;
    }
    throw invalid(`暂不支持内容块 ${part?.type||'unknown'}`);
  }
  return text.join('\n');
}

export function extractImages(path,input) {
  const value=structuredClone(input),images=[];
  if(path==='/v1/chat/completions') {
    if(Array.isArray(value.messages))for(const message of value.messages)message.content=content(message.content,message.role,images);
  } else if(path==='/v1/responses') {
    if(Array.isArray(value.input))for(const item of value.input)if(item&&(!item.type||item.type==='message'))item.content=content(item.content,item.role,images);
  } else if(path==='/v1/messages') {
    if(Array.isArray(value.messages))for(const message of value.messages){
      if(!Array.isArray(message.content))continue;
      const mapped=[];
      for(const block of message.content){
        if(block?.type==='image'){
          if(message.role!=='user')throw invalid('图片只能放在 user 消息中');
          const source=block.source;
          if(source?.type==='base64'&&typeof source.data==='string'&&typeof source.media_type==='string')images.push(`data:${source.media_type};base64,${source.data}`);
          else if(source?.type==='url'&&typeof source.url==='string')images.push(source.url);
          else throw invalid('无效的 Anthropic image source');
          continue;
        }
        if(block?.type==='tool_result'&&Array.isArray(block.content)){
          const nested=[];
          for(const item of block.content){
            if(item?.type!=='image'){nested.push(item);continue;}
            const source=item.source;
            if(source?.type==='base64'&&typeof source.data==='string'&&typeof source.media_type==='string')images.push(`data:${source.media_type};base64,${source.data}`);
            else if(source?.type==='url'&&typeof source.url==='string')images.push(source.url);
            else throw invalid('无效的 Anthropic tool_result 图片');
          }
          mapped.push({...block,content:nested});continue;
        }
        mapped.push(block);
      }
      message.content=mapped;
    }
  }
  if(images.length>MAX_IMAGES)throw invalid(`单次最多上传 ${MAX_IMAGES} 张图片`);
  return {input:value,images};
}

function publicIp(address) {
  if(isIP(address)===4){
    const p=address.split('.').map(Number),[a,b]=p;
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)
      ||(a===192&&(b===0||b===2||b===168))||(a===198&&[18,19,51].includes(b))||(a===203&&b===0&&p[2]===113));
  }
  const value=address.toLowerCase();
  if(value.startsWith('::ffff:'))return publicIp(value.slice(7));
  return !(/^::$|^::1$/.test(value)||value.startsWith('fc')||value.startsWith('fd')||value.startsWith('ff')||/^fe[89abcdef]/.test(value)
    ||value.startsWith('100:')||value.startsWith('2001:2:')||value.startsWith('2001:db8:')||/^2001:0?[0-9a-f]:/.test(value));
}
async function resolvePublic(url) {
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw invalid('图片必须使用公开的 HTTP(S) URL');
  if(url.port&&url.port!==(url.protocol==='https:'?'443':'80'))throw invalid('图片 URL 不能使用非标准端口');
  const addresses=await lookup(url.hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(item=>!publicIp(item.address)))throw invalid('图片 URL 不能指向本机或内网地址');
  return addresses[0].address;
}
async function remote(urlValue,signal,redirects=0) {
  if(urlValue.length>8192)throw invalid('图片 URL 过长');
  if(redirects>3)throw invalid('图片 URL 重定向次数过多');
  const url=new URL(urlValue),address=await resolvePublic(url),client=url.protocol==='https:'?https:http;
  return new Promise((resolve,reject)=>{
    const request=client.request({hostname:address,port:url.port||(url.protocol==='https:'?443:80),path:url.pathname+url.search,method:'GET',
      headers:{Host:url.host,Accept:'image/jpeg,image/png,image/bmp,image/gif,image/webp'},servername:url.hostname,signal},response=>{
      if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.resume();remote(new URL(response.headers.location,url).href,signal,redirects+1).then(resolve,reject);return;}
      if(response.statusCode!==200){response.resume();reject(invalid(`图片下载 HTTP ${response.statusCode}`));return;}
      const mime=(response.headers['content-type']||'').split(';')[0].toLowerCase();
      if(!types.has(mime)){response.resume();reject(invalid('图片格式仅支持 JPEG、PNG、BMP、GIF 和 WebP'));return;}
      if(Number(response.headers['content-length'])>MAX_BYTES){response.resume();reject(invalid('单张图片不能超过 10 MB'));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>MAX_BYTES)response.destroy(invalid('单张图片不能超过 10 MB'));else chunks.push(chunk);});
      response.on('end',()=>resolve({bytes:Buffer.concat(chunks),mime,name:`image${types.get(mime)}`}));
      response.on('error',reject);
    });
    request.on('error',reject);request.end();
  });
}
function validBytes(bytes,mime){
  if(mime==='image/jpeg')return bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
  if(mime==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/gif')return ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii'));
  if(mime==='image/webp')return bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
  if(mime==='image/bmp')return bytes.subarray(0,2).toString('ascii')==='BM';
  return false;
}
function data(value) {
  const match=/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if(!match||!types.has(match[1].toLowerCase()))throw invalid('无效或不支持的图片 data URL');
  const bytes=Buffer.from(match[2].replace(/\s/g,''),'base64');
  if(!bytes.length||bytes.length>MAX_BYTES)throw invalid('单张图片必须介于 1 字节和 10 MB 之间');
  const mime=match[1].toLowerCase();if(!validBytes(bytes,mime))throw invalid('图片内容与声明格式不符');return{bytes,mime,name:`image${types.get(mime)}`};
}
async function upload(file,config,accessToken,signal,fetcher) {
  if(!config.uploadToken)throw invalid('图片输入需要配置 GENAI_UPLOAD_TOKEN');
  // Scope cached upload URLs to the upload credential so two configured
  // accounts in one process can never reuse each other's private result.
  const hash=createHash('sha256').update(config.uploadToken).update('\0').update(file.bytes).digest('hex');
  if(cache.has(hash))return cache.get(hash);
  const form=new FormData();form.set('file',new Blob([file.bytes],{type:file.mime}),file.name);form.set('biz','temp');form.set('uploadType','local');
  const response=await fetcher('https://genaipic.shanghaitech.edu.cn/sys/common/upload',{method:'POST',headers:{Accept:'*/*',Origin:'https://genai.shanghaitech.edu.cn',Referer:'https://genai.shanghaitech.edu.cn/','X-Access-Token':accessToken,token:config.uploadToken},body:form,signal,redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw upstream(`图片上传 HTTP ${response.status}`);}
  let payload;try{payload=await response.json();}catch{throw upstream('图片上传返回无效 JSON');}
  const result=payload?.result,url=result?.url;
  if(payload?.success===false||typeof url!=='string'||!url)throw upstream('图片上传失败');
  const value={imageUrl:/^https?:\/\//.test(url)?url:`https://genaipic.shanghaitech.edu.cn/sys/common/static/${url.replace(/^\/+/, '')}`,width:result.width??'',height:result.height??''};
  cache.set(hash,value);while(cache.size>64)cache.delete(cache.keys().next().value);
  return value;
}

export async function prepareImages(inputs,config,accessToken,signal,fetcher=fetch) {
  const uploaded=[];
  for(const value of inputs){
    let file;
    try{file=value.startsWith('data:')?data(value):await remote(value,signal);}catch(error){if(error.status)throw error;throw invalid('无法安全下载图片');}
    if(!validBytes(file.bytes,file.mime))throw invalid('图片内容与声明格式不符');
    uploaded.push(await upload(file,config,accessToken,signal,fetcher));
  }
  if(!uploaded.length)return{};
  return {imageUrl:uploaded[0].imageUrl,imageUrls:uploaded.map(item=>item.imageUrl),width:uploaded[0].width,height:uploaded[0].height};
}
