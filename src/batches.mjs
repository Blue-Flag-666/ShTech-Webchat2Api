import { randomUUID } from 'node:crypto';

const failure=(status,message)=>Object.assign(new Error(message),{status});
const ENDPOINTS=new Set(['/v1/responses','/v1/chat/completions','/v1/completions']);
const TERMINAL=new Set(['completed','failed','expired','cancelled']);
const clone=value=>structuredClone(value);

function metadata(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>16)throw failure(400,'metadata 必须是最多 16 项的对象');
  for(const [key,item] of Object.entries(value))if(key.length>64||typeof item!=='string'||item.length>512)throw failure(400,'metadata 键最多 64 字符，值必须是最多 512 字符的字符串');
  return clone(value);
}

function outputTtl(value){
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||value.anchor!=='created_at'||!Number.isInteger(value.seconds)||value.seconds<3600||value.seconds>2592000||Object.keys(value).some(key=>!['anchor','seconds'].includes(key)))throw failure(400,'output_expires_after 无效');
  return value.seconds*1000;
}

function inputRequests(file,endpoint){
  if(file.purpose!=='batch')throw failure(400,'Batch 输入文件的 purpose 必须是 batch');
  let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);}catch{throw failure(400,'Batch 输入文件必须是 UTF-8 JSONL');}
  source=source.replace(/\r?\n$/,'');if(!source)throw failure(400,'Batch 输入文件不能为空');
  const lines=source.split(/\r?\n/);if(lines.length>50000)throw failure(400,'Batch 最多包含 50000 个请求');
  const ids=new Set();return lines.map((line,index)=>{
    if(!line.trim())throw failure(400,`Batch 第 ${index+1} 行为空`);
    let value;try{value=JSON.parse(line);}catch{throw failure(400,`Batch 第 ${index+1} 行不是有效 JSON`);}
    if(!value||typeof value!=='object'||Array.isArray(value))throw failure(400,`Batch 第 ${index+1} 行必须是对象`);
    if(typeof value.custom_id!=='string'||!value.custom_id||value.custom_id.length>64)throw failure(400,`Batch 第 ${index+1} 行 custom_id 无效`);
    if(ids.has(value.custom_id))throw failure(400,`Batch custom_id 重复：${value.custom_id}`);ids.add(value.custom_id);
    if(value.method!=='POST')throw failure(400,`Batch 第 ${index+1} 行 method 必须是 POST`);
    if(value.url!==endpoint)throw failure(400,`Batch 第 ${index+1} 行 url 必须是 ${endpoint}`);
    if(!value.body||typeof value.body!=='object'||Array.isArray(value.body))throw failure(400,`Batch 第 ${index+1} 行 body 必须是对象`);
    if(value.body.stream===true)throw failure(400,`Batch 第 ${index+1} 行不支持 stream=true`);
    if(value.body.background===true)throw failure(400,`Batch 第 ${index+1} 行不支持 background=true`);
    return{line:index+1,custom_id:value.custom_id,url:value.url,body:clone(value.body)};
  });
}

function usageFrom(body){
  const usage=body?.usage;if(!usage||typeof usage!=='object')return null;
  const input=usage.input_tokens??usage.prompt_tokens,output=usage.output_tokens??usage.completion_tokens,total=usage.total_tokens;
  return{input_tokens:Number.isInteger(input)?input:0,output_tokens:Number.isInteger(output)?output:0,total_tokens:Number.isInteger(total)?total:(Number.isInteger(input)?input:0)+(Number.isInteger(output)?output:0)};
}

export class BatchStore{
  constructor(fileStore,dispatch,{maximum=32,ttl=3600000,entries=new Map()}={}){
    if(!fileStore)throw new Error('Batches 需要 FileStore');
    if(typeof dispatch!=='function')throw new Error('Batches 需要请求执行器');
    if(!Number.isInteger(maximum)||maximum<0)throw new Error('Batch 存储数量必须为非负整数');
    if(!Number.isFinite(ttl)||ttl<=0)throw new Error('Batch 存储有效期必须为正数');
    this.fileStore=fileStore;this.dispatch=dispatch;this.maximum=maximum;this.ttl=ttl;this.entries=entries;
    for(const [id,entry] of this.entries){entry.controller=new AbortController();if(!TERMINAL.has(entry.value.status)){entry.value.status='failed';entry.value.failed_at=Math.floor(Date.now()/1000);entry.value.errors={object:'list',data:[{code:'server_restarted',message:'服务重启时 Batch 尚未完成',param:null,line:null}]};entry.retireAt=Date.now()+this.ttl;this.entries.sync?.(id);}}
    this.prune();
  }
  prune(now=Date.now()){
    for(const [id,entry] of this.entries)if(TERMINAL.has(entry.value.status)&&entry.retireAt<=now)this.entries.delete(id);
    while(this.entries.size>this.maximum){const removable=[...this.entries].find(([,entry])=>TERMINAL.has(entry.value.status));if(!removable)break;this.entries.delete(removable[0]);}
  }
  entry(id){this.prune();const entry=this.entries.get(id);if(!entry)throw failure(404,`Batch 不存在或已过期：${id}`);return entry;}
  create(body){
    if(!this.maximum)throw failure(400,'Batches 已禁用');
    this.prune();if(this.entries.size>=this.maximum&&!([...this.entries.values()].some(entry=>TERMINAL.has(entry.value.status))))throw failure(429,'运行中的 Batch 数量已达上限');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['input_file_id','endpoint','completion_window','metadata','output_expires_after'].includes(key)))throw failure(400,'Batch 请求无效');
    if(typeof body.input_file_id!=='string'||!body.input_file_id)throw failure(400,'input_file_id 为必填项');
    if(!ENDPOINTS.has(body.endpoint))throw failure(400,'Batch endpoint 仅支持 /v1/responses、/v1/chat/completions 和 /v1/completions');
    if(body.completion_window!=='24h')throw failure(400,'completion_window 仅支持 24h');
    const requests=inputRequests(this.fileStore.get(body.input_file_id,true),body.endpoint),created=Math.floor(Date.now()/1000),id=`batch_${randomUUID().replaceAll('-','')}`;
    const models=new Set(requests.map(request=>request.body.model).filter(value=>typeof value==='string'));
    const value={id,object:'batch',endpoint:body.endpoint,errors:null,input_file_id:body.input_file_id,completion_window:'24h',status:'validating',output_file_id:null,error_file_id:null,created_at:created,in_progress_at:null,expires_at:created+86400,finalizing_at:null,completed_at:null,failed_at:null,expired_at:null,cancelling_at:null,cancelled_at:null,request_counts:{total:requests.length,completed:0,failed:0},metadata:metadata(body.metadata),...(models.size===1?{model:[...models][0]}:{})};
    const entry={value,requests,outputTtl:outputTtl(body.output_expires_after),controller:new AbortController(),retireAt:Date.now()+this.ttl};
    this.entries.set(id,entry);this.prune();setImmediate(()=>void this.run(id));return clone(value);
  }
  get(id){return clone(this.entry(id).value);}
  list({after,limit=20}={}){
    this.prune();if(!Number.isInteger(limit)||limit<1||limit>100)throw failure(400,'Batch limit 必须是 1–100');
    let values=[...this.entries.values()].map(entry=>entry.value).sort((a,b)=>(b.created_at-a.created_at)||b.id.localeCompare(a.id));
    if(after){const index=values.findIndex(value=>value.id===after);if(index<0)throw failure(400,'after Batch 不存在');values=values.slice(index+1);}
    const has_more=values.length>limit,data=values.slice(0,limit).map(clone);return{object:'list',data,first_id:data[0]?.id??null,last_id:data.at(-1)?.id??null,has_more};
  }
  cancel(id){
    const entry=this.entry(id);if(TERMINAL.has(entry.value.status)||entry.value.status==='cancelling')throw failure(400,'只能取消正在处理的 Batch');
    entry.value.status='cancelling';entry.value.cancelling_at=Math.floor(Date.now()/1000);entry.controller.abort();this.entries.sync?.(id);return clone(entry.value);
  }
  async run(id){
    let entry;try{entry=this.entry(id);}catch{return;}
    const outputs=[],errors=[];let input_tokens=0,output_tokens=0,total_tokens=0;
    try{
      if(entry.controller.signal.aborted)return this.finishCancelled(entry,outputs,errors);
      entry.value.status='in_progress';entry.value.in_progress_at=Math.floor(Date.now()/1000);this.entries.sync?.(id);
      for(const request of entry.requests){
        if(entry.controller.signal.aborted)break;
        const requestId=`batch_req_${randomUUID().replaceAll('-','')}`;
        try{
          const result=await this.dispatch(request.url,request.body,entry.controller.signal,requestId);
          if(entry.controller.signal.aborted)break;
          if(result.status>=200&&result.status<300){
            outputs.push({id:`batch_req_${randomUUID().replaceAll('-','')}`,custom_id:request.custom_id,response:{status_code:result.status,request_id:result.requestId||requestId,body:result.body},error:null});entry.value.request_counts.completed++;
            const usage=usageFrom(result.body);if(usage){input_tokens+=usage.input_tokens;output_tokens+=usage.output_tokens;total_tokens+=usage.total_tokens;}this.entries.sync?.(id);
          }else{
            errors.push({id:`batch_req_${randomUUID().replaceAll('-','')}`,custom_id:request.custom_id,response:null,error:{code:String(result.body?.error?.code||result.status),message:result.body?.error?.message||`HTTP ${result.status}`,param:result.body?.error?.param??null,line:request.line}});entry.value.request_counts.failed++;this.entries.sync?.(id);
          }
        }catch(cause){
          if(entry.controller.signal.aborted)break;
          errors.push({id:`batch_req_${randomUUID().replaceAll('-','')}`,custom_id:request.custom_id,response:null,error:{code:'server_error',message:cause?.message||'Batch 请求失败',param:null,line:request.line}});entry.value.request_counts.failed++;this.entries.sync?.(id);
        }
      }
      entry.value.status='finalizing';entry.value.finalizing_at=Math.floor(Date.now()/1000);
      if(outputs.length)entry.value.output_file_id=this.outputFile(entry,outputs,'output').id;
      if(errors.length)entry.value.error_file_id=this.outputFile(entry,errors,'errors').id;
      if(input_tokens||output_tokens||total_tokens)entry.value.usage={input_tokens,output_tokens,total_tokens};
      if(entry.controller.signal.aborted)return this.finishCancelled(entry,outputs,errors);
      entry.value.status='completed';entry.value.completed_at=Math.floor(Date.now()/1000);entry.retireAt=Date.now()+this.ttl;this.entries.sync?.(id);
    }catch(cause){
      entry.value.status='failed';entry.value.failed_at=Math.floor(Date.now()/1000);entry.value.errors={object:'list',data:[{code:'server_error',message:cause?.message||'Batch 处理失败',param:null,line:null}]};entry.retireAt=Date.now()+this.ttl;this.entries.sync?.(id);
    }
  }
  outputFile(entry,lines,suffix){
    const bytes=Buffer.from(lines.map(value=>JSON.stringify(value)).join('\n')+'\n');
    return this.fileStore.create({filename:`${entry.value.id}_${suffix}.jsonl`,mime:'application/jsonl',bytes,purpose:'batch_output',expiresAfter:entry.outputTtl,internal:true});
  }
  finishCancelled(entry){
    entry.value.status='cancelled';entry.value.cancelled_at=Math.floor(Date.now()/1000);entry.retireAt=Date.now()+this.ttl;this.entries.sync?.(entry.value.id);
  }
  close(){for(const entry of this.entries.values())if(!TERMINAL.has(entry.value.status))entry.controller.abort();}
  get size(){this.prune();return this.entries.size;}
  get active(){this.prune();return [...this.entries.values()].filter(entry=>!TERMINAL.has(entry.value.status)).length;}
}
