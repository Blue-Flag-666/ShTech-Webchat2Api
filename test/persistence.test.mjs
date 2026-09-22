import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.mjs';
import { DiskState } from '../src/persistence.mjs';
import { FileStore } from '../src/files.mjs';
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
