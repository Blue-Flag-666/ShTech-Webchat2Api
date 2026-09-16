import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileStore } from '../src/files.mjs';
import { BatchStore } from '../src/batches.mjs';

async function terminal(store,id){
  for(let attempt=0;attempt<100;attempt++){
    const value=store.get(id);if(['completed','failed','cancelled'].includes(value.status))return value;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Batch 没有结束');
}

function input(files,lines){return files.create({filename:'requests.jsonl',mime:'application/jsonl',purpose:'batch',bytes:Buffer.from(lines.map(value=>JSON.stringify(value)).join('\n'))});}

test('Batches 执行 JSONL 请求并生成成功与错误文件',async()=>{
  const files=new FileStore(8,3600000,1024*1024);
  const source=input(files,[
    {custom_id:'ok',method:'POST',url:'/v1/responses',body:{model:'kimi-k3',input:'成功'}},
    {custom_id:'bad',method:'POST',url:'/v1/responses',body:{model:'missing',input:'失败'}}
  ]);
  const batches=new BatchStore(files,async(_url,body,_signal,requestId)=>body.model==='kimi-k3'
    ?{status:200,requestId,body:{id:'resp_ok',usage:{input_tokens:2,output_tokens:3,total_tokens:5}}}
    :{status:400,requestId,body:{error:{code:'invalid_model',message:'模型不存在'}}});
  const created=batches.create({input_file_id:source.id,endpoint:'/v1/responses',completion_window:'24h',metadata:{suite:'unit'}});
  assert.equal(created.status,'validating');
  const done=await terminal(batches,created.id);assert.equal(done.status,'completed');assert.deepEqual(done.request_counts,{total:2,completed:1,failed:1});assert.equal(done.usage.total_tokens,5);
  const output=files.get(done.output_file_id,true).bytes.toString(),failed=files.get(done.error_file_id,true).bytes.toString();
  assert.match(output,/"custom_id":"ok"/);assert.match(failed,/"custom_id":"bad"/);assert.equal(files.get(done.output_file_id).purpose,'batch_output');
  assert.equal(batches.list({limit:1}).data[0].id,created.id);
});

test('Batches 校验输入并可在执行前取消',async()=>{
  const files=new FileStore(4,3600000,1024),wrong=files.create({filename:'wrong.jsonl',mime:'application/jsonl',purpose:'user_data',bytes:Buffer.from('{}')});
  const batches=new BatchStore(files,async()=>({status:200,body:{}}));
  assert.throws(()=>batches.create({input_file_id:wrong.id,endpoint:'/v1/responses',completion_window:'24h'}),/purpose/);
  const source=input(files,[{custom_id:'one',method:'POST',url:'/v1/responses',body:{model:'kimi-k3',input:'x'}}]);
  const created=batches.create({input_file_id:source.id,endpoint:'/v1/responses',completion_window:'24h'}),cancelling=batches.cancel(created.id);
  assert.equal(cancelling.status,'cancelling');assert.equal((await terminal(batches,created.id)).status,'cancelled');
});
