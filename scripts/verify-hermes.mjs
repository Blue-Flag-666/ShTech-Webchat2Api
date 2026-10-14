// Run the actual Hermes agent and its actual file tools in CI only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../src/server.mjs';
import { modelDirectory } from '../src/models.mjs';
import { listenForFetch } from '../test/fixtures.mjs';

if(process.env.CI!=='true')throw new Error('This harness check is restricted to CI');
const records=[
  {aiType:'Kimi-k3',aiName:'Kimi-K3',maxToken:1048576,enableDeepThink:1},
  {aiType:'deepseek-pro',aiName:'DeepSeek-V4.1-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'chatglm',aiName:'GLM-5.3-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'qwen-instruct',aiName:'Qwen-3.8',maxToken:524288,enableDeepThink:0}
].map(record=>({...record,rootAiType:'xinference',status:'3'}));
const models=modelDirectory(records).filter(model=>model.primary);
const root=await mkdtemp(join(tmpdir(),'shtech-hermes-'));
let selected,directory,filePath,sentinel,requests=0,child,childClosed;
const server=createServer({key:'ci-hermes-key',token:'ci-placeholder',group:'',timeout:10000},async(url,options)=>{
  assert.equal(new URL(url).pathname,'/htk/chat/start/chat');
  const body=JSON.parse(options.body);assert.equal(body.aiType,selected.upstream_id);assert.equal(body.rootAiType,'xinference');
  const marker='Tool declarations:\n',offset=body.chatInfo.indexOf(marker);
  let content='CI session';
  if(offset>=0){
    const declarations=JSON.parse(body.chatInfo.slice(offset+marker.length).split('\n')[0]);
    for(const name of ['read_file','write_file'])assert.ok(declarations.some(tool=>tool.name===name),`Hermes did not declare ${name}`);
    const step=++requests;assert.ok(step<=3,'Hermes did not finish its tool loop');
    if(step===1)content=`<api_tool_call>${JSON.stringify({name:'read_file',arguments:{path:filePath}})}</api_tool_call>`;
    else if(step===2){
      assert.ok(JSON.stringify(body).includes(sentinel),'Read result did not reach upstream');
      content=`<api_tool_call>${JSON.stringify({name:'write_file',arguments:{path:filePath,content:`${sentinel}_EDITED`}})}</api_tool_call>`;
    }else{
      assert.equal(await readFile(filePath,'utf8'),`${sentinel}_EDITED`,'Hermes did not apply the write');
      assert.ok(JSON.stringify(body).includes('write_file'),'Write history did not reach upstream');
      content='HERMES_OK';
    }
  }
  const chunks=content.match(/.{1,7}/gs)||[];
  const frames=chunks.map(content=>({id:'chatcmpl-hermes',model:selected.upstream_id,choices:[{index:0,delta:{content},finish_reason:null}]}));
  frames.push({id:'chatcmpl-hermes',model:selected.upstream_id,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}});
  return new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
},async()=>({success:true,result:{records}}));
try{
  await listenForFetch(server);
  for(selected of models){
    directory=join(root,selected.id);filePath=join(directory,'probe.txt');
    const {mkdir}=await import('node:fs/promises');await mkdir(directory);
    sentinel=`HERMES_READ_${randomUUID()}`;requests=0;await writeFile(filePath,sentinel);
    child=spawn('python',[resolve('scripts/hermes-probe.py')],{cwd:directory,stdio:['ignore','pipe','pipe'],env:{...process.env,
      PYTHONPATH:resolve('.ci-hermes'),HERMES_HOME:join(directory,'home'),TERMINAL_ENV:'local',TERMINAL_CWD:directory,
      GENAI_CI_URL:`http://127.0.0.1:${server.address().port}/v1`,GENAI_CI_MODEL:selected.id,GENAI_CI_FILE:filePath,
      HERMES_ENABLE_PLUGINS:'false',HERMES_DISABLE_TELEMETRY:'1'}});
    let stdout='',stderr='';child.stdout.on('data',bytes=>{stdout=(stdout+bytes.toString()).slice(-128*1024);});child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-32*1024);});
    childClosed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),180000);let exit;
    try{exit=await childClosed;}finally{clearTimeout(timeout);}
    assert.equal(exit.code,0,`Hermes failed (${exit.signal||exit.code})\n${stderr}\n${stdout}`);
    assert.ok(stdout.includes(`HERMES_VERIFIED ${selected.id}`));assert.equal(requests,3);
    assert.equal(await readFile(filePath,'utf8'),`${sentinel}_EDITED`);
    console.log(`Actual Hermes Agent (${selected.id}): file read/write, result replay and streamed final response passed`);
  }
}finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await childClosed?.catch(()=>{});}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
}
