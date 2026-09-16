import { randomUUID } from 'node:crypto';
import { extractFileText } from './files.mjs';

const failure=(status,message)=>Object.assign(new Error(message),{status});
const id=prefix=>`${prefix}_${randomUUID().replaceAll('-','')}`;
const clone=value=>structuredClone(value);

function object(value,label='请求'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw failure(400,`${label}必须是 JSON 对象`);
  return value;
}
function keys(value,allowed,label='请求'){
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw failure(400,`${label}包含不支持的参数`);
}
function metadata(value,{attributes=false}={}){
  if(value===undefined||value===null)return attributes?null:{};
  object(value,attributes?'attributes':'metadata');
  const entries=Object.entries(value);if(entries.length>16)throw failure(400,`${attributes?'attributes':'metadata'} 最多包含 16 项`);
  for(const [key,item] of entries){
    if(!key||key.length>64)throw failure(400,`${attributes?'attributes':'metadata'} 键长度必须为 1–64`);
    if(attributes){if(!['string','number','boolean'].includes(typeof item)||typeof item==='string'&&item.length>512||typeof item==='number'&&!Number.isFinite(item))throw failure(400,'attributes 值必须是字符串、有限数字或布尔值');}
    else if(typeof item!=='string'||item.length>512)throw failure(400,'metadata 值必须是最长 512 字符的字符串');
  }
  return clone(value);
}
function expiry(value,ttl){
  if(value===undefined||value===null)return{policy:{anchor:'last_active_at',days:Math.max(1,Math.ceil(ttl/86400000))},ttl};
  object(value,'expires_after');keys(value,['anchor','days'],'expires_after');
  if(value.anchor!=='last_active_at'||!Number.isInteger(value.days)||value.days<1||value.days>365)throw failure(400,'expires_after 必须使用 last_active_at，days 为 1–365');
  return{policy:clone(value),ttl:value.days*86400000};
}
function chunking(value){
  if(value===undefined||value===null||value.type==='auto')return{public:{type:'static',static:{max_chunk_size_tokens:800,chunk_overlap_tokens:400}},size:3200,overlap:1600};
  object(value,'chunking_strategy');keys(value,['type','static'],'chunking_strategy');
  if(value.type!=='static')throw failure(400,'chunking_strategy.type 必须是 auto 或 static');
  const settings=object(value.static,'chunking_strategy.static');keys(settings,['max_chunk_size_tokens','chunk_overlap_tokens'],'chunking_strategy.static');
  const size=settings.max_chunk_size_tokens,overlap=settings.chunk_overlap_tokens;
  if(!Number.isInteger(size)||size<100||size>4096)throw failure(400,'max_chunk_size_tokens 必须为 100–4096');
  if(!Number.isInteger(overlap)||overlap<0||overlap>Math.floor(size/2))throw failure(400,'chunk_overlap_tokens 必须为 0–max_chunk_size_tokens/2');
  return{public:{type:'static',static:{max_chunk_size_tokens:size,chunk_overlap_tokens:overlap}},size:size*4,overlap:overlap*4};
}
function chunks(text,strategy){
  const source=text.replace(/\r\n?/g,'\n').trim();if(!source)return[];
  const result=[];let start=0;
  while(start<source.length){
    let end=Math.min(source.length,start+strategy.size);
    if(end<source.length){const boundary=Math.max(source.lastIndexOf('\n\n',end),source.lastIndexOf('\n',end),source.lastIndexOf(' ',end));if(boundary>start+strategy.size/2)end=boundary;}
    const value=source.slice(start,end).trim();if(value)result.push(value);
    if(end>=source.length)break;
    const next=Math.max(start+1,end-strategy.overlap);start=next;
  }
  return result;
}
function words(value){
  const lower=value.toLocaleLowerCase(),tokens=lower.match(/[\p{L}\p{N}_-]+/gu)||[],result=new Set(tokens);
  for(const token of tokens)if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token))for(let i=0;i<token.length-1;i++)result.add(token.slice(i,i+2));
  return result;
}
function relevance(text,queries){
  const haystack=text.toLocaleLowerCase(),terms=new Set(queries.flatMap(query=>[...words(query)]));if(!terms.size)return 0;
  const doc=words(text);let matched=0,exact=0;
  for(const term of terms)if(doc.has(term)||haystack.includes(term)){matched++;if(haystack.includes(term))exact++;}
  return Math.min(1,(matched/terms.size)*.82+(exact/terms.size)*.18);
}
function compare(actual,operator,value){
  if(operator==='eq')return actual===value;if(operator==='ne')return actual!==value;
  if(operator==='in')return Array.isArray(value)&&value.includes(actual);if(operator==='nin')return Array.isArray(value)&&!value.includes(actual);
  if(operator==='gt')return actual>value;if(operator==='gte')return actual>=value;if(operator==='lt')return actual<value;if(operator==='lte')return actual<=value;
  throw failure(400,`不支持的过滤操作符：${operator}`);
}
function matches(attributes,filter,depth=0){
  if(filter===undefined||filter===null)return true;if(depth>8)throw failure(400,'filters 嵌套过深');object(filter,'filters');
  if(['and','or'].includes(filter.type)){
    if(!Array.isArray(filter.filters)||!filter.filters.length)throw failure(400,'复合 filters 需要非空 filters 数组');
    return filter.type==='and'?filter.filters.every(item=>matches(attributes,item,depth+1)):filter.filters.some(item=>matches(attributes,item,depth+1));
  }
  const operator=filter.type;if(typeof filter.key!=='string'||!filter.key||!['eq','ne','gt','gte','lt','lte','in','nin'].includes(operator))throw failure(400,'filters 比较项无效');
  return compare(attributes?.[filter.key],operator,filter.value);
}
function page(values,{after,before,limit=20,order='desc'}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100||!['asc','desc'].includes(order)||after&&before)throw failure(400,'分页参数无效');
  let data=[...values].sort((a,b)=>(a.created_at-b.created_at)||a.id.localeCompare(b.id));if(order==='desc')data.reverse();
  const cursor=after||before;if(cursor){const index=data.findIndex(value=>value.id===cursor);if(index<0)throw failure(400,'分页游标不存在');data=after?data.slice(index+1):data.slice(0,index);}
  const has_more=data.length>limit;data=data.slice(0,limit);return{object:'list',data:clone(data),first_id:data[0]?.id??null,last_id:data.at(-1)?.id??null,has_more};
}
function queryText(input){
  const values=[];
  const visit=value=>{if(typeof value==='string')values.push(value);else if(Array.isArray(value))for(const item of value)visit(item);else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))if(['text','content','input','output'].includes(key))visit(item);};
  visit(input.input);return values.join('\n').slice(-16000).trim();
}

export class VectorStore {
  constructor(fileStore,{maximum=32,ttl=3600000,maxFiles=100,pdfMaxPages=200}={}){
    if(!Number.isInteger(maximum)||maximum<0)throw new Error('向量库存储数量必须为非负整数');
    if(!Number.isFinite(ttl)||ttl<3600000)throw new Error('向量库存储有效期至少为一小时');
    if(!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>10000)throw new Error('每个向量库文件数量必须为 1–10000');
    this.fileStore=fileStore;this.maximum=maximum;this.ttl=ttl;this.maxFiles=maxFiles;this.pdfMaxPages=pdfMaxPages;this.entries=new Map();
  }
  prune(now=Date.now()){
    for(const [storeId,entry] of this.entries)if(entry.expiresAt<=now)this.entries.delete(storeId);
    while(this.entries.size>this.maximum)this.entries.delete(this.entries.keys().next().value);
  }
  entry(storeId,touch=false){
    this.prune();const entry=this.entries.get(storeId);if(!entry)throw failure(404,`向量库不存在或已过期：${storeId}`);
    if(touch){entry.value.last_active_at=Math.floor(Date.now()/1000);entry.expiresAt=Date.now()+entry.ttl;entry.value.expires_at=Math.floor(entry.expiresAt/1000);}
    return entry;
  }
  public(entry){
    const files=[...entry.files.values()],counts={in_progress:0,completed:0,failed:0,cancelled:0,total:files.length};for(const file of files)counts[file.value.status]++;
    return clone({...entry.value,usage_bytes:files.reduce((sum,file)=>sum+file.value.usage_bytes,0),file_counts:counts,status:counts.in_progress?'in_progress':'completed'});
  }
  async create(body={}){
    object(body);keys(body,['name','file_ids','files','expires_after','chunking_strategy','metadata']);if(!this.maximum)throw failure(400,'向量库存储已禁用');
    if(body.name!==undefined&&(typeof body.name!=='string'||body.name.length>256))throw failure(400,'name 必须是最长 256 字符的字符串');
    if(body.file_ids!==undefined&&body.files!==undefined)throw failure(400,'file_ids 与 files 不能同时使用');
    const selected=body.files??body.file_ids??[];if(!Array.isArray(selected)||selected.length>this.maxFiles)throw failure(400,`文件数量不能超过 ${this.maxFiles}`);
    const now=Date.now(),expires=expiry(body.expires_after,this.ttl),storeId=id('vs');
    const entry={ttl:expires.ttl,expiresAt:now+expires.ttl,files:new Map(),batches:new Map(),value:{id:storeId,object:'vector_store',created_at:Math.floor(now/1000),name:body.name??'',usage_bytes:0,file_counts:{in_progress:0,completed:0,failed:0,cancelled:0,total:0},status:'completed',expires_after:expires.policy,expires_at:Math.floor((now+expires.ttl)/1000),last_active_at:Math.floor(now/1000),metadata:metadata(body.metadata)}};
    this.entries.set(storeId,entry);this.prune();
    try{for(const item of selected)await this.attach(storeId,typeof item==='string'?{file_id:item,chunking_strategy:body.chunking_strategy}:{...item,chunking_strategy:item.chunking_strategy??body.chunking_strategy});}catch(error){this.entries.delete(storeId);throw error;}
    return this.public(entry);
  }
  get(storeId){return this.public(this.entry(storeId));}
  list(options={}){this.prune();return page([...this.entries.values()].map(entry=>this.public(entry)),options);}
  update(storeId,body){
    object(body);keys(body,['name','expires_after','metadata']);const entry=this.entry(storeId,true);
    if(body.name!==undefined&&(typeof body.name!=='string'||body.name.length>256))throw failure(400,'name 必须是最长 256 字符的字符串');
    if(body.name!==undefined)entry.value.name=body.name;if(body.metadata!==undefined)entry.value.metadata=metadata(body.metadata);
    if(body.expires_after!==undefined){const expires=expiry(body.expires_after,this.ttl);entry.ttl=expires.ttl;entry.expiresAt=Date.now()+expires.ttl;entry.value.expires_after=expires.policy;entry.value.expires_at=Math.floor(entry.expiresAt/1000);}
    return this.public(entry);
  }
  delete(storeId){this.entry(storeId);this.entries.delete(storeId);return{id:storeId,object:'vector_store.deleted',deleted:true};}
  async attach(storeId,body){
    object(body);keys(body,['file_id','attributes','chunking_strategy']);const entry=this.entry(storeId,true);
    if(typeof body.file_id!=='string'||!body.file_id)throw failure(400,'file_id 必须是非空字符串');
    if(entry.files.has(body.file_id))throw failure(409,`文件已经在向量库中：${body.file_id}`);if(entry.files.size>=this.maxFiles)throw failure(400,`每个向量库最多包含 ${this.maxFiles} 个文件`);
    const source=this.fileStore.get(body.file_id,true),strategy=chunking(body.chunking_strategy),parsed=await extractFileText(source,this.pdfMaxPages),parts=chunks(parsed.text,strategy);
    if(!parts.length)throw failure(400,`文件 ${source.filename} 没有可索引文本`);
    const value={id:source.id,object:'vector_store.file',created_at:Math.floor(Date.now()/1000),usage_bytes:Buffer.byteLength(parsed.text),vector_store_id:storeId,status:'completed',last_error:null,attributes:metadata(body.attributes,{attributes:true}),chunking_strategy:strategy.public};
    entry.files.set(source.id,{value,filename:source.filename,mime:parsed.mime,text:parsed.text,chunks:parts});return clone(value);
  }
  file(storeId,fileId){const entry=this.entry(storeId);const file=entry.files.get(fileId);if(!file)throw failure(404,`向量库文件不存在：${fileId}`);return{entry,file};}
  getFile(storeId,fileId){return clone(this.file(storeId,fileId).file.value);}
  listFiles(storeId,options={}){const entry=this.entry(storeId);if(options.filter&&!['in_progress','completed','failed','cancelled'].includes(options.filter))throw failure(400,'filter 状态无效');let values=[...entry.files.values()].map(file=>file.value);if(options.filter)values=values.filter(value=>value.status===options.filter);return page(values,options);}
  updateFile(storeId,fileId,body){object(body);keys(body,['attributes']);const {file}=this.file(storeId,fileId);file.value.attributes=metadata(body.attributes,{attributes:true});return clone(file.value);}
  deleteFile(storeId,fileId){const {entry}=this.file(storeId,fileId);entry.files.delete(fileId);return{id:fileId,object:'vector_store.file.deleted',deleted:true};}
  content(storeId,fileId){const {file}=this.file(storeId,fileId);return{file_id:fileId,filename:file.filename,attributes:clone(file.value.attributes),content:file.chunks.map(text=>({type:'text',text}))};}
  async createBatch(storeId,body){
    object(body);keys(body,['file_ids','files','attributes','chunking_strategy']);if(body.file_ids!==undefined&&body.files!==undefined)throw failure(400,'file_ids 与 files 不能同时使用');const entry=this.entry(storeId,true),selected=body.files??body.file_ids;
    if(!Array.isArray(selected)||!selected.length||selected.length>this.maxFiles)throw failure(400,`file_ids/files 必须为 1–${this.maxFiles} 项`);
    const batchId=id('vsfb'),batch={id:batchId,object:'vector_store.files_batch',created_at:Math.floor(Date.now()/1000),vector_store_id:storeId,status:'in_progress',file_counts:{in_progress:selected.length,completed:0,failed:0,cancelled:0,total:selected.length},file_ids:[]};entry.batches.set(batchId,batch);
    for(const item of selected){const value=typeof item==='string'?{file_id:item}:{...item};value.attributes??=body.attributes;value.chunking_strategy??=body.chunking_strategy;try{const attached=await this.attach(storeId,value);batch.file_ids.push(attached.id);batch.file_counts.completed++;}catch{batch.file_counts.failed++;}batch.file_counts.in_progress--;}
    batch.status=batch.file_counts.failed===batch.file_counts.total?'failed':'completed';return this.batchPublic(batch);
  }
  batch(storeId,batchId){const entry=this.entry(storeId),batch=entry.batches.get(batchId);if(!batch)throw failure(404,`向量库文件批次不存在：${batchId}`);return{entry,batch};}
  batchPublic(batch){const {file_ids,...value}=batch;return clone(value);}
  getBatch(storeId,batchId){return this.batchPublic(this.batch(storeId,batchId).batch);}
  cancelBatch(storeId,batchId){const {batch}=this.batch(storeId,batchId);if(batch.status==='in_progress'){batch.status='cancelled';batch.file_counts.cancelled+=batch.file_counts.in_progress;batch.file_counts.in_progress=0;}return this.batchPublic(batch);}
  listBatchFiles(storeId,batchId,options={}){const {entry,batch}=this.batch(storeId,batchId);if(options.filter&&!['in_progress','completed','failed','cancelled'].includes(options.filter))throw failure(400,'filter 状态无效');let values=batch.file_ids.map(fileId=>entry.files.get(fileId)?.value).filter(Boolean);if(options.filter)values=values.filter(value=>value.status===options.filter);return page(values,options);}
  search(storeId,body){
    object(body);keys(body,['query','filters','max_num_results','ranking_options','rewrite_query']);const entry=this.entry(storeId,true);
    const queries=Array.isArray(body.query)?body.query:[body.query];if(!queries.length||queries.some(value=>typeof value!=='string'||!value.trim()))throw failure(400,'query 必须是非空字符串或非空字符串数组');
    const maximum=body.max_num_results??10;if(!Number.isInteger(maximum)||maximum<1||maximum>50)throw failure(400,'max_num_results 必须为 1–50');
    if(body.rewrite_query!==undefined&&typeof body.rewrite_query!=='boolean')throw failure(400,'rewrite_query 必须是布尔值');
    const ranking=body.ranking_options??{};object(ranking,'ranking_options');keys(ranking,['ranker','score_threshold'],'ranking_options');
    if(ranking.ranker!==undefined&&typeof ranking.ranker!=='string')throw failure(400,'ranker 必须是字符串');const threshold=ranking.score_threshold??0;if(typeof threshold!=='number'||threshold<0||threshold>1)throw failure(400,'score_threshold 必须为 0–1');
    const results=[];for(const file of entry.files.values())if(file.value.status==='completed'&&matches(file.value.attributes,body.filters))for(const text of file.chunks){const score=relevance(text,queries);if(score>=threshold&&score>0)results.push({file_id:file.value.id,filename:file.filename,score:Number(score.toFixed(6)),attributes:clone(file.value.attributes),content:[{type:'text',text}]});}
    results.sort((a,b)=>b.score-a.score||a.file_id.localeCompare(b.file_id));return{object:'vector_store.search_results.page',search_query:Array.isArray(body.query)?clone(body.query):body.query,data:results.slice(0,maximum),has_more:results.length>maximum,next_page:null};
  }
  responseSearch(input){
    if(!Array.isArray(input.tools))return null;const tools=input.tools.filter(tool=>tool?.type==='file_search');if(!tools.length)return null;
    const query=queryText(input);if(!query)throw failure(400,'file_search 需要可搜索的文本输入');
    const all=[];for(const tool of tools){
      keys(tool,['type','vector_store_ids','max_num_results','filters','ranking_options']);
      if(!Array.isArray(tool.vector_store_ids)||!tool.vector_store_ids.length||tool.vector_store_ids.length>10||tool.vector_store_ids.some(value=>typeof value!=='string'||!value))throw failure(400,'file_search.vector_store_ids 必须为 1–10 个 ID');
      const maximum=tool.max_num_results??10;if(!Number.isInteger(maximum)||maximum<1||maximum>50)throw failure(400,'file_search.max_num_results 必须为 1–50');
      for(const storeId of tool.vector_store_ids)all.push(...this.search(storeId,{query,filters:tool.filters,max_num_results:maximum,ranking_options:tool.ranking_options}).data);
    }
    const unique=[];for(const result of all.sort((a,b)=>b.score-a.score)){if(!unique.some(item=>item.file_id===result.file_id&&item.content[0].text===result.content[0].text))unique.push(result);}
    const maximum=Math.max(...tools.map(tool=>tool.max_num_results??10)),results=unique.slice(0,maximum),context=results.length
      ?`Use the following locally retrieved file excerpts to answer the user's request. Cite filenames when useful.\n\n${results.map((item,index)=>`[${index+1}] ${item.filename} (${item.file_id}, score ${item.score})\n${item.content[0].text}`).join('\n\n')}`
      :'The requested local file search returned no matching excerpts. Do not claim that a file contained information you did not receive.';
    return{context,item:{id:id('fs'),type:'file_search_call',status:'completed',queries:[query],...(input.include?.includes('file_search_call.results')?{results}:{} )}};
  }
  get size(){this.prune();return this.entries.size;}
  get fileCount(){this.prune();return[...this.entries.values()].reduce((sum,entry)=>sum+entry.files.size,0);}
}
