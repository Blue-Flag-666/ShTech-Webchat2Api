const failure = (status, message) => Object.assign(new Error(message), { status });

export class RequestQueue {
  constructor(limit = 1, maximum = 32, timeout = 120000) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('并发数必须为正整数');
    if (!Number.isInteger(maximum) || maximum < 0) throw new Error('队列长度必须为非负整数');
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('排队超时必须为正数');
    this.limit=limit;this.maximum=maximum;this.timeout=timeout;this.active=0;this.waiting=[];
  }
  async acquire(signal) {
    if (signal?.aborted) throw failure(499,'客户端已断开');
    if (this.active < this.limit) { this.active++; return this.release(); }
    if (this.waiting.length >= this.maximum) throw failure(429,'请求队列已满，请稍后重试');
    return new Promise((resolve,reject)=>{
      const entry={resolve,reject,timer:null,abort:null,signal};
      const remove=()=>{const index=this.waiting.indexOf(entry);if(index>=0)this.waiting.splice(index,1);};
      entry.timer=setTimeout(()=>{remove();signal?.removeEventListener('abort',entry.abort);reject(failure(429,'排队等待超时，请稍后重试'));},this.timeout);
      entry.abort=()=>{remove();clearTimeout(entry.timer);reject(failure(499,'客户端已断开'));};
      signal?.addEventListener('abort',entry.abort,{once:true});
      this.waiting.push(entry);
    });
  }
  release() {
    let used=false;
    return ()=>{
      if(used)return;used=true;
      const next=this.waiting.shift();
      if(next){clearTimeout(next.timer);next.abort&&next.signal?.removeEventListener('abort',next.abort);next.resolve(this.release());}
      else this.active--;
    };
  }
  get depth(){return this.waiting.length;}
}
