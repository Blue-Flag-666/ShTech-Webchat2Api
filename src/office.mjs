import { posix } from 'node:path';
import { unzipSync } from 'fflate';

const MAX_ENTRIES=5000;
const MAX_UNCOMPRESSED_BYTES=32*1024*1024;
const decoder=new TextDecoder('utf-8',{fatal:true});

function fail(message){throw Object.assign(new Error(message),{status:400});}

function inspectZip(bytes){
  const buffer=Buffer.from(bytes),start=Math.max(0,buffer.length-65557);let eocd=-1;
  for(let i=buffer.length-22;i>=start;i--)if(buffer.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  if(eocd<0)fail('Office 文件不是有效的 ZIP 文档');
  const entries=buffer.readUInt16LE(eocd+10),size=buffer.readUInt32LE(eocd+12),offset=buffer.readUInt32LE(eocd+16);
  if(entries===0xffff||size===0xffffffff||offset===0xffffffff)fail('暂不支持 ZIP64 Office 文件');
  if(entries<1||entries>MAX_ENTRIES||offset+size>buffer.length)fail('Office 文件目录无效或文件数量过多');
  let cursor=offset,total=0;
  for(let index=0;index<entries;index++){
    if(cursor+46>buffer.length||buffer.readUInt32LE(cursor)!==0x02014b50)fail('Office 文件目录损坏');
    const flags=buffer.readUInt16LE(cursor+8),uncompressed=buffer.readUInt32LE(cursor+24);
    if(flags&1)fail('不支持加密的 Office 文件');
    total+=uncompressed;if(total>MAX_UNCOMPRESSED_BYTES)fail('Office 文件解压后不能超过 32 MiB');
    cursor+=46+buffer.readUInt16LE(cursor+28)+buffer.readUInt16LE(cursor+30)+buffer.readUInt16LE(cursor+32);
  }
}

function archive(bytes){
  inspectZip(bytes);
  try{return unzipSync(Uint8Array.from(bytes));}catch{fail('无法解压 Office 文件');}
}

function entity(value){
  return value.replace(/&(?:#(x[\da-f]+|\d+)|amp|lt|gt|quot|apos);/gi,(match,numeric)=>{
    if(numeric){const hex=numeric[0].toLowerCase()==='x',code=Number.parseInt(hex?numeric.slice(1):numeric,hex?16:10);return Number.isFinite(code)&&code<=0x10ffff?String.fromCodePoint(code):'';}
    return {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[match.toLowerCase()]??match;
  });
}

function attr(source,name){
  const match=new RegExp(`(?:^|\\s)${name.replace(':','\\:')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i').exec(source);
  return match?entity(match[1]??match[2]):undefined;
}

function xml(bytes,name){
  if(!bytes)fail(`Office 文件缺少 ${name}`);
  try{return decoder.decode(bytes);}catch{fail(`Office 文件中的 ${name} 不是有效 UTF-8 XML`);}
}

function clean(value){
  return value.replace(/\r/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

function prose(source,prefix){
  return clean(entity(source
    .replace(new RegExp(`<${prefix}:tab\\b[^>]*\\/?\\s*>`,'gi'),'\t')
    .replace(new RegExp(`<${prefix}:(?:br|cr)\\b[^>]*\\/?\\s*>`,'gi'),'\n')
    .replace(new RegExp(`</${prefix}:(?:p|tr)>`,'gi'),'\n')
    .replace(new RegExp(`</${prefix}:tc>`,'gi'),'\t')
    .replace(/<[^>]+>/g,'')));
}

function docx(files){
  const names=Object.keys(files).filter(name=>/^word\/(?:document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/i.test(name));
  names.sort((a,b)=>a==='word/document.xml'?-1:b==='word/document.xml'?1:a.localeCompare(b,undefined,{numeric:true}));
  if(!names.includes('word/document.xml'))fail('DOCX 缺少 word/document.xml');
  const text=clean(names.map(name=>prose(xml(files[name],name),'w')).filter(Boolean).join('\n\n'));
  if(!text)fail('DOCX 没有可提取的文本');
  return text;
}

function pptx(files){
  const slides=Object.keys(files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(!slides.length)fail('PPTX 没有幻灯片');
  const sections=[];
  for(const [index,name] of slides.entries()){
    const value=prose(xml(files[name],name),'a'),number=Number(/slide(\d+)\.xml$/i.exec(name)?.[1])||index+1;
    const notesName=`ppt/notesSlides/notesSlide${number}.xml`,notes=files[notesName]?prose(xml(files[notesName],notesName),'a'):'';
    sections.push(`[Slide ${number}]${value?`\n${value}`:''}${notes?`\n[Notes]\n${notes}`:''}`);
  }
  return clean(sections.join('\n\n'));
}

function sharedStrings(files){
  if(!files['xl/sharedStrings.xml'])return [];
  const source=xml(files['xl/sharedStrings.xml'],'xl/sharedStrings.xml'),values=[];
  for(const match of source.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi))values.push(prose(match[1],'(?:\w+|x)'));
  return values;
}

function workbookSheets(files){
  const book=xml(files['xl/workbook.xml'],'xl/workbook.xml'),rels=xml(files['xl/_rels/workbook.xml.rels'],'xl/_rels/workbook.xml.rels'),targets=new Map();
  for(const match of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)){
    const id=attr(match[1],'Id'),target=attr(match[1],'Target');if(id&&target)targets.set(id,posix.normalize(target.startsWith('/')?target.slice(1):posix.join('xl',target)));
  }
  const sheets=[];
  for(const match of book.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)){
    const name=attr(match[1],'name')||`Sheet ${sheets.length+1}`,id=attr(match[1],'r:id'),target=targets.get(id);
    if(target&&target.startsWith('xl/')&&!target.includes('../'))sheets.push({name,target});
  }
  return sheets;
}

function column(reference){
  const letters=/^[A-Z]+/i.exec(reference)?.[0]?.toUpperCase();if(!letters)return null;
  let value=0;for(const letter of letters)value=value*26+letter.charCodeAt(0)-64;return value-1;
}

function sheetText(source,shared){
  const rows=new Map();
  for(const match of source.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)){
    const reference=attr(match[1],'r')||'',col=column(reference);if(col===null||col>16383)continue;
    const row=Number(/\d+$/.exec(reference)?.[0])||1,type=attr(match[1],'t'),body=match[2];let value='';
    if(type==='inlineStr')value=prose(body,'(?:\w+|x)');
    else {const raw=/<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1]??'';value=type==='s'?(shared[Number(raw)]??''):type==='b'?(raw==='1'?'TRUE':'FALSE'):entity(raw);}
    const formula=/<f\b[^>]*>([\s\S]*?)<\/f>/i.exec(body)?.[1];if(formula)value=value?`=${entity(formula)} (${value})`:`=${entity(formula)}`;
    if(value!==''){if(!rows.has(row))rows.set(row,new Map());rows.get(row).set(col,value);}
  }
  return [...rows.entries()].sort((a,b)=>a[0]-b[0]).map(([,cells])=>{
    const last=Math.max(...cells.keys()),parts=[];for(let index=0;index<=last;index++)parts.push(cells.get(index)??'');return parts.join('\t').replace(/\t+$/,'');
  }).join('\n');
}

function xlsx(files){
  const shared=sharedStrings(files),sheets=workbookSheets(files);if(!sheets.length)fail('XLSX 没有工作表');
  const sections=sheets.map(({name,target})=>{const value=sheetText(xml(files[target],target),shared);return `[Sheet: ${name}]${value?`\n${value}`:''}`;});
  return clean(sections.join('\n\n'));
}

export function extractOfficeText(file,type){
  const files=archive(file.bytes);
  if(type==='docx')return{text:docx(files),mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
  if(type==='pptx')return{text:pptx(files),mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
  if(type==='xlsx')return{text:xlsx(files),mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  fail('不支持的 Office 文件类型');
}
