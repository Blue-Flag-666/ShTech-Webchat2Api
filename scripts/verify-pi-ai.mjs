// Exercise the current Pi AI wire client used by DeepSeek Harness, in CI only.
import assert from 'node:assert/strict';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { createServer } from '../src/server.mjs';
import { modelDirectory, modelBudget } from '../src/models.mjs';
import { listenForFetch } from '../test/fixtures.mjs';

if(process.env.CI!=='true')throw new Error('This client check is restricted to CI');
const records=[
  {aiType:'Kimi-k3',aiName:'Kimi-K3',maxToken:1048576,enableDeepThink:1},
  {aiType:'deepseek-pro',aiName:'DeepSeek-V4.1-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'chatglm',aiName:'GLM-5.3-Flash',maxToken:524288,enableDeepThink:1},
  {aiType:'qwen-instruct',aiName:'Qwen-3.8',maxToken:524288,enableDeepThink:0}
].map(record=>({...record,rootAiType:'xinference',status:'3'}));
const directory=modelDirectory(records).filter(model=>model.primary);
let selected,requests=0;
const server=createServer({key:'ci-pi-key',token:'ci-placeholder',group:'',timeout:10000},async(url,options)=>{
  assert.equal(new URL(url).pathname,'/htk/chat/start/chat');
  const body=JSON.parse(options.body);assert.equal(body.aiType,selected.upstream_id);assert.equal(body.rootAiType,'xinference');
  const step=++requests;
  assert.ok(step<=2,'Client loop must be bounded');
  if(selected.webchat_thinking)assert.equal(body.thinking,true);
  let content;
  if(step===1){
    assert.match(body.chatInfo,/Tool declarations:/);
    content='Checking the command.\n<api_tool_call>{"name":"probe","arguments":{"command":"ci-probe"}}</api_tool_call>';
  }else{
    for(const text of ['CI_STDOUT','CI_STDERR','exit_code=7'])assert.ok(JSON.stringify(body).includes(text),`Tool result lost ${text}`);
    content='PI_AI_OK';
  }
  const chunks=[];
  if(selected.capabilities.reasoning)chunks.push({reasoning_content:'Check the tool result.'});
  chunks.push(...(content.match(/.{1,7}/gs)||[]).map(content=>({content})));
  const frames=chunks.map(delta=>({id:'chatcmpl-pi',model:selected.upstream_id,choices:[{index:0,delta,finish_reason:null}]}));
  frames.push({id:'chatcmpl-pi',model:selected.upstream_id,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}});
  return new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
},async()=>({success:true,result:{records}}));
try{
  await listenForFetch(server);
  for(selected of directory){
    requests=0;
    const budget=modelBudget(selected);
    const model={id:selected.id,name:selected.display_name,api:'openai-completions',provider:'shtech',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,
      reasoning:Boolean(selected.capabilities.reasoning),input:['text'],contextWindow:budget.context,maxTokens:budget.output,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    const context={messages:[
      {role:'system',content:'Run the declared probe, then report the result.',toolsAdded:[{name:'probe',description:'A CI command probe',parameters:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}}],timestamp:Date.now()},
      {role:'user',content:'Check the command result.',timestamp:Date.now()}
    ]};
    const options={apiKey:'ci-pi-key',maxTokens:1024,...(model.reasoning?{reasoningEffort:'medium'}:{})};
    const first=stream(model,context,options),events=[];
    for await(const event of first){events.push(event.type);if(event.type==='error')throw new Error(event.error.errorMessage);}
    const result=await first.result();assert.equal(result.stopReason,'toolUse');
    assert.ok(events.includes('toolcall_start')&&events.includes('toolcall_delta')&&events.includes('toolcall_end')&&events.includes('done'));
    if(model.reasoning)assert.ok(events.includes('thinking_delta'));
    const calls=result.content.filter(block=>block.type==='toolCall');assert.equal(calls.length,1);assert.equal(calls[0].name,'probe');assert.deepEqual(calls[0].arguments,{command:'ci-probe'});
    context.messages.push(result,{role:'toolResult',toolCallId:calls[0].id,toolName:'probe',content:[{type:'text',text:'stdout: CI_STDOUT\nstderr: CI_STDERR\nexit_code=7'}],isError:true,timestamp:Date.now()});
    const second=stream(model,context,options),types=[];
    for await(const event of second){types.push(event.type);if(event.type==='error')throw new Error(event.error.errorMessage);}
    const final=await second.result();assert.equal(final.stopReason,'stop');assert.ok(types.includes('done'));
    assert.ok(final.content.some(block=>block.type==='text'&&block.text==='PI_AI_OK'));assert.equal(requests,2);
    assert.ok(final.usage.input>0&&final.usage.output>0);
    console.log(`Pi AI (${selected.id}): default request, reasoning, incremental tools, error-result replay, usage and terminal events passed`);
  }
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
