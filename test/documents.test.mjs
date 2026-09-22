import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { extractFileText } from '../src/files.mjs';

const zip=entries=>Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name,value])=>[name,strToU8(value)]))));

test('ODT 和 ODS 提取段落、空格与表格',async()=>{
  const odt=zip({'content.xml':'<office:document-content><text:h>标题</text:h><text:p>Hello<text:s text:c="2"/>上海 &amp; World</text:p></office:document-content>'});
  const text=await extractFileText({filename:'report.odt',mime:'',bytes:odt});assert.match(text.text,/标题[\s\S]*Hello  上海 & World/);
  const ods=zip({'content.xml':'<office:document-content><table:table><table:table-row><table:table-cell><text:p>A1</text:p></table:table-cell><table:table-cell><text:p>B1</text:p></table:table-cell></table:table-row></table:table></office:document-content>'});
  const sheet=await extractFileText({filename:'data.ods',mime:'',bytes:ods});assert.match(sheet.text,/A1\s+B1/);
});

test('ODP 按页提取标题和正文',async()=>{
  const bytes=zip({'content.xml':'<office:document-content><draw:page draw:name="介绍"><text:p>第一页</text:p></draw:page><draw:page draw:name="结论"><text:p>第二页</text:p></draw:page></office:document-content>'});
  const parsed=await extractFileText({filename:'slides.odp',mime:'application/vnd.oasis.opendocument.presentation',bytes});
  assert.match(parsed.text,/\[Slide 1: 介绍\][\s\S]*第一页[\s\S]*\[Slide 2: 结论\][\s\S]*第二页/);
});

test('EPUB 按 spine 顺序提取 XHTML 并忽略脚本',async()=>{
  const bytes=zip({
    'META-INF/container.xml':'<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>',
    'OPS/package.opf':'<package><manifest><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
    'OPS/one.xhtml':'<html><body><h1>第一章</h1><p>A&nbsp;B</p><script>secret()</script></body></html>',
    'OPS/two.xhtml':'<html><body><h1>第二章</h1><p>结束</p></body></html>'
  });
  const parsed=await extractFileText({filename:'book.epub',mime:'application/octet-stream',bytes});
  assert.match(parsed.text,/\[Chapter 1\][\s\S]*第一章[\s\S]*A B/);assert.ok(parsed.text.indexOf('第一章')<parsed.text.indexOf('第二章'));assert.doesNotMatch(parsed.text,/secret/);
});
