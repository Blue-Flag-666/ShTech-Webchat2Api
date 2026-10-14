// Runs the actual OpenCode CLI in CI; school inference is replaced with a fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.mjs';
import { modelDirectory } from '../src/models.mjs';
import { opencodeConfig } from '../src/opencode.mjs';
import { listenForFetch } from '../test/fixtures.mjs';

if(process.env.CI!=='true')throw new Error('This harness check is restricted to CI');
const directory=await mkdtemp(join(tmpdir(),'shtech-opencode-'));
const sentinel=`READ_RESULT_${randomUUID()}`,filePath=join(directory,'probe.txt');
await writeFile(filePath,sentinel);
const records=[{aiType:'Kimi-k3',aiName:'Kimi-K3',rootAiType:'xinference',status:'3',maxToken:1048576}];
let toolRequests=0,readRequested=false,resultReturned=false,child,childClosed;
const server=createServer({key:'ci-local-key',token:'ci-placeholder',group:'',timeout:10000,contextAuto:true},async(url,options)=>{
  assert.equal(new URL(url).pathname,'/htk/chat/start/chat');
  const body=JSON.parse(options.body);
  assert.equal(body.aiType,'Kimi-k3');assert.equal(body.rootAiType,'xinference');
  const prompt=body.chatInfo,marker='Tool declarations:\n',offset=prompt.indexOf(marker);
  let content='CI session';
  if(offset>=0){
    assert.ok(++toolRequests<=10,'Harness did not finish its tool loop');
    const declarations=JSON.parse(prompt.slice(offset+marker.length).split('\n')[0]);
    assert.ok(declarations.some(tool=>tool.name==='read'),'OpenCode read tool was not declared');
    if(JSON.stringify(body).includes(sentinel)){
      assert.ok(readRequested);resultReturned=true;content=`HARNESS_OK ${sentinel}`;
    }else{
      assert.equal(readRequested,false,'Harness failed to return the requested file');readRequested=true;
      content=`<api_tool_call>${JSON.stringify({name:'read',arguments:{filePath}})}</api_tool_call>`;
    }
  }
  const frame={id:'chatcmpl-harness',object:'chat.completion.chunk',created:1,model:'Kimi-k3',choices:[{index:0,delta:{content},finish_reason:'stop'}]};
  return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
},async()=>({success:true,result:{records}}));
try{
  await listenForFetch(server);
  const config=opencodeConfig(modelDirectory(records),`http://127.0.0.1:${server.address().port}/v1`,'ci-local-key');
  Object.assign(config,{small_model:config.model,enabled_providers:['shtech'],autoupdate:false,share:'disabled',permission:{'*':'deny',read:'allow',external_directory:{[`${directory}/*`]:'allow'}}});
  const configPath=join(directory,'opencode.json');await writeFile(configPath,JSON.stringify(config));
  child=spawn('opencode',['run','--format','json','--model',config.model,`Read ${filePath} with the read tool and report its content.`],{
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
  assert.ok(events.some(event=>event.type==='tool_use'&&event.part?.tool==='read'&&event.part?.state?.status==='completed'),'No completed read event');
  assert.ok(events.some(event=>event.type==='text'&&event.part?.text?.includes(`HARNESS_OK ${sentinel}`)),'No final answer from the tool result');
  assert.ok(resultReturned&&toolRequests>=2,'Tool result did not reach the upstream fixture');
  console.log('Actual OpenCode CLI: generated configuration, file read, tool-result replay and final response passed');
}finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await childClosed?.catch(()=>{});}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
