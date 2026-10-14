import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { extractFileText } from '../src/files.mjs';

function tarEntry(name,content,kind=48){
  const bytes=Buffer.from(content),header=Buffer.alloc(512);
  header.write(name,0,100,'utf8');
  header.write('0000644\0',100,'ascii');header.write('0000000\0',108,'ascii');header.write('0000000\0',116,'ascii');
  header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124,'ascii');
  header.write('00000000000\0',136,'ascii');header.fill(32,148,156);header[156]=kind;
  header.write('ustar\0',257,'ascii');header.write('00',263,'ascii');
  let checksum=0;for(const byte of header)checksum+=byte;
  header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');
  return Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512)]);
}
function tar(name,content){return Buffer.concat([tarEntry(name,content),Buffer.alloc(1024)]);}
function paxRecord(key,value){
  const payload=`${key}=${value}\n`;let length=Buffer.byteLength(payload)+2;
  while(true){const next=Buffer.byteLength(`${length} ${payload}`);if(next===length)break;length=next;}
  return Buffer.from(`${length} ${payload}`);
}

test('仓库 ZIP 提供目录树和代码，忽略依赖、Git 元数据与二进制文件',async()=>{
  const bytes=Buffer.from(zipSync({
    'repo/README.md':strToU8('# Sample repository'),
    'repo/src/main.ts':strToU8('export const answer = 42;'),
    'repo/.git/config':strToU8('secret metadata'),
    'repo/.env':strToU8('PRIVATE_TOKEN=do-not-send'),
    'repo/.env.example':strToU8('PRIVATE_TOKEN=replace-me'),
    'repo/.npmrc':strToU8('npm_secret=do-not-send'),
    'repo/certs/private.pem':strToU8('private key do-not-send'),
    'repo/node_modules/dependency.js':strToU8('ignored dependency'),
    'repo/assets/logo.png':new Uint8Array([0,1,2,3])
  }));
  const result=await extractFileText({filename:'repo.zip',mime:'application/zip',bytes});
  assert.match(result.text,/Directory tree:[\s\S]*README\.md[\s\S]*src\/main\.ts/);
  assert.match(result.text,/File overview:[\s\S]*# Sample repository[\s\S]*answer/);
  assert.match(result.text,/Sample repository/);assert.match(result.text,/answer = 42/);
  assert.match(result.text,/logo\.png \(4 bytes\): binary or packaged asset/);
  assert.match(result.text,/PRIVATE_TOKEN=replace-me/);
  assert.doesNotMatch(result.text,/secret metadata|ignored dependency|do-not-send|private\.pem|\.npmrc/);
});

test('超大源码只提供文件概况，不将整段内容塞进上下文',async()=>{
  const source=`export function processHuge() {}\n${'x'.repeat(300*1024)}TAIL_MARKER`;
  const bytes=Buffer.from(zipSync({'repo/src/large.ts':strToU8(source)}));
  const result=await extractFileText({filename:'repo.zip',mime:'application/zip',bytes});
  assert.match(result.text,/File overview:[\s\S]*large\.ts[\s\S]*processHuge/);
  assert.doesNotMatch(result.text,/TAIL_MARKER/);
  assert.match(result.text,/included text: 0; omitted: 1/);
});

test('LaTeX 项目概况展示章节与引用文件关系',async()=>{
  const bytes=Buffer.from(zipSync({
    'paper/main.tex':strToU8('\\documentclass{article}\n\\input{sections/method}\n\\bibliography{refs}'),
    'paper/sections/method.tex':strToU8('\\section{Method}\nWe describe the method.'),
    'paper/refs.bib':strToU8('@article{example,title={Example}}')
  }));
  const result=await extractFileText({filename:'paper.zip',mime:'application/zip',bytes});
  assert.match(result.text,/main\.tex[^\n]*includes: sections\/method/);
  assert.match(result.text,/method\.tex[^\n]*section: Method/);
  assert.match(result.text,/refs\.bib/);
});

test('TAR 和 tar.gz 都能提取仓库文本',async()=>{
  const bytes=tar('project/AGENTS.md','Use the project conventions.');
  for(const [filename,content] of [['project.tar',bytes],['project.tar.gz',gzipSync(bytes)]]){
    const result=await extractFileText({filename,mime:'application/octet-stream',bytes:content});
    assert.match(result.text,/AGENTS\.md[\s\S]*project conventions/);
  }
});

test('TAR PAX 长路径保留真实文件名并忽略路径穿越记录',async()=>{
  const longPath=`project/src/${'nested/'.repeat(15)}feature.ts`;
  const bytes=Buffer.concat([
    tarEntry('PaxHeaders.0/feature',paxRecord('path',longPath),120),
    tarEntry('project/truncated.ts','export const paxPath = true;'),
    tarEntry('PaxHeaders.0/unsafe',paxRecord('path','../outside.ts'),120),
    tarEntry('project/placeholder.ts','secret outside content'),
    Buffer.alloc(1024)
  ]);
  const result=await extractFileText({filename:'project.tar',mime:'application/x-tar',bytes});
  assert.match(result.text,/src\/nested\/nested\/.*feature\.ts/);
  assert.match(result.text,/paxPath = true/);
  assert.doesNotMatch(result.text,/truncated\.ts|placeholder\.ts|secret outside content/);
});

test('归档输入拒绝路径穿越和过大的解压内容',async()=>{
  const traversal=Buffer.from(zipSync({'../outside.txt':strToU8('outside'),'safe.txt':strToU8('safe')}));
  const parsed=await extractFileText({filename:'repo.zip',mime:'application/zip',bytes:traversal});
  assert.doesNotMatch(parsed.text,/outside/);assert.match(parsed.text,/safe/);
  const bomb=Buffer.from(zipSync({'huge.txt':new Uint8Array(33*1024*1024)}));
  await assert.rejects(()=>extractFileText({filename:'huge.zip',mime:'application/zip',bytes:bomb}),/32 MiB/);
});
