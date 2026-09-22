import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputPolicy, outputPrompt, parseStructured } from '../src/structured.mjs';
import { createServer, events } from '../src/server.mjs';
import { listenForFetch, confirmedModels } from './fixtures.mjs';

const schema={type:'object',properties:{name:{type:'string',minLength:1},count:{type:'integer',minimum:1},tags:{type:'array',items:{type:'string'}}},required:['name','count'],additionalProperties:false};
test('三个协议识别各自 JSON Schema 位置',()=>{
  const policies=[
    outputPolicy('/v1/chat/completions',{response_format:{type:'json_schema',json_schema:{name:'result',schema}}}),
    outputPolicy('/v1/responses',{text:{format:{type:'json_schema',name:'result',schema}}}),
    outputPolicy('/v1/messages',{output_config:{format:{type:'json_schema',schema}}})
  ];
  assert.ok(policies.every(x=>x.schema===schema));assert.match(outputPrompt(policies[0]),/no Markdown/);
});
test('结构化结果解析、规范化并验证常用约束',()=>{
  const policy={type:'json_schema',schema};
  assert.equal(parseStructured(' { "name": "测试", "count": 2, "tags": ["a"] } ',policy),'{"name":"测试","count":2,"tags":["a"]}');
  assert.equal(parseStructured('结果如下：\n```json\n{"name":"测试","count":2}\n```',policy),'{"name":"测试","count":2}');
  for(const value of ['not json','[]','{"name":"","count":2}','{"name":"x","count":0}','{"name":"x","count":1,"extra":true}'])assert.throws(()=>parseStructured(value,policy));
});
test('结构化结果有限修复 BOM、尾随逗号并提取第一个完整值',()=>{
  const policy={type:'json_schema',schema};
  assert.equal(parseStructured('\uFEFF{"name":"测试","count":2,"tags":["a",],}',policy),'{"name":"测试","count":2,"tags":["a"]}');
  assert.equal(parseStructured('说明 {"name":"测试","count":2} 后续还有 {"ignored":true}',policy),'{"name":"测试","count":2}');
  assert.throws(()=>parseStructured('{"name":"测试","count":2,,}',policy));
});
test('拒绝未知关键字、外部引用和错误格式定义',()=>{
  assert.throws(()=>outputPolicy('/v1/responses',{text:{format:{type:'json_schema',name:'x',schema:{type:'object',unevaluatedProperties:false}}}}),/关键字/);
  assert.throws(()=>outputPolicy('/v1/responses',{text:{format:{type:'json_schema',name:'x',schema:{$ref:'https://example.com/schema'}}}}),/本地/);
  assert.throws(()=>outputPolicy('/v1/chat/completions',{response_format:{type:'json_schema',json_schema:{name:'bad name',schema}}}),/name/);
});
test('验证常用 JSON Schema format',()=>{
  const policy={type:'json_schema',schema:{type:'object',properties:{id:{type:'string',format:'uuid'},ip:{type:'string',format:'ipv4'}},required:['id','ip']}};
  assert.doesNotThrow(()=>parseStructured('{"id":"123e4567-e89b-12d3-a456-426614174000","ip":"127.0.0.1"}',policy));
  assert.throws(()=>parseStructured('{"id":"bad","ip":"999.0.0.1"}',policy),/格式/);
});

test('Kimi json_schema strict=false 仅保证 JSON 对象',()=>{
  const loose=outputPolicy('/v1/chat/completions',{response_format:{type:'json_schema',json_schema:{name:'weather',strict:false,schema:{type:'object',properties:{city:{type:'string'}},required:['city']}}}});
  assert.equal(loose.type,'json_object');assert.equal(loose.strict,false);
  assert.equal(parseStructured('{"unexpected":1}',loose),'{"unexpected":1}');
  assert.throws(()=>parseStructured('[]',loose),/JSON 对象/);
  assert.throws(()=>outputPolicy('/v1/chat/completions',{response_format:{type:'json_schema',json_schema:{name:'x',strict:'yes',schema:{type:'object'}}}}),/布尔值/);
});

test('三个 HTTP 协议在返回成功前验证 JSON，流式只发送已验证结果',async()=>{
  const paths=[
    ['/v1/chat/completions',{messages:[{role:'user',content:'提取'}],response_format:{type:'json_schema',json_schema:{name:'result',schema}}}],
    ['/v1/responses',{input:'提取',text:{format:{type:'json_schema',name:'result',schema}}}],
    ['/v1/messages',{messages:[{role:'user',content:'提取'}],max_tokens:64,output_config:{format:{type:'json_schema',schema}}}]
  ];
  let answer=' { "name": "测试", "count": 2 } ';
  const server=createServer({key:'test',token:'token',group:'g',timeout:2000},async(_,options)=>{
    assert.match(JSON.parse(options.body).chatInfo,/JSON Schema/);
    return new Response(`data: ${JSON.stringify({choices:[{index:0,delta:{content:answer},finish_reason:'stop'}]})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  },confirmedModels);
  await listenForFetch(server);
  try {
    for(const [path,body] of paths)for(const stream of [false,true]) {
      const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({...body,stream})});
      assert.equal(response.status,200);
      const wire=await response.text();assert.match(wire,/\\"name\\":\\"测试\\"/);assert.doesNotMatch(wire,/\\n  /);
      if(stream)assert.ok((await Array.fromAsync(events(new Response(wire).body))).length>1);
    }
    answer='{"name":"测试","count":0}';
    for(const [path,body] of paths) {
      const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,502);
    }
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
