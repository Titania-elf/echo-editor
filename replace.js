import { literalSearchPattern } from './search.js';

// Pure planning and preflight only. These helpers never save or mutate native/editor data.
export function replaceLiteralContent(content, query, replacement, {caseSensitive=false}={}) {
    const pattern=literalSearchPattern(query,{caseSensitive,all:true});
    if (!pattern) throw new Error('查找内容不能为空，未替换任何条目。');
    if (typeof replacement!=='string') throw new Error('替换内容必须是文本；留空表示删除匹配内容。');
    const before=String(content ?? ''),matches=[],parts=[];
    let cursor=0,shift=0;
    for (const match of before.matchAll(pattern)) {
        const start=match.index,end=start+match[0].length,afterStart=start+shift;
        matches.push({start,end,afterStart,afterEnd:afterStart+replacement.length});
        parts.push(before.slice(cursor,start),replacement);
        shift+=replacement.length-(end-start);cursor=end;
    }
    parts.push(before.slice(cursor));
    return {before,after:parts.join(''),count:matches.length,matches};
}
function entriesById(entries) {
    if (!Array.isArray(entries)) throw new Error('当前条目列表无效，未替换任何条目。');
    const result=new Map();
    for (const entry of entries) {
        if (!entry || typeof entry.id!=='string' || !entry.id || result.has(entry.id)) throw new Error('条目标识无效或重复，未替换任何条目。');
        result.set(entry.id,entry);
    }
    return result;
}
export function planContentReplacement(entries, query, replacement, {caseSensitive=false}={}) {
    const indexed=entriesById(entries),changes=[],skipped=[];
    // Validate even an empty directory; never turn an empty query into an insertion rule.
    replaceLiteralContent('',query,replacement,{caseSensitive});
    for (const entry of indexed.values()) {
        const result=replaceLiteralContent(entry.content,query,replacement,{caseSensitive});
        if (!result.count) continue;
        const name=String(entry.name || '未命名条目');
        if (entry.editable!==true) skipped.push({id:entry.id,name,count:result.count,reason:entry.reason || '正文只读，跳过'});
        else if (result.after===result.before) skipped.push({id:entry.id,name,count:result.count,reason:'替换后正文不变，跳过'});
        else changes.push({id:entry.id,name,revision:entry.revision,...result});
    }
    return {query:String(query).trim(),replacement,caseSensitive,changes,skipped,totalCount:changes.reduce((sum,item)=>sum+item.count,0)};
}
function stale(message) {
    const error=new Error(message);error.code='STALE_REPLACEMENT';return error;
}
function preflight(changes, entries, undo=false) {
    const current=entriesById(entries),ids=new Set();
    for (const change of changes) {
        if (ids.has(change.id)) throw new Error('替换目标重复，未改动任何条目。');
        ids.add(change.id);
        const entry=current.get(change.id),expected=undo?change.after:change.before;
        if (!entry || entry.editable!==true || String(entry.content ?? '')!==expected || entry.revision!==change.revision) {
            throw stale(undo?'正文已继续编辑、保存或被移除，本次不能一键撤销；未覆盖任何后续改动。':'正文或编辑权限已变化，未替换任何条目。请重新预览。');
        }
    }
}
export function prepareReplacementPatch(plan, selectedIds, entries) {
    if (!plan || !Array.isArray(plan.changes) || !Array.isArray(selectedIds) || !selectedIds.length) throw new Error('请至少勾选一个需要修改的条目。');
    if (new Set(selectedIds).size!==selectedIds.length) throw new Error('替换目标重复，未改动任何条目。');
    const candidates=new Map(plan.changes.map(change=>[change.id,change]));
    const changes=selectedIds.map(id=>{
        const change=candidates.get(id);
        if (!change) throw stale('勾选的条目不在当前预览中，请重新预览。');
        return change;
    });
    preflight(changes,entries);
    return changes.map(change=>({...change,matches:change.matches.map(match=>({...match}))}));
}
export function prepareReplacementUndo(receipt, entries) {
    if (!receipt || receipt.undone || !Array.isArray(receipt.changes) || !receipt.changes.length) throw new Error('没有可撤销的本次替换。');
    preflight(receipt.changes,entries,true);
    return receipt.changes.map(change=>({...change,before:change.after,after:change.before,matches:change.matches.map(match=>({...match}))}));
}
export function mapReplacementOffset(offset, matches, reverse=false) {
    const position=Number.isFinite(offset)?Math.max(0,Math.floor(offset)):0;
    let shift=0;
    for (const match of matches) {
        const fromStart=reverse?match.afterStart:match.start,fromEnd=reverse?match.afterEnd:match.end;
        const toStart=reverse?match.start:match.afterStart,toEnd=reverse?match.end:match.afterEnd;
        if (position<fromStart) break;
        if (position<=fromEnd) return toStart+Math.min(position-fromStart,toEnd-toStart);
        shift=toEnd-fromEnd;
    }
    return position+shift;
}
