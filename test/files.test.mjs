import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { FileStore, expandInputFiles, prepareInputFiles, parseMultipart, readRawBody, uploadedFile } from '../src/files.mjs';

test('Anthropic document 展开文本与嵌套工具附件并保留标题和上下文',async()=>{
  const store=new FileStore(4,3600000,1024);
  const file=store.create({filename:'result.txt',mime:'text/plain',bytes:Buffer.from('test failed at main.py:42')});
  const input={messages:[{role:'user',content:[
    {type:'document',title:'Repo instructions',context:'Read before editing',source:{type:'text',media_type:'text/plain',data:'Run focused tests'},citations:{enabled:false}},
    {type:'tool_result',tool_use_id:'call_read',is_error:true,content:[{type:'document',source:{type:'file',file_id:file.id}}]}
  ]}]};
  const prepared=await prepareInputFiles('/v1/messages',input,store);
  assert.equal(prepared.input.messages[0].content[0].type,'text');
  assert.match(prepared.input.messages[0].content[0].text,/Repo instructions[\s\S]*Read before editing[\s\S]*Run focused tests/);
  assert.match(prepared.input.messages[0].content[1].content[0].text,/test failed at main\.py:42/);
  assert.equal(prepared.input.messages[0].content[1].is_error,true);
  assert.equal(input.messages[0].content[0].type,'document');
});

test('Anthropic document 共享文件总量限制并拒绝无法提供的引用功能',async()=>{
  const store=new FileStore(1,3600000,1024);
  const request=block=>({messages:[{role:'user',content:[block]}]});
  const document={type:'document',source:{type:'text',media_type:'text/plain',data:'x'.repeat(1024)}};
  await assert.rejects(prepareInputFiles('/v1/messages',request(document),store),cause=>cause.status===413);
  await assert.rejects(prepareInputFiles('/v1/messages',request({...document,source:{...document.source,data:'text'},citations:{enabled:true}}),store),/citations/);
  await assert.rejects(prepareInputFiles('/v1/messages',request({type:'document',source:{type:'url',url:'https://example.com/a.pdf'}}),store),/document.source/);
  await assert.rejects(prepareInputFiles('/v1/messages',request({type:'document',source:{type:'base64',media_type:'application/pdf',data:'not-base64!'}}),store),/Base64/);
});

test('请求体按声明长度提前拒绝，并将客户端中断与上游错误区分',async()=>{
  let read=false;
  const tooLarge=Readable.from((async function*(){read=true;yield Buffer.from('body');})());
  tooLarge.headers={'content-length':'11'};
  await assert.rejects(readRawBody(tooLarge,10),cause=>cause.status===413&&cause.param==='body');
  assert.equal(read,false);

  const interrupted=Readable.from((async function*(){yield Buffer.from('partial');throw new Error('aborted');})());
  interrupted.headers={};interrupted.complete=false;interrupted.aborted=true;
  await assert.rejects(readRawBody(interrupted,10),cause=>cause.status===499);
});

test('Files 存储支持创建、分页、读取和删除',()=>{
  const store=new FileStore(2,3600000,1024);
  const first=store.create({filename:'src/a.ts',mime:'text/typescript',bytes:Buffer.from('export const a = 1'),purpose:'user_data'});
  const second=store.create({filename:'b.md',mime:'text/markdown',bytes:Buffer.from('# B'),purpose:'assistants'});
  assert.equal(first.filename,'a.ts');assert.equal(store.get(first.id,true).bytes.toString(),'export const a = 1');
  assert.deepEqual(store.list({purpose:'assistants'}).data.map(file=>file.id),[second.id]);
  assert.equal(store.list({order:'asc',limit:1}).has_more,true);
  store.delete(first.id);assert.throws(()=>store.get(first.id),/不存在/);
});

test('Files 与内联文件严格小于配置的大小上限',async()=>{
  const store=new FileStore(4,3600000,10);
  assert.equal(store.create({filename:'nine.txt',mime:'text/plain',bytes:Buffer.alloc(9)}).bytes,9);
  assert.throws(()=>store.create({filename:'ten.txt',mime:'text/plain',bytes:Buffer.alloc(10)}),/必须小于/);
  const inline=`data:text/plain;base64,${Buffer.alloc(10).toString('base64')}`;
  await assert.rejects(()=>expandInputFiles('/v1/responses',{input:[{role:'user',content:[{type:'input_file',filename:'ten.txt',file_data:inline}]}]},store),/必须小于/);
});

test('multipart 文件上传解析 OpenAI SDK 使用的字段',()=>{
  const boundary='test-boundary';
  const body=Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="expires_after[anchor]"\r\n\r\ncreated_at\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="expires_after[seconds]"\r\n\r\n3600\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="main.ts"\r\nContent-Type: text/typescript\r\n\r\nconst x=1;\r\n`,
    `--${boundary}--\r\n`
  ].join(''));
  const file=uploadedFile(parseMultipart(body,`multipart/form-data; boundary=${boundary}`));
  assert.equal(file.filename,'main.ts');assert.equal(file.purpose,'user_data');assert.equal(file.expiresAfter,3600000);assert.equal(file.bytes.toString(),'const x=1;');
});

test('Responses input_file 与工具文件结果转换为带文件名的文本上下文',async()=>{
  const store=new FileStore(4,3600000,1024),file=store.create({filename:'main.ts',mime:'text/typescript',bytes:Buffer.from('const answer = 42;')});
  const image=store.create({filename:'pixel.png',mime:'image/png',bytes:Buffer.from('iVBORw0KGgo=','base64'),purpose:'vision'});
  const inline=`data:text/plain;base64,${Buffer.from('build failed').toString('base64')}`;
  const value=await expandInputFiles('/v1/responses',{input:[
    {role:'user',content:[{type:'input_text',text:'审查代码'},{type:'input_file',file_id:file.id}]},
    {type:'function_call_output',call_id:'call_1',output:[{type:'input_file',filename:'build.log',file_data:inline}]},
    {role:'user',content:[{type:'input_image',file_id:image.id}]}
  ]},store);
  assert.match(value.input[0].content[1].text,/main\.ts[\s\S]*answer = 42/);
  assert.match(value.input[1].output[0].text,/build\.log[\s\S]*build failed/);
  assert.match(value.input[2].content[0].image_url,/^data:image\/png;base64,/);
});

test('Responses Agent 工具结果可引用本地图片文件',async()=>{
  const store=new FileStore(4,3600000,1024);
  const image=store.create({filename:'chart.png',mime:'image/png',bytes:Buffer.from('iVBORw0KGgo=','base64'),purpose:'vision'});
  const value=await expandInputFiles('/v1/responses',{input:[
    {type:'program_output',call_id:'call_program',result:[{type:'input_image',file_id:image.id}]},
    {type:'apply_patch_call_output',call_id:'call_patch',output:[{type:'input_image',file_id:image.id}]}
  ]},store);
  assert.match(value.input[0].result[0].image_url,/^data:image\/png;base64,/);
  assert.match(value.input[1].output[0].image_url,/^data:image\/png;base64,/);
});

test('单请求多个输入文件合计必须严格小于网页上限',async()=>{
  const store=new FileStore(4,3600000,10),first=store.create({filename:'a.txt',mime:'text/plain',bytes:Buffer.from('123456')}),second=store.create({filename:'b.txt',mime:'text/plain',bytes:Buffer.from('abcd')});
  await assert.rejects(()=>expandInputFiles('/v1/responses',{input:[{role:'user',content:[{type:'input_file',file_id:first.id},{type:'input_file',file_id:second.id}]}]},store),/总大小/);
});

test('原生模式保留文件字节供学校上传，并仅将文件名放入聊天内容',async()=>{
  const store=new FileStore(4,3600000,1024),file=store.create({filename:'report.pdf',mime:'application/pdf',bytes:Buffer.from('raw-document')});
  const prepared=await prepareInputFiles('/v1/responses',{input:[{role:'user',content:[{type:'input_text',text:'总结附件'},{type:'input_file',file_id:file.id}]}]},store,{native:true});
  assert.deepEqual(prepared.files.map(item=>[item.filename,item.bytes.toString()]),[['report.pdf','raw-document']]);
  assert.equal(prepared.input.input[0].content[1].text,'[Attached file: report.pdf]');
});
