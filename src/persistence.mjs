import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';

const safeName=value=>Buffer.from(String(value)).toString('base64url');

export class PersistentMap extends Map {
  constructor(directory,{encode=value=>value,decode=value=>value}={}){
    super();this.directory=resolve(directory);this.encode=encode;this.decode=decode;
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    for(const name of readdirSync(this.directory)){
      if(name.endsWith('.tmp')){try{rmSync(join(this.directory,name),{force:true});}catch{}continue;}
      if(!name.endsWith('.bin'))continue;
      const path=join(this.directory,name);let record;
      try{record=deserialize(readFileSync(path));}catch(cause){throw new Error(`持久化资源损坏：${path}`,{cause});}
      if(record?.format!==1||typeof record.key!=='string'||safeName(record.key)!==name.slice(0,-4))throw new Error(`持久化资源格式无效：${path}`);
      super.set(record.key,this.decode(record.value));
    }
  }
  path(key){return join(this.directory,`${safeName(key)}.bin`);}
  persist(key,value){
    const target=this.path(key),temporary=`${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,bytes=serialize({format:1,key:String(key),value:this.encode(value)});
    let descriptor;try{descriptor=openSync(temporary,'wx',0o600);writeSync(descriptor,bytes);fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;renameSync(temporary,target);}finally{if(descriptor!==undefined)try{closeSync(descriptor);}catch{}if(existsSync(temporary))try{rmSync(temporary,{force:true});}catch{}}
  }
  set(key,value){this.persist(key,value);return super.set(key,value);}
  sync(key){if(super.has(key))this.persist(key,super.get(key));}
  delete(key){const removed=super.delete(key);if(removed)rmSync(this.path(key),{force:true});return removed;}
  clear(){for(const key of this.keys())this.delete(key);}
}

export class DiskState {
  constructor(directory){this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true,mode:0o700});}
  map(name,options){if(!/^[a-z][a-z0-9-]*$/.test(name))throw new Error('持久化命名空间无效');return new PersistentMap(join(this.directory,name),options);}
}
