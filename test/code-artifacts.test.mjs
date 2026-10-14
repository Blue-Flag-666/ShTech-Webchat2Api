import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { extractFileText } from '../src/files.mjs';
import { extractDiffText, extractLogText } from '../src/code-artifacts.mjs';

test('长补丁与日志裁剪保持中文和 emoji 完整，并保留末尾错误',()=>{
  const patch=`diff --git a/src/main.ts b/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n+${'汉😀'.repeat(150000)}\n+末尾修改\n`;
  const diff=extractDiffText(patch);
  assert.match(diff,/patch middle omitted/);assert.match(diff,/末尾修改/);
  assert.doesNotMatch(diff,/\uFFFD/);assert.ok(Buffer.byteLength(diff)<896*1024);
  const log=`开始测试\n${'日志😀'.repeat(90000)}\nERROR: 测试失败\n`;
  const result=extractLogText(log);
  assert.match(result,/log middle omitted/);assert.match(result,/ERROR: 测试失败/);
  assert.doesNotMatch(result,/\uFFFD/);assert.ok(Buffer.byteLength(result)<512*1024);
});

test('补丁提取列出文件与增删概况，同时保留原始 hunk',async()=>{
  const patch='diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const result=await extractFileText({filename:'fix.patch',mime:'text/plain',bytes:Buffer.from(patch)});
  assert.match(result.text,/Patch summary: 1 files, 1 hunks, \+1\/-1 lines/);
  assert.match(result.text,/src\/main\.ts/);assert.match(result.text,/-old\n\+new/);
});

test('长测试日志突出中间错误并保留末尾结果',async()=>{
  const log='prelude\n'+'noise\n'.repeat(70000)+'AssertionError: expected 1, got 2\n'+'noise\n'.repeat(70000)+'tests failed\n';
  const result=await extractFileText({filename:'test.log',mime:'text/plain',bytes:Buffer.from(log)});
  assert.match(result.text,/AssertionError: expected 1, got 2/);
  assert.match(result.text,/tests failed/);assert.match(result.text,/log middle omitted/);
  assert.ok(Buffer.byteLength(result.text)<512*1024);
});

test('仓库归档中的长日志使用专用提取而非整段注入',async()=>{
  const log='noise\n'.repeat(100000)+'FAILED: integration suite\n';
  const bytes=Buffer.from(zipSync({'repo/test-results/run.log':strToU8(log)}));
  const result=await extractFileText({filename:'repo.zip',mime:'application/zip',bytes});
  assert.match(result.text,/FAILED: integration suite/);
  assert.match(result.text,/Test log:/);
  assert.ok(Buffer.byteLength(result.text)<1024*1024);
});

test('接近 1 MiB 的仓库补丁仍保留摘要和片段',async()=>{
  const patch=`diff --git a/src/large.ts b/src/large.ts\n+++ b/src/large.ts\n@@ -1 +1 @@\n+${'x'.repeat(960*1024)}\n`;
  const bytes=Buffer.from(zipSync({'repo/changes.patch':strToU8(patch)}));
  const result=await extractFileText({filename:'repo.zip',mime:'application/zip',bytes});
  assert.match(result.text,/included text: 1; omitted: 0/);
  assert.match(result.text,/Patch summary: 1 files, 1 hunks/);
  assert.match(result.text,/patch middle omitted/);
});
