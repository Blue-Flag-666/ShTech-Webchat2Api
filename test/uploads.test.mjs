import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FileStore } from '../src/files.mjs';
import { UploadStore } from '../src/uploads.mjs';

test('Uploads 按指定顺序组合分片并生成 File',()=>{
  const files=new FileStore(4,3600000,1024),uploads=new UploadStore(files,4,3600000);
  const upload=uploads.create({bytes:11,filename:'hello.txt',mime_type:'text/plain',purpose:'user_data'});
  const second=uploads.addPart(upload.id,Buffer.from('world'));
  const first=uploads.addPart(upload.id,Buffer.from('hello '));
  const expected=Buffer.from('hello world'),completed=uploads.complete(upload.id,{part_ids:[first.id,second.id],md5:createHash('md5').update(expected).digest('base64')});
  assert.equal(completed.status,'completed');assert.equal(files.get(completed.file.id,true).bytes.toString(),'hello world');
  assert.throws(()=>uploads.addPart(upload.id,Buffer.from('!')),/pending/);
});

test('Uploads 拒绝大小、校验和和状态不一致',()=>{
  const files=new FileStore(4,3600000,16),uploads=new UploadStore(files,4,3600000);
  assert.equal(uploads.create({bytes:15,filename:'ok',mime_type:'text/plain',purpose:'user_data'}).bytes,15);
  assert.throws(()=>uploads.create({bytes:16,filename:'x',mime_type:'text/plain',purpose:'user_data'}),/必须小于/);
  const incomplete=uploads.create({bytes:2,filename:'x',mime_type:'text/plain',purpose:'user_data'}),part=uploads.addPart(incomplete.id,Buffer.from('x'));
  assert.throws(()=>uploads.complete(incomplete.id,{part_ids:[part.id]}),/实际大小/);
  const cancelled=uploads.create({bytes:1,filename:'x',mime_type:'text/plain',purpose:'user_data'});assert.equal(uploads.cancel(cancelled.id).status,'cancelled');assert.throws(()=>uploads.cancel(cancelled.id),/pending/);
});
