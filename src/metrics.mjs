const buckets=[0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10,30,60];
const methods=new Set(['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD']);

export class Metrics {
  constructor(){this.started=Date.now();this.requests=new Map();this.latency=buckets.map(()=>0);this.count=0;this.sum=0;}
  observe(method,status,seconds){
    const safeMethod=methods.has(method)?method:'OTHER';
    const safeStatus=Number.isInteger(status)&&status>=100&&status<=599?status:499;
    const duration=Number.isFinite(seconds)&&seconds>=0?seconds:0;
    const key=`${safeMethod}:${safeStatus}`;
    this.requests.set(key,(this.requests.get(key)||0)+1);
    this.count++;this.sum+=duration;
    for(const [index,threshold] of buckets.entries())if(duration<=threshold)this.latency[index]++;
  }
  render(gauges={}){
    const lines=[
      '# HELP shtech_http_requests_total Completed HTTP requests grouped by method and status.',
      '# TYPE shtech_http_requests_total counter'
    ];
    for(const [key,count] of [...this.requests].sort(([a],[b])=>a.localeCompare(b))){
      const [method,status]=key.split(':');lines.push(`shtech_http_requests_total{method="${method}",status="${status}"} ${count}`);
    }
    lines.push('# HELP shtech_http_request_duration_seconds HTTP request duration.','# TYPE shtech_http_request_duration_seconds histogram');
    for(const [index,threshold] of buckets.entries())lines.push(`shtech_http_request_duration_seconds_bucket{le="${threshold}"} ${this.latency[index]}`);
    lines.push(`shtech_http_request_duration_seconds_bucket{le="+Inf"} ${this.count}`);
    lines.push(`shtech_http_request_duration_seconds_sum ${this.sum}`);
    lines.push(`shtech_http_request_duration_seconds_count ${this.count}`);
    const values={
      shtech_uptime_seconds:(Date.now()-this.started)/1000,
      shtech_queue_active:gauges.queueActive,
      shtech_queue_depth:gauges.queueDepth,
      shtech_background_requests:gauges.backgroundRequests,
      shtech_stored_files:gauges.storedFiles,
      shtech_stored_vector_stores:gauges.vectorStores,
      shtech_data_used_bytes:gauges.dataUsedBytes
    };
    for(const [name,value] of Object.entries(values)){
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${Number.isFinite(value)?Math.max(0,value):0}`);
    }
    return lines.join('\n')+'\n';
  }
}
