export class UpstreamCircuit {
  constructor(failures=3,cooldownMs=30000,clock=Date.now) {
    this.failures=failures;this.cooldownMs=cooldownMs;this.clock=clock;this.states=new Map();
  }
  enter(model) {
    const state=this.states.get(model);
    if(!state)return 0;
    const now=this.clock();
    if(state.openUntil>now)return Math.max(1,Math.ceil((state.openUntil-now)/1000));
    if(state.failures>=this.failures){
      if(state.probing)return Math.max(1,Math.ceil(this.cooldownMs/1000));
      state.probing=true;
    }
    return 0;
  }
  success(model) {this.states.delete(model);}
  failure(model) {
    const state=this.states.get(model)||{failures:0,openUntil:0,probing:false};
    state.failures++;
    state.probing=false;
    if(state.failures>=this.failures)state.openUntil=this.clock()+this.cooldownMs;
    this.states.set(model,state);
  }
  release(model) {
    const state=this.states.get(model);
    if(state?.probing){state.probing=false;state.openUntil=this.clock()+this.cooldownMs;}
  }
}
