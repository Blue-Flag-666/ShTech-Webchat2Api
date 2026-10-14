import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamCircuit } from '../src/circuit.mjs';

test('按模型熔断并只允许一个半开探测',()=>{
  let now=1000;
  const circuit=new UpstreamCircuit(2,1000,()=>now);
  assert.equal(circuit.enter('kimi-k3'),0);
  circuit.failure('kimi-k3');
  assert.equal(circuit.enter('kimi-k3'),0);
  circuit.failure('kimi-k3');
  assert.equal(circuit.enter('kimi-k3'),1);
  assert.equal(circuit.enter('qwen-instruct'),0);
  now+=1000;
  assert.equal(circuit.enter('kimi-k3'),0);
  assert.equal(circuit.enter('kimi-k3'),1);
  circuit.success('kimi-k3');
  assert.equal(circuit.enter('kimi-k3'),0);
});

test('半开探测失败后重新冷却',()=>{
  let now=1000;
  const circuit=new UpstreamCircuit(1,1000,()=>now);
  circuit.failure('kimi-k3');
  now+=1000;
  assert.equal(circuit.enter('kimi-k3'),0);
  circuit.failure('kimi-k3');
  assert.equal(circuit.enter('kimi-k3'),1);
});
