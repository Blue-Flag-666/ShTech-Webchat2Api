import { randomBytes } from 'node:crypto';
import { upstreamFetch, readJsonLimited } from './transport.mjs';

const origin='https://genai.shanghaitech.edu.cn';
const failure=message=>Object.assign(new Error(message),{status:502});

function multipart(file){
  const boundary=`----shtech-${randomBytes(18).toString('hex')}`;
  const filename=file.filename.replace(/[\r\n"\\]/g,'_');
  const mime=/^[\w.+-]+\/[\w.+-]+$/.test(file.mime||'')?file.mime:'application/octet-stream';
  const body=Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    file.bytes,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="biz"\r\n\r\ntemp\r\n--${boundary}--\r\n`)
  ]);
  return{boundary,body};
}

export async function uploadNativeFiles(files,{chatGroupId,aiType,accessToken,cookie,signal,fetcher=upstreamFetch}){
  if(!files.length)return [];
  if(typeof chatGroupId!=='string'||!chatGroupId||typeof aiType!=='string'||!aiType)throw new Error('原生文件上传需要会话 ID 和模型 ID');
  const fileIds=[];
  for(const file of files){
    if(!Buffer.isBuffer(file.bytes)||!file.bytes.length||file.bytes.length>=10*1024*1024)throw Object.assign(new Error('单个文件必须小于 10 MiB'),{status:413});
    const {boundary,body}=multipart(file);
    const url=new URL('/htk/chat/upload/chat/file',origin);
    url.searchParams.set('chatGroupId',chatGroupId);url.searchParams.set('aiType',aiType);
    const headers={Accept:'application/json','Content-Type':`multipart/form-data; boundary=${boundary}`,'X-Access-Token':accessToken,Origin:origin,Referer:`${origin}/dashboard/analysis`};
    if(cookie)headers.Cookie=cookie;
    const response=await fetcher(url.href,{method:'POST',headers,body,signal,redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw failure(`学校文件上传 HTTP ${response.status}`);}
    let payload;try{payload=await readJsonLimited(response,1024*1024);}catch{throw failure('学校文件上传返回无效 JSON');}
    const fileId=payload?.result?.fileId;
    if(payload?.success===false||typeof fileId!=='string'||!fileId)throw failure('学校文件上传未返回 fileId');
    fileIds.push(fileId);
  }
  return fileIds;
}
