import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileStore } from '../src/files.mjs';
import { VectorStore } from '../src/vector-stores.mjs';

test('Vector Stores 管理文件、内容、属性过滤和本地检索',async()=>{
  const files=new FileStore(8,3600000,1024*1024);
  const source=files.create({filename:'guide.md',mime:'text/markdown',bytes:Buffer.from('# Deploy\nUse blue-green deployment for production.\nRollback with the previous image.'),purpose:'assistants'});
  const stores=new VectorStore(files,{maximum:4,ttl:3600000,maxFiles:8});
  const store=await stores.create({name:'project docs',file_ids:[source.id],metadata:{project:'demo'}});
  assert.match(store.id,/^vs_/);assert.equal(store.file_counts.completed,1);assert.ok(store.usage_bytes>0);
  const attached=stores.getFile(store.id,source.id);assert.equal(attached.status,'completed');
  const updated=stores.updateFile(store.id,source.id,{attributes:{kind:'runbook',version:2,active:true}});assert.equal(updated.attributes.kind,'runbook');
  const result=stores.search(store.id,{query:'How do I deploy production?',filters:{type:'eq',key:'kind',value:'runbook'},max_num_results:5,ranking_options:{score_threshold:0.01}});
  assert.equal(result.object,'vector_store.search_results.page');assert.equal(result.data[0].file_id,source.id);assert.match(result.data[0].content[0].text,/blue-green/);
  assert.equal(stores.search(store.id,{query:'deploy',filters:{type:'eq',key:'kind',value:'other'}}).data.length,0);
  const content=stores.content(store.id,source.id);assert.equal(content.filename,'guide.md');assert.equal(content.content[0].type,'text');
  assert.equal(stores.listFiles(store.id,{limit:1}).data.length,1);
  assert.equal(stores.update(store.id,{name:'renamed'}).name,'renamed');
  assert.equal(stores.deleteFile(store.id,source.id).deleted,true);assert.equal(stores.delete(store.id).deleted,true);
});

test('Vector Stores 文件批次记录成功和失败项',async()=>{
  const files=new FileStore(4,3600000,1024),source=files.create({filename:'code.ts',mime:'text/typescript',bytes:Buffer.from('export const answer = 42;')});
  const stores=new VectorStore(files,{maximum:2,ttl:3600000,maxFiles:4}),store=await stores.create({});
  const batch=await stores.createBatch(store.id,{file_ids:[source.id,'file-missing']});
  assert.equal(batch.status,'completed');assert.equal(batch.file_counts.completed,1);assert.equal(batch.file_counts.failed,1);assert.equal(batch.file_counts.total,2);
  assert.equal(stores.getBatch(store.id,batch.id).id,batch.id);assert.equal(stores.listBatchFiles(store.id,batch.id).data[0].id,source.id);
  assert.equal(stores.cancelBatch(store.id,batch.id).status,'completed');
});

test('Responses file_search 校验工具并生成检索上下文和调用项',async()=>{
  const files=new FileStore(4,3600000,1024),source=files.create({filename:'api.md',mime:'text/markdown',bytes:Buffer.from('The retry limit is five attempts.')});
  const stores=new VectorStore(files,{maximum:2,ttl:3600000,maxFiles:4}),store=await stores.create({file_ids:[source.id]});
  const found=stores.responseSearch({input:'What is the retry limit?',tools:[{type:'file_search',vector_store_ids:[store.id],max_num_results:3}],include:['file_search_call.results']});
  assert.match(found.context,/five attempts/);assert.equal(found.item.type,'file_search_call');assert.equal(found.item.results[0].file_id,source.id);
  assert.throws(()=>stores.responseSearch({input:'x',tools:[{type:'file_search',vector_store_ids:['missing']}]}),/不存在/);
});
