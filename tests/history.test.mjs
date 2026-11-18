import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryStore,assertHistoryStore,versionsFor,versionById,headVersion,normalizeVersion,validateVersion,suggestVersion,serializePreset,groupsForPreset,replacePresetGroups,planVersionSave,removeVersion,historyBytes} from '../history.js';

const scope=(name,character='a')=>JSON.stringify([name,'global',character]);
const preset=()=>({temperature:0.7,extensions:{foreign:{x:1}},unknown:{keep:true},prompts:[
    {identifier:'a',name:'A',content:'original',marker:false,foreign:{nested:[1,2]}},
    {identifier:'unused',name:'Library only',content:'retained'},
],prompt_order:[{character_id:'a',order:[{identifier:'a',enabled:false,foreign:17}],foreign:'bucket'},{character_id:'b',order:[{identifier:'a',enabled:true}]}]});
let counter=0;
const save=(store,name='One',version=suggestVersion(store,name),options={})=>planVersionSave(store,{presetName:name,version,preset:preset(),initialPreset:preset(),scope:scope(name),idFactory:()=>`version-${++counter}`,createdAt:'2026-11-18T12:00:00.000Z',...options});

test('first complete save keeps the original and records a distinct saved version',()=>{
    const original=preset(),edited=preset();edited.prompts[0].content='edited';
    const result=save(createHistoryStore(),'One','v1.0',{initialPreset:original,preset:edited,note:' Change content '});
    assert.deepEqual(result.store.versions.map(record=>record.version),['初始版本','v1.0']);
    assert.equal(result.initial.preset.prompts[0].content,'original');
    assert.equal(result.record.preset.prompts[0].content,'edited');
    assert.equal(result.record.note,'Change content');
    assert.equal(result.record.parentId,result.initial.id);
    assert.equal(headVersion(result.store,'One').id,result.record.id);
    assert.equal(result.store.workingByScope[scope('One')],result.record.id);
});
test('snapshots and planned stores share no mutable data with sources or older stores',()=>{
    const original=preset(),store=createHistoryStore(),result=save(store,'One','v1.0',{preset:original});
    original.prompts[0].foreign.nested.push(3);original.prompt_order[0].order[0].enabled=true;
    assert.deepEqual(result.record.preset.prompts[0].foreign.nested,[1,2]);
    assert.equal(result.record.preset.prompt_order[0].order[0].enabled,false);
    assert.equal(store.versions.length,0);
    const second=save(result.store);second.store.versions[0].preset.unknown.keep=false;
    assert.equal(result.store.versions[0].preset.unknown.keep,true);
});
test('full JSON round trips preserve unknown fields, unused prompts and all character buckets',()=>{
    const source=preset();source.optional=undefined;
    const snapshot=serializePreset(source);
    assert.deepEqual(snapshot,JSON.parse(JSON.stringify(source)));
    const result=save(createHistoryStore(),'One','v1.0',{preset:source});
    assert.deepEqual(serializePreset(versionById(JSON.parse(JSON.stringify(result.store)),'One',result.record.id).preset),snapshot);
});
test('version suggestions advance beyond all recorded versions, not the loaded parent',()=>{
    let {store,record}=save(createHistoryStore(),'One','v1.0');const first=record;
    ({store}=save(store,'One','v1.1'));({store}=save(store,'One','v1.2'));
    assert.equal(suggestVersion(store,'One'),'v1.3');
    const branch=save(store,'One',suggestVersion(store,'One'),{parentId:first.id});
    assert.equal(branch.record.parentId,first.id);
    assert.equal(branch.record.version,'v1.3');
    assert.deepEqual(versionsFor(branch.store,'One').map(item=>item.version),['初始版本','v1.0','v1.1','v1.2','v1.3']);
});
test('numeric version sorting and custom labels do not produce duplicate defaults',()=>{
    let {store}=save(createHistoryStore(),'One','v1.9');({store}=save(store,'One','v1.10'));
    assert.equal(suggestVersion(store,'One'),'v1.11');
    ({store}=save(store,'One','v2.3.8'));assert.equal(suggestVersion(store,'One'),'v2.3.9');
    assert.equal(suggestVersion(createHistoryStore(),'One'),'v1.0');
    assert.equal(normalizeVersion('  V1.2  '),'v1.2');
    assert.equal(normalizeVersion('  Draft B  '),'Draft B');
});
test('duplicate labels and invalid metadata fail without altering history',()=>{
    const {store}=save(createHistoryStore(),'One','v1.0'),before=structuredClone(store);
    assert.throws(()=>save(store,'One','V1.0'),/已经存在/);
    assert.throws(()=>validateVersion(store,'One','   '));
    assert.throws(()=>validateVersion(store,'One','bad\nlabel'));
    assert.throws(()=>validateVersion(store,'One','x'.repeat(65)));
    assert.throws(()=>validateVersion(store,'One','v1.1','x'.repeat(501)));
    assert.throws(()=>save(createHistoryStore(),'One','初始版本'));
    assert.deepEqual(store,before);
});
test('preset histories are isolated, even for names used by object prototypes',()=>{
    let {store}=save(createHistoryStore(),'__proto__','v1.0');({store}=save(store,'constructor','v1.0'));
    assert.equal(versionsFor(store,'__proto__').length,2);
    assert.equal(versionsFor(store,'constructor').length,2);
    assert.equal(suggestVersion(store,'__proto__'),'v1.1');
    assert.equal(headVersion(store,'constructor').version,'v1.0');
    assert.equal({}.polluted,undefined);
});
test('group collection and restoration change only the target preset across all scopes',()=>{
    const group={id:'g',startId:'a',endId:'unused',name:'Group',collapsed:true};
    const groups={[scope('One')]:[group],[scope('One','b')]:[{...group,id:'gb'}],[scope('Other')]:[{...group,id:'other'}]};
    const captured=groupsForPreset(groups,'One');captured[scope('One')][0].name='Saved';
    assert.equal(groups[scope('One')][0].name,'Group');
    const restored=replacePresetGroups({...groups,[scope('One','new')]:[]},'One',captured);
    assert.equal(restored[scope('One')][0].name,'Saved');
    assert.deepEqual(restored[scope('Other')],groups[scope('Other')]);
    assert.equal(restored[scope('One','new')],undefined);
    assert.equal(Object.keys(captured).length,2);
});
test('removing a version leaves preset content and other histories untouched',()=>{
    let {store,record}=save(createHistoryStore());const selected=record;
    ({store}=save(store,'Other','v1.0'));const before=structuredClone(store);
    const next=removeVersion(store,'One',selected.id);
    assert.equal(versionById(next,'One',selected.id),null);
    assert.equal(headVersion(next,'One'),null);
    assert.equal(next.workingByScope[scope('One')],undefined);
    assert.deepEqual(versionsFor(next,'Other'),versionsFor(store,'Other'));
    assert.deepEqual(store,before);
    assert.throws(()=>removeVersion(store,'Other',selected.id));
});
test('unknown schemas and malformed snapshots are rejected rather than silently replaced',()=>{
    assert.throws(()=>assertHistoryStore({schemaVersion:2,versions:[],heads:{},workingByScope:{}}));
    assert.throws(()=>serializePreset({prompts:[],prompt_order:null}));
    const duplicate=preset();duplicate.prompts.push({...duplicate.prompts[0]});assert.throws(()=>serializePreset(duplicate));
    const duplicateOrder=preset();duplicateOrder.prompt_order[0].order.push({...duplicateOrder.prompt_order[0].order[0]});assert.throws(()=>serializePreset(duplicateOrder));
    assert.throws(()=>save(createHistoryStore(),'One','v1.0',{idFactory:()=> 'same'}));
});
test('history size measures persisted UTF-8 rather than character count',()=>{
    const {store}=save(createHistoryStore(),'预设','v1.0',{note:'更新说明'});
    assert.equal(historyBytes(store),Buffer.byteLength(JSON.stringify(store),'utf8'));
});
