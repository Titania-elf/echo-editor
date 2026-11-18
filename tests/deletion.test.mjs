import test from 'node:test';
import assert from 'node:assert/strict';
import { planPromptDeletion } from '../model.js';

const prompt = (id, extra = {}) => ({ identifier:id, name:id, content:`body-${id}`, system_prompt:false, foreign:{keep:true}, ...extra });

test('deletion preflight finds references in every character without mutating data', () => {
    const prompts=[prompt('a'),prompt('b')],first=[{identifier:'a',enabled:true},{identifier:'b',enabled:false}];
    const second=[{identifier:'b',enabled:true},{identifier:'a',enabled:false}];
    const buckets=[{character_id:'one',order:first,foreign:'keep'},{character_id:'two',order:second}];
    const before=structuredClone({prompts,buckets});
    const plan=planPromptDeletion(prompts,buckets,'a');
    assert.equal(plan.index,0);assert.equal(plan.prompt,prompts[0]);
    assert.deepEqual(plan.references.map(reference=>reference.indices),[[0],[1]]);
    assert.equal(plan.references[0].order,first);assert.equal(plan.references[1].order,second);
    assert.deepEqual({prompts,buckets},before);
});

test('an unlinked library entry can be deleted without any order changes', () => {
    const prompts=[prompt('unused')],buckets=[{character_id:'one',order:[]}];
    const plan=planPromptDeletion(prompts,buckets,'unused');
    assert.equal(plan.index,0);assert.deepEqual(plan.references,[]);
});

test('built-in or unspecified prompt sources are never deletable', () => {
    for(const system_prompt of [true,undefined,null,0]) {
        assert.throws(()=>planPromptDeletion([prompt('a',{system_prompt})],[],'a'));
    }
});

test('native deletion permission can further restrict a custom prompt', () => {
    const prompts=[prompt('a')],before=structuredClone(prompts);
    assert.throws(()=>planPromptDeletion(prompts,[],'a',()=>false));
    assert.deepEqual(prompts,before);
});

test('missing and duplicate library identifiers are rejected', () => {
    assert.throws(()=>planPromptDeletion([prompt('b')],[],'a'));
    const prompts=[prompt('a'),prompt('a')],before=structuredClone(prompts);
    assert.throws(()=>planPromptDeletion(prompts,[],'a'));
    assert.deepEqual(prompts,before);
});

test('malformed inactive orders are rejected before any mutation', () => {
    const prompts=[prompt('a')],buckets=[{character_id:'one',order:[{identifier:'a'}]},{character_id:'two',order:null}];
    const before=structuredClone({prompts,buckets});
    assert.throws(()=>planPromptDeletion(prompts,buckets,'a'));
    assert.deepEqual({prompts,buckets},before);
});

test('the deletion plan removes duplicate references but retains unrelated objects and metadata', () => {
    const keep=prompt('b'),prompts=[prompt('a'),keep],keptOrder={identifier:'b',enabled:false,foreign:42};
    const order=[{identifier:'a'},keptOrder,{identifier:'a'}],bucket={character_id:'one',order,foreign:'keep'},buckets=[bucket];
    const plan=planPromptDeletion(prompts,buckets,'a');
    prompts.splice(plan.index,1);
    for(const reference of plan.references)for(const index of [...reference.indices].reverse())reference.order.splice(index,1);
    assert.equal(prompts[0],keep);assert.deepEqual(prompts,[keep]);
    assert.equal(buckets[0],bucket);assert.equal(bucket.order,order);assert.equal(order[0],keptOrder);
    assert.deepEqual(order,[{identifier:'b',enabled:false,foreign:42}]);assert.equal(bucket.foreign,'keep');
});

test('invalid deletion targets and settings arrays fail safely', () => {
    for(const id of ['',null,undefined,42])assert.throws(()=>planPromptDeletion([prompt('a')],[],id));
    assert.throws(()=>planPromptDeletion(null,[],'a'));
    assert.throws(()=>planPromptDeletion([prompt('a')],null,'a'));
});
