import { createHash } from 'node:crypto';

const TTL=10*60*1000,MAX_ENTRIES=256,MAX_RESPONSE_BYTES=8*1024*1024,MAX_CACHED_BYTES=16*1024*1024;
const replayHeaders=['content-type','cache-control','x-usage-source','x-accel-buffering'];
const failure=(status,message)=>Object.assign(new Error(message),{status,param:'Idempotency-Key'});
const canonical=value=>JSON.stringify(value,(_key,part)=>part&&typeof part==='object'&&!Array.isArray(part)
  ?Object.fromEntries(Object.entries(part).sort(([left],[right])=>left<right?-1:left>right?1:0)):part);

export class IdempotencyStore {
  constructor(){this.entries=new Map();this.bytes=0;this.pendingBytes=0;this.failed=new WeakMap();this.inFlight=new WeakMap();}

  fail(res){this.failed.set(res,{started:res.headersSent});}
  dispatched(res){const entry=this.inFlight.get(res);if(entry)entry.dispatched=true;}

  prune(){
    const now=Date.now();
    for(const [key,entry] of this.entries)if(entry.done&&entry.expires<=now){this.bytes-=entry.size||0;this.entries.delete(key);}
  }

  async begin(header,path,body,res){
    if(header===undefined)return false;
    if(typeof header!=='string'||!/^[\x21-\x7e]{1,255}$/.test(header))throw failure(400,'Idempotency-Key 必须是 1–255 个可打印 ASCII 字符');
    this.prune();
    const key=`${path}\0${header}`;
    const fingerprint=createHash('sha256').update(canonical(body)).digest('hex');
    const existing=this.entries.get(key);
    if(existing){
      if(existing.fingerprint!==fingerprint)throw failure(409,'Idempotency-Key 已用于不同请求');
      const result=await new Promise((resolve,reject)=>{
        if(res.destroyed)return reject(failure(499,'客户端已断开'));
        const closed=()=>reject(failure(499,'客户端已断开'));
        res.once('close',closed);
        existing.promise.then(value=>{res.removeListener('close',closed);resolve(value);},cause=>{res.removeListener('close',closed);reject(cause);});
      });
      if(res.destroyed)throw failure(499,'客户端已断开');
      if(!result)throw failure(409,'同一幂等请求未成功完成，请使用原键重试');
      if(result.unreplayable)throw failure(409,result.reason||'幂等响应超过重放容量，已阻止重复调用上游');
      res.writeHead(result.status,result.headers);res.end(result.body);
      return true;
    }
    if(this.entries.size>=MAX_ENTRIES)throw failure(429,'幂等请求记录已满，请稍后重试');
    let resolve;
    const promise=new Promise(done=>{resolve=done;});
    const entry={fingerprint,promise,resolve,done:false,dispatched:false,expires:Infinity,size:0};
    this.entries.set(key,entry);
    this.inFlight.set(res,entry);
    const chunks=[];let length=0,captured=0,overflow=false;
    const collect=chunk=>{
      if(overflow||chunk===undefined||chunk===null)return;
      if(typeof chunk!=='string'&&!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array))return;
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      length+=bytes.length;
      if(length>MAX_RESPONSE_BYTES||this.bytes+this.pendingBytes+bytes.length>MAX_CACHED_BYTES){
        overflow=true;chunks.length=0;this.pendingBytes-=captured;captured=0;return;
      }
      this.pendingBytes+=bytes.length;captured+=bytes.length;
      chunks.push(Buffer.from(bytes));
    };
    const writeHead=res.writeHead.bind(res),write=res.write.bind(res),end=res.end.bind(res);let inEnd=false;
    const sentHeaders=Object.create(null);
    res.writeHead=(status,...args)=>{
      const headers=args.at(-1);
      if(headers&&typeof headers==='object'&&!Array.isArray(headers))for(const [name,value] of Object.entries(headers)){
        const lower=name.toLowerCase();if(replayHeaders.includes(lower))sentHeaders[lower]=value;
      }
      return writeHead(status,...args);
    };
    res.write=(chunk,...args)=>{if(!inEnd)collect(chunk);return write(chunk,...args);};
    res.end=(chunk,...args)=>{collect(chunk);inEnd=true;try{return end(chunk,...args);}finally{inEnd=false;}};
    const settle=()=>{
      if(entry.done)return;
      entry.done=true;entry.expires=Date.now()+TTL;
      this.inFlight.delete(res);
      this.pendingBytes-=captured;
      if(res.writableFinished&&res.statusCode>=200&&res.statusCode<300&&!this.failed.has(res)){
        const headers={};for(const name of replayHeaders){const value=sentHeaders[name]??res.getHeader(name);if(value!==undefined)headers[name]=value;}
        const result=overflow||this.bytes+length>MAX_CACHED_BYTES
          ?{unreplayable:true}
          :{status:res.statusCode,headers,body:Buffer.concat(chunks,length)};
        entry.size=result.body?.length||0;this.bytes+=entry.size;
        entry.resolve(result);
      }else if(entry.dispatched||this.failed.get(res)?.started||!res.writableFinished&&res.headersSent){entry.resolve({unreplayable:true,reason:entry.dispatched?'幂等请求已发送至上游但未成功完成，已阻止重复调用上游':'幂等请求已开始输出但未成功完成，已阻止重复调用上游'});}
      else{this.entries.delete(key);entry.resolve(null);}
    };
    res.once('finish',settle);res.once('close',settle);
    return false;
  }
}
