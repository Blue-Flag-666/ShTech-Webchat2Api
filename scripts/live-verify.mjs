// Explicit opt-in live verification; reads configuration and consumes school quota.
import assert from 'node:assert/strict';
import { configuration, createServer, events } from '../src/server.mjs';
import { listenForFetch } from '../test/fixtures.mjs';
import { upstreamFetch, fetchModelList } from '../src/transport.mjs';
import { isKimiK3Model } from '../src/models.mjs';

const config=configuration();
const args=process.argv.slice(2);let requestedModel,allModels=false;
for(let index=0;index<args.length;index++){
  if(args[index]==='--model'){
    if(requestedModel||!args[index+1]||args[index+1].startsWith('--'))throw new Error('--model requires one model ID');
    requestedModel=args[++index];
  }else if(args[index]==='--all-models')allModels=true;
  else if(!['--cas','--debug'].includes(args[index]))throw new Error(`Unknown option: ${args[index]}`);
}
if(requestedModel&&allModels)throw new Error('--model and --all-models cannot be combined');
// Live checks must re-read the current catalogue before every inference.
config.modelTtl=0;
if(process.argv.includes('--cas'))config.token='';
const fetcher=process.argv.includes('--debug')?async(url,options)=>{
  const response=await upstreamFetch(url,options);
  if(response.headers.get('content-type')?.includes('text/event-stream')){
    let text='', first, last;
    const copy=response.clone().body.getReader();
    async function* chunks(){while(true){const part=await copy.read();if(part.done)return;yield part.value;}}
    for await(const event of events(chunks())){
      if(event.data==='[DONE]')break;
      const chunk=JSON.parse(event.data);first ||= chunk;last=chunk; text+=chunk.choices?.[0]?.delta?.content || '';
    }
    void copy.cancel();
    console.log('Synthetic upstream text:',text.slice(0,2000));
    if(!text)console.log('First/last chunk:',JSON.stringify([first,last]));
  }
  return response;
}:upstreamFetch;
let catalogueFresh=false;
const liveModelFetcher=async(token,signal)=>{
  catalogueFresh=false;
  const result=await fetchModelList(token,signal);
  const records=result?.result?.records||result?.data?.records||result?.data||[];
  assert.ok(Array.isArray(records)&&result?.success!==false&&(result?.success===true||records.length),'Invalid fresh school model catalogue');
  catalogueFresh=true;return result;
};
const server=createServer(config,fetcher,liveModelFetcher);
await listenForFetch(server);
const base=`http://127.0.0.1:${server.address().port}`;
let model;
const plain='请只回复：API连接成功';
const question='请调用 echo 工具，value 参数为“工具连接成功”。';
const fn={name:'echo',description:'返回输入文本的测试工具',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}};
const paths=['/v1/chat/completions','/v1/completions','/v1/responses','/v1/messages'];
async function call(path,body){
  catalogueFresh=false;
  const check=await fetch(`${base}/v1/models/${encodeURIComponent(model)}`,{headers:{authorization:`Bearer ${config.key}`},signal:AbortSignal.timeout(config.timeout+15000)});
  assert.equal(check.status,200,`Model ${model} is no longer available`);
  assert.ok(catalogueFresh,'Cannot verify fresh model metadata; refusing inference with an outage fallback');
  const selected=await check.json();
  assert.equal(selected.root_ai_type,'xinference','Refusing to send to a model not confirmed as self-deployed');
  assert.equal(selected.owned_by,'shanghaitech');
  const response=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json'},body:JSON.stringify({model,...body}),signal:AbortSignal.timeout(config.timeout+15000)});
  if(!response.ok){const error=await response.json();throw new Error(`${path}: HTTP ${response.status}: ${error.error?.message}`);}
  return response;
}
function input(path,prompt){return path==='/v1/responses'?{input:prompt,store:false,max_output_tokens:256}:path==='/v1/completions'?{prompt,max_tokens:256}:{messages:[{role:'user',content:prompt}],max_tokens:256};}
function outputText(path,value){return path==='/v1/chat/completions'?value.choices[0].message.content:path==='/v1/completions'?value.choices[0].text:path==='/v1/responses'?value.output.filter(x=>x.type==='message').flatMap(x=>x.content).map(x=>x.text||'').join(''):value.content.filter(x=>x.type==='text').map(x=>x.text).join('');}
try {
  catalogueFresh=false;
  const catalogueResponse=await fetch(`${base}/v1/models`,{headers:{authorization:`Bearer ${config.key}`},signal:AbortSignal.timeout(config.timeout+15000)});
  assert.equal(catalogueResponse.status,200,'Cannot confirm the current school model catalogue');
  assert.ok(catalogueFresh,'Cannot confirm a fresh school model catalogue');
  const catalogue=(await catalogueResponse.json()).data;
  assert.ok(Array.isArray(catalogue),'Invalid model catalogue');
  const selfHosted=catalogue.filter(item=>item.root_ai_type==='xinference'&&item.owned_by==='shanghaitech'&&item.primary!==false);
  assert.ok(selfHosted.length,'No confirmed self-deployed models are available');
  const preferred=requestedModel?selfHosted.find(item=>item.id===requestedModel):selfHosted.find(isKimiK3Model)||selfHosted[0];
  assert.ok(preferred,'Requested model is not in the current self-deployed catalogue');
  for(const candidate of allModels?selfHosted:[preferred]){
  model=candidate.id;console.log(`Verifying confirmed Xinference model: ${model}`);
  for(const path of paths){
    for(const stream of [false,true]){
      const response=await call(path,{...input(path,plain),stream});let text='',finished=false;
      if(!stream){text=outputText(path,await response.json());finished=true;}
      else for await(const event of events(response.body)){
        if(event.data==='[DONE]'){finished=true;continue;}
        const value=JSON.parse(event.data);if(value.error)throw new Error(value.error.message);
        text+=value.choices?.[0]?.delta?.content || value.choices?.[0]?.text || (value.type==='response.output_text.delta'?value.delta:'') || (value.delta?.type==='text_delta'?value.delta.text:'');
        if(['response.completed','message_stop'].includes(value.type))finished=true;
      }
      assert.ok(finished && (path==='/v1/completions'?text.length>0:text.includes('API连接成功')));
      console.log(`${path}: ${stream?'SSE':'JSON'} OK`);
    }
    if(path==='/v1/completions')continue;
    const request=input(path,question);
    if(path==='/v1/chat/completions'){request.tools=[{type:'function',function:fn}];request.tool_choice='required';}
    else if(path==='/v1/responses'){request.tools=[{type:'function',...fn}];request.tool_choice='required';}
    else{request.tools=[{name:fn.name,description:fn.description,input_schema:fn.parameters}];request.tool_choice={type:'any'};}
    const first=await (await call(path,request)).json();
    let follow;
    if(path==='/v1/chat/completions'){
      const message=first.choices[0].message;const tool=message.tool_calls[0];
      assert.equal(tool.function.name,'echo');assert.equal(JSON.parse(tool.function.arguments).value,'工具连接成功');
      follow={messages:[{role:'user',content:question},message,{role:'tool',tool_call_id:tool.id,content:'工具连接成功'}],max_tokens:256};
    }else if(path==='/v1/responses'){
      const tool=first.output.find(x=>x.type==='function_call');
      assert.equal(tool.name,'echo');assert.equal(JSON.parse(tool.arguments).value,'工具连接成功');
      follow={input:[{role:'user',content:question},...first.output,{type:'function_call_output',call_id:tool.call_id,output:'工具连接成功'}],store:false,max_output_tokens:256};
    }else{
      const tool=first.content.find(x=>x.type==='tool_use');assert.equal(tool.name,'echo');assert.equal(tool.input.value,'工具连接成功');
      follow={messages:[{role:'user',content:question},{role:'assistant',content:first.content},{role:'user',content:[{type:'tool_result',tool_use_id:tool.id,content:'工具连接成功'}]}],max_tokens:256};
    }
    const answer=outputText(path,await (await call(path,follow)).json());assert.ok(answer?.includes('工具连接成功'));
    console.log(`${path}: tool call + result round trip OK`);
  }
  }
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
