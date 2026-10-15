// Time spent consuming a yielded event (including downstream backpressure) is
// outside the upstream wait budget. Each next event gets a fresh idle deadline.
export async function* withStreamTimeout(source, milliseconds) {
  const iterator=source[Symbol.asyncIterator]();
  let finished=false;
  try {
    while(true){
      let timer;
      const timeout=new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(new Error(`上游连续 ${milliseconds} ms 未返回有效响应数据`),{status:504})),milliseconds);
      });
      let next;
      try{next=await Promise.race([iterator.next(),timeout]);}
      finally{clearTimeout(timer);}
      if(next.done){finished=true;return;}
      yield next.value;
    }
  }finally{
    // A source that ignores cancellation must not hold the client open forever.
    // The request owner also aborts its HTTP controller in its own finally.
    if(!finished)try{void Promise.resolve(iterator.return?.()).catch(()=>{});}catch{}
  }
}
