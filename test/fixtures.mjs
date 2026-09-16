import { once } from 'node:events';
export const confirmedModels = async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference'}]}});

// Let the OS avoid reserved/excluded Windows port ranges. Manually selecting a
// random port can fail with EACCES when Hyper-V has reserved that port.
export async function listenForFetch(server) {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
}
