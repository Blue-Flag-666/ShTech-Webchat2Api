import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileStore, expandInputFiles, parseMultipart, uploadedFile } from '../src/files.mjs';

test('Files 存储支持创建、分页、读取和删除',()=>{
  const store=new FileStore(2,3600000,1024);
  const first=store.create({filename:'src/a.ts',mime:'text/typescript',bytes:Buffer.from('export const a = 1'),purpose:'user_data'});
  const second=store.create({filename:'b.md',mime:'text/markdown',bytes:Buffer.from('# B'),purpose:'assistants'});
  assert.equal(first.filename,'a.ts');assert.equal(store.get(first.id,true).bytes.toString(),'export const a = 1');
  assert.deepEqual(store.list({purpose:'assistants'}).data.map(file=>file.id),[second.id]);
  assert.equal(store.list({order:'asc',limit:1}).has_more,true);
  store.delete(first.id);assert.throws(()=>store.get(first.id),/不存在/);
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
  await assert.rejects(()=>expandInputFiles('/v1/responses',{input:[{role:'user',content:[{type:'input_file',filename:'a.docx',file_data:'data:application\/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBA=='}]}]},store),/不支持读取/);
});
