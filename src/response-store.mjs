const failure=(status,message)=>Object.assign(new Error(message),{status});

export class ResponseStore {
  constructor(maximum=128,ttl=60*60*1000,label='响应'){
    if(!Number.isInteger(maximum)||maximum<0)throw new Error('响应存储数量必须为非负整数');
    if(!Number.isFinite(ttl)||ttl<=0)throw new Error('响应存储有效期必须为正数');
    this.maximum=maximum;this.ttl=ttl;this.label=label;this.entries=new Map();
  }
  prune(now=Date.now()){
    for(const [id,entry] of this.entries)if(entry.expires<=now)this.entries.delete(id);
    while(this.entries.size>this.maximum)this.entries.delete(this.entries.keys().next().value);
  }
  set(id,value){
    if(!this.maximum)return;
    this.prune();this.entries.delete(id);this.entries.set(id,{expires:Date.now()+this.ttl,value:structuredClone(value)});this.prune();
  }
  get(id){
    this.prune();const entry=this.entries.get(id);if(!entry)throw failure(404,`${this.label}不存在或已过期：${id}`);
    return structuredClone(entry.value);
  }
  delete(id){
    this.prune();if(!this.entries.delete(id))throw failure(404,`${this.label}不存在或已过期：${id}`);
  }
  get size(){this.prune();return this.entries.size;}
}
