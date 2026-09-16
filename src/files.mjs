import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

const failure=(status,message)=>Object.assign(new Error(message),{status});
const TEXT_EXTENSIONS=new Set(['.txt','.md','.markdown','.json','.jsonl','.csv','.tsv','.xml','.html','.htm','.css','.scss','.less','.js','.mjs','.cjs','.jsx','.ts','.tsx','.py','.java','.c','.h','.cc','.cpp','.hpp','.cs','.go','.rs','.rb','.php','.sh','.bash','.zsh','.fish','.ps1','.yaml','.yml','.toml','.ini','.conf','.cfg','.env','.sql','.graphql','.gql','.log','.diff','.patch','.vue','.svelte','.tex','.rst']);
const FILE_PURPOSES=new Set(['assistants','batch','fine-tune','vision','user_data','evals']);
const INTERNAL_FILE_PURPOSES=new Set(['assistants_output','batch_output','fine-tune-results']);

function cleanFilename(value){
  if(typeof value!=='string'||!value.trim())throw failure(400,'文件名不能为空');
  const name=value.replaceAll('\\','/').split('/').at(-1).replace(/[\x00-\x1f\x7f]/g,'').trim();
  if(!name||name.length>255)throw failure(400,'文件名无效');
  return name;
}

async function pdfFile(file,maxPages){
  let pdf;
  try{
    const {extractText,getDocumentProxy}=await import('unpdf');
    pdf=await getDocumentProxy(Uint8Array.from(file.bytes),{maxImageSize:16_777_216});
    if(pdf.numPages>maxPages)throw failure(400,`PDF 页数不能超过 ${maxPages}`);
    const result=await extractText(pdf,{mergePages:true}),value=typeof result.text==='string'?result.text:result.text.join('\n\n');
    if(!value.trim())throw failure(400,`PDF ${file.filename} 没有可提取的文本，暂不支持扫描件 OCR`);
    return `<attached_file name=${JSON.stringify(file.filename)} media_type="application/pdf" pages=${result.totalPages}>\n${value}\n</attached_file>`;
  }catch(error){
    if(error?.status)throw error;
    throw failure(400,`无法读取 PDF ${file.filename}`);
  }finally{try{await pdf?.destroy();}catch{}}
}

async function textFile(file,maxPages){
  const mime=(file.mime||'').split(';')[0].toLowerCase(),extension=extname(file.filename).toLowerCase();
  if(mime==='application/pdf'||extension==='.pdf')return pdfFile(file,maxPages);
  if(!(mime.startsWith('text/')||['application/json','application/jsonl','application/xml','application/yaml','application/x-yaml','application/toml','application/javascript'].includes(mime)||TEXT_EXTENSIONS.has(extension)))throw failure(400,`暂不支持读取文件类型：${mime||extension||'unknown'}`);
  let value;try{value=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);}catch{throw failure(400,`文件 ${file.filename} 不是有效 UTF-8 文本`);}
  return `<attached_file name=${JSON.stringify(file.filename)} media_type=${JSON.stringify(mime||'text/plain')}>
${value}
</attached_file>`;
}

export class FileStore {
  constructor(maximum=32,ttl=60*60*1000,maxBytes=2*1024*1024){
    if(!Number.isInteger(maximum)||maximum<0)throw new Error('文件存储数量必须为非负整数');
    if(!Number.isFinite(ttl)||ttl<=0)throw new Error('文件存储有效期必须为正数');
    if(!Number.isInteger(maxBytes)||maxBytes<1)throw new Error('文件大小上限必须为正整数');
    this.maximum=maximum;this.ttl=ttl;this.maxBytes=maxBytes;this.entries=new Map();
  }
  prune(now=Date.now()){
    for(const [id,entry] of this.entries)if(entry.expiresAt<=now)this.entries.delete(id);
    while(this.entries.size>this.maximum)this.entries.delete(this.entries.keys().next().value);
  }
  create({filename,mime,bytes,purpose='user_data',expiresAfter,internal=false}){
    if(!this.maximum)throw failure(400,'文件存储已禁用');
    if(!Buffer.isBuffer(bytes)||!bytes.length)throw failure(400,'上传文件不能为空');
    if(bytes.length>this.maxBytes)throw failure(413,`单个文件不能超过 ${Math.ceil(this.maxBytes/1048576)} MiB`);
    if(!FILE_PURPOSES.has(purpose)&&!(internal&&INTERNAL_FILE_PURPOSES.has(purpose)))throw failure(400,'文件 purpose 无效');
    const created=Date.now(),ttl=expiresAfter??this.ttl,id=`file-${randomUUID().replaceAll('-','')}`;
    if(!Number.isInteger(ttl)||ttl<3600000||ttl>2592000000)throw failure(400,'expires_after.seconds 必须为 3600–2592000');
    const value={id,object:'file',bytes:bytes.length,created_at:Math.floor(created/1000),expires_at:Math.floor((created+ttl)/1000),filename:cleanFilename(filename),purpose,mime:mime||'application/octet-stream'};
    this.entries.set(id,{expiresAt:created+ttl,value,bytes:Buffer.from(bytes)});this.prune();return structuredClone(value);
  }
  get(id,withBytes=false){
    this.prune();const entry=this.entries.get(id);if(!entry)throw failure(404,`文件不存在或已过期：${id}`);
    return withBytes?{...structuredClone(entry.value),bytes:Buffer.from(entry.bytes)}:structuredClone(entry.value);
  }
  delete(id){this.prune();if(!this.entries.delete(id))throw failure(404,`文件不存在或已过期：${id}`);}
  list({purpose,order='desc',after,limit=10000}={}){
    this.prune();let values=[...this.entries.values()].map(entry=>structuredClone(entry.value));
    if(purpose)values=values.filter(value=>value.purpose===purpose);
    values.sort((a,b)=>(a.created_at-b.created_at)||(a.id.localeCompare(b.id)));if(order==='desc')values.reverse();
    if(after){const index=values.findIndex(value=>value.id===after);if(index<0)throw failure(400,'after 文件不存在');values=values.slice(index+1);}
    const more=values.length>limit,data=values.slice(0,limit);return{object:'list',data,first_id:data[0]?.id??null,last_id:data.at(-1)?.id??null,has_more:more};
  }
  get size(){this.prune();return this.entries.size;}
}

export async function readRawBody(req,limit){
  let size=0;const parts=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw failure(413,`请求不能超过 ${Math.floor(limit/1048576)} MiB`);parts.push(chunk);}
  return Buffer.concat(parts);
}

function disposition(value){
  const result={};for(const match of value.matchAll(/;\s*([\w-]+)=(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g))result[match[1].toLowerCase()]=(match[2]??match[3]).replace(/\\(["\\])/g,'$1');
  return result;
}

export function parseMultipart(buffer,contentType){
  const match=/^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType||'');
  const boundary=match?.[1]||match?.[2];if(!boundary||boundary.length>200)throw failure(400,'文件上传必须使用 multipart/form-data');
  const marker=Buffer.from(`--${boundary}`),separator=Buffer.from('\r\n\r\n'),parts=[];let cursor=0;
  if(buffer.indexOf(marker)!==0)throw failure(400,'multipart 边界无效');
  while(true){
    cursor+=marker.length;if(buffer.subarray(cursor,cursor+2).equals(Buffer.from('--')))break;
    if(!buffer.subarray(cursor,cursor+2).equals(Buffer.from('\r\n')))throw failure(400,'multipart 格式无效');cursor+=2;
    const headerEnd=buffer.indexOf(separator,cursor);if(headerEnd<0)throw failure(400,'multipart 头部不完整');
    const headers={};for(const line of buffer.subarray(cursor,headerEnd).toString('latin1').split('\r\n')){const colon=line.indexOf(':');if(colon<1)throw failure(400,'multipart 头部无效');headers[line.slice(0,colon).trim().toLowerCase()]=line.slice(colon+1).trim();}
    const next=buffer.indexOf(Buffer.concat([Buffer.from('\r\n'),marker]),headerEnd+4);if(next<0)throw failure(400,'multipart 内容不完整');
    const fields=disposition(headers['content-disposition']||'');if(!fields.name)throw failure(400,'multipart 字段缺少 name');
    parts.push({name:fields.name,filename:fields.filename,contentType:headers['content-type'],bytes:buffer.subarray(headerEnd+4,next)});cursor=next+2;
  }
  return parts;
}

export function uploadedFile(parts){
  const fileParts=parts.filter(part=>part.name==='file'),fields=new Map(parts.filter(part=>part.name!=='file').map(part=>[part.name,part.bytes.toString('utf8')]));
  if(fileParts.length!==1||!fileParts[0].filename)throw failure(400,'必须上传一个 file 字段');
  const anchor=fields.get('expires_after[anchor]'),seconds=fields.get('expires_after[seconds]');
  if((anchor!==undefined||seconds!==undefined)&&(anchor!=='created_at'||!/^\d+$/.test(seconds||'')))throw failure(400,'expires_after 无效');
  return{filename:fileParts[0].filename,mime:fileParts[0].contentType,bytes:Buffer.from(fileParts[0].bytes),purpose:fields.get('purpose')||'user_data',expiresAfter:seconds===undefined?undefined:Number(seconds)*1000};
}

function inlineFile(part,store){
  if(part.file_id!==undefined){if(typeof part.file_id!=='string'||!part.file_id)throw failure(400,'input_file.file_id 无效');return store.get(part.file_id,true);}
  if(typeof part.file_data!=='string'||typeof part.filename!=='string')throw failure(400,'input_file 需要 file_id，或 filename 与 file_data');
  const match=/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(part.file_data);
  if(!match)throw failure(400,'input_file.file_data 必须是 Base64 data URL');
  const encoded=match[2].replace(/\s/g,'');if(encoded.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw failure(400,'input_file.file_data Base64 无效');
  const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>store.maxBytes)throw failure(413,`输入文件不能超过 ${Math.ceil(store.maxBytes/1048576)} MiB`);
  return{filename:cleanFilename(part.filename),mime:match[1].toLowerCase(),bytes};
}

function storedImage(fileId,store){
  if(typeof fileId!=='string'||!fileId)throw failure(400,'input_image.file_id 无效');
  const file=store.get(fileId,true);if(!['image/jpeg','image/png','image/gif','image/webp','image/bmp'].includes(file.mime))throw failure(400,'file_id 不是支持的图片');
  return `data:${file.mime};base64,${file.bytes.toString('base64')}`;
}

export async function expandInputFiles(path,input,store,{pdfMaxPages=200}={}){
  if(!Number.isInteger(pdfMaxPages)||pdfMaxPages<1)throw new Error('PDF 页数上限必须为正整数');
  const value=structuredClone(input);
  const convert=async content=>{
    if(!Array.isArray(content))return content;
    return Promise.all(content.map(async part=>{
      if(part?.type==='input_file')return{type:'input_text',text:await textFile(inlineFile(part,store),pdfMaxPages)};
      if(part?.type==='input_image'&&part.file_id!==undefined)return{...part,file_id:undefined,image_url:storedImage(part.file_id,store)};
      return part;
    }));
  };
  if(path==='/v1/responses'&&Array.isArray(value.input))for(const item of value.input){
    if(item&&(!item.type||item.type==='message'))item.content=await convert(item.content);
    else if(['function_call_output','custom_tool_call_output'].includes(item?.type))item.output=await convert(item.output);
    else if(item?.type==='computer_call_output'&&item.output?.type==='computer_screenshot'&&item.output.file_id!==undefined)item.output={...item.output,file_id:undefined,image_url:storedImage(item.output.file_id,store)};
  }
  if(path==='/v1/chat/completions'&&Array.isArray(value.messages))for(const message of value.messages)if(Array.isArray(message.content))message.content=await Promise.all(message.content.map(async part=>{
    if(part?.type!=='file')return part;const file=part.file;if(!file||typeof file!=='object')throw failure(400,'file 内容块无效');return{type:'text',text:await textFile(inlineFile({file_id:file.file_id,file_data:file.file_data,filename:file.filename},store),pdfMaxPages)};
  }));
  return value;
}
