import { getContext } from '../../../extensions.js';
import { doNavbarIconClick } from '../../../../script.js';
import * as native from './adapter.js';
import { normalizePrompt, draftChanged, mergeDraftPositions, insertId, PROMPT_FIELDS, TRIGGERS, copy } from './model.js';
import { createDragSorter } from './drag-sort.js';
import { createSaveQueue } from './save-queue.js';
import { parseGroupName, detectGroups, resolveGroups } from './groups.js';
import { textMatch, searchEntries } from './search.js';

const MODULE = '回声编辑台';
const LEGACY_MODULE = 'st-preset-mobile-editor';
const EXTENSION_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).at(-1));
const defaults = { enabled:true, interceptNative:true, enableNewOnSave:false, theme:'paper' };
const THEMES = [
    {id:'paper', label:'纸白', description:'米白纸张、深墨文字与灰蓝强调色。'},
    {id:'night', label:'夜色', description:'柔和石墨灰，适合夜间连续编辑。'},
    {id:'tavern', label:'跟随酒馆', short:'酒馆', description:'继承酒馆当前配色，不改变酒馆本身。'},
];
const iconPaths = {
    echo:'<path d="M4 4h9l3 3v13H4Z"/><path d="M13 4v4h3M7 11h3M7 15h3"/><path d="M18 9a5 5 0 0 1 0 6M20 6a9 9 0 0 1 0 12"/>',
    theme:'<circle cx="12" cy="12" r="8"/><path d="M12 4v16M12 4a8 8 0 0 1 0 16"/>',
    pen:'<path d="m15 4 5 5-10 10-6 1 1-6Z"/><path d="m13 6 5 5M4 20l4-4"/>',
    plus:'<path d="M12 5v14M5 12h14"/>', check:'<path d="m5 12 4 4 10-10"/>',
    more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    expand:'<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
    back:'<path d="m14 6-6 6 6 6"/>', next:'<path d="m10 6 6 6-6 6"/>',
    chevron:'<path d="m6 9 6 6 6-6"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
    grip:'<path d="M6 7h12M6 12h12M6 17h12"/>',
    copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
    library:'<path d="M4 5h4v15H4zm7 0h4v15h-4zm7 0 3 14"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    folder:'<path d="M3 7V5h6l2 2h10v13H3Z"/>',
    remove:'<path d="M5 12h14"/><circle cx="12" cy="12" r="9"/>',
};
const icon = name => `<svg class="pmme-icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let root, initialized=false, workspace=null, busy=false, epoch=0, sorter, observer, scheduledMount=0, toastTimer, allowPresetSwitch=false;
let originalOverflow='', sheetFocus=null, disabledControls=new Map(), returnLocation=null, navigationVersion=0, returningVersion=0, preferencesError=null;
const archives=new Map();
const preferencesOwner={preferences:true};
const $ = name => document.getElementById(`pmme-${name}`);
function migrateLegacySettings(){
    const settings=getContext().extensionSettings;
    let changed=false;
    if(!settings[MODULE]&&settings[LEGACY_MODULE]){
        settings[MODULE]=copy(settings[LEGACY_MODULE]);
        changed=true;
    }
    const previousName=`third-party/${LEGACY_MODULE}`,currentName=`third-party/${EXTENSION_FOLDER}`;
    if(settings.disabledExtensions?.includes(previousName)){
        settings.disabledExtensions=[...new Set(settings.disabledExtensions.map(name=>name===previousName?currentName:name))];
        changed=true;
    }
    return {changed,disabled:Boolean(settings.disabledExtensions?.includes(currentName))};
}
function config(){
    const settings=getContext().extensionSettings[MODULE] ||= {};
    for(const [key,value] of Object.entries(defaults))if(settings[key]===undefined)settings[key]=value;
    if(!THEMES.some(theme=>theme.id===settings.theme))settings.theme='paper';
    if(!settings.groupsByScope || typeof settings.groupsByScope!=='object' || Array.isArray(settings.groupsByScope))settings.groupsByScope={};
    return settings;
}
const settingsSaver = createSaveQueue({
    persist: owner => native.persistSettings(owner===preferencesOwner?null:owner.scope, 15000, true),
    isCurrent(owner) { if(owner===preferencesOwner)return true;if(workspace!==owner)return false;try{native.assertScope(owner.scope);return true;}catch{return false;} },
    onPending(owner) {
        if(owner===preferencesOwner){preferencesError=null;if(root&&!root.hidden)paintStatus();return;}
        owner.backgroundSaving=true;owner.settingsUnconfirmed=true;owner.settingsSaveFailed=false;
        if(workspace===owner&&root&&!root.hidden)paintStatus();
    },
    onSaved(owner) {
        if(owner===preferencesOwner){preferencesError=null;if(root&&!root.hidden)paintStatus();return;}
        owner.backgroundSaving=false;owner.settingsUnconfirmed=false;owner.settingsSaveFailed=false;
        if(workspace===owner&&root&&!root.hidden)paintStatus();
    },
    onError(owner,error) {
        if(owner===preferencesOwner){preferencesError=error;if(root&&!root.hidden)paintStatus();notify('界面偏好未确认保存，请检查连接后重试。',true);return;}
        owner.backgroundSaving=false;owner.settingsUnconfirmed=true;owner.settingsSaveFailed=true;
        if(workspace===owner&&root&&!root.hidden)paintStatus();
        if(workspace===owner&&error.code!=='STALE_SETTINGS_CONTEXT')notify(error.message,true);
    },
});
function persistCurrentSettings(owner = workspace) {
    settingsSaver.request(owner);
    return settingsSaver.wait(owner);
}

function notify(message,error=false) {
    if (!root || root.hidden) { globalThis.toastr?.[error?'error':'info'](message); return; }
    clearTimeout(toastTimer); $('toast').textContent=message; $('toast').classList.toggle('pmme-error',error); $('toast').hidden=false;
    toastTimer=setTimeout(()=>{$('toast').hidden=true;},error?6500:3000);
}
function saveConfig() { settingsSaver.request(preferencesOwner); mountEntryButton(); }
function applyAppearance(){
    if(!root)return;
    const theme=THEMES.find(item=>item.id===config().theme);
    root.dataset.pmmeTheme=theme.id;
    for(const name of ['theme-control','full-theme-control']){
        const button=$(name);if(!button)continue;
        button.innerHTML=`${icon('theme')}<span>${theme.short||theme.label}</span>`;
        button.title=`当前主题：${theme.label}`;
        button.setAttribute('aria-label',`界面主题：${theme.label}，点击选择`);
    }
    if($('setting-theme'))$('setting-theme').value=theme.id;
}
function setAppearance(theme){
    if(!THEMES.some(item=>item.id===theme))return;
    config().theme=theme;applyAppearance();settingsSaver.request(preferencesOwner);
}
function showAppearancePicker(){
    rememberCursor();
    const current=config().theme;
    showSheet('界面主题',THEMES.map(theme=>`<button type="button" class="pmme-theme-option" data-pmme-theme="${theme.id}" aria-pressed="${current===theme.id}"><span class="pmme-theme-copy"><strong>${theme.label}</strong><small>${theme.description}</small></span>${current===theme.id?'<span class="pmme-current-theme">当前</span>':''}</button>`).join(''));
}
function makeRoot() {
    root=document.createElement('section');root.id='pmme-root';root.hidden=true;root.setAttribute('aria-label','回声编辑台预设编辑器');
    root.innerHTML=`<div class="pmme-frame">
      <div id="pmme-directory-view" class="pmme-directory-view">
        <header class="pmme-topbar pmme-gutter"><button id="pmme-close" class="pmme-button pmme-quiet pmme-return-button" aria-label="返回酒馆预设编辑" title="返回预设">${icon('back')}预设</button><h2>${icon('echo')}回声编辑台</h2><button id="pmme-theme-control" type="button" class="pmme-button pmme-theme-control" aria-label="选择界面主题"></button><span class="pmme-mode-label">预设编辑</span></header>
        <section class="pmme-preset pmme-gutter"><div><h3 id="pmme-preset-name"></h3><p id="pmme-status"></p><button id="pmme-retry" class="pmme-button pmme-quiet" hidden>重试保存</button></div><button id="pmme-update" class="pmme-button pmme-secondary">更新预设</button></section>
        <div class="pmme-search-line pmme-gutter"><label class="pmme-search-control" for="pmme-directory-search">${icon('search')}<input id="pmme-directory-search" type="search" placeholder="搜索标题或正文" aria-label="搜索当前预设条目" autocomplete="off"></label><button id="pmme-clear-search" class="pmme-icon-button" aria-label="清空搜索" title="清空搜索" hidden>${icon('close')}</button></div>
        <div class="pmme-toolbar pmme-gutter"><label class="pmme-search-scope" for="pmme-search-titles"><input id="pmme-search-titles" type="checkbox">仅标题</label><span class="pmme-grow"></span><button id="pmme-library" class="pmme-button">${icon('library')}添加已有</button><button id="pmme-groups" class="pmme-button">${icon('folder')}分组</button><button id="pmme-organize" class="pmme-icon-button" aria-label="整理排列" title="整理排列">${icon('grip')}</button></div>
        <div class="pmme-caption pmme-gutter"><span id="pmme-hint">点击条目快改，展开全屏长写</span><span id="pmme-count"></span></div>
        <div id="pmme-scroll" class="pmme-scroll pmme-gutter"><main id="pmme-list" aria-label="预设排列"></main><p class="pmme-footnote">草稿在本次页面中保留；刷新前请保存。</p></div>
      </div>
      <div id="pmme-full-view" class="pmme-full-view" hidden>
        <header class="pmme-full-header pmme-gutter"><button id="pmme-collapse" class="pmme-button pmme-quiet">${icon('back')}收起</button><div class="pmme-full-heading"><strong id="pmme-full-title"></strong><span id="pmme-full-status"></span></div><div class="pmme-full-actions"><button id="pmme-full-theme-control" type="button" class="pmme-button pmme-theme-control" aria-label="选择界面主题"></button><button id="pmme-full-menu" class="pmme-icon-button" aria-label="当前条目的更多操作">${icon('more')}</button></div></header>
        <p id="pmme-full-context" class="pmme-full-context pmme-gutter"></p><div id="pmme-full-slot" class="pmme-full-slot pmme-gutter"></div>
        <nav class="pmme-full-nav pmme-gutter"><button id="pmme-previous" class="pmme-button pmme-quiet">${icon('back')}上一条</button><span id="pmme-position"></span><button id="pmme-next" class="pmme-button pmme-quiet">下一条${icon('next')}</button></nav>
      </div>
      <div id="pmme-parking" hidden><section id="pmme-editor" class="pmme-editor" aria-label="条目编辑">
        <div class="pmme-editor-meta"><label class="pmme-field pmme-grow" for="pmme-name"><span>条目标题</span><input id="pmme-name" type="text" placeholder="先写内容，标题稍后补" autocomplete="off"></label><label class="pmme-field pmme-role-field" for="pmme-role"><span>消息角色</span><select id="pmme-role"><option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option></select></label></div>
        <div id="pmme-body-field" class="pmme-body-field"><label for="pmme-content"><span>正文</span><output id="pmme-chars"></output></label><textarea id="pmme-content" placeholder="从这里开始写……" spellcheck="false" data-macros></textarea></div>
        <div id="pmme-source" class="pmme-source" hidden></div>
        <details id="pmme-advanced" class="pmme-advanced"><summary>高级设置${icon('chevron')}</summary><div class="pmme-advanced-fields"><label class="pmme-field" for="pmme-injection"><span>注入位置</span><select id="pmme-injection"><option value="0">按预设排列</option><option value="1">聊天内注入</option></select></label><div id="pmme-depth-fields" class="pmme-row" hidden><label class="pmme-field pmme-grow" for="pmme-depth"><span>聊天深度</span><input id="pmme-depth" type="number" min="0" max="9999" step="1"></label><label class="pmme-field pmme-grow" for="pmme-order"><span>注入顺序</span><input id="pmme-order" type="number" min="0" max="9999" step="1"></label></div><p id="pmme-depth-note" class="pmme-small" hidden>聊天内注入受深度和顺序控制，不只取决于目录位置。</p><div class="pmme-field"><span>触发条件（不选则不限制）</span><div class="pmme-triggers">${TRIGGERS.map((trigger,i)=>`<label for="pmme-trigger-${trigger}"><input id="pmme-trigger-${trigger}" type="checkbox" value="${trigger}">${['普通发送','继续','代写','滑动','重新生成','静默'][i]}</label>`).join('')}</div></div><label id="pmme-override-field" class="pmme-check" for="pmme-overrides" hidden><input id="pmme-overrides" type="checkbox">禁止角色卡覆盖此条目</label></div></details>
        <label id="pmme-enable-field" class="pmme-check" for="pmme-enable-new" hidden><input id="pmme-enable-new" type="checkbox">首次保存后启用（草稿不参与发送）</label>
        <div class="pmme-editor-footer"><button id="pmme-discard" class="pmme-button pmme-quiet">放弃</button><button id="pmme-expand" class="pmme-button">${icon('expand')}全屏</button><button id="pmme-new-after" class="pmme-button" hidden>${icon('plus')}新增</button><button id="pmme-save" class="pmme-button pmme-primary pmme-grow">保存条目</button></div>
      </section></div>
    </div><div id="pmme-sheet-layer" class="pmme-sheet-layer" hidden><div id="pmme-backdrop" class="pmme-backdrop"></div><section class="pmme-sheet pmme-gutter" role="dialog" aria-modal="true" aria-labelledby="pmme-sheet-title"><div class="pmme-sheet-handle"></div><header><h3 id="pmme-sheet-title"></h3><button id="pmme-sheet-close" class="pmme-icon-button" aria-label="关闭操作面板">${icon('close')}</button></header><div id="pmme-sheet-body"></div></section></div><div id="pmme-toast" class="pmme-toast" role="status" aria-live="polite" hidden></div>`;
    document.body.appendChild(root);
    applyAppearance();
}
function bufferFor(id) {
    let buffer=workspace.buffers.get(id);
    if (!buffer) {
        const prompt=workspace.drafts.get(id)?.prompt || native.findPrompt(id);if(!prompt)return null;
        const base=normalizePrompt(prompt);buffer={base,values:copy(base)};workspace.buffers.set(id,buffer);
    }
    return buffer;
}
function promptFor(id) { return workspace.drafts.get(id)?.prompt || native.findPrompt(id); }
function titleFor(id) { return bufferFor(id)?.values.name || '未命名条目'; }
function hasDraft(id) { return workspace.drafts.has(id) || Boolean(bufferFor(id)&&draftChanged(bufferFor(id))); }
function pendingIds() { return workspace.ids.filter(id=>hasDraft(id)); }
function needsAttention() { return workspace && (pendingIds().length>0 || workspace.settingsUnconfirmed || native.presetNeedsUpdate()); }
function syncWorkspace() {
    const nativeIds=native.nativeOrder().map(entry=>entry.identifier);
    // Preserve unsaved text if another editor removes its source prompt from the current sequence.
    for (const [id,buffer] of [...workspace.buffers]) {
        if (workspace.drafts.has(id)||nativeIds.includes(id)||!draftChanged(buffer))continue;
        const replacement=native.newId(),prompt={identifier:replacement,...copy(buffer.values),system_prompt:false,marker:false};
        workspace.drafts.set(replacement,{prompt,enableOnSave:false});workspace.buffers.set(replacement,{base:normalizePrompt({}),values:copy(buffer.values)});
        workspace.ids=workspace.ids.map(candidate=>candidate===id?replacement:candidate);workspace.buffers.delete(id);
        if(workspace.selected===id)workspace.selected=replacement;
        notify('原条目已移出排列，未保存内容保留为独立草稿。');
    }
    workspace.ids=mergeDraftPositions(nativeIds,workspace.ids,new Set(workspace.drafts.keys()));
    for(const id of nativeIds){
        const buffer=workspace.buffers.get(id),prompt=native.findPrompt(id);if(!buffer||!prompt)continue;
        const latest=normalizePrompt(prompt);
        for(const key of PROMPT_FIELDS)if(JSON.stringify(buffer.base[key])===JSON.stringify(buffer.values[key])){buffer.base[key]=copy(latest[key]);buffer.values[key]=copy(latest[key]);}
    }
    if(workspace.selected&&!workspace.ids.includes(workspace.selected))workspace.selected=null;
}
function makeWorkspace() {
    const scope=native.scopeKey();
    if(workspace?.scope===scope)return;
    if(workspace)archives.set(workspace.scope,workspace);
    workspace=archives.get(scope) || {
        scope,ids:native.nativeOrder().map(e=>e.identifier),buffers:new Map(),drafts:new Map(),cursors:new Map(),
        selected:null,full:false,organizing:false,scrollTop:0,settingsUnconfirmed:false,query:'',titleOnly:false,searchScroll:null,
        groupDefinitions:copy(Array.isArray(config().groupsByScope[scope])?config().groupsByScope[scope]:[]),pendingGroupStart:null,
    };
    workspace.full=false;workspace.organizing=false;
    workspace.presetValue=document.getElementById('settings_preset_openai')?.value;
    syncWorkspace();
}
function rememberCursor() {
    const id=$('editor').dataset.entryId;if(!id||!workspace)return;
    workspace.cursors.set(id,{start:$('content').selectionStart,end:$('content').selectionEnd,scroll:$('content').scrollTop,nameStart:$('name').selectionStart,nameEnd:$('name').selectionEnd});
}
function restoreCursor() {
    const cursor=workspace.cursors.get(workspace.selected);if(!cursor)return;
    $('content').setSelectionRange(cursor.start,cursor.end);$('content').scrollTop=cursor.scroll;
    $('name').setSelectionRange(cursor.nameStart,cursor.nameEnd);
}
function setView() {
    $('directory-view').hidden=workspace.full;$('full-view').hidden=!workspace.full;
    root.classList.toggle('pmme-full',workspace.full);
    $('expand').hidden=workspace.full;$('new-after').hidden=!workspace.full;
}
function hasSearch() { return Boolean(workspace?.query.trim()); }
function currentEntries() {
    return workspace.ids.map(id=>{const values=bufferFor(id)?.values;return values?{id,name:values.name,content:values.content}:null;}).filter(Boolean);
}
function resolveWorkspaceGroups() {
    workspace.groupView=resolveGroups(workspace.ids,workspace.groupDefinitions);
    return workspace.groupView;
}
function storeGroupPreferences(owner=workspace) {
    // A group's draft boundary IDs cannot survive a reload until their first save.
    config().groupsByScope[owner.scope]=owner.groupDefinitions.filter(group=>group&&owner.ids.includes(group.startId)&&owner.ids.includes(group.endId)&&!owner.drafts.has(group.startId)&&!owner.drafts.has(group.endId)).map(group=>({
        id:group.id,startId:group.startId,endId:group.endId,name:group.name,collapsed:Boolean(group.collapsed),
    }));
}
function persistGroups() { storeGroupPreferences();settingsSaver.request(preferencesOwner); }
function revealEntry(id,clearSearch=false) {
    if(clearSearch){workspace.query='';workspace.searchScroll=null;}
    let changed=false;
    for(const group of resolveWorkspaceGroups().groups){
        if(!group.ids.includes(id))continue;
        const definition=workspace.groupDefinitions.find(item=>item?.id===group.id);
        if(definition?.collapsed){definition.collapsed=false;changed=true;}
    }
    if(changed)persistGroups();
}
function setSearchQuery(value) {
    const wasSearching=hasSearch();workspace.query=String(value);
    if(!wasSearching&&hasSearch())workspace.searchScroll=$('scroll').scrollTop;
    if(hasSearch())workspace.organizing=false;
    const restore=wasSearching&&!hasSearch()?workspace.searchScroll:null;
    if(!hasSearch())workspace.searchScroll=null;
    renderList();
    if(restore!==null)$('scroll').scrollTop=restore;
}
function highlightText(text,range) {
    const source=String(text);
    return range?`${escape(source.slice(0,range.start))}<mark>${escape(source.slice(range.start,range.end))}</mark>${escape(source.slice(range.end))}`:escape(source);
}
function snippetMarkup(snippet) {
    return snippet?`${snippet.leading?'…':''}${escape(snippet.before)}<mark>${escape(snippet.match)}</mark>${escape(snippet.after)}${snippet.trailing?'…':''}`:'';
}
function renderEntry(id,boundary=null) {
    if(hasSearch()&&!workspace.visibleIds.has(id))return '';
    const prompt=promptFor(id),buffer=bufferFor(id),key=escape(id);
    if(!prompt||!buffer)return `<article class="pmme-item pmme-sort-unit" data-pmme-id="${key}" data-pmme-sort-key="entry:${key}"><p class="pmme-unavailable">不可用条目 · ${key}</p></article>`;
    const draft=workspace.drafts.has(id),allowed=draft?{toggle:false,edit:true}:native.permissions(prompt),entry=workspace.orderMap.get(id);
    const enabled=Boolean(entry?.enabled),role=prompt.marker?'内容占位符':buffer.values.role,match=workspace.searchMatches.get(id);
    return `<article id="pmme-row-${key}" class="pmme-item ${boundary?'pmme-boundary':'pmme-sort-unit'} ${workspace.selected===id&&!workspace.organizing?'pmme-selected':''}" data-pmme-id="${key}" ${boundary?'':`data-pmme-sort-key="entry:${key}"`}>
      <div class="pmme-item-top">${workspace.organizing&&!boundary?`<button class="pmme-drag-handle pmme-icon-button" aria-label="拖动${escape(titleFor(id))}排序" title="按住拖动">${icon('grip')}</button>`:''}
        <button class="pmme-item-main" data-pmme-select="${key}" aria-expanded="${workspace.selected===id&&!workspace.organizing}">
          <span id="pmme-title-${key}" class="pmme-item-title">${highlightText(titleFor(id),match?.titleMatch)}</span>
          <span class="pmme-item-sub">${boundary?`<span class="pmme-boundary-label">${boundary}</span>`:''}<span>${escape(role)}</span><span data-pmme-state>${draft?'草稿 · 不发送':enabled?'已启用':'已关闭'}</span><span id="pmme-dirty-${key}" class="pmme-pending" ${!draft&&draftChanged(buffer)?'':'hidden'}>有修改</span></span>
          <span class="pmme-match-preview" ${match?.snippet?'':'hidden'}>${snippetMarkup(match?.snippet)}</span>
        </button>
        <div class="pmme-item-actions"><button type="button" class="pmme-toggle pmme-icon-button" role="switch" data-pmme-toggle="${key}" aria-label="${escape(titleFor(id))}的启用状态" aria-checked="${enabled&&!draft}" title="${draft?'草稿保存后才可启用':enabled?'点击关闭':'点击启用'}" ${draft||!allowed.toggle?'disabled':''}><span class="pmme-switch-track" aria-hidden="true"></span></button><button class="pmme-icon-button" data-pmme-menu="${key}" aria-label="${escape(titleFor(id))}的更多操作">${icon('more')}</button></div>
      </div><div id="pmme-slot-${key}" class="pmme-editor-slot"></div></article>`;
}
function groupSummary(group) {
    let enabled=0,toggleable=0,drafts=0,locked=0;
    for(const id of group.ids){
        if(workspace.drafts.has(id)){drafts++;continue;}
        const prompt=promptFor(id),entry=workspace.orderMap.get(id);
        if(!prompt||!entry||!native.permissions(prompt).toggle){locked++;continue;}
        toggleable++;if(entry.enabled)enabled++;
    }
    return {enabled,toggleable,drafts,locked,state:enabled===0?'false':enabled===toggleable?'true':'mixed'};
}
function renderTree(nodes) {
    return nodes.map(node=>{
        if(node.type==='entry')return renderEntry(node.id);
        const group=node.group;
        if(hasSearch()&&!group.ids.some(id=>workspace.visibleIds.has(id)))return '';
        const key=escape(group.id),open=hasSearch()||!group.collapsed;
        return `<section class="pmme-group pmme-sort-unit" data-pmme-group="${key}" data-pmme-sort-key="group:${key}">
          <div class="pmme-group-header">${workspace.organizing?`<button class="pmme-drag-handle pmme-icon-button" aria-label="拖动整个${escape(group.name)}分组" title="整组拖动，包含首尾边界">${icon('grip')}</button>`:''}
            <button class="pmme-group-main" data-pmme-fold="${key}" aria-expanded="${open}" aria-controls="pmme-group-body-${key}">${icon('chevron')}<span class="pmme-group-copy"><strong>${highlightText(group.name,hasSearch()?textMatch(group.name,workspace.query):null)}</strong><span class="pmme-group-summary" data-pmme-group-summary="${key}"></span></span></button>
            <div class="pmme-item-actions"><button type="button" class="pmme-toggle pmme-icon-button" role="checkbox" data-pmme-group-toggle="${key}" aria-label="${escape(group.name)}分组的批量启停（含边界）"><span class="pmme-switch-track" aria-hidden="true"></span></button><button class="pmme-icon-button" data-pmme-group-menu="${key}" aria-label="${escape(group.name)}分组的更多操作">${icon('more')}</button></div>
          </div><div id="pmme-group-body-${key}" class="pmme-group-body" ${open?'':'hidden'}>
            ${renderEntry(group.startId,'开始边界')}<div class="pmme-group-members" data-pmme-sort-container data-pmme-sort-parent="${key}">${renderTree(node.children)}${workspace.organizing&&!node.children.length?'<p class="pmme-group-empty">拖动条目到组内</p>':''}</div>${renderEntry(group.endId,'结束边界')}
          </div></section>`;
    }).join('');
}
function paintGroupStates() {
    if(!workspace.groupView)return;
    workspace.orderMap=new Map(native.nativeOrder().map(entry=>[entry.identifier,entry]));
    for(const group of workspace.groupView.groups){
        const section=[...$('list').querySelectorAll('[data-pmme-group]')].find(element=>element.dataset.pmmeGroup===group.id);
        if(!section)continue;
        const state=groupSummary(group),summary=section.querySelector('[data-pmme-group-summary]'),button=section.querySelector('[data-pmme-group-toggle]');
        summary.textContent=`${group.ids.length} 条（含边界） · 已启用 ${state.enabled}/${state.toggleable}${state.drafts?` · 草稿 ${state.drafts}`:''}${state.locked?` · 受限 ${state.locked}`:''}`;
        button.setAttribute('aria-checked',state.state);button.disabled=busy||!state.toggleable;
        button.title=`${state.state==='true'?'全部关闭':'全部启用'}（含首尾边界；跳过草稿和受限项）`;
    }
}
function renderList() {
    if(!workspace)return;
    const focus=$('editor').contains(document.activeElement)?document.activeElement.id:null,scroll=$('scroll').scrollTop;
    rememberCursor();sorter?.cancel();$('parking').appendChild($('editor'));syncWorkspace();setView();
    const view=resolveWorkspaceGroups();workspace.orderMap=new Map(native.nativeOrder().map(entry=>[entry.identifier,entry]));
    workspace.searchMatches=searchEntries(currentEntries(),workspace.query,{titleOnly:workspace.titleOnly});
    workspace.visibleIds=new Set(workspace.searchMatches.keys());
    if(hasSearch())for(const group of view.groups)if(textMatch(group.name,workspace.query))for(const id of group.ids)workspace.visibleIds.add(id);
    $('directory-search').value=workspace.query;$('directory-search').placeholder=workspace.titleOnly?'搜索条目标题':'搜索标题或正文';$('search-titles').checked=workspace.titleOnly;$('clear-search').hidden=!workspace.query;
    $('list').innerHTML=renderTree(view.tree);
    if(!workspace.ids.length)$('list').innerHTML='<div class="pmme-empty"><p>当前排列还没有条目</p><button class="pmme-button pmme-primary" data-pmme-create-first>创建第一个条目</button></div>';
    else if(hasSearch()&&!workspace.visibleIds.size)$('list').innerHTML='<div class="pmme-empty"><p>没有匹配条目，试试其他关键词</p><button class="pmme-button" data-pmme-clear-query>清空搜索</button></div>';
    if(workspace.selected&&!workspace.organizing){const slot=workspace.full?$('full-slot'):$(`slot-${workspace.selected}`);if(slot){slot.appendChild($('editor'));loadEditor();}}
    $('scroll').scrollTop=scroll;
    if(focus&&!workspace.organizing&&$('editor').getClientRects().length)document.getElementById(focus)?.focus({preventScroll:true});
    paintStatus();paintBusy();
}
function loadEditor() {
    const id=workspace.selected,prompt=promptFor(id),buffer=bufferFor(id);if(!prompt||!buffer)return;
    const draft=workspace.drafts.get(id),allowed=draft?{edit:true,content:true,overrides:false}:native.permissions(prompt),v=buffer.values;
    $('editor').dataset.entryId=id;$('name').value=v.name;$('role').value=v.role;$('content').value=v.content;
    $('injection').value=String(v.injection_position);$('depth').value=v.injection_depth;$('order').value=v.injection_order;$('overrides').checked=v.forbid_overrides;
    TRIGGERS.forEach(t=>{$(`trigger-${t}`).checked=v.injection_trigger.includes(t);});
    $('enable-new').checked=Boolean(draft?.enableOnSave);
    $('name').disabled=!allowed.edit;$('role').disabled=!allowed.edit;
    $('body-field').hidden=!allowed.content;$('source').hidden=allowed.content;
    $('source').textContent=allowed.edit?'正文由角色卡、世界书或其他来源提供，不能在这里改写；可调整其他原生允许的属性。':'该占位符内容由酒馆生成，保留原生编辑限制。可在目录中整理它的位置。';
    $('advanced').hidden=!allowed.edit;$('override-field').hidden=!allowed.overrides;$('enable-field').hidden=!draft;
    $('save').hidden=!allowed.edit;$('discard').hidden=!allowed.edit;$('save').textContent=draft?'保存并加入':'保存条目';
    updateAdvanced();restoreCursor();paintStatus();
}
function updateAdvanced(){const chat=$('injection').value==='1';$('depth-fields').hidden=!chat;$('depth-note').hidden=!chat;}
function paintStatus() {
    if(!workspace)return;
    $('preset-name').textContent=native.presetName()||'当前配置';
    const pending=pendingIds().length;
    $('status').textContent=busy?'正在更新预设…':workspace.settingsSaveFailed?'后台保存失败，修改仍保留':preferencesError?'界面偏好未确认保存，请重试':pending?`${pending} 个条目有草稿或修改`:workspace.backgroundSaving?'当前配置 · 命名预设待更新':workspace.settingsUnconfirmed?'当前设置尚未确认保存，请重试':native.presetNeedsUpdate()?'条目已保存 · 命名预设待更新':'当前条目与命名预设一致';
    $('retry').hidden=!(workspace.settingsSaveFailed||preferencesError)||busy;
    $('status').classList.toggle('pmme-pending',Boolean(pending||workspace.settingsUnconfirmed||preferencesError||native.presetNeedsUpdate()));
    $('hint').textContent=workspace.dragging?workspace.dragTarget||'拖到目标位置后松手':workspace.pendingGroupStart?`选择结束边界：${titleFor(workspace.pendingGroupStart)}`:workspace.organizing?'拖动组或条目；展开组可拖入、拖出':hasSearch()?'搜索包含草稿和已关闭条目':'点击条目快改，展开全屏长写';
    $('count').textContent=hasSearch()?`找到 ${workspace.visibleIds?.size||0} / ${workspace.ids.length} 条`:`${workspace.ids.length} 条${workspace.groupView?.groups.length?` · ${workspace.groupView.groups.length} 组`:''}`;
    $('organize').innerHTML=icon(workspace.organizing?'check':'grip');$('organize').setAttribute('aria-label',workspace.organizing?'完成整理':hasSearch()?'清空搜索并整理排列':'整理排列');$('organize').title=workspace.organizing?'完成整理':hasSearch()?'清空搜索并整理排列':'整理排列';
    for(const id of workspace.ids){const buffer=bufferFor(id);if(!buffer)continue;const title=$(`title-${id}`),badge=$(`dirty-${id}`);if(title)title.innerHTML=highlightText(buffer.values.name||'未命名条目',hasSearch()?textMatch(buffer.values.name,workspace.query):null);if(badge)badge.hidden=workspace.drafts.has(id)||!draftChanged(buffer);}
    paintGroupStates();
    if(!workspace.selected)return;
    const id=workspace.selected,buffer=bufferFor(id),index=workspace.ids.indexOf(id);if(!buffer)return;
    $('chars').textContent=`${Array.from(buffer.values.content).length} 字`;$('discard').disabled=busy||!hasDraft(id);
    $('full-title').textContent=titleFor(id);$('full-status').textContent=workspace.drafts.has(id)?'草稿 · 尚未加入发送':draftChanged(buffer)?'修改未保存':workspace.settingsUnconfirmed?'修改已应用':'条目已保存';
    $('full-context').textContent=index?`位于「${titleFor(workspace.ids[index-1])}」之后`:'位于预设开头';$('position').textContent=`${index+1} / ${workspace.ids.length}`;
    $('previous').disabled=busy||index===0;$('next').disabled=busy||index===workspace.ids.length-1;
}
function paintBusy(){if(!busy)return;for(const control of root.querySelectorAll('button,input,select,textarea')){if(!disabledControls.has(control))disabledControls.set(control,control.disabled);control.disabled=true;}}
function setBusy(value){busy=value;root.classList.toggle('pmme-busy',value);if(value)paintBusy();else{for(const [control,disabled]of disabledControls)if(control.isConnected)control.disabled=disabled;disabledControls.clear();}paintStatus();}
async function operation(action){
    if(busy||!workspace)return false;
    const owner=workspace,version=epoch;setBusy(true);
    const check=()=>{if(workspace!==owner||epoch!==version)throw new Error('预设在操作期间发生切换；已阻止继续写入。');native.assertScope(owner.scope);};
    try{check();await action(check);check();return true;}
    catch(error){notify(error.message,true);console.warn('[回声编辑台]',error);if(error.code==='PROMPT_CONFLICT')showConflict();return false;}
    finally{busy=false;root.classList.remove('pmme-busy');for(const[control,disabled]of disabledControls)if(control.isConnected)control.disabled=disabled;disabledControls.clear();if(workspace&&!root.hidden){renderList();paintStatus();}native.refreshNative();}
}
function markApplied(ids){for(const id of ids){workspace.drafts.delete(id);const prompt=native.findPrompt(id);if(prompt){const base=normalizePrompt(prompt);workspace.buffers.set(id,{base,values:copy(base)});}}storeGroupPreferences();}
function validateEditor(){for(const control of[$('depth'),$('order')])if(!control.hidden&&control.offsetParent&&!control.checkValidity()){control.reportValidity();return false;}return true;}
function applyIds(ids){
    syncWorkspace();const owner=workspace;
    const applied=native.applyBuffers({scope:owner.scope,ids,buffers:owner.buffers,drafts:owner.drafts,visibleOrder:owner.ids});
    markApplied(applied);settingsSaver.request(owner);renderList();paintBusy();native.refreshNative();
    return owner;
}
async function saveIds(ids,check){const owner=applyIds(ids);await settingsSaver.wait(owner);check();}
function saveSelected(){
    if(busy||!workspace.selected||!validateEditor())return;
    const wasDraft=workspace.drafts.has(workspace.selected);
    try{applyIds([workspace.selected]);notify(wasDraft?'条目已加入排列；可以继续编辑。':'修改已应用，可以继续编辑。');}
    catch(error){notify(error.message,true);if(error.code==='PROMPT_CONFLICT')showConflict();}
}
function action(label,name,kind,extra=''){return `<button class="pmme-sheet-action ${extra}" data-pmme-action="${kind}">${icon(name)}<span>${escape(label)}</span></button>`;}
function showSheet(title,html){sheetFocus=document.activeElement;$('sheet-title').textContent=title;$('sheet-body').innerHTML=html;$('sheet-layer').hidden=false;$('sheet-close').focus({preventScroll:true});paintBusy();}
function closeSheet(restore=true){$('sheet-layer').hidden=true;$('sheet-body').replaceChildren();if(restore&&sheetFocus?.isConnected)sheetFocus.focus({preventScroll:true});}
function requestUpdate(){
    const pending=pendingIds().length;
    showSheet(`更新「${native.presetName()}」？`,`<p>这会覆盖当前命名预设，包含当前参数、已保存条目和排列。${pending?`还有 ${pending} 个条目未保存。`:''}</p><button class="pmme-button pmme-primary" data-pmme-action="update-all">${pending?'保存修改并更新预设':'确认更新预设'}</button>${pending?'<button class="pmme-button" data-pmme-action="update-saved">只更新已保存条目</button>':''}<button class="pmme-button pmme-quiet" data-pmme-action="close">继续编辑</button>`);
}
async function updateNamed(includeDrafts=true){
    if(!validateEditor())return false;
    closeSheet(false);
    const success=await operation(async check=>{if(includeDrafts&&pendingIds().length)await saveIds(pendingIds(),check);else if(workspace.settingsUnconfirmed){await persistCurrentSettings();check();}check();const name=await native.saveNamedPreset(workspace.scope);check();notify(`已更新预设「${name}」。`);});
    return success;
}
function showConflict(){if(!workspace.selected)return;showSheet('条目发生编辑冲突','<p>其他编辑器改动了同一个字段。当前草稿保留，你可以继续检查，或明确载入最新的原生内容。</p><button class="pmme-button" data-pmme-action="reload-latest">放弃本条草稿，载入最新内容</button><button class="pmme-button pmme-quiet" data-pmme-action="close">保留草稿继续查看</button>');}
function select(id,toggle=false){if(busy||workspace.organizing)return;rememberCursor();workspace.selected=toggle&&workspace.selected===id&&!workspace.full?null:id;if(workspace.selected)revealEntry(id);renderList();}
function createDraft(anchor,before=false,source=null){
    if(busy)return;
    rememberCursor();const id=native.newId(),values=source?copy(source):normalizePrompt({name:'',role:'system',content:''});
    if(source)values.name=`${values.name||'未命名条目'}（副本）`;
    const prompt={identifier:id,...values,system_prompt:false,marker:false,enabled:false};
    workspace.drafts.set(id,{prompt,enableOnSave:config().enableNewOnSave});workspace.buffers.set(id,{base:normalizePrompt({}),values:copy(values)});workspace.ids=insertId(workspace.ids,id,anchor,before);workspace.selected=id;workspace.organizing=false;
    revealEntry(id,true);renderList();if(!workspace.full)$(`row-${id}`)?.scrollIntoView({block:'nearest',behavior:'smooth'});$('name').focus({preventScroll:true});$('name').select();notify('草稿已占据位置，首次保存会自动加入排列。');
}
function expand(){if(!workspace.selected||busy)return;rememberCursor();workspace.scrollTop=$('scroll').scrollTop;workspace.full=true;setView();$('full-slot').appendChild($('editor'));restoreCursor();paintStatus();updateViewport();$('collapse').focus({preventScroll:true});}
function collapse(){if(busy)return;rememberCursor();workspace.full=false;root.classList.remove('pmme-typing');revealEntry(workspace.selected,true);renderList();$('scroll').scrollTop=workspace.scrollTop;$('expand').focus({preventScroll:true});}
function organize(){if(busy)return;rememberCursor();if(workspace.full){workspace.full=false;setView();}workspace.organizing=!workspace.organizing;if(workspace.organizing){workspace.query='';workspace.searchScroll=null;}else if(workspace.selected)revealEntry(workspace.selected);renderList();}
function groupById(id) { return resolveWorkspaceGroups().groups.find(group=>group.id===id); }
function foldGroup(id) {
    if(hasSearch()){notify('搜索时临时展开匹配分组；清空搜索后恢复折叠状态。');return;}
    const definition=workspace.groupDefinitions.find(group=>group?.id===id);
    if(!definition)return;
    definition.collapsed=!definition.collapsed;persistGroups();renderList();
    [...$('list').querySelectorAll('[data-pmme-fold]')].find(button=>button.dataset.pmmeFold===id)?.focus({preventScroll:true});
}
function foldAllGroups(collapsed) {
    for(const group of workspace.groupDefinitions)if(group&&typeof group==='object')group.collapsed=collapsed;
    persistGroups();closeSheet(false);renderList();
    if(hasSearch())notify('已记住折叠状态；搜索结果仍临时展开。');
}
function showGroupTools() {
    syncWorkspace();const view=resolveWorkspaceGroups();
    showSheet('目录分组',`<p>整组拖动和批量启停包含首尾边界。分组记录只保存在插件偏好中，不改写条目名称或正文。</p>
      ${view.invalid.length?`<p class="pmme-group-warning">${view.invalid.length} 个分组边界失效或交叉，相关条目已平铺显示。可重新识别或取消分组。</p>`:''}
      ${action('识别配对名称并预览','search','groups-detect')}
      ${view.groups.length?`${action('全部展开','expand','groups-expand')}${action('全部收起','folder','groups-collapse')}`:''}
      ${workspace.pendingGroupStart?`${action('取消当前首尾边界选择','close','group-mark-cancel')}`:''}
      ${workspace.groupDefinitions.length?`${action('取消全部分组，保留所有条目','remove','groups-clear','pmme-danger')}`:''}
      <p>遇到重名或特殊装饰时，也可以从条目菜单手动指定分组起点和终点。</p>`);
}
function groupingSignature() { return JSON.stringify([workspace.ids,currentEntries().map(entry=>[entry.id,entry.name])]); }
function previewGroups() {
    syncWorkspace();const entries=currentEntries(),result=detectGroups(entries);
    workspace.groupPreview={scope:workspace.scope,signature:groupingSignature(),groups:result.groups};
    const indices=new Map(workspace.ids.map((id,index)=>[id,index]));
    showSheet('识别分组预览',`<p>应用后会替换当前目录分组；不会修改条目内容、开关或排列。默认勾选识别到的配对，可取消不需要的组。</p>
      ${result.groups.map((group,index)=>`<label class="pmme-group-candidate"><input type="checkbox" data-pmme-candidate="${index}" checked><span><strong>${escape(group.name)}</strong><small>${indices.get(group.endId)-indices.get(group.startId)+1} 条（含边界） · ${escape(titleFor(group.startId))} → ${escape(titleFor(group.endId))}</small></span></label>`).join('')}
      ${!result.groups.length?'<p>未找到可确认的配对。可在条目菜单手动指定首尾边界。</p>':''}
      ${result.issues.length?`<div class="pmme-group-warning"><p>以下名称需要检查，未自动配对：</p><ul>${result.issues.map(issue=>`<li>${escape(issue.name||'未命名')}：${escape(issue.message)}</li>`).join('')}</ul></div>`:''}
      ${result.groups.length?'<button class="pmme-button pmme-primary" data-pmme-action="groups-apply">应用所选分组</button>':''}
      <button class="pmme-button" data-pmme-action="groups-tools">返回分组管理</button>`);
}
function applyPreviewGroups() {
    const preview=workspace.groupPreview;if(!preview)return;
    syncWorkspace();native.assertScope(preview.scope);
    if(preview.scope!==workspace.scope||preview.signature!==groupingSignature()){notify('排列或名称已变化，请重新识别分组。',true);previewGroups();return;}
    const selected=[...$('sheet-body').querySelectorAll('[data-pmme-candidate]:checked')].map(input=>preview.groups[Number(input.dataset.pmmeCandidate)]).filter(Boolean);
    const previous=new Map(workspace.groupDefinitions.filter(group=>group&&typeof group==='object').map(group=>[JSON.stringify([group.startId,group.endId]),group]));
    workspace.groupDefinitions=selected.map(group=>({...group,collapsed:previous.get(JSON.stringify([group.startId,group.endId]))?.collapsed??true}));
    workspace.pendingGroupStart=null;workspace.groupPreview=null;closeSheet(false);
    if(workspace.selected)revealEntry(workspace.selected);
    persistGroups();renderList();notify(`已应用 ${selected.length} 个分组，条目内容和排列未改变。`);
}
function groupMenu(id) {
    syncWorkspace();const group=groupById(id);if(!group){notify('分组边界已变化，请重新识别。',true);return;}
    showSheet(group.name,`<div data-pmme-group-action="${escape(id)}">
      ${action('组内新增','plus','group-new')}${action('在组上方新增','plus','group-before')}${action('在组下方新增','plus','group-after')}
      ${action('全部启用（含首尾边界）','check','group-enable')}${action('全部关闭（含首尾边界）','remove','group-disable')}
      ${action('整理分组与条目','grip','organize')}${action('查看开始边界','pen','group-start')}${action('查看结束边界','pen','group-end')}
      ${action('取消这个分组，保留所有条目','remove','group-remove')}
      </div><p>批量启停跳过未保存草稿和原生禁止切换的条目；启用会把所有可切换成员设为开启，不恢复之前的个别开关组合。</p>`);
}
function setGroupEnabled(id,enabled=null) {
    try{
        syncWorkspace();const group=groupById(id);if(!group)throw new Error('分组边界已变化，请重新识别。');
        workspace.orderMap=new Map(native.nativeOrder().map(entry=>[entry.identifier,entry]));
        const state=groupSummary(group),target=enabled===null?state.state!=='true':enabled;
        const drafts=group.ids.filter(item=>workspace.drafts.has(item));
        const result=native.setPromptsEnabled(workspace.scope,group.ids.filter(item=>!workspace.drafts.has(item)),target);
        if(result.changed.length){settingsSaver.request(workspace);native.refreshNative();}
        const skipped=[drafts.length?`${drafts.length} 个草稿`:'',result.skipped.length?`${result.skipped.length} 个受限条目`:''].filter(Boolean);
        paintStatus();
        for(const item of result.changed)paintToggle(item,target);
        notify(`${result.changed.length?`已${target?'启用':'关闭'} ${result.changed.length} 条`:'可切换条目已是目标状态'}${skipped.length?`；跳过 ${skipped.join('、')}`:''}。`);
    }catch(error){notify(error.message,true);}
}
function markGroupStart(id) {
    workspace.pendingGroupStart=id;closeSheet(false);paintStatus();notify('已选择开始边界，请在结束条目的菜单选择“在此结束分组”。');
}
function markGroupEnd(id) {
    syncWorkspace();const startId=workspace.pendingGroupStart;
    if(!startId||!workspace.ids.includes(startId)){workspace.pendingGroupStart=null;throw new Error('开始边界已失效，请重新选择。');}
    const group={id:startId,startId,endId:id,name:parseGroupName(titleFor(startId))?.name||titleFor(startId),collapsed:true};
    const next=[...workspace.groupDefinitions,group],view=resolveGroups(workspace.ids,next);
    if(!view.groups.some(item=>item.id===group.id&&item.startId===startId&&item.endId===id)||view.invalid.some(item=>item.group===group||item.group?.id===group.id))throw new Error('边界顺序错误、已被使用或与其他组交叉。请先取消冲突分组，再选择边界。');
    workspace.groupDefinitions=next;workspace.pendingGroupStart=null;closeSheet(false);if(workspace.selected)revealEntry(workspace.selected);persistGroups();renderList();notify('已建立分组，首尾条目保持原样。');
}
function entryMenu(id){
    const prompt=promptFor(id);if(!prompt)return;const draft=workspace.drafts.has(id),allowed=draft?{remove:true,content:true}:native.permissions(prompt);
    const boundary=resolveWorkspaceGroups().groups.some(group=>group.startId===id||group.endId===id);
    showSheet(titleFor(id),`<div data-pmme-entry="${escape(id)}">${action('在上方新增','plus','before')}${action('在下方新增','plus','after')}${allowed.content?action('复制为独立草稿','copy','duplicate'):''}
      ${!boundary?action('设为分组起点','folder','group-mark-start'):''}${workspace.pendingGroupStart&&workspace.pendingGroupStart!==id&&!boundary?action('在此结束分组','folder','group-mark-end'):''}
      ${action('整理条目顺序','grip','organize')}${allowed.remove?action(draft?'放弃草稿':'从当前排列移除','remove','remove','pmme-danger'):''}</div><p>${boundary?'这是分组边界，随整组拖动；单独移动前请先取消分组。':''}移除只改变排列，不会彻底删除已有条目。${boundary?'移除此边界后，该分组将平铺显示。':''}</p>`);
}
function discardRequest(id=workspace.selected){if(!id||!hasDraft(id))return;const draft=workspace.drafts.has(id);showSheet(draft?'放弃草稿？':'放弃未保存修改？',`<p>${draft?'草稿会从目录中移除。':'本条恢复到最新保存内容。'}其他条目的草稿仍保留。</p><button class="pmme-button pmme-danger" data-pmme-action="discard" data-pmme-entry="${escape(id)}">确认放弃</button><button class="pmme-button" data-pmme-action="close">继续编辑</button>`);}
function discardId(id){
    if(workspace.drafts.has(id)){workspace.drafts.delete(id);workspace.buffers.delete(id);const index=workspace.ids.indexOf(id);workspace.ids=workspace.ids.filter(candidate=>candidate!==id);if(workspace.selected===id)workspace.selected=workspace.ids[Math.min(index,workspace.ids.length-1)]||null;}
    else{const prompt=native.findPrompt(id);if(prompt){const base=normalizePrompt(prompt);workspace.buffers.set(id,{base,values:copy(base)});}}
    renderList();notify('已放弃本条修改，其他草稿仍保留。');
}
function openLibrary(){showSheet('添加已有条目','<p>加入当前条目之后；未选择条目时加入末尾。默认保持关闭。</p><label class="pmme-field" for="pmme-search"><span>搜索标题或正文</span><input id="pmme-search" type="search" placeholder="搜索已有条目" autocomplete="off"></label><div id="pmme-library-results"></div>');renderLibrary('');}
function renderLibrary(query){
    const entries=native.allPrompts().filter(prompt=>!prompt.system_prompt&&`${prompt.name||''} ${prompt.content||''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
    $('library-results').innerHTML=entries.length?entries.map(prompt=>{const included=workspace.ids.includes(prompt.identifier);return `<div class="pmme-library-row"><div><strong>${escape(prompt.name||'未命名条目')}</strong><p>${escape(prompt.marker?'由酒馆提供的内容':String(prompt.content||'').slice(0,50))}</p></div><button class="pmme-button ${included?'pmme-quiet':'pmme-secondary'}" data-pmme-add="${escape(prompt.identifier)}" ${included?'disabled':''}>${included?'已加入':'加入'}</button></div>`;}).join(''):'<p>没有匹配条目，换一个关键词试试。</p>';
}
function addExisting(id){
    closeSheet(false);
    try{syncWorkspace();const next=insertId(workspace.ids,id,workspace.selected);native.insertExisting(workspace.scope,id,next);workspace.ids=next;workspace.selected=id;revealEntry(id,true);settingsSaver.request(workspace);renderList();native.refreshNative();notify('已加入排列，保持关闭。');}
    catch(error){notify(error.message,true);}
}
function removeExisting(id){
    closeSheet(false);
    try{native.removePrompt(workspace.scope,id);workspace.buffers.delete(id);const index=workspace.ids.indexOf(id);workspace.ids=workspace.ids.filter(candidate=>candidate!==id);if(workspace.selected===id)workspace.selected=workspace.ids[Math.min(index,workspace.ids.length-1)]||null;settingsSaver.request(workspace);renderList();native.refreshNative();notify('已从排列中移除，条目仍在已有条目库中。');}
    catch(error){notify(error.message,true);}
}
function paintToggle(id,enabled){
    const row=$(`row-${id}`),button=row?.querySelector('[data-pmme-toggle]'),label=row?.querySelector('[data-pmme-state]');
    if(button){button.setAttribute('aria-checked',String(enabled));button.setAttribute('aria-label',`${titleFor(id)}的启用状态`);button.title=enabled?'点击关闭':'点击启用';}
    if(label)label.textContent=enabled?'已启用':'已关闭';
    paintStatus();
}
function bindSorter(){
    let dragOwner=null,dragVersion=0,dragNativeIds=[];
    sorter=createDragSorter({
        container:$('list'),rowSelector:'.pmme-sort-unit',handleSelector:'.pmme-drag-handle',getId:row=>row.dataset.pmmeSortKey,
        getOrder:()=>[...$('list').querySelectorAll('[data-pmme-id]')].map(row=>row.dataset.pmmeId),
        dropContainers:()=>[$('list'),...$('list').querySelectorAll('[data-pmme-sort-container]')],
        scroller:$('scroll'),ghostHost:root,decorateGhost:ghost=>ghost.querySelector('.pmme-group-body')?.remove(),
        canStart(){
            if(!workspace?.organizing||busy||hasSearch()||!$('sheet-layer').hidden)return false;
            try{
                native.assertScope(workspace.scope);
                const expected=workspace.ids.filter(id=>!workspace.drafts.has(id)),actual=native.nativeOrder().map(entry=>entry.identifier);
                if(JSON.stringify(expected)!==JSON.stringify(actual)){renderList();notify('排列已被其他编辑器修改，请重新拖动。',true);return false;}
                return true;
            }catch(error){notify(error.message,true);return false;}
        },
        onStart(id,original){dragOwner=workspace;dragVersion=epoch;dragNativeIds=original.filter(item=>!workspace.drafts.has(item));workspace.dragging=true;paintStatus();},
        onTargetChange(target){
            if(!workspace)return;
            const group=target?.dataset.pmmeSortParent?workspace.groupView?.groups.find(item=>item.id===target.dataset.pmmeSortParent):null;
            workspace.dragTarget=target?group?`放入「${group.name}」组内`:'放在顶层排列（组外）':null;
            if(!root.hidden)paintStatus();
        },
        onEnd(){if(workspace){workspace.dragging=false;workspace.dragTarget=null;if(!root.hidden)paintStatus();}},
        onCommit(next,original){
            const owner=dragOwner;
            if(!owner||workspace!==owner||epoch!==dragVersion)return;
            try{
                if(next.length!==original.length||new Set(next).size!==next.length||next.some(id=>!original.includes(id)))throw new Error('拖动期间条目发生变化，已取消排序。');
                const previous=resolveGroups(original,owner.groupDefinitions),view=resolveGroups(next,owner.groupDefinitions);
                if(previous.groups.some(group=>!view.groups.some(item=>item.id===group.id)))throw new Error('分组边界发生交叉，已取消排序。');
                const changed=native.applyReorder(owner.scope,next,dragNativeIds);owner.ids=next;
                if(changed){settingsSaver.request(owner);native.refreshNative();}
                renderList();notify(changed?'排列已调整，分组边界一起移动。':'草稿位置已调整。');
            }catch(error){if(workspace!==owner)return;owner.ids=original;renderList();notify(error.message,true);}
        },
    });
}
function capturePresetLocation(){
    const manager=document.getElementById('completion_prompt_manager'),panel=document.getElementById('left-nav-panel'),positions=[];
    const record=element=>{if(element)positions.push({element,id:element.id,top:element.scrollTop,left:element.scrollLeft});};
    record(manager?.querySelector('#completion_prompt_manager_list'));
    for(let element=manager;element&&element!==document.body;element=element.parentElement){
        record(element);
        if(element===panel)break;
    }
    return {scope:workspace.scope,visible:Boolean(panel?.classList.contains('openDrawer')&&manager?.getClientRects().length),positions};
}
function selectedNativeNeighbor(){
    if(!workspace?.selected)return null;
    const nativeIds=new Set(native.nativeOrder().map(entry=>entry.identifier));
    if(nativeIds.has(workspace.selected))return workspace.selected;
    const index=workspace.ids.indexOf(workspace.selected);
    return [...workspace.ids.slice(0,index).reverse(),...workspace.ids.slice(index+1)].find(id=>nativeIds.has(id))||null;
}
async function restorePresetPosition(location,targetId,version){
    if(version!==navigationVersion||!root.hidden||getContext().mainApi!=='openai')return;
    const panel=document.getElementById('left-nav-panel');
    // The mobile drawer opens from zero height, so restore scrolling after that transition.
    const animations=(panel?.getAnimations?.()||[]).filter(animation=>animation.playState==='running'&&Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(animations.map(animation=>animation.finished));
    if(version!==navigationVersion||!root.hidden||getContext().mainApi!=='openai')return;
    const manager=document.getElementById('completion_prompt_manager');
    if(!manager)return;
    let sameScope=false;
    try{sameScope=location?.scope===native.scopeKey();}catch{return;}
    if(sameScope&&location.visible){
        for(const position of location.positions){
            const element=position.id?document.getElementById(position.id):position.element;
            if(!element?.isConnected)continue;
            element.scrollTop=position.top;element.scrollLeft=position.left;
        }
    }
    const row=sameScope&&targetId?[...manager.querySelectorAll('[data-pm-identifier]')].find(element=>element.dataset.pmIdentifier===targetId):null;
    if(row?.getClientRects().length)row.scrollIntoView({block:'nearest',inline:'nearest'});
    else if(!sameScope||!location.visible)manager.scrollIntoView({block:'start',inline:'nearest'});
    const focus=row?.querySelector('.prompt-manager-edit-action')||document.getElementById('pmme-open');
    focus?.focus({preventScroll:true});
}
function open(id=null){
    if(!config().enabled){notify('请先在扩展设置中启用回声编辑台。',true);return;}
    try{
        makeWorkspace();native.assertScope(workspace.scope);navigationVersion++;returningVersion=0;
        if(root.hidden){
            returnLocation=capturePresetLocation();originalOverflow=document.body.style.overflow;
            root.hidden=false;document.body.style.overflow='hidden';
        }
        applyAppearance();
        if(id&&workspace.ids.includes(id)){workspace.selected=id;workspace.organizing=false;revealEntry(id,true);}
        renderList();updateViewport();
        if(id&&!workspace.full)requestAnimationFrame(()=>$(`row-${id}`)?.scrollIntoView({block:'nearest'}));
    }catch(error){notify(error.message,true);}
}
async function close(showNotice=true,force=false,restorePreset=true){
    if(root.hidden||(!force&&(busy||returningVersion)))return;
    const version=++navigationVersion,location=returnLocation;
    returningVersion=version;
    rememberCursor();sorter?.cancel();closeSheet(false);
    if(workspace)archives.set(workspace.scope,workspace);
    let targetId=null;
    if(restorePreset&&getContext().mainApi==='openai'){
        try{
            targetId=selectedNativeNeighbor();
            const panel=document.getElementById('left-nav-panel'),toggle=document.querySelector('#ai-config-button > .drawer-toggle');
            // Open the destination beneath the editor before removing the covering page.
            if(panel&&toggle&&!panel.classList.contains('openDrawer'))await doNavbarIconClick.call(toggle);
        }catch(error){console.warn('[回声编辑台] 返回预设编辑区失败',error);}
    }
    if(version!==navigationVersion){if(returningVersion===version)returningVersion=0;return;}
    returningVersion=0;
    root.hidden=true;document.body.style.overflow=originalOverflow;root.classList.remove('pmme-typing');
    if(restorePreset)requestAnimationFrame(()=>restorePresetPosition(location,targetId,version));
    if(showNotice&&workspace&&pendingIds().length)notify('草稿在本次页面中保留；刷新前请保存。');
}
function performPresetSwitch(value){const select=document.getElementById('settings_preset_openai');if(!select)return;allowPresetSwitch=true;try{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));}finally{allowPresetSwitch=false;}}
function interceptPresetChange(event){
    if(allowPresetSwitch||!config().enabled||event.target?.id!=='settings_preset_openai'||!workspace)return;
    let attention;try{attention=needsAttention();}catch{return;}if(!attention&&!busy)return;
    const value=event.target.value;if(value===workspace.presetValue)return;
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();event.target.value=workspace.presetValue;
    if(busy){notify('请等待当前保存完成再切换预设。',true);return;}
    open();workspace.switchValue=value;
    showSheet('切换预设前处理修改','<p>当前预设有草稿或尚未更新的配置。直接切换会用目标预设覆盖当前配置。</p><button class="pmme-button pmme-primary" data-pmme-action="save-switch">保存修改并更新后切换</button><button class="pmme-button pmme-danger" data-pmme-action="discard-switch">放弃当前改动并切换</button><button class="pmme-button pmme-quiet" data-pmme-action="close">取消切换</button>');
}
function interceptNativeClick(event){
    if(!config().enabled||!config().interceptNative||event.shiftKey)return;
    const target=event.target instanceof Element?event.target:null,managerRoot=target?.closest('#completion_prompt_manager');if(!managerRoot)return;
    const edit=target.closest('.prompt-manager-edit-action'),create=target.closest('.completion_prompt_manager_footer .fa-plus-square');
    if(!edit&&!create)return;
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    const id=edit?.closest('[data-pm-identifier]')?.dataset.pmIdentifier;
    open(id||null);if(create&&!root.hidden)createDraft(workspace.selected);
}
function updateViewport(){
    if(!root||root.hidden)return;const viewport=window.visualViewport;
    if(viewport){root.style.setProperty('--pmme-height',`${viewport.height}px`);root.style.setProperty('--pmme-top',`${viewport.offsetTop}px`);}
    root.classList.toggle('pmme-typing',Boolean(workspace?.full&&document.activeElement===$('content')&&viewport&&viewport.height<window.innerHeight*.8));
}
function mountEntryButton(){
    const manager=document.getElementById('completion_prompt_manager');if(!manager)return;
    const existing=document.getElementById('pmme-open');if(existing){existing.hidden=!config().enabled;return;}
    const host=manager.querySelector('.completion_prompt_manager_header');if(!host)return;
    const button=document.createElement('button');button.id='pmme-open';button.type='button';button.className='menu_button pmme-entry-button';button.innerHTML=`${icon('echo')}<span>回声编辑台</span>`;button.title='回声编辑台 · 预设编辑';button.setAttribute('aria-label','打开回声编辑台预设编辑器');button.hidden=!config().enabled;button.addEventListener('click',()=>open());host.appendChild(button);
}
function bindUI(){
    $('retry').addEventListener('click',()=>{if(workspace?.settingsSaveFailed)settingsSaver.request(workspace);if(preferencesError)settingsSaver.request(preferencesOwner);});
    $('theme-control').addEventListener('click',showAppearancePicker);$('full-theme-control').addEventListener('click',showAppearancePicker);
    $('close').addEventListener('click',()=>close());$('new-after').addEventListener('click',()=>createDraft(workspace.selected));$('library').addEventListener('click',openLibrary);$('organize').addEventListener('click',organize);$('expand').addEventListener('click',expand);$('collapse').addEventListener('click',collapse);$('save').addEventListener('click',saveSelected);$('update').addEventListener('click',requestUpdate);$('discard').addEventListener('click',()=>discardRequest());$('full-menu').addEventListener('click',()=>entryMenu(workspace.selected));
    $('directory-search').addEventListener('input',event=>{if(!busy)setSearchQuery(event.target.value);});
    $('clear-search').addEventListener('click',()=>{if(busy)return;setSearchQuery('');$('directory-search').focus();});
    $('search-titles').addEventListener('change',event=>{if(busy)return;workspace.titleOnly=event.target.checked;renderList();});
    $('groups').addEventListener('click',()=>{if(busy)return;try{showGroupTools();}catch(error){notify(error.message,true);}});
    $('previous').addEventListener('click',()=>{const index=workspace.ids.indexOf(workspace.selected);if(index>0)select(workspace.ids[index-1]);});$('next').addEventListener('click',()=>{const index=workspace.ids.indexOf(workspace.selected);if(index<workspace.ids.length-1)select(workspace.ids[index+1]);});
    $('list').addEventListener('click',event=>{
        if(busy)return;const button=event.target.closest('button');if(!button||button.disabled)return;
        if(button.hasAttribute('data-pmme-create-first')){createDraft(null);return;}
        if(button.hasAttribute('data-pmme-clear-query')){setSearchQuery('');$('directory-search').focus();return;}
        if(button.dataset.pmmeFold){foldGroup(button.dataset.pmmeFold);return;}
        if(button.dataset.pmmeGroupMenu){groupMenu(button.dataset.pmmeGroupMenu);return;}
        if(button.dataset.pmmeGroupToggle){setGroupEnabled(button.dataset.pmmeGroupToggle);return;}
        if(button.dataset.pmmeSelect)select(button.dataset.pmmeSelect,true);
        if(button.dataset.pmmeMenu)entryMenu(button.dataset.pmmeMenu);
        if(button.dataset.pmmeToggle){const id=button.dataset.pmmeToggle;if(workspace.drafts.has(id)){notify('草稿不参与发送；保存时可选择启用。');return;}try{const enabled=native.togglePrompt(workspace.scope,id);paintToggle(id,enabled);settingsSaver.request(workspace);native.refreshNative();}catch(error){notify(error.message,true);}}
    });
    $('editor').addEventListener('input',event=>{
        if(busy||!workspace.selected)return;const buffer=bufferFor(workspace.selected),name=event.target.id.replace('pmme-',''),map={name:'name',role:'role',content:'content',injection:'injection_position',depth:'injection_depth',order:'injection_order',overrides:'forbid_overrides'};
        if(map[name])buffer.values[map[name]]=name==='overrides'?event.target.checked:['injection','depth','order'].includes(name)?Number(event.target.value):event.target.value;
        if(name.startsWith('trigger-'))buffer.values.injection_trigger=[...buffer.values.injection_trigger.filter(t=>!TRIGGERS.includes(t)),...TRIGGERS.filter(t=>$(`trigger-${t}`).checked)];
        if(name==='enable-new')workspace.drafts.get(workspace.selected).enableOnSave=event.target.checked;
        updateAdvanced();rememberCursor();paintStatus();
    });
    $('editor').addEventListener('focusout',()=>{rememberCursor();requestAnimationFrame(updateViewport);});$('editor').addEventListener('focusin',updateViewport);$('content').addEventListener('select',rememberCursor);$('content').addEventListener('scroll',rememberCursor);
    $('sheet-close').addEventListener('click',()=>closeSheet());$('backdrop').addEventListener('click',()=>{if(!busy)closeSheet();});
    $('sheet-body').addEventListener('input',event=>{if(event.target.id==='pmme-search')renderLibrary(event.target.value);});
    $('sheet-body').addEventListener('click',async event=>{
        if(busy)return;const button=event.target.closest('button');if(!button)return;
        if(button.dataset.pmmeTheme){setAppearance(button.dataset.pmmeTheme);closeSheet();return;}
        if(button.dataset.pmmeAdd){await addExisting(button.dataset.pmmeAdd);return;}
        const kind=button.dataset.pmmeAction,id=button.closest('[data-pmme-entry]')?.dataset.pmmeEntry,groupId=button.closest('[data-pmme-group-action]')?.dataset.pmmeGroupAction;
        if(kind==='close'){closeSheet();return;}
        try{
            if(kind==='groups-tools'){showGroupTools();return;}
            if(kind==='groups-detect'){previewGroups();return;}
            if(kind==='groups-apply'){applyPreviewGroups();return;}
            if(kind==='groups-expand'||kind==='groups-collapse'){foldAllGroups(kind==='groups-collapse');return;}
            if(kind==='groups-clear'){showSheet('取消全部分组？','<p>只取消目录分组，所有条目、开关和排列保持原样。</p><button class="pmme-button pmme-danger" data-pmme-action="groups-clear-confirm">确认取消分组</button><button class="pmme-button" data-pmme-action="groups-tools">保留分组</button>');return;}
            if(kind==='groups-clear-confirm'){workspace.groupDefinitions=[];workspace.pendingGroupStart=null;persistGroups();closeSheet(false);renderList();notify('已取消分组，所有条目保持原样。');return;}
            if(kind==='group-mark-start'){markGroupStart(id);return;}
            if(kind==='group-mark-end'){markGroupEnd(id);return;}
            if(kind==='group-mark-cancel'){workspace.pendingGroupStart=null;closeSheet(false);paintStatus();return;}
            if(['group-new','group-before','group-after','group-start','group-end','group-remove','group-enable','group-disable'].includes(kind)){
                syncWorkspace();const group=groupById(groupId);if(!group)throw new Error('分组边界已变化，请重新识别。');closeSheet(false);
                if(kind==='group-enable'||kind==='group-disable'){setGroupEnabled(groupId,kind==='group-enable');return;}
                if(kind==='group-remove'){workspace.groupDefinitions=workspace.groupDefinitions.filter(item=>item?.id!==groupId);persistGroups();renderList();notify('已取消此分组，条目和子分组保持原样。');return;}
                if(kind==='group-start'||kind==='group-end'){const target=kind==='group-start'?group.startId:group.endId;workspace.organizing=false;revealEntry(target,true);select(target);$(`row-${target}`)?.scrollIntoView({block:'nearest'});return;}
                createDraft(kind==='group-before'?group.startId:group.endId,kind!=='group-after');return;
            }
        }catch(error){notify(error.message,true);return;}
        if(['before','after','duplicate'].includes(kind)){closeSheet(false);createDraft(id,kind==='before',kind==='duplicate'?bufferFor(id).values:null);return;}
        if(kind==='organize'){closeSheet(false);organize();return;}
        if(kind==='update-all'||kind==='update-saved'){await updateNamed(kind==='update-all');return;}
        if(kind==='discard'){closeSheet(false);discardId(id);return;}
        if(kind==='reload-latest'){const target=workspace.selected;closeSheet(false);discardId(target);return;}
        if(kind==='remove'){
            if(workspace.drafts.has(id)){discardRequest(id);return;}
            showSheet('从当前排列移除？',`<p>「${escape(titleFor(id))}」仍保留在已有条目库中。${hasDraft(id)?'本条未保存的修改会被放弃。':''}</p><button class="pmme-button pmme-danger" data-pmme-action="remove-confirm" data-pmme-entry="${escape(id)}">确认移除</button><button class="pmme-button" data-pmme-action="close">保留条目</button>`);return;
        }
        if(kind==='remove-confirm'){await removeExisting(id);return;}
        if(kind==='save-switch'){const value=workspace.switchValue;if(await updateNamed(true))performPresetSwitch(value);return;}
        if(kind==='discard-switch'){const value=workspace.switchValue;settingsSaver.cancel(workspace);archives.delete(workspace.scope);workspace.buffers.clear();workspace.drafts.clear();workspace.backgroundSaving=false;workspace.settingsSaveFailed=false;workspace.settingsUnconfirmed=false;closeSheet(false);performPresetSwitch(value);}
    });
    root.addEventListener('keydown',event=>{
        if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(workspace.selected)void saveSelected();else requestUpdate();}
        if(event.key==='Escape'&&!busy){event.preventDefault();event.stopPropagation();if(!$('sheet-layer').hidden)closeSheet();else if(workspace.full)collapse();else if(hasSearch()){setSearchQuery('');$('directory-search').focus();}else close();}
        if(event.key==='Tab'&&!$('sheet-layer').hidden){const focusable=[...$('sheet-layer').querySelectorAll('button:not(:disabled),input,select')],first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
    });
    // Keep the native configuration drawer open while interacting with our own page.
    root.addEventListener('click',event=>event.stopPropagation());
    window.addEventListener('click',interceptNativeClick,true);window.addEventListener('change',interceptPresetChange,true);
    window.visualViewport?.addEventListener('resize',updateViewport);window.visualViewport?.addEventListener('scroll',updateViewport);window.addEventListener('resize',updateViewport);
    window.addEventListener('beforeunload',event=>{if(!config().enabled)return;const workspaces=new Set([...archives.values(),workspace].filter(Boolean));const unsaved=settingsSaver.isPending(preferencesOwner)||[...workspaces].some(w=>w.settingsUnconfirmed||w.drafts.size||[...w.buffers.values()].some(draftChanged));if(unsaved){event.preventDefault();event.returnValue='';}});
    bindSorter();
}
async function mountSettings(){
    const context=getContext(),host=document.getElementById('extensions_settings2')||document.getElementById('extensions_settings');if(!host)return;
    host.insertAdjacentHTML('beforeend',await context.renderExtensionTemplateAsync(`third-party/${EXTENSION_FOLDER}`,'settings'));
    const settings=config();$('setting-enabled').checked=settings.enabled;$('setting-intercept').checked=settings.interceptNative;$('setting-enable-new').checked=settings.enableNewOnSave;
    $('setting-theme').value=settings.theme;$('setting-theme').addEventListener('change',()=>setAppearance($('setting-theme').value));
    for(const[id,key]of[['setting-enabled','enabled'],['setting-intercept','interceptNative'],['setting-enable-new','enableNewOnSave']])$(id).addEventListener('change',()=>{settings[key]=$(id).checked;if(key==='enabled'&&!settings.enabled&&!root.hidden)close();saveConfig();});
    $('setting-open').addEventListener('click',()=>open());
}
async function initialize(){
    if(initialized)return;initialized=true;
    const migration=migrateLegacySettings();config();
    if(migration.disabled){if(migration.changed)settingsSaver.request(preferencesOwner);return;}
    makeRoot();bindUI();
    const context=getContext();
    context.eventSource.on(context.eventTypes.OAI_PRESET_CHANGED_BEFORE,()=>{epoch++;sorter.cancel();if(workspace)archives.set(workspace.scope,workspace);if(!root.hidden)close(false,true,false);workspace=null;});
    context.eventSource.on(context.eventTypes.OAI_PRESET_CHANGED_AFTER,()=>{workspace=null;mountEntryButton();});
    context.eventSource.on(context.eventTypes.MAIN_API_CHANGED,()=>{if(!root.hidden&&getContext().mainApi!=='openai'){epoch++;close(false,true,false);notify('已返回酒馆；草稿在本次页面中保留。');}});
    const manager=document.getElementById('completion_prompt_manager');if(manager){observer=new MutationObserver(()=>{if(!scheduledMount)scheduledMount=requestAnimationFrame(()=>{scheduledMount=0;mountEntryButton();});});observer.observe(manager,{childList:true,subtree:true});}
    mountEntryButton();try{await mountSettings();}catch(error){console.warn('[回声编辑台] 设置面板加载失败',error);}
    if(migration.changed)settingsSaver.request(preferencesOwner);
}
getContext().eventSource.on(getContext().eventTypes.APP_READY,initialize);
