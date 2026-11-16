import test from 'node:test';
import assert from 'node:assert/strict';
import {createSaveQueue} from '../save-queue.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('first write starts immediately without waiting for a debounce timer',async()=>{
 const owner={},gate=deferred();let calls=0;
 const queue=createSaveQueue({persist:()=>{calls++;return gate.promise;}});
 queue.request(owner);assert.equal(calls,1);assert.equal(queue.isPending(owner),true);
 gate.resolve();await queue.wait(owner);assert.equal(queue.isPending(owner),false);
});
test('rapid edits coalesce and an older response does not acknowledge newer changes',async()=>{
 const owner={value:0},gates=[],snapshots=[],saved=[];
 const queue=createSaveQueue({persist:o=>{snapshots.push(o.value);const gate=deferred();gates.push(gate);return gate.promise;},onSaved:o=>saved.push(o.value)});
 owner.value=1;queue.request(owner);owner.value=2;queue.request(owner);owner.value=3;queue.request(owner);
 assert.deepEqual(snapshots,[1]);const complete=queue.wait(owner);
 gates[0].resolve();await tick();assert.deepEqual(snapshots,[1,3]);assert.deepEqual(saved,[]);assert.equal(queue.isPending(owner),true);
 gates[1].resolve();await complete;assert.deepEqual(saved,[3]);assert.equal(queue.isPending(owner),false);
});
test('foreground flush waits for the latest queued revision',async()=>{
 const owner={},gates=[];let finished=false;
 const queue=createSaveQueue({persist:()=>{const gate=deferred();gates.push(gate);return gate.promise;}});
 queue.request(owner);queue.request(owner);const complete=queue.wait(owner).then(()=>{finished=true;});
 gates[0].resolve();await tick();assert.equal(finished,false);gates[1].resolve();await complete;assert.equal(finished,true);
});
test('failed writes stay pending and explicit retry recovers',async()=>{
 const owner={},failure=new Error('offline');let attempts=0,failures=0,saved=0;
 const queue=createSaveQueue({persist:async()=>{if(++attempts===1)throw failure;},onError:()=>failures++,onSaved:()=>saved++});
 queue.request(owner);await assert.rejects(queue.wait(owner),/offline/);assert.equal(queue.isPending(owner),true);assert.equal(failures,1);assert.equal(saved,0);
 queue.request(owner);await queue.wait(owner);assert.equal(saved,1);assert.equal(queue.isPending(owner),false);
});
test('stale contexts never start a write',async()=>{
 const owner={};let calls=0;
 const queue=createSaveQueue({isCurrent:()=>false,persist:async()=>calls++});
 queue.request(owner);await assert.rejects(queue.wait(owner),{code:'STALE_SETTINGS_CONTEXT'});assert.equal(calls,0);
});
test('cancelling an in-flight owner cannot acknowledge its replacement',async()=>{
 const owner={},gates=[];let saved=0;
 const queue=createSaveQueue({persist:()=>{const gate=deferred();gates.push(gate);return gate.promise;},onSaved:()=>saved++});
 queue.request(owner);queue.cancel(owner);queue.request(owner);const complete=queue.wait(owner);
 gates[0].resolve();await tick();assert.equal(saved,0);assert.equal(gates.length,2);
 gates[1].resolve();await complete;assert.equal(saved,1);
});
