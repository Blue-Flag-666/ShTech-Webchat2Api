// CI-only packaged-runtime check. Never calls the school service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { strToU8, zipSync } from 'fflate';
import { envValue } from '../../src/cli-config.mjs';
import { checkPackagedPdf } from './packaged-pdf.mjs';

if(!process.argv[2])throw new Error('Provide the packaged executable path');
const executable=resolve(process.argv[2]);
const directory=await mkdtemp(join(tmpdir(),'shtech-cli-check-'));
const portServer=createServer();
await new Promise((done,fail)=>{portServer.once('error',fail);portServer.listen(0,'127.0.0.1',done);});
const port=portServer.address().port;
await new Promise(done=>portServer.close(done));
const key=String.raw`ci-packaged-key\path"#literal`,base=`http://127.0.0.1:${port}`;
const configPath=join(directory,'packaged.env');
await writeFile(configPath,`API_KEY=${envValue(key)}\nGENAI_TOKEN=ci-placeholder-token\n`,{mode:0o600});
const launchOptions={
  cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
    API_KEY_FILE:'',GENAI_TOKEN_FILE:'',
    HOST:'127.0.0.1',PORT:String(port),GENAI_DATA_DIR:join(directory,'data'),GENAI_LOG_FILE:'',GENAI_STARTUP_CHECK:'false'}
};
delete launchOptions.env.API_KEY;delete launchOptions.env.GENAI_TOKEN;
let child,exited,output='',spawnError;
function launch(){
  spawnError=undefined;
  child=spawn(executable,['start','--config',configPath],launchOptions);
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output=(output+bytes.toString()).slice(-16000);});
  child.on('error',cause=>{spawnError=cause;});
  exited=new Promise(done=>{child.once('exit',done);child.once('error',done);});
}
async function stop(){
  if(!child)return;
  if(child.exitCode===null&&child.signalCode===null&&!spawnError)child.kill();
  const closed=()=>Promise.race([exited.then(()=>true),delay(5000,false,{ref:false})]);
  if(await closed())return;
  child.kill('SIGKILL');
  if(!await closed())throw new Error('Packaged service did not exit after forced shutdown');
}
const request=async(path,options={})=>{
  const response=await fetch(base+path,{...options,headers:{Authorization:`Bearer ${key}`,...options.headers},signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200,`${path}: ${response.status}`);return response.json();
};
async function waitReady(){
  let ready=false;
  for(let attempt=0;attempt<60;attempt++){
    if(spawnError)throw spawnError;
    if(child.exitCode!==null||child.signalCode!==null)throw new Error('Packaged service exited before readiness');
    try{const health=await request('/healthz');ready=health.status==='ok';}catch{}
    if(ready)break;
    await delay(250);
  }
  assert.ok(ready,'Packaged service did not become ready');
}
try{
  launch();await waitReady();
  assert.equal((await request('/health')).persistence_enabled,true);
  await checkPackagedPdf(base,key);
  const form=new FormData();form.append('purpose','assistants');
  const archive=zipSync({'project/src/deploy.ts':strToU8('export const deployment = 42;')});
  form.append('file',new File([archive],'package-check.zip',{type:'application/zip'}));
  const file=await request('/v1/files',{method:'POST',body:form});
  assert.equal(file.filename,'package-check.zip');
  const store=await request('/v1/vector_stores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'packaged-runtime',file_ids:[file.id]})});
  assert.equal(store.file_counts.completed,1);
  const search=await request(`/v1/vector_stores/${store.id}/search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'deployment'})});
  assert.equal(search.data[0].file_id,file.id);
  await stop();launch();await waitReady();
  assert.equal((await request(`/v1/files/${file.id}`)).filename,'package-check.zip');
  assert.equal((await request(`/v1/vector_stores/${store.id}`)).file_counts.completed,1);
  const restored=await request(`/v1/vector_stores/${store.id}/search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'deployment'})});
  assert.equal(restored.data[0].file_id,file.id);
  console.log('Packaged executable: configuration, startup, ZIP extraction and persisted file/index recovery passed');
}catch(cause){throw new Error(`${cause.message}\nPackaged service output:\n${output}`,{cause});}
finally{
  await stop();
  await rm(directory,{recursive:true,force:true});
}
