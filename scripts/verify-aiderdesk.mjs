// Exercise the published AiderDesk app, its provider discovery and real tools.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.mjs';
import { modelDirectory } from '../src/models.mjs';
import { listenForFetch } from '../test/fixtures.mjs';

if(process.env.CI!=='true'||process.platform!=='linux')throw new Error('This app check is restricted to Linux CI');
const records=[
  {aiType:'Kimi-k3',aiName:'Kimi-K3',maxToken:1048576,enableDeepThink:1},
  {aiType:'deepseek-pro',aiName:'DeepSeek-V4.1-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'chatglm',aiName:'GLM-5.3-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'qwen-instruct',aiName:'Qwen-3.8',maxToken:524288,enableDeepThink:0}
].map(record=>({...record,rootAiType:'xinference',status:'3'}));
const models=modelDirectory(records).filter(model=>model.primary),root=await mkdtemp(join(tmpdir(),'shtech-aiderdesk-'));
const readTool='power---file_read',writeTool='power---file_write';
let selected,filePath,sentinel,requests=0,app,appClosed,run,runClosed,appOutput='';
const server=createServer({key:'ci-aider-key',token:'ci-placeholder',group:'',timeout:10000},async(url,options)=>{
  assert.equal(new URL(url).pathname,'/htk/chat/start/chat');
  const body=JSON.parse(options.body);assert.equal(body.aiType,selected.upstream_id);assert.equal(body.rootAiType,'xinference');
  const marker='Tool declarations:\n',offset=body.chatInfo.indexOf(marker);let content='CI session';
  if(offset>=0){
    const declarations=JSON.parse(body.chatInfo.slice(offset+marker.length).split('\n')[0]);
    for(const name of [readTool,writeTool])assert.ok(declarations.some(tool=>tool.name===name),`AiderDesk did not declare ${name}`);
    const step=++requests;assert.ok(step<=3,'AiderDesk did not finish its tool loop');
    if(step===1)content=`<api_tool_call>${JSON.stringify({name:readTool,arguments:{filePath}})}</api_tool_call>`;
    else if(step===2){
      assert.ok(JSON.stringify(body).includes(sentinel),'Read result did not reach upstream');
      content=`<api_tool_call>${JSON.stringify({name:writeTool,arguments:{filePath,content:`${sentinel}_EDITED`,mode:'overwrite'}})}</api_tool_call>`;
    }else{
      assert.equal(await readFile(filePath,'utf8'),`${sentinel}_EDITED`,'AiderDesk did not apply the write');
      assert.ok(JSON.stringify(body).includes(writeTool),'Write history did not reach upstream');content='AIDERDESK_OK';
    }
  }
  const frames=(content.match(/.{1,7}/gs)||[]).map(content=>({id:'chatcmpl-aider',model:selected.upstream_id,choices:[{index:0,delta:{content},finish_reason:null}]}));
  frames.push({id:'chatcmpl-aider',model:selected.upstream_id,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}});
  return new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
},async()=>({success:true,result:{records}}));
const closed=child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
function stopGroup(child){if(child?.pid)try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}}
try{
  await listenForFetch(server);
  const reservation=http.createServer();await listenForFetch(reservation);const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const env={...process.env,AIDER_DESK_DATA_DIR:join(root,'data'),OPENAI_API_KEY:'ci-aider-key',OPENAI_API_BASE:`http://127.0.0.1:${server.address().port}/v1`};
  app=spawn('aiderdesk',['start','--port',String(port)],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});appClosed=closed(app);
  for(const output of [app.stdout,app.stderr])output.on('data',bytes=>{appOutput=(appOutput+bytes.toString()).slice(-64*1024);});
  const base=`http://127.0.0.1:${port}/api`;
  const api=async(path,method='GET',body)=>{
    const response=await fetch(`${base}${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    assert.ok(response.ok,`${path}: ${response.status} ${await response.clone().text()}`);return response.json();
  };
  let ready=false;
  for(let attempt=0;attempt<90;attempt++){
    if(app.exitCode!==null||app.signalCode!==null)throw new Error(`AiderDesk stopped during startup\n${appOutput}`);
    try{const health=await api('/health');if(health.status==='ok'){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(ready,`AiderDesk did not start\n${appOutput}`);
  const settings=await api('/settings');await api('/settings','POST',{...settings,telemetryEnabled:false,aiderDeskAutoUpdate:false});
  await api('/providers','POST',[{id:'shtech',name:'School CI',provider:{name:'openai-compatible',apiKey:'ci-aider-key',baseUrl:env.OPENAI_API_BASE}}]);
  const discovery=await api('/models?reload=true'),discovered=discovery.models;
  assert.ok(Array.isArray(discovered),`Invalid model discovery response: ${JSON.stringify(discovery)}`);
  for(const model of models)assert.ok(discovered.some(item=>item.id===model.id&&item.providerId==='shtech'),`Model discovery lost ${model.id}`);
  const profiles=await api('/agent-profiles');assert.ok(profiles.length,'AiderDesk did not create default profiles');
  const template=profiles.find(profile=>profile.id==='default')||profiles[0];
  const approvals=Object.fromEntries(Object.keys(template.toolApprovals||{}).map(name=>[name,'never']));approvals[readTool]='always';approvals[writeTool]='always';
  const profile={...template,id:'shtech-ci',name:'School CI',provider:'shtech',maxIterations:6,maxTokens:1024,minTimeBetweenToolCalls:0,
    includeContextFiles:false,includeRepoMap:false,usePowerTools:true,useAiderTools:false,useTodoTools:false,useSubagents:false,useTaskTools:false,useMemoryTools:false,useSkillsTools:false,
    enabledServers:[],toolApprovals:approvals};
  await api('/agent-profile/create','POST',{profile:{...profile,model:models[0].id}});
  for(selected of models){
    const directory=join(root,selected.id);await mkdir(directory);filePath=join(directory,'probe.txt');sentinel=`AIDER_READ_${randomUUID()}`;requests=0;await writeFile(filePath,sentinel);
    await api('/agent-profile/update','POST',{profile:{...profile,model:selected.id}});
    run=spawn('aiderdesk',['run','--port',String(port),'--format','json','--agent-profile','shtech-ci',`Read ${filePath}, overwrite it with the file_write tool, and report the result.`],{cwd:directory,env,detached:true,stdio:['ignore','pipe','pipe']});runClosed=closed(run);
    let stdout='',stderr='';run.stdout.on('data',bytes=>{stdout=(stdout+bytes.toString()).slice(-128*1024);});run.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-32*1024);});
    const timeout=setTimeout(()=>stopGroup(run),180000);let exit;try{exit=await runClosed;}finally{clearTimeout(timeout);}
    assert.equal(exit.code,0,`AiderDesk failed (${exit.signal||exit.code})\n${stderr}\n${stdout}\n${appOutput}`);
    assert.ok(stdout.includes('AIDERDESK_OK'),`Missing final answer\n${stdout}`);assert.equal(requests,3);
    assert.equal(await readFile(filePath,'utf8'),`${sentinel}_EDITED`);
    console.log(`Actual AiderDesk (${selected.id}): provider/model discovery, real file read/write, result replay and final response passed`);
  }
}finally{
  stopGroup(run);stopGroup(app);
  if(app)await Promise.race([appClosed.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,5000))]);
  if(app?.pid)try{process.kill(-app.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
}
