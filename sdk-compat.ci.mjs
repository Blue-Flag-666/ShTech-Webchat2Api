import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { createServer } from './server.mjs';
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

test('最新版 OpenAI SDK 调用 models、Chat 和 Responses 的 JSON/SSE',async()=>{
  await fixture(async base=>{
    const client=new OpenAI({apiKey:'test',baseURL:`${base}/v1`,maxRetries:0});
    const models=await client.models.list();assert.equal(models.data[0].id,'qwen-instruct');
    const chat=await client.chat.completions.create({model:'qwen-instruct',messages:[{role:'user',content:'你好'}]});
    assert.equal(chat.choices[0].message.content,'你好');
    const chatStream=await client.chat.completions.create({model:'qwen-instruct',messages:[{role:'user',content:'你好'}],stream:true});
    let chatText='';for await(const chunk of chatStream)chatText+=chunk.choices[0]?.delta?.content || '';
    assert.equal(chatText,'你好');
    const response=await client.responses.create({model:'qwen-instruct',input:'你好',store:false});
    assert.equal(response.output[0].content[0].text,'你好');
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
