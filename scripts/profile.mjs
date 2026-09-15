// Offline, synthetic end-to-end profile. Does not load .env or contact school.
import { spawnSync } from 'node:child_process';
import { createServer } from '../src/server.mjs';
import { listenForFetch, confirmedModels } from '../test/fixtures.mjs';

const paths=['/v1/chat/completions','/v1/responses','/v1/messages'];
if (!process.argv[2]) {
  console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,description:'Synthetic 4 MiB ASCII reply; proxy and draining client in same process; isolated process per protocol'}));
  for(const path of paths) {
    const child=spawnSync(process.execPath,[process.argv[1],path],{encoding:'utf8'});
    if(child.status!==0) throw new Error(child.stderr || 'Profile subprocess failed');
    process.stdout.write(child.stdout);
  }
} else {
  const path=process.argv[2];
  if(!paths.includes(path)) throw new Error('Unknown protocol');
  const size=4*1024*1024, chunkSize=4096;
  const encoder=new TextEncoder();
  const server=createServer({key:'profile',token:'mock',group:'mock',timeout:30000},async()=>{
    let sent=0;
    return new Response(new ReadableStream({pull(c){
      if(sent<size){sent+=chunkSize;c.enqueue(encoder.encode(`data: ${JSON.stringify({choices:[{index:0,delta:{content:'x'.repeat(chunkSize)},finish_reason:null}]})}\n\n`));}
      else{c.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'));c.close();}
    }}),{headers:{'content-type':'text/event-stream'}});
  },confirmedModels);
  await listenForFetch(server);
  const baseline=process.memoryUsage().rss, start=performance.now();
  try {
    const input=path==='/v1/responses'?{input:'profile'}:{messages:[{role:'user',content:'profile'}],max_tokens:16384};
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{authorization:'Bearer profile','content-type':'application/json'},body:JSON.stringify({...input,stream:true})});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    let wireBytes=0;
    for await(const chunk of response.body) wireBytes+=chunk.byteLength;
    console.log(JSON.stringify({path,replyBytes:size,wireBytes,elapsedMs:Math.round(performance.now()-start),baselineRssMiB:Math.round(baseline/1048576),peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024)}));
  } finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
