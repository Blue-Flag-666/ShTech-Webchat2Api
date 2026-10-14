import { validModelId } from './models.mjs';

const failure = (status, message) => Object.assign(new Error(message), { status });

export class RequestQueue {
  constructor(limit = 1, maximum = 32, timeout = 120000, models = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('并发数必须为正整数');
    if (!Number.isInteger(maximum) || maximum < 0) throw new Error('队列长度必须为非负整数');
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('排队超时必须为正数');
    if(!models||typeof models!=='object'||Array.isArray(models))throw new Error('模型队列配置必须是对象');
    for(const [model,value] of Object.entries(models)){
      if(!validModelId(model)||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['concurrency','queue'].includes(key)))throw new Error('模型队列配置无效');
      if(value.concurrency!==undefined&&(!Number.isInteger(value.concurrency)||value.concurrency<1))throw new Error('模型并发数必须为正整数');
      if(value.queue!==undefined&&(!Number.isInteger(value.queue)||value.queue<0))throw new Error('模型队列长度必须为非负整数');
    }
    this.limit=limit;this.maximum=maximum;this.timeout=timeout;this.models=Object.assign(Object.create(null),models);this.active=0;this.activeModels=new Map();this.waiting=[];
  }
  capacity(model){return this.active<this.limit&&(this.activeModels.get(model)||0)<(this.models[model]?.concurrency??this.limit);}
  grant(model){
    this.active++;this.activeModels.set(model,(this.activeModels.get(model)||0)+1);
    let used=false;
    return ()=>{
      if(used)return;used=true;
      this.active--;const count=this.activeModels.get(model)-1;
      if(count)this.activeModels.set(model,count);else this.activeModels.delete(model);
      this.drain();
    };
  }
  drain(){
    while(this.active<this.limit){
      const index=this.waiting.findIndex(entry=>this.capacity(entry.model));
      if(index<0)break;
      const [next]=this.waiting.splice(index,1);
      clearTimeout(next.timer);next.signal?.removeEventListener('abort',next.abort);
      next.resolve(this.grant(next.model));
    }
  }
  async acquire(signal,model='default') {
    if (signal?.aborted) throw failure(499,'客户端已断开');
    if(typeof model!=='string'||!model)throw new Error('模型队列名称无效');
    if (this.capacity(model))return this.grant(model);
    if (this.waiting.length >= this.maximum) throw failure(429,'请求队列已满，请稍后重试');
    if(this.waiting.filter(entry=>entry.model===model).length>=(this.models[model]?.queue??this.maximum))throw failure(429,`模型 ${model} 的请求队列已满`);
    return new Promise((resolve,reject)=>{
      const entry={resolve,reject,timer:null,abort:null,signal,model};
      const remove=()=>{const index=this.waiting.indexOf(entry);if(index>=0)this.waiting.splice(index,1);};
      entry.timer=setTimeout(()=>{remove();signal?.removeEventListener('abort',entry.abort);reject(failure(429,'排队等待超时，请稍后重试'));},this.timeout);
      entry.abort=()=>{remove();clearTimeout(entry.timer);reject(failure(499,'客户端已断开'));};
      signal?.addEventListener('abort',entry.abort,{once:true});
      this.waiting.push(entry);
      if(signal?.aborted)entry.abort();
    });
  }
  get depth(){return this.waiting.length;}
}
