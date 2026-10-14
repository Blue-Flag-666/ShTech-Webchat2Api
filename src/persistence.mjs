import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, statfsSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';

const safeName=value=>Buffer.from(String(value)).toString('base64url');
const checksum=bytes=>createHash('sha256').update(bytes).digest('hex');
const storageFull=(message,cause)=>Object.assign(new Error(message,{cause}),{status:507,code:'insufficient_storage'});

export class PersistentMap extends Map {
  constructor(directory,{encode=value=>value,decode=value=>value,reserve=()=>{}}={}){
    super();this.directory=resolve(directory);this.encode=encode;this.decode=decode;this.reserve=reserve;this.corrupt=[];this.recovered=[];
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const names=readdirSync(this.directory);
    for(const name of names)if(name.endsWith('.tmp'))try{rmSync(join(this.directory,name),{force:true});}catch{}
    const resources=new Set(names.filter(name=>name.endsWith('.bin')||name.endsWith('.bin.bak')).map(name=>name.replace(/\.bin(?:\.bak)?$/,'')));
    for(const name of resources){
      const primary=join(this.directory,`${name}.bin`),backup=`${primary}.bak`;
      let record,value;
      for(const candidate of [primary,backup]){
        if(!existsSync(candidate))continue;
        try{record=this.load(candidate,name);value=this.decode(record.value);break;}
        catch{
          record=undefined;value=undefined;
          const quarantined=`${candidate}.corrupt.${Date.now()}.${randomUUID()}`;
          renameSync(candidate,quarantined);this.corrupt.push(quarantined);
        }
      }
      if(!record)continue;
      if(!existsSync(primary)){copyFileSync(backup,primary);this.recovered.push(primary);}
      super.set(record.key,value);
    }
  }
  load(path,name){
    const record=deserialize(readFileSync(path));
    if(typeof record?.key!=='string'||safeName(record.key)!==name)throw new Error('持久化资源键无效');
    if(record.format===1)return record;
    if(record.format!==2||!Buffer.isBuffer(record.payload)&&!(record.payload instanceof Uint8Array)||typeof record.sha256!=='string')throw new Error('持久化资源格式无效');
    const payload=Buffer.from(record.payload);
    if(checksum(payload)!==record.sha256)throw new Error('持久化资源校验失败');
    return {key:record.key,value:deserialize(payload)};
  }
  path(key){return join(this.directory,`${safeName(key)}.bin`);}
  persist(key,value){
    const target=this.path(key),backup=`${target}.bak`,temporary=`${target}.${process.pid}.${randomUUID()}.tmp`;
    const payload=serialize(this.encode(value)),bytes=serialize({format:2,key:String(key),payload,sha256:checksum(payload)});
    this.reserve(bytes.length+(existsSync(target)?statSync(target).size:0));
    let descriptor;
    try{
      descriptor=openSync(temporary,'wx',0o600);writeSync(descriptor,bytes);fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
      if(existsSync(target)){
        const backupTemporary=`${backup}.${randomUUID()}.tmp`;
        try{copyFileSync(target,backupTemporary);renameSync(backupTemporary,backup);}
        finally{if(existsSync(backupTemporary))rmSync(backupTemporary,{force:true});}
      }
      renameSync(temporary,target);
    }catch(cause){
      if(['ENOSPC','EDQUOT'].includes(cause.code))throw storageFull('持久化写入失败：磁盘空间或文件系统配额不足',cause);
      throw cause;
    }finally{if(descriptor!==undefined)try{closeSync(descriptor);}catch{}if(existsSync(temporary))try{rmSync(temporary,{force:true});}catch{}}
  }
  set(key,value){this.persist(key,value);return super.set(key,value);}
  sync(key){if(super.has(key))try{this.persist(key,super.get(key));}catch(cause){
    try{const record=this.load(this.path(key),safeName(key));super.set(key,this.decode(record.value));}catch{}
    throw cause;
  }}
  delete(key){
    if(!super.has(key))return false;
    // Keep the in-memory resource until disk removal succeeds. Remove backups
    // first so a failed primary deletion cannot restore an older version later.
    rmSync(`${this.path(key)}.bak`,{force:true});
    rmSync(this.path(key),{force:true});
    return super.delete(key);
  }
  clear(){for(const key of this.keys())this.delete(key);}
}

export class DiskState {
  constructor(directory,quotaBytes=0,filesystemStats=statfsSync){
    if(!Number.isSafeInteger(quotaBytes)||quotaBytes<0)throw new Error('数据目录配额无效');
    this.directory=resolve(directory);this.quotaBytes=quotaBytes;this.filesystemStats=filesystemStats;this.corruptResources=[];this.recoveredResources=[];mkdirSync(this.directory,{recursive:true,mode:0o700});
  }
  usageBytes(){
    let total=0,stack=[this.directory];
    while(stack.length){
      const directory=stack.pop();
      for(const entry of readdirSync(directory,{withFileTypes:true})){
        const path=join(directory,entry.name);
        if(entry.isDirectory())stack.push(path);
        else if(entry.isFile())total+=statSync(path).size;
      }
    }
    return total;
  }
  reserve(bytes){
    if(this.quotaBytes&&this.usageBytes()+bytes>this.quotaBytes)throw storageFull('数据目录配额不足');
    let stats;
    try{stats=this.filesystemStats(this.directory,{bigint:true});}
    catch(cause){
      if(['ENOSYS','ENOTSUP','EOPNOTSUPP'].includes(cause.code))return;
      if(['ENOSPC','EDQUOT'].includes(cause.code))throw storageFull('数据目录所在磁盘空间不足',cause);
      throw cause;
    }
    if(BigInt(stats.bavail)*BigInt(stats.bsize)<BigInt(bytes))throw storageFull('数据目录所在磁盘空间不足');
  }
  acquireLock(){
    const path=join(this.directory,'.instance.lock'),owner=randomUUID(),contents=JSON.stringify({pid:process.pid,owner,created_at:new Date().toISOString()});
    for(let attempt=0;attempt<3;attempt++){
      let descriptor;
      try{
        descriptor=openSync(path,'wx',0o600);writeSync(descriptor,contents);fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
        let released=false;
        const release=()=>{
          if(released)return;released=true;process.removeListener('exit',release);
          try{if(JSON.parse(readFileSync(path,'utf8')).owner===owner)rmSync(path,{force:true});}catch{}
        };
        process.once('exit',release);
        return release;
      }catch(cause){
        if(descriptor!==undefined){try{closeSync(descriptor);}catch{}try{rmSync(path,{force:true});}catch{}}
        if(cause.code!=='EEXIST')throw cause;
        let stale,staleOwner;
        try{
          const record=JSON.parse(readFileSync(path,'utf8'));
          if(!Number.isInteger(record.pid)||record.pid<1||typeof record.owner!=='string')throw new Error('invalid lock');
          staleOwner=record.owner;
          try{process.kill(record.pid,0);stale=false;}catch(error){stale=error.code==='ESRCH';}
        }catch(error){if(error.code==='ENOENT')continue;stale=false;}
        if(!stale)throw new Error(`数据目录正在被另一个进程使用：${this.directory}`);
        const recovery=`${path}.recover`;
        try{mkdirSync(recovery);}catch(error){if(error.code==='EEXIST')throw new Error(`数据目录锁正在恢复：${this.directory}`);throw error;}
        try{
          let latest;try{latest=JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
          if(latest.owner!==staleOwner)continue;
          const stalePath=`${path}.stale.${randomUUID()}`;
          renameSync(path,stalePath);rmSync(stalePath,{force:true});
        }finally{rmdirSync(recovery);}
      }
    }
    throw new Error(`无法获取数据目录锁：${this.directory}`);
  }
  map(name,options){
    if(!/^[a-z][a-z0-9-]*$/.test(name))throw new Error('持久化命名空间无效');
    const result=new PersistentMap(join(this.directory,name),{...options,reserve:bytes=>this.reserve(bytes)});
    this.corruptResources.push(...result.corrupt);this.recoveredResources.push(...result.recovered);
    return result;
  }
}
