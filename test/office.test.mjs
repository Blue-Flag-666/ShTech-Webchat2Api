import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { extractFileText, expandInputFiles, FileStore } from '../src/files.mjs';

const zip=entries=>Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name,value])=>[name,strToU8(value)]))));

export function sampleDocx(){return zip({
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'word/document.xml':'<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Hello &amp; 上海</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  'word/header1.xml':'<w:hdr xmlns:w="urn:w"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>'
});}

function samplePptx(){return zip({
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'ppt/slides/slide2.xml':'<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide1.xml':'<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>',
  'ppt/notesSlides/notesSlide1.xml':'<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>'
});}

function sampleXlsx(){return zip({
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'xl/workbook.xml':'<workbook xmlns:r="urn:r"><sheets><sheet name="数据 &amp; 表" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml':'<sst><si><t>Name</t></si><si><r><t>上海</t></r><r><t>科技</t></r></si></sst>',
  'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>1+1</f><v>2</v></c><c r="C2" t="b"><v>1</v></c></row></sheetData></worksheet>'
});}

test('DOCX 提取正文、表格和页眉并可作为 Responses 输入',async()=>{
  const bytes=sampleDocx(),parsed=await extractFileText({filename:'报告.docx',mime:'application/octet-stream',bytes});
  assert.match(parsed.text,/Hello & 上海/);assert.match(parsed.text,/A1\s+B1/);assert.match(parsed.text,/Header/);
  const store=new FileStore(2,3600000,1024*1024),file=store.create({filename:'报告.docx',mime:parsed.mime,bytes});
  const expanded=await expandInputFiles('/v1/responses',{input:[{role:'user',content:[{type:'input_file',file_id:file.id}]}]},store);
  assert.match(expanded.input[0].content[0].text,/报告\.docx[\s\S]*Hello & 上海/);
});

test('PPTX 按页提取幻灯片和演讲者备注',async()=>{
  const parsed=await extractFileText({filename:'slides.pptx',mime:'',bytes:samplePptx()});
  assert.match(parsed.text,/\[Slide 1\][\s\S]*First slide[\s\S]*\[Notes\][\s\S]*Speaker note/);
  assert.ok(parsed.text.indexOf('First slide')<parsed.text.indexOf('Second'));
});

test('XLSX 按工作表提取共享字符串、行列、公式和布尔值',async()=>{
  const parsed=await extractFileText({filename:'data.xlsx',mime:'',bytes:sampleXlsx()});
  assert.match(parsed.text,/\[Sheet: 数据 & 表\]/);assert.match(parsed.text,/Name\tValue/);
  assert.match(parsed.text,/上海科技\t=1\+1 \(2\)\tTRUE/);
});

test('Office 解压前拒绝畸形压缩包',async()=>{
  await assert.rejects(()=>extractFileText({filename:'bad.docx',mime:'',bytes:Buffer.from('PK')}),/有效的 ZIP/);
});
