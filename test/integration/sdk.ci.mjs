import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { strToU8, zipSync } from 'fflate';
import { createServer } from '../../src/server.mjs';
import { opencodeConfig } from '../../src/opencode.mjs';
import { listenForFetch, confirmedModels } from '../fixtures.mjs';

async function fixture(run) {
  const server=createServer({key:'test',token:'token',group:'g',timeout:5000},async()=>{
    const chunks=[
      {id:'chatcmpl_sdk',model:'qwen-instruct',choices:[{index:0,delta:{content:'你'},finish_reason:null}]},
      {id:'chatcmpl_sdk',model:'qwen-instruct',choices:[{index:0,delta:{content:'好'},finish_reason:null}]},
      {id:'chatcmpl_sdk',model:'qwen-instruct',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:2}}
    ];
    return new Response(chunks.map(value=>`data: ${JSON.stringify(value)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  },confirmedModels);
  await listenForFetch(server);
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
}

test('OpenAI SDK 自动分页完整读取文件、向量库和会话项',async()=>{
  await fixture(async base=>{
    const client=new OpenAI({apiKey:'test',baseURL:`${base}/v1`,maxRetries:0});
    const files=[],stores=[];
    for(let index=0;index<3;index++){
      files.push(await client.files.create({file:new File([`deployment guide ${index}`],`page-${index}.txt`,{type:'text/plain'}),purpose:'assistants'}));
      stores.push(await client.vectorStores.create({name:`page-${index}`}));
    }
    const collect=async pages=>{const ids=[];for await(const value of pages){ids.push(value.id);assert.ok(ids.length<=10,'pagination must terminate');}return ids;};
    const expectedFiles=files.map(file=>file.id).sort();
    const first=await client.files.list({purpose:'assistants',limit:1});
    assert.equal(first.data.length,1);assert.equal(first.hasNextPage(),true);
    const second=await first.getNextPage();assert.notEqual(second.data[0].id,first.data[0].id);
    assert.deepEqual((await collect(client.files.list({purpose:'assistants',limit:1}))).sort(),expectedFiles);
    assert.deepEqual((await collect(client.vectorStores.list({limit:1}))).sort(),stores.map(store=>store.id).sort());
    const batch=await client.vectorStores.fileBatches.create(stores[0].id,{file_ids:files.map(file=>file.id)});
    assert.deepEqual((await collect(client.vectorStores.files.list(stores[0].id,{limit:1}))).sort(),expectedFiles);
    assert.deepEqual((await collect(client.vectorStores.fileBatches.listFiles(batch.id,{vector_store_id:stores[0].id,limit:1}))).sort(),expectedFiles);
    const search=await client.vectorStores.search(stores[0].id,{query:'deployment',max_num_results:1});
    assert.equal(search.data.length,1);assert.equal(search.hasNextPage(),false);
    const conversation=await client.conversations.create({items:[{role:'user',content:'first'},{role:'assistant',content:'second'},{role:'user',content:'third'}]});
    const all=await client.conversations.items.list(conversation.id,{order:'asc'});
    assert.deepEqual(await collect(client.conversations.items.list(conversation.id,{limit:1,order:'asc'})),all.data.map(item=>item.id));
  });
});

function simplePdf(text='Hello PDF'){
  const escaped=text.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(`BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`)} >>\nstream\nBT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\nendstream`
  ];
  let source='%PDF-1.4\n',offsets=[0];
  objects.forEach((body,index)=>{offsets.push(Buffer.byteLength(source));source+=`${index+1} 0 obj\n${body}\nendobj\n`;});
  const xref=Buffer.byteLength(source);source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

function simpleDocx(text='Office attachment works'){
  return Buffer.from(zipSync({
    '[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml':strToU8(`<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
  }));
}

test('最新版 OpenAI SDK 调用 models、Chat 和 Responses 的 JSON/SSE',async()=>{
  await fixture(async base=>{
    const client=new OpenAI({apiKey:'test',baseURL:`${base}/v1`,maxRetries:0});
    const models=await client.models.list();assert.equal(models.data[0].id,'qwen-instruct');
    assert.equal((await client.models.retrieve('qwen-instruct')).id,'qwen-instruct');
    const uploaded=await client.files.create({file:new File(['export const answer = 42;'],'answer.ts',{type:'text/typescript'}),purpose:'user_data'});
    assert.equal((await client.files.retrieve(uploaded.id)).filename,'answer.ts');
    assert.equal(await (await client.files.content(uploaded.id)).text(),'export const answer = 42;');
    assert.equal((await client.files.list({purpose:'user_data'})).data[0].id,uploaded.id);
    const fileResponse=await client.responses.create({model:'qwen-instruct',input:[{role:'user',content:[{type:'input_text',text:'阅读文件'},{type:'input_file',file_id:uploaded.id}]}],store:false});
    assert.equal(fileResponse.output_text,'你好');assert.equal((await client.files.delete(uploaded.id)).deleted,true);
    const bytes=Buffer.from('chunked upload'),upload=await client.uploads.create({bytes:bytes.length,filename:'chunked.txt',mime_type:'text/plain',purpose:'user_data'});
    const first=await client.uploads.parts.create(upload.id,{data:new File([bytes.subarray(0,8)],'first.bin')});
    const second=await client.uploads.parts.create(upload.id,{data:new File([bytes.subarray(8)],'second.bin')});
    const completed=await client.uploads.complete(upload.id,{part_ids:[first.id,second.id]});assert.equal(completed.status,'completed');assert.equal(await (await client.files.content(completed.file.id)).text(),'chunked upload');
    const pdf=await client.files.create({file:new File([simplePdf('PDF attachment works')],'document.pdf',{type:'application/pdf'}),purpose:'user_data'});
    const pdfResponse=await client.responses.create({model:'qwen-instruct',input:[{role:'user',content:[{type:'input_file',file_id:pdf.id}]}],store:false});assert.equal(pdfResponse.output_text,'你好');
    const office=await client.files.create({file:new File([simpleDocx()],'report.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),purpose:'user_data'});
    const officeResponse=await client.responses.create({model:'qwen-instruct',input:[{role:'user',content:[{type:'input_file',file_id:office.id}]}],store:false});assert.equal(officeResponse.output_text,'你好');
    const knowledge=await client.files.create({file:new File(['Production deployment uses blue-green releases.'],'runbook.md',{type:'text/markdown'}),purpose:'assistants'});
    const vectorStore=await client.vectorStores.create({name:'SDK knowledge',file_ids:[knowledge.id]});assert.equal(vectorStore.file_counts.completed,1);
    assert.equal((await client.vectorStores.retrieve(vectorStore.id)).id,vectorStore.id);assert.equal((await client.vectorStores.list({limit:1})).data[0].id,vectorStore.id);
    assert.equal((await client.vectorStores.files.list(vectorStore.id)).data[0].id,knowledge.id);
    const search=await client.vectorStores.search(vectorStore.id,{query:'production deployment'});assert.equal(search.data[0].file_id,knowledge.id);
    const searchedResponse=await client.responses.create({model:'qwen-instruct',input:'How is production deployed?',tools:[{type:'file_search',vector_store_ids:[vectorStore.id]}],include:['file_search_call.results'],store:false});
    assert.equal(searchedResponse.output_text,'你好');assert.equal(searchedResponse.output[0].type,'file_search_call');assert.equal(searchedResponse.output[0].results[0].file_id,knowledge.id);
    assert.equal((await client.vectorStores.delete(vectorStore.id)).deleted,true);
    const batchLine={custom_id:'sdk-batch-1',method:'POST',url:'/v1/responses',body:{model:'qwen-instruct',input:'批处理',store:false}};
    const batchInput=await client.files.create({file:new File([JSON.stringify(batchLine)],'requests.jsonl',{type:'application/jsonl'}),purpose:'batch'});
    let batch=await client.batches.create({input_file_id:batchInput.id,endpoint:'/v1/responses',completion_window:'24h'});
    for(let attempt=0;attempt<100&&!['completed','failed','cancelled'].includes(batch.status);attempt++){await new Promise(resolve=>setTimeout(resolve,10));batch=await client.batches.retrieve(batch.id);}
    assert.equal(batch.status,'completed');assert.equal(batch.request_counts.completed,1);
    const batchOutput=JSON.parse((await (await client.files.content(batch.output_file_id)).text()).trim());assert.equal(batchOutput.custom_id,'sdk-batch-1');assert.equal(batchOutput.response.body.output_text,'你好');
    assert.equal((await client.batches.list({limit:1})).data[0].id,batch.id);
    const chat=await client.chat.completions.create({model:'qwen-instruct',messages:[{role:'user',content:'你好'}]});
    assert.equal(chat.choices[0].message.content,'你好');
    const completion=await client.completions.create({model:'qwen-instruct',prompt:'你'});
    assert.equal(completion.choices[0].text,'你好');
    const chatStream=await client.chat.completions.create({model:'qwen-instruct',messages:[{role:'user',content:'你好'}],stream:true,stream_options:{include_usage:true}});
    let chatText='',usage;for await(const chunk of chatStream){chatText+=chunk.choices[0]?.delta?.content || '';usage=chunk.usage || usage;}
    assert.equal(chatText,'你好');assert.equal(usage.total_tokens,3);
    const response=await client.responses.create({model:'qwen-instruct',input:'你好',store:false,max_tool_calls:2,metadata:{task:'sdk'},reasoning:{summary:'concise'},text:{verbosity:'low'},service_tier:'default',safety_identifier:'sdk-user',prompt_cache_key:'sdk-workspace'});
    assert.equal(response.output[0].content[0].text,'你好');assert.equal(response.max_tool_calls,2);assert.deepEqual(response.metadata,{task:'sdk'});assert.equal(response.prompt_cache_key,'sdk-workspace');
    const stored=await client.responses.create({model:'qwen-instruct',input:'默认保存'});assert.equal(stored.store,true);
    assert.equal((await client.responses.retrieve(stored.id)).id,stored.id);
    const conversation=await client.conversations.create({metadata:{project:'sdk'},items:[{type:'message',role:'user',content:'旧问题'}]});
    const continued=await client.responses.create({model:'qwen-instruct',conversation:conversation.id,input:'继续'});
    assert.equal(continued.conversation.id,conversation.id);
    const conversationItems=await client.conversations.items.list(conversation.id,{order:'asc'});assert.equal(conversationItems.data.length,3);
    assert.equal((await client.conversations.delete(conversation.id)).deleted,true);
    const tokenCount=await client.responses.inputTokens.count({model:'qwen-instruct',input:'你好'});assert.equal(tokenCount.object,'response.input_tokens');assert.ok(tokenCount.input_tokens>0);
    const compacted=await client.responses.compact({model:'qwen-instruct',input:'需要压缩的任务'});assert.equal(compacted.object,'response.compaction');assert.equal(compacted.output.at(-1).type,'compaction');
    const responseStream=await client.responses.create({model:'qwen-instruct',input:'你好',store:false,stream:true,stream_options:{include_obfuscation:true}});
    let responseText='',obfuscated=0;for await(const event of responseStream){if(event.type==='response.output_text.delta')responseText+=event.delta;if(event.obfuscation)obfuscated++;}
    assert.ok(obfuscated>0);
    assert.equal(responseText,'你好');
  });
});

test('最新版 Anthropic SDK 调用 Messages 的 JSON/SSE',async()=>{
  await fixture(async base=>{
    const client=new Anthropic({apiKey:'test',baseURL:base,maxRetries:0});
    const {data:message,response,request_id}=await client.messages.create({model:'qwen-instruct',max_tokens:64,messages:[{role:'user',content:'你好'}]}).withResponse();
    assert.equal(message.content[0].text,'你好');
    assert.match(request_id,/^req_[a-f0-9]+$/);assert.equal(message._request_id,request_id);assert.equal(response.headers.get('x-request-id'),request_id);
    const {data:stream,request_id:streamRequestId}=await client.messages.create({model:'qwen-instruct',max_tokens:64,messages:[{role:'user',content:'你好'}],stream:true}).withResponse();
    assert.match(streamRequestId,/^req_[a-f0-9]+$/);
    let text='';for await(const event of stream)if(event.type==='content_block_delta'&&event.delta.type==='text_delta')text+=event.delta.text;
    assert.equal(text,'你好');
    for(const source of [
      {type:'text',media_type:'text/plain',data:'Repository instructions: run focused tests.'},
      {type:'base64',media_type:'application/pdf',data:simplePdf('PDF document from Anthropic SDK').toString('base64')}
    ]){
      const documentMessage=await client.messages.create({model:'qwen-instruct',max_tokens:64,messages:[{role:'user',content:[{type:'document',title:'SDK document',source},{type:'text',text:'Read the document'}]}]});
      assert.equal(documentMessage.content[0].text,'你好');
      const counted=await client.messages.countTokens({model:'qwen-instruct',messages:[{role:'user',content:[{type:'document',title:'SDK document',source}]}]});
      assert.ok(counted.input_tokens>0);
    }
    const unauthorized=new Anthropic({apiKey:'wrong-key',baseURL:base,maxRetries:0});
    await assert.rejects(unauthorized.messages.create({model:'qwen-instruct',max_tokens:64,messages:[{role:'user',content:'你好'}]}),cause=>{
      assert.equal(cause.status,401);assert.match(cause.requestID,/^req_[a-f0-9]+$/);return true;
    });
  });
});

test('OpenAI 与 Anthropic SDK 的 JSON/SSE 工具结果可完整回传',async()=>{
  let calls=0,results=0;
  const prompt='读取 README.md',resultText='README_CONTENT: setup complete';
  const fn={name:'read_file',description:'读取项目文件',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}};
  const server=createServer({key:'test',token:'token',group:'g',timeout:5000},async(_url,options)=>{
    calls++;
    const body=JSON.parse(options.body);
    const returned=/Tool result \([^)]+\):\n/.test(body.chatInfo);
    if(returned){results++;assert.ok(body.chatInfo.includes(resultText));}
    const answer=returned?'文件结果已收到':'<api_tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</api_tool_call>';
    const parts=[answer.slice(0,10),answer.slice(10,40),answer.slice(40)];
    return new Response(parts.map((content,index)=>`data: ${JSON.stringify({id:`chatcmpl_cycle_${calls}`,choices:[{index:0,delta:{content},finish_reason:index===parts.length-1?'stop':null}]})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  },confirmedModels);
  await listenForFetch(server);
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const openai=new OpenAI({apiKey:'test',baseURL:`${base}/v1`,maxRetries:0});
    const anthropic=new Anthropic({apiKey:'test',baseURL:base,maxRetries:0});
    for(const stream of [false,true]){
      const chatRequest={model:'qwen-instruct',messages:[{role:'user',content:prompt}],tools:[{type:'function',function:fn}],tool_choice:'required',max_tokens:256,stream};
      const first=await openai.chat.completions.create(chatRequest);
      let message;
      if(!stream){message=first.choices[0].message;assert.equal(first.choices[0].finish_reason,'tool_calls');}
      else{
        const calls=new Map();let finish;
        for await(const chunk of first){
          const choice=chunk.choices[0];if(!choice)continue;
          finish=choice.finish_reason??finish;
          for(const part of choice.delta.tool_calls||[]){
            const current=calls.get(part.index)||{id:'',type:'function',function:{name:'',arguments:''}};
            current.id+=part.id||'';current.function.name+=part.function?.name||'';current.function.arguments+=part.function?.arguments||'';calls.set(part.index,current);
          }
        }
        assert.equal(finish,'tool_calls');message={role:'assistant',content:null,tool_calls:[...calls.values()]};
      }
      assert.equal(message.tool_calls.length,1);
      const chatCall=message.tool_calls[0];assert.equal(chatCall.function.name,fn.name);assert.deepEqual(JSON.parse(chatCall.function.arguments),{path:'README.md'});
      const chatFollow=await openai.chat.completions.create({...chatRequest,tool_choice:'auto',messages:[...chatRequest.messages,message,{role:'tool',tool_call_id:chatCall.id,content:resultText}]});
      let chatText='';
      if(!stream)chatText=chatFollow.choices[0].message.content;
      else for await(const chunk of chatFollow)chatText+=chunk.choices[0]?.delta?.content||'';
      assert.equal(chatText,'文件结果已收到');

      const responseRequest={model:'qwen-instruct',input:prompt,tools:[{type:'function',...fn}],tool_choice:'required',max_output_tokens:256,store:false,stream};
      const responseFirst=await openai.responses.create(responseRequest);
      let response;
      if(!stream)response=responseFirst;
      else for await(const event of responseFirst){if(event.type==='response.completed')response=event.response;assert.notEqual(event.type,'error');}
      assert.equal(response.status,'completed');
      const responseCall=response.output.find(item=>item.type==='function_call');
      assert.equal(responseCall.name,fn.name);assert.deepEqual(JSON.parse(responseCall.arguments),{path:'README.md'});
      const responseFollow=await openai.responses.create({...responseRequest,tool_choice:'auto',input:[{role:'user',content:prompt},...response.output,{type:'function_call_output',call_id:responseCall.call_id,output:resultText}]});
      let responseText='';
      if(!stream)responseText=responseFollow.output_text;
      else for await(const event of responseFollow)if(event.type==='response.output_text.delta')responseText+=event.delta;
      assert.equal(responseText,'文件结果已收到');

      const messageRequest={model:'qwen-instruct',messages:[{role:'user',content:prompt}],tools:[{name:fn.name,description:fn.description,input_schema:fn.parameters}],tool_choice:{type:'any'},max_tokens:256,stream};
      const messageFirst=await anthropic.messages.create(messageRequest);
      let content,stop;
      if(!stream){content=messageFirst.content;stop=messageFirst.stop_reason;}
      else{
        content=[];let argumentsText='';
        for await(const event of messageFirst){
          if(event.type==='content_block_start'&&event.content_block.type==='tool_use')content.push({...event.content_block});
          if(event.type==='content_block_delta'&&event.delta.type==='input_json_delta')argumentsText+=event.delta.partial_json;
          if(event.type==='message_delta')stop=event.delta.stop_reason??stop;
          assert.notEqual(event.type,'error');
        }
        assert.equal(content.length,1);content[0].input=JSON.parse(argumentsText);
      }
      assert.equal(stop,'tool_use');
      const messageCall=content.find(item=>item.type==='tool_use');assert.equal(messageCall.name,fn.name);assert.deepEqual(messageCall.input,{path:'README.md'});
      const messageFollow=await anthropic.messages.create({...messageRequest,tool_choice:{type:'auto'},messages:[...messageRequest.messages,{role:'assistant',content},{role:'user',content:[{type:'tool_result',tool_use_id:messageCall.id,content:resultText}]}]});
      let messageText='';
      if(!stream)messageText=messageFollow.content.filter(item=>item.type==='text').map(item=>item.text).join('');
      else for await(const event of messageFollow)if(event.type==='content_block_delta'&&event.delta.type==='text_delta')messageText+=event.delta.text;
      assert.equal(messageText,'文件结果已收到');
    }
    assert.equal(calls,12);assert.equal(results,6);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('最新版 Vercel AI SDK/OpenAI Compatible 可执行 OpenCode 风格工具循环与流式文本',async()=>{
  let calls=0;
  const server=createServer({key:'test',token:'token',group:'g',timeout:5000},async(_,options)=>{
    calls++;
    const body=JSON.parse(options.body);
    if([2,5].includes(calls)){
      assert.match(body.chatInfo,/Tool result/);
      assert.match(body.chatInfo,/晴/);
    }
    const answer=[1,4].includes(calls)
      ? '<api_tool_call>{"name":"weather","arguments":{"city":"上海"}}</api_tool_call>'
      : [2,5].includes(calls)?'工具结果已收到':'流式正常';
    return new Response(`data: ${JSON.stringify({id:`chatcmpl_ai_${calls}`,model:'kimi-k3',choices:[{index:0,delta:{content:answer},finish_reason:'stop'}]})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  },async()=>({success:true,result:{records:[{aiType:'Kimi-k3',simpleName:'Kimi-K3',maxToken:800000,rootAiType:'xinference'}]}}));
  await listenForFetch(server);
  try {
    const provider=createOpenAICompatible({name:'shtech',apiKey:'test',baseURL:`http://127.0.0.1:${server.address().port}/v1`,includeUsage:true});
    const model=provider.languageModel('kimi-k3');
    const tools={weather:tool({description:'查询天气',inputSchema:jsonSchema({type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}),execute:async({city})=>({city,weather:'晴'})})};
    const result=await generateText({model,prompt:'上海天气',tools,stopWhen:stepCountIs(2)});
    assert.equal(result.text,'工具结果已收到');assert.equal(calls,2);
    const streamed=streamText({model,prompt:'测试流式'});assert.equal(await streamed.text,'流式正常');assert.equal(calls,3);
    const toolStream=streamText({model,prompt:'流式查询上海天气',tools,stopWhen:stepCountIs(2)});
    const parts=[];for await(const part of toolStream.fullStream)parts.push(part);
    assert.equal(await toolStream.text,'工具结果已收到');assert.equal(calls,5);
    assert.equal(parts.filter(part=>part.type==='tool-call').length,1);
    assert.equal(parts.find(part=>part.type==='tool-call').toolName,'weather');
    assert.equal(parts.filter(part=>part.type==='tool-result').length,1);
    assert.equal(parts.filter(part=>part.type==='finish-step').length,2);
    assert.equal(parts.some(part=>part.type==='error'),false);
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});

test('OpenCode 生成配置可通过 AI SDK 访问所有列出的校内部署模型',async()=>{
  const routed=[];
  const records=[
    {aiType:'Kimi-k3',aiName:'Kimi-K3',rootAiType:'xinference',status:3,maxToken:1048576},
    {aiType:'chatglm',aiName:'GLM-5.3-Flash',rootAiType:'xinference',status:3,maxToken:524288},
    {aiType:'qwen-instruct',aiName:'Qwen-3.8',rootAiType:'xinference',status:3,maxToken:524288},
    {aiType:'deepseek-pro',aiName:'DeepSeek-V4.1-Flash',rootAiType:'xinference',status:3,maxToken:524288},
    {aiType:'vendor/code_v2',aiName:'Code Small',rootAiType:'xinference',status:3,maxToken:8192},
    {aiType:'code-unknown',rootAiType:'xinference',status:3},
    {aiType:'gpt-6',aiName:'GPT-6',rootAiType:'azure',status:3,maxToken:1048576}
  ];
  const server=createServer({key:'test',token:'token',group:'g',timeout:5000},async(_,options)=>{
    const body=JSON.parse(options.body);
    routed.push({model:body.aiType,root:body.rootAiType});
    return new Response(`data: ${JSON.stringify({id:'chatcmpl_multi',choices:[{index:0,delta:{content:'正常'},finish_reason:'stop'}]})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  },async()=>({success:true,result:{records}}));
  await listenForFetch(server);
  try{
    const baseURL=`http://127.0.0.1:${server.address().port}/v1`;
    const response=await fetch(`${baseURL}/models`,{headers:{authorization:'Bearer test'}});
    assert.equal(response.status,200);
    const config=opencodeConfig((await response.json()).data,baseURL,'test');
    assert.equal(config.model,'shtech/kimi-k3');
    assert.equal(Object.hasOwn(config.provider.shtech.models,'gpt-6'),false);
    const provider=createOpenAICompatible({name:'shtech',...config.provider.shtech.options});
    for(const [id,upstream] of [['kimi-k3','Kimi-k3'],['chatglm','chatglm'],['qwen-instruct','qwen-instruct'],['deepseek-pro','deepseek-pro'],['vendor/code_v2','vendor/code_v2'],['code-unknown','code-unknown']]){
      assert.ok(config.provider.shtech.models[id],id);
      const result=await generateText({model:provider.languageModel(id),prompt:'检查连接',maxOutputTokens:config.provider.shtech.models[id].limit.output});
      assert.equal(result.text,'正常');
      assert.deepEqual(routed.at(-1),{model:upstream,root:'xinference'});
    }
    assert.equal(routed.length,6);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
