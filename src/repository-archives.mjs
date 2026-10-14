import { posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openDocumentArchive } from './office.mjs';
import { extractNotebookText } from './notebooks.mjs';
import { extractDiffText, extractLogText } from './code-artifacts.mjs';
import { extractRtfText, extractLegacyDocText } from './legacy-documents.mjs';

const MAX_UNPACKED=32*1024*1024,MAX_ENTRIES=5000,MAX_TREE=64*1024,MAX_OVERVIEW=32*1024,MAX_TEXT=1024*1024,MAX_FILE=256*1024;
const ignored=new Set(['.git','.hg','.svn','node_modules','vendor','.venv','venv','__pycache__','dist','build','coverage','.next','.nuxt','.turbo','.cache','target','out']);
const exampleEnv=/^\.env(?:\.[^.]+)*\.(?:example|sample|template)$/i;
function credentialFile(path){
  const lower=path.toLowerCase(),base=posix.basename(lower);
  return (/^\.env(?:\.|$)/.test(base)&&!exampleEnv.test(base))
    ||['.envrc','.npmrc','.pypirc','.netrc','id_rsa','id_ed25519','credentials.json','secrets.json','service-account.json'].includes(base)
    ||/\.(?:pem|p12|pfx|key)$/i.test(base)
    ||/(?:^|\/)\.docker\/config\.json$|(?:^|\/)\.aws\/(?:credentials|config)$/.test(lower);
}
const binaryExtensions=/\.(?:png|jpe?g|gif|webp|bmp|ico|icns|pdf|docx|pptx?|xlsx?|od[tsdp]|epub|zip|tar|tgz|gz|7z|rar|exe|dll|so|dylib|class|jar|wasm|mp[34]|mov|wav|ogg|flac|woff2?|ttf|otf|eot|sqlite|db|lockb)$/i;
const decoder=new TextDecoder('utf-8',{fatal:true});
const fail=message=>{throw Object.assign(new Error(message),{status:400});};

function safePath(name){
  if(typeof name!=='string'||!name||/[\x00-\x1f\x7f]/.test(name)||name.startsWith('/')||/^[A-Za-z]:/.test(name))return null;
  const path=name.replaceAll('\\','/');
  if(path.startsWith('/')||path.split('/').includes('..'))return null;
  const normalized=posix.normalize(path).replace(/^\.\//,'');
  if(!normalized||normalized==='.'||normalized.startsWith('../'))return null;
  return normalized;
}

function paxPath(bytes){
  let offset=0,path='';
  while(offset<bytes.length){
    const space=bytes.indexOf(32,offset);
    if(space<0)fail('TAR PAX 路径记录无效');
    const digits=bytes.subarray(offset,space).toString('ascii');
    if(!/^[1-9]\d*$/.test(digits))fail('TAR PAX 记录长度无效');
    const end=offset+Number(digits);
    if(!Number.isSafeInteger(end)||end<=space+1||end>bytes.length||bytes[end-1]!==10)fail('TAR PAX 记录不完整');
    let record;try{record=decoder.decode(bytes.subarray(space+1,end-1));}catch{fail('TAR PAX 记录不是有效 UTF-8');}
    const separator=record.indexOf('=');
    if(separator<1)fail('TAR PAX 记录无效');
    if(record.slice(0,separator)==='path')path=record.slice(separator+1);
    offset=end;
  }
  return path;
}

function tarEntries(bytes){
  const input=Buffer.from(bytes),entries=[];
  if(input.length>MAX_UNPACKED)fail('TAR 解包后不能超过 32 MiB');
  const field=(header,start,length)=>header.subarray(start,start+length).toString('utf8').split('\0')[0].trim();
  let offset=0,longName='',paxName='',scanned=0;
  while(offset+512<=input.length){
    const header=input.subarray(offset,offset+512);
    if(header.every(byte=>byte===0))break;
    if(++scanned>MAX_ENTRIES)fail('TAR 文件数量不能超过 5000');
    const rawSize=field(header,124,12),size=rawSize?/^[0-7]+$/.test(rawSize)?Number.parseInt(rawSize,8):NaN:0;
    if(!Number.isSafeInteger(size)||size<0||size>MAX_UNPACKED)fail('TAR 文件大小字段无效');
    const stored=field(header,148,8),checksum=/^[0-7]+$/.test(stored)?Number.parseInt(stored,8):NaN;
    let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];
    if(sum!==checksum)fail('TAR 文件头校验失败');
    const start=offset+512,end=start+size,next=start+Math.ceil(size/512)*512;
    if(end>input.length||next>input.length)fail('TAR 文件内容不完整');
    const kind=header[156],name=paxName||longName||[field(header,345,155),field(header,0,100)].filter(Boolean).join('/');
    if(kind===76)longName=input.subarray(start,end).toString('utf8').split('\0')[0];
    else if(kind===120)paxName=paxPath(input.subarray(start,end));
    else{
      if(kind===0||kind===48)entries.push({name,bytes:input.subarray(start,end)});
      longName='';paxName='';
    }
    offset=next;
  }
  if(!entries.length)fail('TAR 中没有普通文件');
  return entries;
}

function archiveEntries(file,type){
  if(type==='zip')return Object.entries(openDocumentArchive(file.bytes,'ZIP')).map(([name,bytes])=>({name,bytes}));
  let bytes=file.bytes;
  if(type==='tgz'){
    try{bytes=gunzipSync(bytes,{maxOutputLength:MAX_UNPACKED});}catch{fail('无法解压 GZIP 或解压后超过 32 MiB');}
  }
  return tarEntries(bytes);
}

function textFile(bytes,path){
  const special=/\.(?:diff|patch|log)$/i.test(path);
  if(bytes.length>(special?10*1024*1024:MAX_FILE)||bytes.includes(0))return null;
  let value;try{value=decoder.decode(bytes);}catch{return null;}
  const controls=(value.match(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g)||[]).length;
  if(controls>Math.max(2,value.length/100))return null;
  return /\.(?:diff|patch)$/i.test(path)?extractDiffText(value):/\.log$/i.test(path)?extractLogText(value):value;
}

function priority(path){
  const base=posix.basename(path).toLowerCase();
  if(base==='agents.md')return 0;
  if(/^readme(?:\.|$)/.test(base)||['package.json','pyproject.toml','cargo.toml','go.mod','pom.xml','build.gradle','requirements.txt','makefile','dockerfile'].includes(base))return 1;
  if(/(?:^|\/)(?:src|app|lib|test|tests)\//.test(path))return 2;
  return 3;
}

function overview(entry){
  const size=entry.bytes.length,label=`${entry.path} (${size} bytes)`;
  if(binaryExtensions.test(entry.path))return `${label}: binary or packaged asset`;
  const sample=entry.bytes.subarray(0,Math.min(size,64*1024));
  if(sample.includes(0))return `${label}: binary data`;
  const source=Buffer.from(sample).toString('utf8');
  const controls=(source.match(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g)||[]).length;
  if(controls>Math.max(2,source.length/100))return `${label}: binary data`;
  const lines=source.split(/\r?\n/);
  const hints=[];
  for(const line of lines){
    const heading=/^\s*#{1,3}\s+(.{1,80})/.exec(line);
    const latex=/^\s*\\(?:chapter|section|subsection|subsubsection)\*?\{([^}]{1,80})\}/.exec(line);
    const include=/^\s*\\(?:input|include|bibliography)\{([^}]{1,80})\}/.exec(line);
    const symbol=/^\s*(?:(?:export|public|private|protected|static|async|pub)\s+)*(?:function|class|interface|type|enum|def|fn|func|struct)\s+([A-Za-z_$][\w$]*)/.exec(line)
      ||/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if(heading)hints.push(`# ${heading[1].trim()}`);
    else if(latex)hints.push(`section: ${latex[1].trim()}`);
    else if(include)hints.push(`includes: ${include[1].trim()}`);
    else if(symbol)hints.push(symbol[1]);
    if(hints.length>=4)break;
  }
  const lineCount=size<=sample.length?`${lines.length} lines`:`at least ${lines.length} sampled lines`;
  return `${label}: ${lineCount}${hints.length?`; headings/declarations: ${hints.join(', ')}`:''}`;
}

export function extractRepositoryArchive(file,type){
  const entries=archiveEntries(file,type),paths=[];
  for(const entry of entries){
    const path=safePath(entry.name);
    if(!path||path.endsWith('/')||path.split('/').some(segment=>ignored.has(segment.toLowerCase()))||credentialFile(path))continue;
    paths.push({path,bytes:entry.bytes});
  }
  if(!paths.length)fail('压缩包没有可读取的项目文件');
  const roots=new Set(paths.map(entry=>entry.path.split('/')[0]));
  if(roots.size===1&&paths.every(entry=>entry.path.includes('/'))){const prefix=[...roots][0]+'/';for(const entry of paths)entry.path=entry.path.slice(prefix.length);}
  paths.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const tree=[],overviews=[],contents=[];let treeBytes=0,overviewBytes=0,textBytes=0,included=0,skipped=0;
  for(const entry of paths){
    const line=entry.path+'\n',length=Buffer.byteLength(line);
    if(treeBytes+length<=MAX_TREE){tree.push(entry.path);treeBytes+=length;}
  }
  for(const entry of [...paths].sort((a,b)=>priority(a.path)-priority(b.path)||a.path.localeCompare(b.path,'en'))){
    const brief=overview(entry),briefBytes=Buffer.byteLength(brief+'\n');
    if(overviewBytes+briefBytes<=MAX_OVERVIEW){overviews.push(brief);overviewBytes+=briefBytes;}
    if(binaryExtensions.test(entry.path)){skipped++;continue;}
    let value;
    if(/\.ipynb$/i.test(entry.path)&&entry.bytes.length<10*1024*1024){try{value=extractNotebookText(entry.bytes);}catch{value=null;}}
    else if(/\.rtf$/i.test(entry.path)&&entry.bytes.length<10*1024*1024){try{value=extractRtfText(entry.bytes);}catch{value=null;}}
    else if(/\.doc$/i.test(entry.path)&&entry.bytes.length<10*1024*1024){try{value=extractLegacyDocText(entry.bytes);}catch{value=null;}}
    else value=textFile(entry.bytes,entry.path);
    if(value===null){skipped++;continue;}
    const section=`[File: ${entry.path}]\n${value}\n`;
    const length=Buffer.byteLength(section);
    if(textBytes+length>MAX_TEXT){skipped++;continue;}
    contents.push(section);textBytes+=length;included++;
  }
  const summary=`Repository archive: ${file.filename}\nFiles: ${paths.length}; included text: ${included}; omitted: ${skipped}.\nDirectory tree:\n${tree.join('\n')}${tree.length<paths.length?'\n... (tree truncated)':''}\nFile overview:\n${overviews.join('\n')}${overviews.length<paths.length?'\n... (overview truncated)':''}`;
  return{text:`${summary}\n\n${contents.join('\n')}`,mime:type==='zip'?'application/zip':type==='tgz'?'application/gzip':'application/x-tar'};
}
