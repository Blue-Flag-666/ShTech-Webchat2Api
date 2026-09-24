import { createHash, randomUUID } from 'node:crypto';

const failure=(status,message)=>Object.assign(new Error(message),{status});
const PURPOSES=new Set(['assistants','batch','fine-tune','vision','user_data','evals']);
const clone=value=>structuredClone(value);

function filename(value){
  if(typeof value!=='string'||!value.trim())throw failure(400,'filename 不能为空');
  const name=value.replaceAll('\\','/').split('/').at(-1).replace(/[\x00-\x1f\x7f]/g,'').trim();
  if(!name||name.length>255)throw failure(400,'filename 无效');
  return name;
}

function expiresAfter(value){
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||value.anchor!=='created_at'||!Number.isInteger(value.seconds)||value.seconds<3600||value.seconds>2592000||Object.keys(value).some(key=>!['anchor','seconds'].includes(key)))throw failure(400,'expires_after 无效');
  return value.seconds*1000;
}

export class UploadStore{
  constructor(fileStore,maximum=32,ttl=3600000,entries=new Map()){
    if(!fileStore)throw new Error('Uploads 需要 FileStore');
    if(!Number.isInteger(maximum)||maximum<0)throw new Error('上传存储数量必须为非负整数');
    if(!Number.isFinite(ttl)||ttl<=0)throw new Error('上传存储有效期必须为正数');
    this.fileStore=fileStore;this.maximum=maximum;this.ttl=ttl;this.entries=entries;this.prune();
  }
  prune(now=Date.now()){
    for(const [id,entry] of this.entries)if(entry.expiresAt<=now)this.entries.delete(id);
    while(this.entries.size>this.maximum)this.entries.delete(this.entries.keys().next().value);
  }
  create(body){
    if(!this.maximum)throw failure(400,'Uploads 已禁用');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['bytes','filename','mime_type','purpose','expires_after'].includes(key)))throw failure(400,'Upload 请求无效');
    if(!Number.isInteger(body.bytes)||body.bytes<1)throw failure(400,'bytes 必须为正整数');
    if(body.bytes>=this.fileStore.maxBytes)throw failure(413,`Upload 必须小于 ${Math.ceil(this.fileStore.maxBytes/1048576)} MiB`);
    if(typeof body.mime_type!=='string'||!body.mime_type.trim()||body.mime_type.length>255)throw failure(400,'mime_type 无效');
    if(!PURPOSES.has(body.purpose))throw failure(400,'purpose 无效');
    const now=Date.now(),id=`upload_${randomUUID().replaceAll('-','')}`,value={id,object:'upload',bytes:body.bytes,created_at:Math.floor(now/1000),expires_at:Math.floor((now+this.ttl)/1000),filename:filename(body.filename),purpose:body.purpose,status:'pending'};
    this.entries.set(id,{expiresAt:now+this.ttl,value,mime:body.mime_type.trim().toLowerCase(),fileTtl:expiresAfter(body.expires_after),parts:new Map(),partBytes:0});this.prune();return clone(value);
  }
  entry(id){this.prune();const entry=this.entries.get(id);if(!entry)throw failure(404,`Upload 不存在或已过期：${id}`);return entry;}
  addPart(id,bytes){
    const entry=this.entry(id);if(entry.value.status!=='pending')throw failure(400,'只能向 pending Upload 添加分片');
    if(!Buffer.isBuffer(bytes)||!bytes.length)throw failure(400,'Upload 分片不能为空');
    if(bytes.length>64*1024*1024)throw failure(413,'Upload 分片不能超过 64 MiB');
    if(entry.partBytes+bytes.length>entry.value.bytes)throw failure(400,'Upload 分片总大小超过声明的 bytes');
    const partId=`part_${randomUUID().replaceAll('-','')}`,created_at=Math.floor(Date.now()/1000);
    entry.parts.set(partId,Buffer.from(bytes));entry.partBytes+=bytes.length;this.entries.sync?.(id);
    return{id:partId,object:'upload.part',created_at,upload_id:id};
  }
  complete(id,body){
    const entry=this.entry(id);if(entry.value.status!=='pending')throw failure(400,'只能完成 pending Upload');
    if(!body||typeof body!=='object'||Array.isArray(body)||!Array.isArray(body.part_ids)||!body.part_ids.length||body.part_ids.some(value=>typeof value!=='string'||!value)||new Set(body.part_ids).size!==body.part_ids.length||Object.keys(body).some(key=>!['part_ids','md5'].includes(key)))throw failure(400,'part_ids 必须是非空且不重复的字符串数组');
    const parts=body.part_ids.map(partId=>{const bytes=entry.parts.get(partId);if(!bytes)throw failure(400,`Upload 分片不存在：${partId}`);return bytes;}),bytes=Buffer.concat(parts);
    if(bytes.length!==entry.value.bytes)throw failure(400,`Upload 实际大小 ${bytes.length} 与声明的 ${entry.value.bytes} 不一致`);
    if(body.md5!==undefined){
      if(typeof body.md5!=='string'||!body.md5)throw failure(400,'md5 无效');
      const hash=createHash('md5').update(bytes),hex=hash.copy().digest('hex'),base64=hash.digest('base64');
      if(body.md5.toLowerCase()!==hex&&body.md5!==base64)throw failure(400,'Upload MD5 校验失败');
    }
    const file=this.fileStore.create({filename:entry.value.filename,mime:entry.mime,bytes,purpose:entry.value.purpose,expiresAfter:entry.fileTtl});
    entry.value={...entry.value,status:'completed',file};entry.parts.clear();entry.partBytes=0;this.entries.sync?.(id);return clone(entry.value);
  }
  cancel(id){const entry=this.entry(id);if(entry.value.status!=='pending')throw failure(400,'只能取消 pending Upload');entry.value={...entry.value,status:'cancelled'};entry.parts.clear();entry.partBytes=0;this.entries.sync?.(id);return clone(entry.value);}
  get size(){this.prune();return this.entries.size;}
}

export function uploadPart(parts){
  const data=parts.filter(part=>part.name==='data');
  if(data.length!==1)throw failure(400,'必须上传一个 data 字段');
  return Buffer.from(data[0].bytes);
}
