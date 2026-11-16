import { getContext } from '../../../extensions.js';
import { doNavbarIconClick } from '../../../../script.js';
import * as native from './adapter.js';
import { normalizePrompt, draftChanged, mergeDraftPositions, insertId, PROMPT_FIELDS, TRIGGERS, copy } from './model.js';
import { createDragSorter } from './drag-sort.js';
import { createSaveQueue } from './save-queue.js';

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
        <div class="pmme-toolbar pmme-gutter"><button id="pmme-new" class="pmme-button pmme-primary pmme-grow">${icon('plus')}新建条目</button><button id="pmme-library" class="pmme-button">${icon('library')}添加已有</button><button id="pmme-organize" class="pmme-icon-button" aria-label="整理排列" title="整理排列">${icon('grip')}</button></div>
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
    workspace=archives.get(scope) || {scope,ids:native.nativeOrder().map(e=>e.identifier),buffers:new Map(),drafts:new Map(),cursors:new Map(),selected:null,full:false,organizing:false,scrollTop:0,settingsUnconfirmed:false};
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
function renderList() {
    if(!workspace)return;
    const focus=$('editor').contains(document.activeElement)?document.activeElement.id:null,scroll=$('scroll').scrollTop;
    rememberCursor();sorter?.cancel();$('parking').appendChild($('editor'));syncWorkspace();setView();
    $('list').innerHTML=workspace.ids.map(id=>{
        const prompt=promptFor(id),buffer=bufferFor(id);if(!prompt||!buffer)return '';
        const draft=workspace.drafts.has(id),allowed=draft?{toggle:false,edit:true}:native.permissions(prompt),entry=native.nativeOrder().find(item=>item.identifier===id);
        const enabled=Boolean(entry?.enabled),role=prompt.marker?'内容占位符':buffer.values.role;
        return `<article id="pmme-row-${escape(id)}" class="pmme-item ${workspace.selected===id&&!workspace.organizing?'pmme-selected':''}" data-pmme-id="${escape(id)}"><div class="pmme-item-top">${workspace.organizing?`<button class="pmme-drag-handle pmme-icon-button" aria-label="拖动${escape(titleFor(id))}排序" title="按住拖动">${icon('grip')}</button>`:''}<button class="pmme-item-main" data-pmme-select="${escape(id)}" aria-expanded="${workspace.selected===id&&!workspace.organizing}"><span id="pmme-title-${escape(id)}" class="pmme-item-title">${escape(titleFor(id))}</span><span class="pmme-item-sub"><span>${escape(role)}</span><span data-pmme-state>${draft?'草稿 · 不发送':enabled?'已启用':'已关闭'}</span><span id="pmme-dirty-${escape(id)}" class="pmme-pending" ${!draft&&draftChanged(buffer)?'':'hidden'}>有修改</span></span></button><div class="pmme-item-actions"><button type="button" class="pmme-toggle pmme-icon-button" role="switch" data-pmme-toggle="${escape(id)}" aria-label="${escape(titleFor(id))}的启用状态" aria-checked="${enabled&&!draft}" title="${draft?'草稿保存后才可启用':enabled?'点击关闭':'点击启用'}" ${draft||!allowed.toggle?'disabled':''}><span class="pmme-switch-track" aria-hidden="true"></span></button><button class="pmme-icon-button" data-pmme-menu="${escape(id)}" aria-label="${escape(titleFor(id))}的更多操作">${icon('more')}</button></div></div><div id="pmme-slot-${escape(id)}" class="pmme-editor-slot"></div></article>`;
    }).join('');
    if(workspace.selected&&!workspace.organizing){(workspace.full?$('full-slot'):$(`slot-${workspace.selected}`))?.appendChild($('editor'));loadEditor();}
    $('scroll').scrollTop=scroll;
    if(focus&&!workspace.organizing&&document.getElementById(focus)?.isConnected)document.getElementById(focus).focus({preventScroll:true});
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
    $('status').textContent=busy?'正在更新预设…':workspace.settingsSaveFailed?'后台保存失败，修改仍保留':preferencesError?'主题偏好未确认保存，请重试':pending?`${pending} 个条目有草稿或修改`:workspace.backgroundSaving?'当前配置 · 命名预设待更新':workspace.settingsUnconfirmed?'当前设置尚未确认保存，请重试':native.presetNeedsUpdate()?'条目已保存 · 命名预设待更新':'当前条目与命名预设一致';
    $('retry').hidden=!(workspace.settingsSaveFailed||preferencesError)||busy;
    $('status').classList.toggle('pmme-pending',Boolean(pending||workspace.settingsUnconfirmed||preferencesError||native.presetNeedsUpdate()));
    $('hint').textContent=workspace.dragging?'拖到目标位置后松手':workspace.organizing?'按住把手拖动；松手后保存排列':'点击条目快改，展开全屏长写';
    $('count').textContent=`${workspace.ids.length} 个条目`;$('organize').innerHTML=icon(workspace.organizing?'check':'grip');$('organize').setAttribute('aria-label',workspace.organizing?'完成整理':'整理排列');
    for(const id of workspace.ids){const buffer=bufferFor(id);if(!buffer)continue;const title=$(`title-${id}`),badge=$(`dirty-${id}`);if(title)title.textContent=buffer.values.name||'未命名条目';if(badge)badge.hidden=workspace.drafts.has(id)||!draftChanged(buffer);}
    if(!workspace.selected)return;
    const id=workspace.selected,buffer=bufferFor(id),index=workspace.ids.indexOf(id);if(!buffer)return;
    $('chars').textContent=`${Array.from(buffer.values.content).length} 字`;$('discard').disabled=!hasDraft(id);
    $('full-title').textContent=titleFor(id);$('full-status').textContent=workspace.drafts.has(id)?'草稿 · 尚未加入发送':draftChanged(buffer)?'修改未保存':workspace.settingsUnconfirmed?'修改已应用':'条目已保存';
    $('full-context').textContent=index?`位于「${titleFor(workspace.ids[index-1])}」之后`:'位于预设开头';$('position').textContent=`${index+1} / ${workspace.ids.length}`;
    $('previous').disabled=index===0;$('next').disabled=index===workspace.ids.length-1;
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
function markApplied(ids){for(const id of ids){workspace.drafts.delete(id);const prompt=native.findPrompt(id);if(prompt){const base=normalizePrompt(prompt);workspace.buffers.set(id,{base,values:copy(base)});}}}
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
function select(id,toggle=false){if(busy||workspace.organizing)return;rememberCursor();workspace.selected=toggle&&workspace.selected===id&&!workspace.full?null:id;renderList();}
function createDraft(anchor,before=false,source=null){
    if(busy)return;
    rememberCursor();const id=native.newId(),values=source?copy(source):normalizePrompt({name:'',role:'system',content:''});
    if(source)values.name=`${values.name||'未命名条目'}（副本）`;
    const prompt={identifier:id,...values,system_prompt:false,marker:false,enabled:false};
    workspace.drafts.set(id,{prompt,enableOnSave:config().enableNewOnSave});workspace.buffers.set(id,{base:normalizePrompt({}),values:copy(values)});workspace.ids=insertId(workspace.ids,id,anchor,before);workspace.selected=id;workspace.organizing=false;
    renderList();if(!workspace.full)$(`row-${id}`).scrollIntoView({block:'nearest',behavior:'smooth'});$('name').focus({preventScroll:true});$('name').select();notify('草稿已占据位置，首次保存会自动加入排列。');
}
function expand(){if(!workspace.selected||busy)return;rememberCursor();workspace.scrollTop=$('scroll').scrollTop;workspace.full=true;setView();$('full-slot').appendChild($('editor'));restoreCursor();paintStatus();updateViewport();$('collapse').focus({preventScroll:true});}
function collapse(){if(busy)return;rememberCursor();workspace.full=false;root.classList.remove('pmme-typing');renderList();$('scroll').scrollTop=workspace.scrollTop;$('expand').focus({preventScroll:true});}
function organize(){if(busy)return;rememberCursor();if(workspace.full){workspace.full=false;setView();}workspace.organizing=!workspace.organizing;renderList();}
function entryMenu(id){
    const prompt=promptFor(id);if(!prompt)return;const draft=workspace.drafts.has(id),allowed=draft?{remove:true,content:true}:native.permissions(prompt);
    showSheet(titleFor(id),`<div data-pmme-entry="${escape(id)}">${action('在上方新增','plus','before')}${action('在下方新增','plus','after')}${allowed.content?action('复制为独立草稿','copy','duplicate'):''}${action('整理条目顺序','grip','organize')}${allowed.remove?action(draft?'放弃草稿':'从当前排列移除','remove','remove','pmme-danger'):''}</div><p>整理模式中按住把手拖动。移除只改变排列，不会彻底删除已有条目。</p>`);
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
    try{syncWorkspace();const next=insertId(workspace.ids,id,workspace.selected);native.insertExisting(workspace.scope,id,next);workspace.ids=next;workspace.selected=id;settingsSaver.request(workspace);renderList();native.refreshNative();notify('已加入排列，保持关闭。');}
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
    sorter=createDragSorter({container:$('list'),rowSelector:'.pmme-item',handleSelector:'.pmme-drag-handle',getId:row=>row.dataset.pmmeId,scroller:$('scroll'),ghostHost:root,canStart:()=>Boolean(workspace?.organizing&&!busy),
        onStart(){workspace.dragging=true;workspace.dragNativeIds=native.nativeOrder().map(e=>e.identifier);paintStatus();},onEnd(){if(workspace){workspace.dragging=false;paintStatus();}},
        async onCommit(next,original){
            if(!workspace)return;
            const owner=workspace;
            try{const changed=native.applyReorder(owner.scope,next,owner.dragNativeIds);owner.ids=next;
                if(changed){settingsSaver.request(owner);paintStatus();native.refreshNative();notify('排列已调整。');}
                else{renderList();notify('草稿位置已调整。');}
            }catch(error){if(workspace!==owner)return;owner.ids=original;renderList();notify(error.message,true);}
        }
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
        if(id&&workspace.ids.includes(id)){workspace.selected=id;workspace.organizing=false;}
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
    $('close').addEventListener('click',()=>close());$('new').addEventListener('click',()=>createDraft(workspace.selected));$('new-after').addEventListener('click',()=>createDraft(workspace.selected));$('library').addEventListener('click',openLibrary);$('organize').addEventListener('click',organize);$('expand').addEventListener('click',expand);$('collapse').addEventListener('click',collapse);$('save').addEventListener('click',saveSelected);$('update').addEventListener('click',requestUpdate);$('discard').addEventListener('click',()=>discardRequest());$('full-menu').addEventListener('click',()=>entryMenu(workspace.selected));
    $('previous').addEventListener('click',()=>{const index=workspace.ids.indexOf(workspace.selected);if(index>0)select(workspace.ids[index-1]);});$('next').addEventListener('click',()=>{const index=workspace.ids.indexOf(workspace.selected);if(index<workspace.ids.length-1)select(workspace.ids[index+1]);});
    $('list').addEventListener('click',event=>{
        if(busy)return;const button=event.target.closest('button');if(!button)return;
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
        const kind=button.dataset.pmmeAction,id=button.closest('[data-pmme-entry]')?.dataset.pmmeEntry;
        if(kind==='close'){closeSheet();return;}
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
        if(event.key==='Escape'&&!busy){event.preventDefault();event.stopPropagation();if(!$('sheet-layer').hidden)closeSheet();else if(workspace.full)collapse();else close();}
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
