import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePrompt,buildPromptPatch,projectOrder,mergeDraftPositions,insertId} from '../model.js';

test('patch only changes edited fields and keeps foreign fields outside the patch',()=>{
 const source={name:'a',content:'old',role:'system',foreign:{x:1}};
 const base=normalizePrompt(source),values={...base,content:'new'};
 assert.deepEqual(buildPromptPatch({base,values},{...source,name:'changed elsewhere'}),{content:'new'});
});
test('conflicting edits are rejected before writing',()=>{
 const base=normalizePrompt({content:'old'}),values={...base,content:'ours'};
 assert.throws(()=>buildPromptPatch({base,values},{content:'theirs'}),{code:'PROMPT_CONFLICT'});
});
test('same final value is not a conflict',()=>{
 const base=normalizePrompt({content:'old'}),values={...base,content:'new'};
 assert.deepEqual(buildPromptPatch({base,values},{content:'new'}),{content:'new'});
});
test('source content cannot be overwritten',()=>{
 const base=normalizePrompt({content:'source'}),values={...base,content:'wrong'};
 assert.deepEqual(buildPromptPatch({base,values},{content:'source'},{contentEditable:false}),{});
});
test('order projection ignores drafts but preserves enabled flags and object identity',()=>{
 const a={identifier:'a',enabled:false,extra:42},b={identifier:'b',enabled:true};
 const result=projectOrder([a,b],['b','draft','a']);assert.equal(result[0],b);assert.equal(result[1],a);
});
test('order projection rejects lost or duplicate native entries',()=>{
 assert.throws(()=>projectOrder([{identifier:'a'},{identifier:'b'}],['a']));
 assert.throws(()=>projectOrder([{identifier:'a'}],['a','a']));
});
test('drafts retain relative anchors when native order changes',()=>{
 assert.deepEqual(mergeDraftPositions(['x','a','b'],['a','d1','d2','b'],new Set(['d1','d2'])),['x','a','d1','d2','b']);
 assert.deepEqual(mergeDraftPositions(['a'],['a','d1','d2'],new Set(['d1','d2'])),['a','d1','d2']);
});
test('insertion is contextual and does not mutate the original',()=>{
 const ids=['a','b'];assert.deepEqual(insertId(ids,'d','a'),['a','d','b']);assert.deepEqual(ids,['a','b']);
 assert.deepEqual(insertId(ids,'d','a',true),['d','a','b']);assert.throws(()=>insertId(ids,'a','b'));
});
