const MAX_DIFF=896*1024,MAX_LOG=512*1024;
const diagnostics=/\b(?:error|failed|failure|panic|exception|traceback|assert(?:ion)?|fatal|segmentation fault|test suite failed)\b|错误|失败|异常|✖/i;

function head(value,bytes){
  const data=Buffer.from(value);let end=Math.min(bytes,data.length);
  while(end>0&&end<data.length&&(data[end]&0xc0)===0x80)end--;
  return data.subarray(0,end).toString('utf8');
}
function tail(value,bytes){
  const data=Buffer.from(value);let start=Math.max(0,data.length-bytes);
  while(start<data.length&&(data[start]&0xc0)===0x80)start++;
  return data.subarray(start).toString('utf8');
}

export function extractDiffText(source){
  const files=new Set(),deleted=new Set();let hunks=0,added=0,removed=0;
  for(const line of source.split(/\r?\n/)){
    if(line.startsWith('+++ b/'))files.add(line.slice(6,262));
    else if(line.startsWith('--- a/'))deleted.add(line.slice(6,262));
    else if(line.startsWith('diff --git ')){const marker=line.lastIndexOf(' b/');if(marker>=0)files.add(line.slice(marker+3,marker+259));}
    if(line.startsWith('@@'))hunks++;
    else if(line.startsWith('+')&&!line.startsWith('+++'))added++;
    else if(line.startsWith('-')&&!line.startsWith('---'))removed++;
  }
  for(const name of deleted)if(!files.has(name))files.add(name);
  const names=[...files].slice(0,200);
  const summary=`Patch summary: ${files.size} files, ${hunks} hunks, +${added}/-${removed} lines.\n${names.join('\n')}${files.size>names.length?'\n... more files omitted':''}`;
  if(Buffer.byteLength(source)<=MAX_DIFF)return `${summary}\n\n${source}`;
  return `${summary}\n\n${head(source,512*1024)}\n[patch middle omitted]\n${tail(source,256*1024)}`;
}

export function extractLogText(source){
  const clean=source.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
  if(Buffer.byteLength(clean)<=MAX_LOG)return clean;
  const lines=clean.split(/\r?\n/),matches=[];
  for(let index=0;index<lines.length;index++)if(diagnostics.test(lines[index]))matches.push(index);
  const selected=new Set();
  for(const index of matches.slice(-60))for(let offset=-1;offset<=2;offset++)if(index+offset>=0&&index+offset<lines.length)selected.add(index+offset);
  let highlights=[...selected].sort((a,b)=>a-b).map(index=>`${index+1}: ${lines[index].slice(0,2048)}`).join('\n');
  if(Buffer.byteLength(highlights)>160*1024)highlights=tail(highlights,160*1024);
  return `Test log: ${lines.length} lines, ${matches.length} diagnostic lines.\n[Failure context]\n${highlights||'(none detected)'}\n\n[Start]\n${head(clean,32*1024)}\n[log middle omitted]\n[End]\n${tail(clean,256*1024)}`;
}
