import { once } from 'node:events';
import { randomInt } from 'node:crypto';
export const confirmedModels = async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference'}]}});

// Avoid Fetch-blocked ports in Windows custom ephemeral port ranges.
export async function listenForFetch(server) {
  for (let attempt=0;attempt<100;attempt++) {
    try {
      server.listen(randomInt(20000,60000),'127.0.0.1'); await once(server,'listening');
      return;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('Could not allocate a Fetch-compatible test port');
}
