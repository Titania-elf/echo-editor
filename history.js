// Durable, JSON-only full preset versions. Never share mutable snapshot objects with the editor.
export const HISTORY_SCHEMA = 1;
export const VERSION_LIMIT = 64;
export const NOTE_LIMIT = 500;
export const HISTORY_WARNING_BYTES = 5 * 1024 * 1024;
const jsonCopy = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nameKey = name => JSON.stringify(name);

export function createHistoryStore() {
    return { schemaVersion:HISTORY_SCHEMA, versions:[], heads:{}, workingByScope:{} };
}
export function assertHistoryStore(store) {
    if (!object(store) || store.schemaVersion !== HISTORY_SCHEMA || !Array.isArray(store.versions) || !object(store.heads) || !object(store.workingByScope)) {
        throw new Error('历史版本数据格式无法识别，未覆盖已有记录。请先备份酒馆设置并检查扩展版本。');
    }
    return store;
}
export function versionsFor(store, presetName) {
    assertHistoryStore(store);
    return store.versions.filter(record => object(record) && record.presetName === presetName);
}
export function versionById(store, presetName, id) {
    return versionsFor(store,presetName).find(record => record.id === id) || null;
}
export function headVersion(store, presetName) {
    return versionById(store,presetName,store.heads[nameKey(presetName)]);
}
export function scopePresetName(scope) {
    try { const tuple=JSON.parse(scope); return Array.isArray(tuple) && typeof tuple[0] === 'string' ? tuple[0] : null; }
    catch { return null; }
}
export function normalizeVersion(value) {
    if (typeof value !== 'string') throw new Error('请输入版本号。');
    let version=value.trim();
    if (!version || version.length > VERSION_LIMIT || /[\u0000-\u001f\u007f]/u.test(version)) throw new Error(`版本号不能为空，且不能超过 ${VERSION_LIMIT} 个字符。`);
    if (/^v?\d+(?:\.\d+)+$/i.test(version)) version=`v${version.replace(/^v/i,'')}`;
    return version;
}
export function validateVersion(store, presetName, value, note='') {
    const version=normalizeVersion(value);
    if (typeof note !== 'string' || note.length > NOTE_LIMIT) throw new Error(`更新说明不能超过 ${NOTE_LIMIT} 个字符。`);
    if (versionsFor(store,presetName).some(record => String(record.version).toLocaleLowerCase() === version.toLocaleLowerCase()) || !versionsFor(store,presetName).length && version === '初始版本') {
        throw new Error('这个版本号已经存在或保留给初始版本。请使用新版本号，历史版本不会被覆盖。');
    }
    return {version,note:note.trim()};
}
export function suggestVersion(store, presetName) {
    const versions=versionsFor(store,presetName), numbers=versions.flatMap(record => {
        const match=/^v?(\d+(?:\.\d+)+)$/i.exec(String(record.version));
        if (!match) return [];
        const parts=match[1].split('.').map(Number);
        return parts.every(Number.isSafeInteger) ? [parts] : [];
    });
    numbers.sort((a,b) => {
        for (let i=0;i<Math.max(a.length,b.length);i++) if ((a[i]||0)!==(b[i]||0)) return (a[i]||0)-(b[i]||0);
        return a.length-b.length;
    });
    const next=numbers.length ? [...numbers.at(-1)] : [1,-1];
    if (next.at(-1) >= Number.MAX_SAFE_INTEGER) throw new Error('版本号超出自动递增范围，请手动填写新版本号。');
    next[next.length-1]++;
    let version=`v${next.join('.')}`;
    while (versions.some(record => String(record.version).toLowerCase() === version.toLowerCase())) {
        if (next.at(-1) >= Number.MAX_SAFE_INTEGER) throw new Error('请手动填写新版本号。');
        next[next.length-1]++;version=`v${next.join('.')}`;
    }
    return version;
}
export function serializePreset(preset) {
    const snapshot=jsonCopy(preset);
    if (!object(snapshot) || !Array.isArray(snapshot.prompts) || !Array.isArray(snapshot.prompt_order)) throw new Error('完整预设缺少条目库或角色排列，未创建或载入历史版本。');
    const ids=new Set();
    for (const prompt of snapshot.prompts) {
        if (!object(prompt) || typeof prompt.identifier !== 'string' || !prompt.identifier || ids.has(prompt.identifier)) throw new Error('预设条目库有无效或重复标识，未创建或载入历史版本。');
        ids.add(prompt.identifier);
    }
    const characters=new Set();
    for (const bucket of snapshot.prompt_order) {
        if (!object(bucket) || bucket.character_id === undefined || !Array.isArray(bucket.order) || characters.has(String(bucket.character_id))) throw new Error('预设角色排列无效，未创建或载入历史版本。');
        characters.add(String(bucket.character_id));
        const ordered=new Set();
        for (const entry of bucket.order) {
            if (!object(entry) || typeof entry.identifier !== 'string' || !entry.identifier || ordered.has(entry.identifier)) throw new Error('预设排列有无效或重复条目标识，未创建或载入历史版本。');
            ordered.add(entry.identifier);
        }
    }
    return snapshot;
}
export function groupsForPreset(groupsByScope, presetName) {
    return Object.fromEntries(Object.entries(groupsByScope || {}).filter(([scope,groups]) => scopePresetName(scope) === presetName && Array.isArray(groups)).map(([scope,groups]) => [scope,jsonCopy(groups)]));
}
export function replacePresetGroups(groupsByScope, presetName, savedGroups) {
    return {...Object.fromEntries(Object.entries(groupsByScope || {}).filter(([scope]) => scopePresetName(scope) !== presetName)),...groupsForPreset(savedGroups,presetName)};
}
export function planVersionSave(store, {presetName,version,note='',preset,groupsByScope={},initialPreset,initialGroupsByScope={},parentId=null,scope,idFactory,createdAt=new Date().toISOString()}) {
    const metadata=validateVersion(store,presetName,version,note);
    if (typeof presetName !== 'string' || !presetName || typeof idFactory !== 'function') throw new Error('请先选择一个已命名的预设。');
    const next=jsonCopy(store), existing=versionsFor(next,presetName);
    const make=(label,description,body,groups,parent,kind) => {
        const id=idFactory();
        if (typeof id !== 'string' || !id || next.versions.some(record => record.id === id)) throw new Error('历史版本标识重复，请重试保存。');
        const record={id,presetName,version:label,note:description,createdAt,parentId:parent,kind,preset:serializePreset(body),groupsByScope:groupsForPreset(groups,presetName)};
        next.versions.push(record);return record;
    };
    let initial=null;
    if (!existing.length && initialPreset) initial=make('初始版本','首次纳入历史前的命名预设。',initialPreset,initialGroupsByScope,null,'initial');
    const parent=versionById(next,presetName,parentId) || headVersion(next,presetName) || initial;
    const record=make(metadata.version,metadata.note,preset,groupsByScope,parent?.id || null,'saved');
    next.heads[nameKey(presetName)]=record.id;
    if (scope && scopePresetName(scope) === presetName) next.workingByScope[scope]=record.id;
    return {store:next,record,initial};
}
export function removeVersion(store, presetName, id) {
    assertHistoryStore(store);
    if (!versionById(store,presetName,id)) throw new Error('历史版本已不存在，请重新打开列表。');
    const next=jsonCopy(store);
    next.versions=next.versions.filter(record => record.id !== id || record.presetName !== presetName);
    if (next.heads[nameKey(presetName)] === id) delete next.heads[nameKey(presetName)];
    for (const [scope,versionId] of Object.entries(next.workingByScope)) if (versionId === id && scopePresetName(scope) === presetName) delete next.workingByScope[scope];
    return next;
}
export function historyBytes(store) {
    assertHistoryStore(store);
    return new TextEncoder().encode(JSON.stringify(store)).byteLength;
}
