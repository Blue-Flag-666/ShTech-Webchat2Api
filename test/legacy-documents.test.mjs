import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { extractFileText } from '../src/files.mjs';

const rtf=`{\\rtf1\\ansi Hello \\b world\\b0\\par Unicode \\u20320?\\u22909?\\par {\\fonttbl{\\f0 Hidden Font;}}{\\pict 89504e47}Quoted \\'93text\\'94}`;

test('RTF 提取可见文本和 Unicode，忽略字体与图片组',async()=>{
  const parsed=await extractFileText({filename:'report.rtf',mime:'application/rtf',bytes:Buffer.from(rtf,'ascii')});
  assert.match(parsed.text,/Hello world/);assert.match(parsed.text,/Unicode 你好/);assert.match(parsed.text,/“text”/);
  assert.doesNotMatch(parsed.text,/Hidden Font|89504e47|\?\?/);
});

test('DOC 仅接受纯文本或 RTF，明确拒绝二进制 Word 文档',async()=>{
  const plain=await extractFileText({filename:'legacy.doc',mime:'application/msword',bytes:Buffer.from('Plain UTF-8 上海')});
  assert.match(plain.text,/上海/);
  const wrapped=await extractFileText({filename:'wrapped.doc',mime:'application/msword',bytes:Buffer.from(rtf,'ascii')});
  assert.match(wrapped.text,/Unicode 你好/);
  const ole=Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,0,0,0,0]);
  await assert.rejects(()=>extractFileText({filename:'binary.doc',mime:'application/msword',bytes:ole}),/二进制 DOC 暂不支持/);
});

test('仓库归档中的 RTF 和纯文本 DOC 可进入上下文',async()=>{
  const bytes=Buffer.from(zipSync({'repo/notes.rtf':strToU8(rtf),'repo/legacy.doc':strToU8('Project notes')}));
  const parsed=await extractFileText({filename:'repo.zip',mime:'application/zip',bytes});
  assert.match(parsed.text,/notes\.rtf[\s\S]*Unicode 你好/);
  assert.match(parsed.text,/legacy\.doc[\s\S]*Project notes/);
});
