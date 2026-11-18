import test from 'node:test';
import assert from 'node:assert/strict';
import {textMatch,literalSearchPattern} from '../search.js';
import {replaceLiteralContent,planContentReplacement,prepareReplacementPatch,prepareReplacementUndo,mapReplacementOffset} from '../replace.js';

const entry=(id,content,extra={})=>({id,name:`Entry ${id}`,content,editable:true,revision:`base-${id}`,...extra});
const plan=(entries,replacement='new',options={})=>planContentReplacement(entries,'old',replacement,options);

test('replacement follows literal search and replaces every case-insensitive match',()=>{
    const result=replaceLiteralContent('Old old OLD','old','new');
    assert.equal(result.after,'new new new');assert.equal(result.count,3);
    assert.deepEqual(textMatch('Old old OLD','old'),{start:0,end:3});
    assert.equal(literalSearchPattern('',{all:true}),null);
});
test('case-sensitive replacement changes only the requested spelling',()=>{
    const result=replaceLiteralContent('Old old OLD','old','new',{caseSensitive:true});
    assert.equal(result.after,'Old new OLD');assert.equal(result.count,1);
});
test('query metacharacters are literal and replacement dollars and slashes never expand',()=>{
    const query='[$1].*',replacement='$& $1 '+String.fromCharCode(92)+'n';
    const result=replaceLiteralContent(`${query} / ${query}`,query,replacement);
    assert.equal(result.after,`${replacement} / ${replacement}`);assert.equal(result.count,2);
    const slash=String.fromCharCode(92);
    assert.equal(replaceLiteralContent(`a${slash}b${slash}c`,slash,'/').after,'a/b/c');
});
test('multiline and whitespace replacement text is kept exactly as entered',()=>{
    assert.equal(replaceLiteralContent('old + old',' old ',' first\nsecond ').after,' first\nsecond  +  first\nsecond ');
    assert.equal(replaceLiteralContent('old','old',' ').after,' ');
});
test('empty replacement deletes matches but empty searches never insert or delete anything',()=>{
    const result=replaceLiteralContent('a old b old','old','');assert.equal(result.after,'a  b ');assert.equal(result.count,2);
    for(const query of ['', '   ', null])assert.throws(()=>replaceLiteralContent('source',query,'x'));
    assert.throws(()=>planContentReplacement([], '', 'x'));
    assert.throws(()=>replaceLiteralContent('old','old',null));
});
test('adjacent matches are non-overlapping and never recursively replace new text',()=>{
    assert.equal(replaceLiteralContent('aaaa','aa','x').after,'xx');
    const result=replaceLiteralContent('old old','old','old old');assert.equal(result.count,2);assert.equal(result.after,'old old old old');
});
test('planning excludes title-only matches, skips protected bodies and does not mutate sources',()=>{
    const entries=[entry('a','old old'),entry('title','unrelated',{name:'old title'}),entry('locked','old',{editable:false,reason:'Read-only'})],before=structuredClone(entries);
    const result=plan(entries);
    assert.deepEqual(result.changes.map(change=>change.id),['a']);assert.equal(result.totalCount,2);
    assert.deepEqual(result.skipped,[{id:'locked',name:'Entry locked',count:1,reason:'Read-only'}]);
    assert.deepEqual(entries,before);
});
test('replacement with identical content creates no dirty patch',()=>{
    const result=plan([entry('a','old')],'old');assert.equal(result.changes.length,0);assert.equal(result.skipped.length,1);
    assert.throws(()=>prepareReplacementPatch(result,[],[entry('a','old')]));
});
test('checkbox selection produces only the chosen body patches',()=>{
    const entries=[entry('a','old'),entry('b','old old')],preview=plan(entries);
    const changes=prepareReplacementPatch(preview,['b'],entries);
    assert.deepEqual(changes.map(change=>change.id),['b']);assert.equal(changes[0].after,'new new');
    changes[0].matches[0].start=99;assert.equal(preview.changes[1].matches[0].start,0);
    assert.throws(()=>prepareReplacementPatch(preview,['a','a'],entries));
    assert.throws(()=>prepareReplacementPatch(preview,['missing'],entries));
});
test('preflight rejects changed text or permissions before any batch write',()=>{
    const entries=[entry('a','old'),entry('b','old')],preview=plan(entries);
    for(const changed of [[entries[0],{...entries[1],content:'later'}],[entries[0],{...entries[1],editable:false}]]){
        const before=structuredClone(changed);assert.throws(()=>prepareReplacementPatch(preview,['a','b'],changed),{code:'STALE_REPLACEMENT'});assert.deepEqual(changed,before);
    }
});
test('preflight also rejects a changed native/save revision with identical visible text',()=>{
    const entries=[entry('a','old')],preview=plan(entries);
    assert.throws(()=>prepareReplacementPatch(preview,['a'],[entry('a','old',{revision:'new-base'})]),{code:'STALE_REPLACEMENT'});
});
test('undo returns exactly the previous unsaved body without altering other data',()=>{
    const before=[entry('a','old with prior draft',{role:'user'})],changes=prepareReplacementPatch(plan(before),['a'],before);
    const current=[{...before[0],name:'Later title',content:changes[0].after,role:'assistant'}],snapshot=structuredClone(current);
    const undo=prepareReplacementUndo({changes,undone:false},current);
    assert.equal(undo[0].after,'old with prior draft');assert.deepEqual(current,snapshot);
    assert.equal(current[0].name,'Later title');assert.equal(current[0].role,'assistant');
});
test('undo never overwrites later manual edits, saved revisions or missing entries',()=>{
    const entries=[entry('a','old'),entry('b','old')],changes=prepareReplacementPatch(plan(entries),['a','b'],entries);
    const current=entries.map((item,index)=>({...item,content:changes[index].after}));
    for(const changed of [[current[0],{...current[1],content:'manual'}],[current[0],{...current[1],revision:'saved'}],[current[0]]]){
        const before=structuredClone(changed);assert.throws(()=>prepareReplacementUndo({changes},changed),{code:'STALE_REPLACEMENT'});assert.deepEqual(changed,before);
    }
    assert.throws(()=>prepareReplacementUndo({changes,undone:true},current));
});
test('cursor mapping accounts for every earlier replacement and supports undo',()=>{
    const result=replaceLiteralContent('a cat cat z','cat','whale');
    assert.equal(mapReplacementOffset(0,result.matches),0);
    assert.equal(mapReplacementOffset(5,result.matches),7);
    assert.equal(mapReplacementOffset(6,result.matches),8);
    assert.equal(mapReplacementOffset(11,result.matches),15);
    assert.equal(mapReplacementOffset(15,result.matches,true),11);
    assert.equal(mapReplacementOffset(13,result.matches,true),9);
});
test('Unicode offsets and case folding agree with the existing search',()=>{
    const result=replaceLiteralContent('😀 old 😀 old','old','新');assert.equal(result.after,'😀 新 😀 新');assert.equal(result.count,2);
    assert.equal(result.matches[0].start,3);assert.equal(mapReplacementOffset(13,result.matches),9);
    assert.equal(replaceLiteralContent('K','k','x').count,textMatch('K','k')?1:0);
});
test('malformed or duplicate entry IDs are rejected',()=>{
    assert.throws(()=>plan([entry('a','old'),entry('a','old')]));
    assert.throws(()=>plan([entry('','old')]));
});
