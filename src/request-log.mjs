import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const ROUTES=new Set(['/healthz','/health','/metrics','/v1/models','/v1/chat/completions','/v1/completions','/v1/responses','/v1/messages','/v1/files','/v1/uploads','/v1/vector_stores','/v1/batches','/v1/conversations','/v1/messages/count_tokens','/v1/responses/input_tokens','/v1/responses/compact','/v1/tokenizers/estimate-token-count']);
const MAX_BYTES=5*1024*1024,BACKUPS=3;

export function routeLabel(path){
  if(ROUTES.has(path))return path;
  for(const [pattern,label] of [
    [/^\/v1\/models\/[^/]+$/,'/v1/models/:id'],
    [/^\/v1\/responses\/[^/]+(?:\/input_items|\/cancel)?$/,'/v1/responses/:id'],
    [/^\/v1\/files\/[^/]+(?:\/content)?$/,'/v1/files/:id'],
    [/^\/v1\/uploads\/[^/]+\/(?:parts|complete|cancel)$/,'/v1/uploads/:id'],
    [/^\/v1\/vector_stores\/[^/]+(?:\/.*)?$/,'/v1/vector_stores/:id'],
    [/^\/v1\/batches\/[^/]+(?:\/cancel)?$/,'/v1/batches/:id'],
    [/^\/v1\/conversations\/[^/]+(?:\/.*)?$/,'/v1/conversations/:id']
  ])if(pattern.test(path))return label;
  return 'other';
}

export class RequestLogger {
  constructor(path,{maxBytes=MAX_BYTES,backups=BACKUPS}={}){
    this.path=path;this.maxBytes=maxBytes;this.backups=backups;this.disabled=false;
  }
  rotate(incoming){
    if(!existsSync(this.path)||statSync(this.path).size+incoming<=this.maxBytes)return;
    for(let index=this.backups;index>=1;index--){
      const target=`${this.path}.${index}`;
      if(existsSync(target))rmSync(target);
      const source=index===1?this.path:`${this.path}.${index-1}`;
      if(existsSync(source))renameSync(source,target);
    }
  }
  observe({requestId,method,path,status,durationMs}){
    if(!this.path||this.disabled)return;
    const requestHash=typeof requestId==='string'&&requestId?createHash('sha256').update(requestId).digest('hex').slice(0,16):null;
    const line=JSON.stringify({time:new Date().toISOString(),request_id_hash:requestHash,method:/^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(method)?method:'OTHER',route:routeLabel(path),status:Number.isInteger(status)?status:499,duration_ms:Math.max(0,Math.round(durationMs))})+'\n';
    try{mkdirSync(dirname(this.path),{recursive:true});this.rotate(Buffer.byteLength(line));appendFileSync(this.path,line,{mode:0o600});}
    catch{this.disabled=true;console.error('访问日志写入失败，已关闭文件日志');}
  }
}
