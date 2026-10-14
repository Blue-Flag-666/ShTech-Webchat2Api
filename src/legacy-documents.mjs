const MAX_TEXT=1024*1024;
const skipDestinations=new Set(['fonttbl','colortbl','stylesheet','info','pict','object','header','footer','headerl','headerr','footerl','footerr','annotation','xmlnstbl','datastore','themedata']);
const controls=new Map([['par','\n'],['line','\n'],['row','\n'],['cell','\t'],['tab','\t'],['emdash','—'],['endash','–'],['bullet','•'],['lquote','‘'],['rquote','’'],['ldblquote','“'],['rdblquote','”']]);
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const cp1252=new TextDecoder('windows-1252');

export function extractRtfText(bytes){
  const source=cp1252.decode(bytes);
  if(!source.startsWith('{\\rtf'))fail('RTF 文件头无效');
  const stack=[{skip:false,uc:1,fallback:0,pendingSkip:false}],output=[];
  let size=0,truncated=false;
  const current=()=>stack.at(-1);
  const append=(value,force=false)=>{
    const state=current();if(state.skip)return;
    if(!force&&state.fallback>0){state.fallback--;return;}
    const length=Buffer.byteLength(value);
    if(size+length>MAX_TEXT){truncated=true;return;}
    output.push(value);size+=length;
  };
  for(let index=0;index<source.length&&!truncated;){
    const char=source[index];
    if(char==='{'){
      if(stack.length>=100)fail('RTF 嵌套过深');
      stack.push({...current(),pendingSkip:false});index++;continue;
    }
    if(char==='}'){
      if(stack.length===1)fail('RTF 分组无效');
      stack.pop();index++;continue;
    }
    if(char!=='\\'){
      if(char!=='\r'&&char!=='\n')append(char);
      index++;continue;
    }
    if(index+1>=source.length)break;
    const next=source[index+1];
    if(next==='\\'||next==='{'||next==='}'){
      append(next);index+=2;continue;
    }
    if(next==="'"){
      const hex=source.slice(index+2,index+4);
      if(!/^[0-9a-f]{2}$/i.test(hex))fail('RTF 十六进制转义无效');
      append(cp1252.decode(Uint8Array.of(Number.parseInt(hex,16))));index+=4;continue;
    }
    if(!/[A-Za-z]/.test(next)){
      if(next==='*')current().pendingSkip=true;
      else if(next==='~')append('\u00a0');
      else if(next==='-')append('\u00ad');
      else if(next==='_')append('\u2011');
      index+=2;continue;
    }
    let end=index+1;while(end<source.length&&/[A-Za-z]/.test(source[end]))end++;
    const word=source.slice(index+1,end).toLowerCase();
    let numberStart=end;if(source[end]==='-')end++;
    while(end<source.length&&/[0-9]/.test(source[end]))end++;
    const argument=end>numberStart?Number(source.slice(numberStart,end)):undefined;
    if(source[end]===' ')end++;
    index=end;
    const state=current();
    if(state.pendingSkip||skipDestinations.has(word)){state.skip=true;state.pendingSkip=false;continue;}
    if(word==='bin'&&Number.isInteger(argument)&&argument>=0){index=Math.min(source.length,index+argument);continue;}
    if(state.skip)continue;
    if(word==='uc'&&Number.isInteger(argument))state.uc=Math.max(0,Math.min(argument,32));
    else if(word==='u'&&Number.isInteger(argument)){append(String.fromCharCode((argument+65536)%65536),true);state.fallback=state.uc;}
    else if(controls.has(word))append(controls.get(word));
  }
  if(!truncated&&stack.length!==1)fail('RTF 分组未闭合');
  const text=output.join('').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  if(!text)fail('RTF 没有可提取的文本');
  return `${text}${truncated?'\n[RTF text truncated]':''}`;
}

export function extractLegacyDocText(bytes){
  const data=Buffer.from(bytes);
  if(data.subarray(0,5).toString('ascii')==='{\\rtf')return extractRtfText(data);
  if(data.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])))fail('二进制 DOC 暂不支持，请转换为 DOCX 或纯文本');
  if(data.includes(0))fail('DOC 不是纯文本文件');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{fail('DOC 不是有效 UTF-8 纯文本');}
  const controls=(text.match(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g)||[]).length;
  if(controls>Math.max(2,text.length/100)||!text.trim())fail('DOC 不是可读取的纯文本');
  return Buffer.byteLength(text)<=MAX_TEXT?text:`${data.subarray(0,MAX_TEXT).toString('utf8')}\n[DOC text truncated]`;
}
