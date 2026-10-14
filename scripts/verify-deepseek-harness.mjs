// Exercise the published DeepSeek Harness's real headless agent and file tools.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.mjs';
import { modelDirectory, modelBudget } from '../src/models.mjs';
import { listenForFetch } from '../test/fixtures.mjs';

if(process.env.CI!=='true')throw new Error('This harness check is restricted to CI');
const records=[
  {aiType:'Kimi-k3',aiName:'Kimi-K3',maxToken:1048576,enableDeepThink:1},
  {aiType:'deepseek-pro',aiName:'DeepSeek-V4.1-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'chatglm',aiName:'GLM-5.3-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'qwen-instruct',aiName:'Qwen-3.8',maxToken:524288,enableDeepThink:0}
].map(record=>({...record,rootAiType:'xinference',status:'3'}));
const models=modelDirectory(records).filter(model=>model.primary),root=await mkdtemp(join(tmpdir(),'shtech-dsh-'));
let selected,filePath,sentinel,requests=0,child,childClosed;
const server=createServer({key:'ci-dsh-key',token:'ci-placeholder',group:'',timeout:10000},async(url,options)=>{
  assert.equal(new URL(url).pathname,'/htk/chat/start/chat');
  const body=JSON.parse(options.body);assert.equal(body.aiType,selected.upstream_id);assert.equal(body.rootAiType,'xinference');
  const marker='Tool declarations:\n',offset=body.chatInfo.indexOf(marker);
  let content='CI session';
  if(offset>=0){
    const declarations=JSON.parse(body.chatInfo.slice(offset+marker.length).split('\n')[0]);
    for(const name of ['read','write'])assert.ok(declarations.some(tool=>tool.name===name),`DeepSeek Harness did not declare ${name}`);
    const step=++requests;assert.ok(step<=3,'Harness did not finish its tool loop');
    if(step===1)content=`<api_tool_call>${JSON.stringify({name:'read',arguments:{file_path:filePath}})}</api_tool_call>`;
    else if(step===2){
      assert.ok(JSON.stringify(body).includes(sentinel),'Read result did not reach upstream');
      content=`<api_tool_call>${JSON.stringify({name:'write',arguments:{file_path:filePath,content:`${sentinel}_EDITED`}})}</api_tool_call>`;
    }else{
      assert.equal(await readFile(filePath,'utf8'),`${sentinel}_EDITED`,'Harness did not apply the write');
      assert.ok(JSON.stringify(body).includes('write'),'Write history did not reach upstream');content='DSH_OK';
    }
  }
  const frames=(content.match(/.{1,7}/gs)||[]).map(content=>({id:'chatcmpl-dsh',model:selected.upstream_id,choices:[{index:0,delta:{content},finish_reason:null}]}));
  frames.push({id:'chatcmpl-dsh',model:selected.upstream_id,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}});
  return new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
},async()=>({success:true,result:{records}}));
try{
  await listenForFetch(server);
  for(selected of models){
    const directory=join(root,selected.id);await mkdir(directory);
    filePath=join(directory,'probe.txt');sentinel=`DSH_READ_${randomUUID()}`;requests=0;await writeFile(filePath,sentinel);
    const patchPath=join(directory,'ci.patch.yml'),budget=modelBudget(selected);
    await writeFile(patchPath,JSON.stringify([
      {id:'llm-deepseek',disabled:true},
      {id:'llm-pi-ai',config:{providers:{shtech:{apiKeyEnv:'SHTECH_CI_KEY',api:'openai-completions',baseURL:`http://127.0.0.1:${server.address().port}/v1`,models:[{id:selected.id,contextWindow:budget.context,maxTokens:1024,input:['text']}],reasoning:'off',cacheRetention:'none'}}}},
      {id:'agent-default-model',config:{provider:'shtech',model:selected.id}},
      {id:'session-persistence-jsonl',config:{root:join(directory,'sessions'),compression:'none'}}
    ]));
    child=spawn('dsh',['--profile','headless','--patch',patchPath,'--json',`Read ${filePath} with read, update it with write, and report the result.`],{
      cwd:directory,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:join(directory,'home'),SHTECH_CI_KEY:'ci-dsh-key'}});
    let stdout='',stderr='';child.stdout.on('data',bytes=>{stdout=(stdout+bytes.toString()).slice(-128*1024);});child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-32*1024);});
    childClosed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),180000);let exit;
    try{exit=await childClosed;}finally{clearTimeout(timeout);}
    assert.equal(exit.code,0,`DeepSeek Harness failed (${exit.signal||exit.code})\n${stderr}\n${stdout}`);
    const events=stdout.split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
    for(const name of ['read','write']){
      const call=events.find(event=>event.type==='tool_call'&&event.tool===name);assert.ok(call,`Missing ${name} event\n${stdout}`);
      assert.ok(events.some(event=>event.type==='tool_result'&&event.callId===call.callId&&event.status==='completed'),`Missing completed ${name} result\n${stdout}`);
    }
    assert.ok(events.some(event=>event.type==='final'&&event.text==='DSH_OK'),`Missing final answer\n${stdout}`);
    assert.equal(requests,3);assert.equal(await readFile(filePath,'utf8'),`${sentinel}_EDITED`);
    console.log(`Actual DeepSeek Harness (${selected.id}): custom provider, file read/write, result replay and final response passed`);
  }
}finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await childClosed?.catch(()=>{});}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
}
