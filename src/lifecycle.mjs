const pending = new WeakMap();

// Stop accepting requests, allow active work to drain, then close its sockets.
export function shutdown(server, graceMs=5000) {
  if (pending.has(server)) return pending.get(server);
  const promise=new Promise((resolve,reject)=>{
    let forced=false;
    // Connections active at close() may become idle after their response ends.
    const idle=setInterval(()=>server.closeIdleConnections(),25);
    idle.unref();
    const timer=setTimeout(()=>{forced=true;server.closeAllConnections();},graceMs);
    timer.unref();
    server.close(error=>{
      clearTimeout(timer);
      clearInterval(idle);
      if(error && error.code!=='ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve({forced});
    });
  });
  pending.set(server,promise);
  return promise;
}
