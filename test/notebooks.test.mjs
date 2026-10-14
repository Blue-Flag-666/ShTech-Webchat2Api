import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { extractFileText } from '../src/files.mjs';

const notebook={nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:'python3'}},cells:[
  {cell_type:'markdown',source:['# Analysis\n','Describe the result.'],metadata:{}},
  {cell_type:'code',source:['answer = 42\n','print(answer)'],metadata:{},execution_count:1,outputs:[
    {output_type:'stream',name:'stdout',text:['42\n']},
    {output_type:'display_data',data:{'image/png':'BASE64_IMAGE_PAYLOAD','text/plain':['<Figure size 640x480>']},metadata:{}},
    {output_type:'error',ename:'ValueError',evalue:'bad value',traceback:['\u001b[31mValueError: bad value\u001b[0m']}
  ]}
]};

test('Notebook 仅提取 Markdown、代码和文本输出，不注入图片编码与 ANSI 控制符',async()=>{
  const bytes=Buffer.from(JSON.stringify(notebook));
  const parsed=await extractFileText({filename:'analysis.ipynb',mime:'application/json',bytes});
  assert.equal(parsed.mime,'application/x-ipynb+json');
  assert.match(parsed.text,/Markdown cell 1[\s\S]*# Analysis/);
  assert.match(parsed.text,/Code cell 2[\s\S]*answer = 42[\s\S]*42[\s\S]*ValueError: bad value/);
  assert.doesNotMatch(parsed.text,/BASE64_IMAGE_PAYLOAD|\u001b|kernelspec/);
});

test('仓库 ZIP 中的 Notebook 也按单元格提取',async()=>{
  const bytes=Buffer.from(zipSync({'repo/notebooks/analysis.ipynb':strToU8(JSON.stringify(notebook))}));
  const parsed=await extractFileText({filename:'repo.zip',mime:'application/zip',bytes});
  assert.match(parsed.text,/Code cell 2[\s\S]*answer = 42/);
  assert.doesNotMatch(parsed.text,/BASE64_IMAGE_PAYLOAD/);
});

test('格式错误的 Notebook 提供明确错误',async()=>{
  await assert.rejects(()=>extractFileText({filename:'broken.ipynb',mime:'application/json',bytes:Buffer.from('{bad')}),/Notebook 不是有效 JSON/);
});

test('Notebook 长输出保留末尾错误且不截断 UTF-8 字符',async()=>{
  const value={nbformat:4,cells:[{cell_type:'code',source:'汉🙂'.repeat(20000),outputs:[
    {output_type:'error',ename:'ValueError',evalue:'failed',traceback:['开始汉🙂','汉🙂'.repeat(6000),'File analysis.py, line 42: final failure']}
  ]}]};
  const parsed=await extractFileText({filename:'long.ipynb',mime:'application/json',bytes:Buffer.from(JSON.stringify(value))});
  assert.match(parsed.text,/ValueError: failed/);assert.match(parsed.text,/analysis\.py, line 42: final failure/);
  assert.match(parsed.text,/middle omitted/);assert.doesNotMatch(parsed.text,/\uFFFD/);
  assert.ok(Buffer.byteLength(parsed.text)<90*1024);
});

test('Notebook 超过输出块上限时优先保留错误并保留近期日志',async()=>{
  const outputs=[{output_type:'error',ename:'ImportError',evalue:'dependency missing',traceback:[]}];
  for(let index=0;index<30;index++)outputs.push({output_type:'stream',text:`progress-${index}\n`});
  outputs.push({output_type:'error',ename:'AssertionError',evalue:'test failed',traceback:['test_main.py:17']});
  const value={nbformat:4,cells:[{cell_type:'code',source:'run_tests()',outputs}]};
  const parsed=await extractFileText({filename:'outputs.ipynb',mime:'application/json',bytes:Buffer.from(JSON.stringify(value))});
  assert.match(parsed.text,/ImportError: dependency missing/);assert.match(parsed.text,/AssertionError: test failed/);
  assert.match(parsed.text,/progress-29/);assert.match(parsed.text,/output blocks omitted/);
  assert.doesNotMatch(parsed.text,/progress-0\n/);
});
