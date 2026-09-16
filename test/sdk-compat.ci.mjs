import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { createServer } from '../src/server.mjs';
import { listenForFetch, confirmedModels } from './fixtures.mjs';

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
    const response=await client.responses.create({model:'qwen-instruct',input:'你好',store:false});
    assert.equal(response.output[0].content[0].text,'你好');
    const stored=await client.responses.create({model:'qwen-instruct',input:'默认保存'});assert.equal(stored.store,true);
    assert.equal((await client.responses.retrieve(stored.id)).id,stored.id);
    const conversation=await client.conversations.create({metadata:{project:'sdk'},items:[{type:'message',role:'user',content:'旧问题'}]});
    const continued=await client.responses.create({model:'qwen-instruct',conversation:conversation.id,input:'继续'});
    assert.equal(continued.conversation.id,conversation.id);
    const conversationItems=await client.conversations.items.list(conversation.id,{order:'asc'});assert.equal(conversationItems.data.length,3);
    assert.equal((await client.conversations.delete(conversation.id)).deleted,true);
    const tokenCount=await client.responses.inputTokens.count({model:'qwen-instruct',input:'你好'});assert.equal(tokenCount.object,'response.input_tokens');assert.ok(tokenCount.input_tokens>0);
    const compacted=await client.responses.compact({model:'qwen-instruct',input:'需要压缩的任务'});assert.equal(compacted.object,'response.compaction');assert.equal(compacted.output.at(-1).type,'compaction');
    const responseStream=await client.responses.create({model:'qwen-instruct',input:'你好',store:false,stream:true});
    let responseText='';for await(const event of responseStream)if(event.type==='response.output_text.delta')responseText+=event.delta;
    assert.equal(responseText,'你好');
  });
});

test('最新版 Anthropic SDK 调用 Messages 的 JSON/SSE',async()=>{
  await fixture(async base=>{
    const client=new Anthropic({apiKey:'test',baseURL:base,maxRetries:0});
    const message=await client.messages.create({model:'qwen-instruct',max_tokens:64,messages:[{role:'user',content:'你好'}]});
    assert.equal(message.content[0].text,'你好');
    const stream=await client.messages.create({model:'qwen-instruct',max_tokens:64,messages:[{role:'user',content:'你好'}],stream:true});
    let text='';for await(const event of stream)if(event.type==='content_block_delta'&&event.delta.type==='text_delta')text+=event.delta.text;
    assert.equal(text,'你好');
  });
});

test('最新版 Vercel AI SDK/OpenAI Compatible 可执行 OpenCode 风格工具循环与流式文本',async()=>{
  let calls=0;
  const server=createServer({key:'test',token:'token',group:'g',timeout:5000},async(_,options)=>{
    calls++;
    const body=JSON.parse(options.body);
    const answer=calls===1
      ? '<api_tool_call>{"name":"weather","arguments":{"city":"上海"}}</api_tool_call>'
      : calls===2?'工具结果已收到':'流式正常';
    return new Response(`data: ${JSON.stringify({id:`chatcmpl_ai_${calls}`,model:'kimi-k3',choices:[{index:0,delta:{content:answer},finish_reason:'stop'}]})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  },async()=>({success:true,result:{records:[{aiType:'Kimi-k3',simpleName:'Kimi-K3',maxToken:800000,rootAiType:'xinference'}]}}));
  await listenForFetch(server);
  try {
    const provider=createOpenAICompatible({name:'shtech',apiKey:'test',baseURL:`http://127.0.0.1:${server.address().port}/v1`,includeUsage:true});
    const model=provider.languageModel('kimi-k3');
    const result=await generateText({model,prompt:'上海天气',tools:{weather:tool({description:'查询天气',inputSchema:jsonSchema({type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}),execute:async({city})=>({city,weather:'晴'})})},stopWhen:stepCountIs(2)});
    assert.equal(result.text,'工具结果已收到');assert.equal(calls,2);
    const streamed=streamText({model,prompt:'测试流式'});assert.equal(await streamed.text,'流式正常');assert.equal(calls,3);
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});
