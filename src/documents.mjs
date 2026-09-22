import { posix } from 'node:path';
import { cleanExtractedText, decodeDocumentXml, decodeXmlEntities, openDocumentArchive } from './office.mjs';

const fail=message=>{throw Object.assign(new Error(message),{status:400});};

function attr(source,name){
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),match=new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i').exec(source);
  return match?decodeXmlEntities(match[1]??match[2]):undefined;
}

function odfText(source){
  return cleanExtractedText(decodeXmlEntities(source
    .replace(/<text:s\b([^>]*)\/?\s*>/gi,(_,attributes)=>' '.repeat(Math.min(100,Number(attr(attributes,'text:c')||1))))
    .replace(/<text:(?:tab)\b[^>]*\/?\s*>/gi,'\t')
    .replace(/<text:line-break\b[^>]*\/?\s*>/gi,'\n')
    .replace(/<\/text:(?:p|h)>/gi,'\n')
    .replace(/<\/table:table-cell>/gi,'\t')
    .replace(/<\/table:table-row>/gi,'\n')
    .replace(/<[^>]+>/g,'')));
}

function odf(files,type){
  const source=decodeDocumentXml(files['content.xml'],'content.xml');
  if(type==='odp'){
    const slides=[];
    for(const [index,match] of [...source.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/gi)].entries()){
      const name=attr(match[1],'draw:name'),text=odfText(match[2]);slides.push(`[Slide ${index+1}${name?`: ${name}`:''}]${text?`\n${text}`:''}`);
    }
    if(!slides.length)fail('ODP 没有幻灯片');return cleanExtractedText(slides.join('\n\n'));
  }
  const text=odfText(source);if(!text)fail(`${type.toUpperCase()} 没有可提取的文本`);return text;
}

function htmlText(source){
  return cleanExtractedText(decodeXmlEntities(source
    .replace(/<(?:script|style|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|svg)>/gi,'')
    .replace(/<br\b[^>]*\/?\s*>/gi,'\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article)>/gi,'\n')
    .replace(/<\/(?:td|th)>/gi,'\t')
    .replace(/<[^>]+>/g,'')));
}

function epub(files){
  const container=decodeDocumentXml(files['META-INF/container.xml'],'META-INF/container.xml'),rootMatch=/<rootfile\b([^>]*)\/?\s*>/i.exec(container),root=attr(rootMatch?.[1]||'','full-path');
  if(!root||root.startsWith('/')||root.split('/').includes('..'))fail('EPUB 容器路径无效');
  const packageXml=decodeDocumentXml(files[root],root),manifest=new Map();
  for(const match of packageXml.matchAll(/<item\b([^>]*)\/?\s*>/gi)){
    const id=attr(match[1],'id'),href=attr(match[1],'href'),media=attr(match[1],'media-type');if(id&&href&&['application/xhtml+xml','text/html'].includes(media))manifest.set(id,href);
  }
  const order=[];for(const match of packageXml.matchAll(/<itemref\b([^>]*)\/?\s*>/gi)){const href=manifest.get(attr(match[1],'idref'));if(href)order.push(href);}
  if(!order.length)order.push(...manifest.values());if(!order.length)fail('EPUB 没有可读取的正文');
  const base=posix.dirname(root),chapters=[];
  for(const href of order){
    let decoded;try{decoded=decodeURIComponent(href.split('#')[0]);}catch{fail('EPUB 正文路径编码无效');}const path=posix.normalize(posix.join(base,decoded));if(path.startsWith('../')||path.includes('/../'))fail('EPUB 正文路径无效');
    const text=htmlText(decodeDocumentXml(files[path],path));if(text)chapters.push(`[Chapter ${chapters.length+1}]\n${text}`);
  }
  if(!chapters.length)fail('EPUB 正文没有可提取的文本');return cleanExtractedText(chapters.join('\n\n'));
}

const MIME={
  odt:'application/vnd.oasis.opendocument.text',ods:'application/vnd.oasis.opendocument.spreadsheet',
  odp:'application/vnd.oasis.opendocument.presentation',epub:'application/epub+zip'
};

export function extractDocumentText(file,type){
  const files=openDocumentArchive(file.bytes),text=type==='epub'?epub(files):odf(files,type);
  return{text,mime:MIME[type]};
}
