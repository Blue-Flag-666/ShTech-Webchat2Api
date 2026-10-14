const MAX_CELLS=2000,MAX_TEXT=1024*1024,MAX_SOURCE=64*1024,MAX_OUTPUT=16*1024;
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const decoder=new TextDecoder('utf-8',{fatal:true});

function lines(value){
  if(typeof value==='string')return value;
  if(Array.isArray(value)&&value.every(item=>typeof item==='string'))return value.join('');
  return '';
}
function clip(value,limit,tail=false){
  const bytes=Buffer.from(value);
  if(bytes.length<=limit)return value;
  let end=tail?Math.floor(limit/2):limit;
  while(end>0&&(bytes[end]&0xc0)===0x80)end--;
  const head=bytes.subarray(0,end).toString('utf8');
  if(!tail)return `${head}\n[truncated]`;
  let start=bytes.length-(limit-Math.floor(limit/2));
  while(start<bytes.length&&(bytes[start]&0xc0)===0x80)start++;
  return `${head}\n[truncated; middle omitted]\n${bytes.subarray(start).toString('utf8')}`;
}
function outputText(output){
  if(!output||typeof output!=='object')return '';
  if(output.output_type==='stream')return lines(output.text);
  if(output.output_type==='error'){
    const name=typeof output.ename==='string'?output.ename:'Error',message=typeof output.evalue==='string'?output.evalue:'';
    const traceback=Array.isArray(output.traceback)?output.traceback.filter(item=>typeof item==='string').join('\n'):'';
    return `${name}: ${message}${traceback?`\n${traceback}`:''}`;
  }
  if(['execute_result','display_data'].includes(output.output_type))return lines(output.data?.['text/plain']);
  return '';
}

export function extractNotebookText(bytes){
  let source;try{source=decoder.decode(bytes);}catch{fail('Notebook 不是有效 UTF-8 文本');}
  let notebook;try{notebook=JSON.parse(source);}catch{fail('Notebook 不是有效 JSON');}
  if(notebook?.nbformat!==4||!Array.isArray(notebook.cells)||notebook.cells.length>MAX_CELLS)fail('Notebook 格式无效或单元格过多');
  const sections=[];let size=0,truncated=false;
  const append=value=>{
    if(!value.trim())return;
    const length=Buffer.byteLength(value);
    if(size+length>MAX_TEXT){truncated=true;return;}
    sections.push(value);size+=length;
  };
  for(const [index,cell] of notebook.cells.entries()){
    if(!['code','markdown'].includes(cell?.cell_type))continue;
    const content=lines(cell.source);
    if(!content.trim()&&!(cell.cell_type==='code'&&Array.isArray(cell.outputs)&&cell.outputs.length))continue;
    append(`[${cell.cell_type==='code'?'Code':'Markdown'} cell ${index+1}]\n${clip(content,MAX_SOURCE)}`);
    if(cell.cell_type==='code'&&Array.isArray(cell.outputs)){
      // Keep errors even when they appear after many display/stream updates.
      const chosen=new Set();
      for(let i=cell.outputs.length-1;i>=0&&chosen.size<20;i--)if(cell.outputs[i]?.output_type==='error')chosen.add(i);
      for(let i=cell.outputs.length-1;i>=0&&chosen.size<20;i--)chosen.add(i);
      if(cell.outputs.length>chosen.size)append('[Earlier output blocks omitted]');
      for(const index of [...chosen].sort((a,b)=>a-b)){
        const output=cell.outputs[index];
        const value=outputText(output).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
        if(value.trim())append(`[Output]\n${clip(value,MAX_OUTPUT,true)}`);
      }
    }
  }
  if(!sections.length)fail('Notebook 没有可提取的代码或 Markdown');
  return `Jupyter Notebook (${notebook.cells.length} cells)\n${sections.join('\n\n')}${truncated?'\n\n[notebook text truncated]':''}`;
}
