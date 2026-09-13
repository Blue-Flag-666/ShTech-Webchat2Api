// Explicit opt-in live verification; reads configuration and consumes school quota.
import assert from 'node:assert/strict';
import { configuration, createServer, events } from './server.mjs';
import { listenForFetch } from './fixtures.mjs';
import { upstreamFetch } from './transport.mjs';

const config=configuration();
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
const server=createServer(config,fetcher);
await listenForFetch(server);
const base=`http://127.0.0.1:${server.address().port}`;
const model='qwen-instruct';
const plain='请只回复：API连接成功';
const question='请调用 echo 工具，value 参数为“工具连接成功”。';
const fn={name:'echo',description:'返回输入文本的测试工具',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}};
const paths=['/v1/chat/completions','/v1/responses','/v1/messages'];
async function call(path,body){
  const response=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json'},body:JSON.stringify({model,...body}),signal:AbortSignal.timeout(config.timeout+15000)});
  if(!response.ok){const error=await response.json();throw new Error(`${path}: HTTP ${response.status}: ${error.error?.message}`);}
  return response;
}
function input(path,prompt){return path==='/v1/responses'?{input:prompt,store:false}:{messages:[{role:'user',content:prompt}],max_tokens:256};}
function outputText(path,value){return path==='/v1/chat/completions'?value.choices[0].message.content:path==='/v1/responses'?value.output.filter(x=>x.type==='message').flatMap(x=>x.content).map(x=>x.text||'').join(''):value.content.filter(x=>x.type==='text').map(x=>x.text).join('');}
try {
  for(const path of paths){
    for(const stream of [false,true]){
      const response=await call(path,{...input(path,plain),stream});let text='',finished=false;
      if(!stream){text=outputText(path,await response.json());finished=true;}
      else for await(const event of events(response.body)){
        if(event.data==='[DONE]'){finished=true;continue;}
        const value=JSON.parse(event.data);if(value.error)throw new Error(value.error.message);
        text+=value.choices?.[0]?.delta?.content || (value.type==='response.output_text.delta'?value.delta:'') || (value.delta?.type==='text_delta'?value.delta.text:'');
        if(['response.completed','message_stop'].includes(value.type))finished=true;
      }
      assert.ok(finished && text.includes('API连接成功'));
      console.log(`${path}: ${stream?'SSE':'JSON'} OK`);
    }
    const request=input(path,question);
    if(path==='/v1/chat/completions'){request.tools=[{type:'function',function:fn}];request.tool_choice='required';}
    else if(path==='/v1/responses'){request.tools=[{type:'function',...fn}];request.tool_choice='required';}
    else{request.tools=[{name:fn.name,description:fn.description,input_schema:fn.parameters}];request.tool_choice={type:'any'};}
    const first=await (await call(path,request)).json();
    let follow;
    if(path==='/v1/chat/completions'){
      const message=first.choices[0].message;const tool=message.tool_calls[0];
      assert.equal(tool.function.name,'echo');assert.equal(JSON.parse(tool.function.arguments).value,'工具连接成功');
      follow={messages:[{role:'user',content:question},message,{role:'tool',tool_call_id:tool.id,content:'工具连接成功'}]};
    }else if(path==='/v1/responses'){
      const tool=first.output.find(x=>x.type==='function_call');
      assert.equal(tool.name,'echo');assert.equal(JSON.parse(tool.arguments).value,'工具连接成功');
      follow={input:[{role:'user',content:question},...first.output,{type:'function_call_output',call_id:tool.call_id,output:'工具连接成功'}],store:false};
    }else{
      const tool=first.content.find(x=>x.type==='tool_use');assert.equal(tool.name,'echo');assert.equal(tool.input.value,'工具连接成功');
      follow={messages:[{role:'user',content:question},{role:'assistant',content:first.content},{role:'user',content:[{type:'tool_result',tool_use_id:tool.id,content:'工具连接成功'}]}],max_tokens:256};
    }
    const answer=outputText(path,await (await call(path,follow)).json());assert.ok(answer?.includes('工具连接成功'));
    console.log(`${path}: tool call + result round trip OK`);
  }
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
