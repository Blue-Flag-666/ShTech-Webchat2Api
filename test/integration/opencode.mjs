// Runs the actual OpenCode CLI in CI; school inference is replaced with a fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/server.mjs';
import { modelDirectory } from '../../src/models.mjs';
import { opencodeConfig } from '../../src/opencode.mjs';
import { listenForFetch } from '../fixtures.mjs';

if(process.env.CI!=='true')throw new Error('This harness check is restricted to CI');
const directory=await mkdtemp(join(tmpdir(),'shtech-opencode-'));
const sentinel=`READ_RESULT_${randomUUID()}`,filePath=join(directory,'probe.txt');
await writeFile(filePath,sentinel);
const records=[
  {aiType:'Kimi-k3',aiName:'Kimi-K3',maxToken:1048576,enableDeepThink:1},
  {aiType:'deepseek-pro',aiName:'DeepSeek-V4.1-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'chatglm',aiName:'GLM-5.3-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'qwen-instruct',aiName:'Qwen-3.8',maxToken:524288,enableDeepThink:0}
].map(record=>({...record,rootAiType:'xinference',status:'3'}));
const modelId=process.env.GENAI_CI_MODEL||'kimi-k3';
const selected=modelDirectory(records).find(model=>model.primary&&model.id===modelId);
assert.ok(selected,'CI model must be a confirmed school model fixture');
const edited=`${sentinel}_EDITED`;
let toolRequests=0,resultReturned=false,child,childClosed;
const server=createServer({key:'ci-local-key',token:'ci-placeholder',group:'',timeout:10000,contextAuto:true},async(url,options)=>{
  assert.equal(new URL(url).pathname,'/htk/chat/start/chat');
  const body=JSON.parse(options.body);
  assert.equal(body.aiType,selected.upstream_id);assert.equal(body.rootAiType,'xinference');
  const prompt=body.chatInfo,marker='Tool declarations:\n',offset=prompt.indexOf(marker);
  let content='CI session';
  if(offset>=0){
    assert.ok(++toolRequests<=3,'Harness did not finish its tool loop');
    const declarations=JSON.parse(prompt.slice(offset+marker.length).split('\n')[0]);
    for(const name of ['read','edit'])assert.ok(declarations.some(tool=>tool.name===name),`OpenCode ${name} tool was not declared`);
    if(toolRequests===1)content=`Reading the fixture.\n<api_tool_call>${JSON.stringify({name:'read',arguments:{filePath}})}</api_tool_call>`;
    else if(toolRequests===2){
      assert.ok(JSON.stringify(body).includes(sentinel),'Read result did not reach the upstream fixture');
      content=`Updating the fixture.\n<api_tool_call>${JSON.stringify({name:'edit',arguments:{filePath,oldString:sentinel,newString:edited}})}</api_tool_call>`;
    }else{
      assert.equal(await readFile(filePath,'utf8'),edited,'OpenCode did not apply the requested edit');
      assert.ok(JSON.stringify(body).includes(edited),'Edit result did not reach the upstream fixture');
      resultReturned=true;content=`HARNESS_OK ${edited}`;
    }
  }
  const chunks=content.match(/.{1,7}/gs)||[];
  const frames=chunks.map(content=>({id:'chatcmpl-harness',object:'chat.completion.chunk',created:1,model:selected.upstream_id,choices:[{index:0,delta:{content},finish_reason:null}]}));
  frames.push({id:'chatcmpl-harness',object:'chat.completion.chunk',created:1,model:selected.upstream_id,choices:[{index:0,delta:{},finish_reason:'stop'}]});
  const encoder=new TextEncoder(),data=[...frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`),'data: [DONE]\n\n'];
  return new Response(new ReadableStream({pull(controller){const next=data.shift();if(next===undefined)controller.close();else controller.enqueue(encoder.encode(next));}}),{headers:{'content-type':'text/event-stream'}});
},async()=>({success:true,result:{records}}));
try{
  await listenForFetch(server);
  const config=opencodeConfig(modelDirectory(records),`http://127.0.0.1:${server.address().port}/v1`,'ci-local-key');
  config.model=`shtech/${modelId}`;
  Object.assign(config,{small_model:config.model,enabled_providers:['shtech'],autoupdate:false,share:'disabled',permission:{'*':'deny',read:'allow',edit:'allow',external_directory:{[`${directory}/*`]:'allow'}}});
  const configPath=join(directory,'opencode.json');await writeFile(configPath,JSON.stringify(config));
  child=spawn('opencode',['run','--format','json','--model',config.model,`Read ${filePath} with the read tool, replace its content with the edit tool, and report the result.`],{
    cwd:directory,stdio:['ignore','pipe','pipe'],env:{...process.env,OPENCODE_CONFIG:configPath,
      XDG_CONFIG_HOME:join(directory,'config'),XDG_DATA_HOME:join(directory,'data'),XDG_CACHE_HOME:join(directory,'cache'),XDG_STATE_HOME:join(directory,'state')}
  });
  let stdout='',stderr='';
  child.stdout.on('data',bytes=>{stdout=(stdout+bytes.toString()).slice(-128*1024);});
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-32*1024);});
  childClosed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),180000);
  let exit;try{exit=await childClosed;}finally{clearTimeout(timeout);}
  assert.equal(exit.code,0,`OpenCode failed (${exit.signal||exit.code})\n${stderr}\n${stdout}`);
  const events=stdout.split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
  for(const name of ['read','edit'])assert.ok(events.some(event=>event.type==='tool_use'&&event.part?.tool===name&&event.part?.state?.status==='completed'),`No completed ${name} event\n${stdout}\n${stderr}`);
  assert.ok(events.some(event=>event.type==='text'&&event.part?.text?.includes(`HARNESS_OK ${edited}`)),`No final answer from the tool result\n${stdout}`);
  assert.ok(resultReturned&&toolRequests===3,'Tool results did not reach the upstream fixture');
  assert.equal(await readFile(filePath,'utf8'),edited);
  console.log(`Actual OpenCode CLI (${modelId}): generated configuration, fragmented tool calls, file read/edit, result replay and final response passed`);
}finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await childClosed?.catch(()=>{});}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
