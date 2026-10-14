import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { createServer } from '../src/server.mjs';
import { DiskState } from '../src/persistence.mjs';
import { FileStore } from '../src/files.mjs';
import { ResponseStore } from '../src/response-store.mjs';
import { UploadStore } from '../src/uploads.mjs';
import { BatchStore } from '../src/batches.mjs';
import { listenForFetch, confirmedModels } from './fixtures.mjs';

const auth={authorization:'Bearer persistence-test'};
const jsonHeaders={...auth,'content-type':'application/json'};

async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('PersistentMap 原子保存 Buffer、Map、更新和删除',t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-state-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const first=new DiskState(directory).map('values');first.set('资源 1',{bytes:Buffer.from('内容'),nested:new Map([['a',1]])});
  first.get('资源 1').nested.set('b',2);first.sync('资源 1');
  const second=new DiskState(directory).map('values'),loaded=second.get('资源 1');
  assert.equal(Buffer.from(loaded.bytes).toString(),'内容');assert.equal(loaded.nested.get('b'),2);
  second.delete('资源 1');assert.equal(new DiskState(directory).map('values').size,0);
});

test('持久化删除失败时内存和主记录保留，解除阻塞后可重试',t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-state-delete-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const map=new DiskState(directory).map('values');map.set('saved',{answer:'keep'});
  const primary=map.path('saved'),backup=`${primary}.bak`,original=readFileSync(primary);
  mkdirSync(backup);writeFileSync(join(backup,'blocker'),'not a backup file');
  assert.throws(()=>map.delete('saved'));
  assert.equal(map.has('saved'),true);assert.equal(map.get('saved').answer,'keep');
  assert.deepEqual(readFileSync(primary),original);
  rmSync(backup,{recursive:true,force:true});
  assert.equal(map.delete('saved'),true);assert.equal(map.has('saved'),false);assert.equal(existsSync(primary),false);
  assert.equal(new DiskState(directory).map('values').has('saved'),false);
});

test('数据目录配额在临时写入前拒绝超额资源并保留旧记录',t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-state-quota-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const state=new DiskState(directory,2048),map=state.map('values');
  map.set('small',{bytes:Buffer.from('saved')});
  const original=readFileSync(map.path('small'));
  assert.throws(()=>map.set('large',{bytes:Buffer.alloc(4096)}),cause=>cause.status===507&&cause.code==='insufficient_storage');
  assert.equal(map.has('large'),false);
  map.get('small').bytes=Buffer.alloc(4096);
  assert.throws(()=>map.sync('small'),cause=>cause.status===507);
  assert.equal(Buffer.from(map.get('small').bytes).toString(),'saved');
  assert.deepEqual(readFileSync(map.path('small')),original);
  assert.ok(state.usageBytes()<=2048);
  const conversations=new ResponseStore(4,3600000,'对话',state.map('conversations'));
  conversations.set('conversation',{text:'original'});
  assert.throws(()=>conversations.set('conversation',{text:'x'.repeat(4096)}),cause=>cause.status===507);
  assert.equal(conversations.get('conversation').text,'original');
});

test('磁盘可用空间不足时保留原记录且不创建临时文件',t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-state-space-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let available=1024n*1024n;
  const state=new DiskState(directory,0,()=>({bsize:1n,bavail:available})),map=state.map('values');
  map.set('saved',{answer:'original'});const original=readFileSync(map.path('saved'));
  available=1n;
  assert.throws(()=>map.set('saved',{answer:'updated'}),cause=>cause.status===507&&cause.code==='insufficient_storage');
  assert.equal(map.get('saved').answer,'original');assert.deepEqual(readFileSync(map.path('saved')),original);
  assert.equal(readdirSync(join(directory,'values')).some(name=>name.endsWith('.tmp')),false);
  available=1024n*1024n;map.set('saved',{answer:'updated'});
  assert.equal(map.get('saved').answer,'updated');
});

test('文件系统不支持空间查询时继续使用配置配额',t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-state-statfs-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const state=new DiskState(directory,1024,()=>{throw Object.assign(new Error('unsupported'),{code:'ENOTSUP'});}),map=state.map('values');
  map.set('small',{answer:1});
  assert.throws(()=>map.set('large',{bytes:Buffer.alloc(4096)}),cause=>cause.status===507);
});

test('持久化记录迁移到校验格式，损坏主记录从上一版本恢复',t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-state-recovery-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const namespace=join(directory,'values');mkdirSync(namespace);
  const oldPath=join(namespace,`${Buffer.from('old').toString('base64url')}.bin`);
  writeFileSync(oldPath,serialize({format:1,key:'old',value:{answer:'legacy'}}));
  const state=new DiskState(directory),map=state.map('values');
  assert.equal(map.get('old').answer,'legacy');
  map.set('old',{answer:'updated'});
  assert.equal(deserialize(readFileSync(oldPath)).format,2);
  writeFileSync(oldPath,Buffer.from('damaged'));
  const restoredState=new DiskState(directory),restored=restoredState.map('values');
  assert.equal(restored.get('old').answer,'legacy');
  assert.equal(restoredState.corruptResources.length,1);
  assert.equal(restoredState.recoveredResources.length,1);
  assert.equal(deserialize(readFileSync(oldPath)).format,1);
  restored.set('old',{answer:'latest'});
  assert.equal(deserialize(readFileSync(oldPath)).format,2);
  restored.delete('old');
  assert.equal(readdirSync(namespace).filter(name=>name.endsWith('.bin')||name.endsWith('.bin.bak')).length,0);
});

test('单个资源校验失败会被隔离，不影响同目录的有效资源',t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-state-isolation-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const state=new DiskState(directory),map=state.map('values');
  map.set('valid',{answer:1});map.set('broken',{answer:2});
  const brokenPath=map.path('broken'),record=deserialize(readFileSync(brokenPath));
  record.sha256='0'.repeat(64);writeFileSync(brokenPath,serialize(record));
  const reopened=new DiskState(directory),loaded=reopened.map('values');
  assert.equal(loaded.get('valid').answer,1);
  assert.equal(loaded.has('broken'),false);
  assert.equal(reopened.corruptResources.length,1);
  assert.ok(readdirSync(join(directory,'values')).some(name=>name.includes('.corrupt.')));
});

test('数据目录锁拒绝第二个进程并在释放后允许重启',t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-state-lock-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const first=new DiskState(directory).acquireLock();
  assert.throws(()=>new DiskState(directory).acquireLock(),/正在被另一个进程使用/);
  first();
  const second=new DiskState(directory).acquireLock();second();
  assert.equal(existsSync(join(directory,'.instance.lock')),false);
});

test('崩溃进程遗留的目录锁可被恢复',t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-state-stale-lock-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  writeFileSync(join(directory,'.instance.lock'),JSON.stringify({pid:999999999,owner:'dead',created_at:'2020-01-01T00:00:00Z'}));
  const release=new DiskState(directory).acquireLock();
  assert.equal(JSON.parse(readFileSync(join(directory,'.instance.lock'),'utf8')).pid,process.pid);
  release();
});

test('Uploads 分片和已结束 Batches 可在重建存储后恢复',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-resource-state-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const state=new DiskState(directory),files=new FileStore(8,3600000,1024*1024,state.map('files'));
  const uploads=new UploadStore(files,8,3600000,state.map('uploads')),upload=uploads.create({bytes:5,filename:'part.txt',mime_type:'text/plain',purpose:'user_data'}),part=uploads.addPart(upload.id,Buffer.from('hello'));
  const restoredUploads=new UploadStore(files,8,3600000,new DiskState(directory).map('uploads'));
  assert.equal(restoredUploads.complete(upload.id,{part_ids:[part.id]}).file.filename,'part.txt');
  const source=files.create({filename:'batch.jsonl',mime:'application/jsonl',purpose:'batch',bytes:Buffer.from('{"custom_id":"one","method":"POST","url":"/v1/responses","body":{"model":"kimi-k3","input":"x"}}')});
  const codec={encode:entry=>{const {controller,...saved}=entry;return saved;},decode:entry=>({...entry,controller:new AbortController()})};
  const batches=new BatchStore(files,async()=>({status:200,requestId:'req_batch',body:{id:'resp_batch'}}),{maximum:4,ttl:3600000,entries:state.map('batches',codec)}),created=batches.create({input_file_id:source.id,endpoint:'/v1/responses',completion_window:'24h'});
  let done;for(let attempt=0;attempt<100;attempt++){done=batches.get(created.id);if(done.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(done.status,'completed');batches.close();
  const restored=new BatchStore(files,async()=>{throw new Error('不应重新执行');},{maximum:4,ttl:3600000,entries:new DiskState(directory).map('batches',codec)});
  assert.equal(restored.get(created.id).status,'completed');restored.close();
});

test('服务重启后恢复 Files、Conversations 和 Vector Stores，但不缓存 Responses',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'shtech-server-state-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const config={key:'persistence-test',token:'upstream-test',group:'g',timeout:3000,dataDir:directory,fileStoreTtl:3600000,vectorStoreTtl:3600000,responseStoreTtl:3600000};
  const upstream=async()=>new Response('data: {"id":"chatcmpl_persist","model":"qwen-instruct","choices":[{"index":0,"delta":{"content":"临时回答"},"finish_reason":"stop"}]}\n\n',{headers:{'content-type':'text/event-stream'}});
  const first=createServer(config,upstream,confirmedModels);await listenForFetch(first);const firstBase=`http://127.0.0.1:${first.address().port}`;
  assert.throws(()=>createServer(config,upstream,confirmedModels),/正在被另一个进程使用/);
  const form=new FormData();form.set('purpose','assistants');form.set('file',new File(['persistent deployment guide'],'guide.md',{type:'text/markdown'}));
  const file=await(await fetch(`${firstBase}/v1/files`,{method:'POST',headers:auth,body:form})).json();
  const conversation=await(await fetch(`${firstBase}/v1/conversations`,{method:'POST',headers:jsonHeaders,body:JSON.stringify({items:[{type:'message',role:'user',content:'保留我'}]})})).json();
  const vector=await(await fetch(`${firstBase}/v1/vector_stores`,{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'persistent',file_ids:[file.id]})})).json();
  const response=await(await fetch(`${firstBase}/v1/responses`,{method:'POST',headers:jsonHeaders,body:JSON.stringify({model:'qwen-instruct',input:'不要持久化模型结果'})})).json();
  await close(first);
  const second=createServer(config,upstream,confirmedModels);await listenForFetch(second);t.after(()=>close(second));const secondBase=`http://127.0.0.1:${second.address().port}`;
  assert.equal((await(await fetch(`${secondBase}/v1/files/${file.id}`,{headers:auth})).json()).filename,'guide.md');
  const items=await(await fetch(`${secondBase}/v1/conversations/${conversation.id}/items`,{headers:auth})).json();assert.equal(items.data[0].content,'保留我');
  const found=await(await fetch(`${secondBase}/v1/vector_stores/${vector.id}/search`,{method:'POST',headers:jsonHeaders,body:JSON.stringify({query:'deployment'})})).json();assert.equal(found.data[0].file_id,file.id);
  assert.equal((await fetch(`${secondBase}/v1/responses/${response.id}`,{headers:auth})).status,404);
});
