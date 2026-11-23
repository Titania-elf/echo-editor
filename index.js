import { getContext } from '../../../extensions.js';
import { doNavbarIconClick } from '../../../../script.js';
import * as native from './adapter.js';
import { normalizePrompt, draftChanged, mergeDraftPositions, insertId, PROMPT_FIELDS, TRIGGERS, copy } from './model.js';
import { createDragSorter } from './drag-sort.js';
import { createSaveQueue } from './save-queue.js';
import { parseGroupName, detectGroups, resolveGroups } from './groups.js';
import { textMatch, searchEntries } from './search.js';
import { planContentReplacement, prepareReplacementPatch, prepareReplacementUndo, mapReplacementOffset } from './replace.js';
import { DESKTOP_MIN_WIDTH, DEFAULT_DIRECTORY_WIDTH, normalizeLayout, normalizeDirectoryWidth, resolveLayout, directoryWidthBounds, fitDirectoryWidth } from './layout.js';
import { createHistoryStore, assertHistoryStore, versionsFor, versionById, headVersion, suggestVersion, validateVersion, planVersionSave, removeVersion, groupsForPreset, replacePresetGroups, scopePresetName, historyBytes, HISTORY_WARNING_BYTES, VERSION_LIMIT, NOTE_LIMIT } from './history.js';

const MODULE = '回声编辑台';
const LEGACY_MODULE = 'st-preset-mobile-editor';
const EXTENSION_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).at(-1));
const defaults = { enabled:true, interceptNative:true, enableNewOnSave:false, theme:'paper', layout:'auto', directoryWidth:DEFAULT_DIRECTORY_WIDTH };
const THEMES = [
    {id:'paper', label:'纸白', description:'米白纸张、深墨文字与灰蓝强调色。'},
    {id:'night', label:'夜色', description:'柔和石墨灰，适合夜间连续编辑。'},
    {id:'tavern', label:'跟随酒馆', short:'酒馆', description:'继承酒馆当前配色，不改变酒馆本身。'},
];
const LAYOUTS = [
    {id:'auto', label:'自动', description:'宽窗口使用电脑双栏，窄窗口保留手机单栏。'},
    {id:'mobile', label:'手机单栏', description:'在目录内编辑条目，长正文可单独全屏阅读和写作。'},
    {id:'desktop', label:'电脑双栏', description:'左侧目录、右侧编辑；窗口过窄时临时使用单栏。'},
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
    layout:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 4v16"/>',
    remove:'<path d="M5 12h14"/><circle cx="12" cy="12" r="9"/>',
    trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/>',
    history:'<path d="M3 11a9 9 0 1 1 2.6 7M3 5v6h6M12 7v5l3 2"/>',
    replace:'<path d="M4 7h14m-3-3 3 3-3 3M20 17H6m3-3-3 3 3 3"/>',
    undo:'<path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12"/>',
};
const icon = name => `<svg class="pmme-icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let root, initialized=false, workspace=null, busy=false, epoch=0, sorter, observer, scheduledMount=0, toastTimer, allowPresetSwitch=false;
let originalOverflow='', sheetFocus=null, sheetAnchor=null, deleteConfirmation=null, directoryResize=null, disabledControls=new Map(), returnLocation=null, navigationVersion=0, returningVersion=0, preferencesError=null;
let versionConfirmation=null, historyConfirmation=null, historyError=null, historySaving=false, busyLabel='正在处理…', replacementPanel=null;
const archives=new Map();
const preferencesOwner={preferences:true},historyOwner={history:true};
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
    settings.layout=normalizeLayout(settings.layout);
    settings.directoryWidth=normalizeDirectoryWidth(settings.directoryWidth);
    if(!settings.groupsByScope || typeof settings.groupsByScope!=='object' || Array.isArray(settings.groupsByScope))settings.groupsByScope={};
    return settings;
}
function historyStore() {
    const settings=config();
    if(settings.presetHistory===undefined)settings.presetHistory=createHistoryStore();
    return assertHistoryStore(settings.presetHistory);
}
const settingsSaver = createSaveQueue({
    persist: owner => native.persistSettings(owner===preferencesOwner||owner===historyOwner?null:owner.scope, 15000, true),
    isCurrent(owner) { if(owner===preferencesOwner||owner===historyOwner)return true;if(workspace!==owner)return false;try{native.assertScope(owner.scope);return true;}catch{return false;} },
    onPending(owner) {
        if(owner===historyOwner){historySaving=true;historyError=null;if(root&&!root.hidden)paintStatus();return;}
        if(owner===preferencesOwner){preferencesError=null;if(root&&!root.hidden)paintStatus();return;}
        owner.backgroundSaving=true;owner.settingsUnconfirmed=true;owner.settingsSaveFailed=false;
        if(workspace===owner&&root&&!root.hidden)paintStatus();
    },
    onSaved(owner) {
        if(owner===historyOwner){historySaving=false;historyError=null;if(root&&!root.hidden)paintStatus();return;}
        if(owner===preferencesOwner){preferencesError=null;if(root&&!root.hidden)paintStatus();return;}
        owner.backgroundSaving=false;owner.settingsUnconfirmed=false;owner.settingsSaveFailed=false;
        if(workspace===owner&&root&&!root.hidden)paintStatus();
    },
    onError(owner,error) {
        if(owner===historyOwner){historySaving=false;historyError=error;if(root&&!root.hidden)paintStatus();notify('历史版本未确认保存，记录仍在当前页面，请重试保存。',true);return;}
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
function isDesktop() { return root?.dataset.pmmeLayout==='desktop'; }
function directoryAvailableWidth() {
    return $('workbench').clientWidth || Math.min(1600,document.documentElement.clientWidth || window.innerWidth);
}
function syncDirectoryWidth(value=config().directoryWidth) {
    const available=directoryAvailableWidth(),width=fitDirectoryWidth(value,available),bounds=directoryWidthBounds(available);
    root.style.setProperty('--pmme-directory-width',`${width}px`);
    const splitter=$('splitter');
    splitter.setAttribute('aria-valuemin',String(bounds.min));splitter.setAttribute('aria-valuemax',String(bounds.max));
    splitter.setAttribute('aria-valuenow',String(width));splitter.setAttribute('aria-valuetext',`目录宽度 ${width} 像素`);
    return width;
}
function applyLayout(redraw=true) {
    if(!root)return;
    const width=document.documentElement.clientWidth || window.innerWidth,settings=config(),layout=resolveLayout(settings.layout,width);
    const changed=root.dataset.pmmeLayout!==layout;
    if(changed){rememberCursor();finishDirectoryResize(true);sorter?.cancel();}
    root.dataset.pmmeLayout=layout;root.dataset.pmmeWide=String(width>=DESKTOP_MIN_WIDTH);
    syncDirectoryWidth(directoryResize?.width??settings.directoryWidth);
    const preference=LAYOUTS.find(item=>item.id===settings.layout),button=$('layout-control');
    button.innerHTML=`${icon('layout')}<span>${layout==='desktop'?'双栏':'单栏'}</span>`;
    button.title=`界面布局：${preference.label}`;button.setAttribute('aria-label',`界面布局：${preference.label}，点击选择`);
    if($('setting-layout'))$('setting-layout').value=settings.layout;
    if(changed&&redraw&&workspace&&!root.hidden)renderList(false);
    if(!$('sheet-layer').hidden)positionSheet();
}
function setLayout(layout) {
    if(!LAYOUTS.some(item=>item.id===layout))return;
    rememberCursor();config().layout=layout;applyLayout();settingsSaver.request(preferencesOwner);
}
function showLayoutPicker() {
    rememberCursor();
    const current=config().layout;
    showSheet('界面布局',LAYOUTS.map(layout=>`<button type="button" class="pmme-theme-option" data-pmme-layout="${layout.id}" aria-pressed="${current===layout.id}"><span class="pmme-theme-copy"><strong>${layout.label}</strong><small>${layout.description}</small></span>${current===layout.id?'<span class="pmme-current-theme">当前</span>':''}</button>`).join(''));
}
function saveDirectoryWidth(value) {
    const width=syncDirectoryWidth(value);
    if(config().directoryWidth===width)return;
    config().directoryWidth=width;settingsSaver.request(preferencesOwner);
}
function finishDirectoryResize(cancelled=false) {
    if(!directoryResize)return;
    const ended=directoryResize;directoryResize=null;root.classList.remove('pmme-resizing');
    const splitter=$('splitter');
    if(splitter.hasPointerCapture?.(ended.pointerId))splitter.releasePointerCapture(ended.pointerId);
    if(cancelled)syncDirectoryWidth();else saveDirectoryWidth(ended.width);
}
function bindDirectoryResize() {
    const splitter=$('splitter');
    const available=()=>isDesktop()&&!workspace?.full&&!busy&&$('sheet-layer').hidden;
    splitter.addEventListener('pointerdown',event=>{
        if(!available()||directoryResize||event.button!==0||event.isPrimary===false)return;
        event.preventDefault();rememberCursor();
        const width=syncDirectoryWidth();directoryResize={pointerId:event.pointerId,startX:event.clientX,startWidth:width,width};
        splitter.setPointerCapture?.(event.pointerId);root.classList.add('pmme-resizing');splitter.focus({preventScroll:true});
    });
    splitter.addEventListener('pointermove',event=>{
        if(!directoryResize||event.pointerId!==directoryResize.pointerId)return;
        event.preventDefault();directoryResize.width=syncDirectoryWidth(directoryResize.startWidth+event.clientX-directoryResize.startX);
    });
    splitter.addEventListener('pointerup',event=>{if(directoryResize?.pointerId===event.pointerId)finishDirectoryResize();});
    for(const type of ['pointercancel','lostpointercapture'])splitter.addEventListener(type,event=>{if(directoryResize?.pointerId===event.pointerId)finishDirectoryResize(true);});
    splitter.addEventListener('dblclick',()=>{if(available())saveDirectoryWidth(DEFAULT_DIRECTORY_WIDTH);});
    splitter.addEventListener('keydown',event=>{
        if(!available())return;
        const bounds=directoryWidthBounds(directoryAvailableWidth()),step=event.shiftKey?30:10;
        const width=Number(splitter.getAttribute('aria-valuenow'));
        const next={ArrowLeft:width-step,ArrowRight:width+step,Home:bounds.min,End:bounds.max}[event.key];
        if(next===undefined)return;
        event.preventDefault();saveDirectoryWidth(next);
    });
}
function makeRoot() {
    root=document.createElement('section');root.id='pmme-root';root.hidden=true;root.setAttribute('aria-label','回声编辑台预设编辑器');
    root.innerHTML=`<div class="pmme-frame">
      <div id="pmme-directory-view" class="pmme-directory-view">
        <header class="pmme-topbar pmme-gutter"><button id="pmme-close" class="pmme-button pmme-quiet pmme-return-button" aria-label="返回酒馆预设编辑" title="返回预设">${icon('back')}预设</button><h2>${icon('echo')}回声编辑台</h2><button id="pmme-theme-control" type="button" class="pmme-button pmme-theme-control" aria-label="选择界面主题"></button><button id="pmme-layout-control" type="button" class="pmme-button pmme-theme-control pmme-layout-control" aria-label="选择界面布局"></button><span class="pmme-mode-label">预设编辑</span></header>
        <section class="pmme-preset pmme-gutter"><div><h3 id="pmme-preset-name"></h3><p id="pmme-status"></p><button id="pmme-retry" class="pmme-button pmme-quiet" hidden>重试保存</button></div><button id="pmme-history" type="button" class="pmme-button" aria-label="查看当前预设的历史版本">${icon('history')}<span>历史版本</span></button><button id="pmme-update" class="pmme-button pmme-secondary">更新预设</button><button id="pmme-desktop-close" class="pmme-icon-button pmme-desktop-close" aria-label="关闭回声编辑台，返回预设" title="返回预设">${icon('close')}</button></section>
        <div id="pmme-workbench" class="pmme-workbench">
          <aside id="pmme-directory-pane" class="pmme-directory-pane" aria-label="条目目录">
            <div class="pmme-search-line pmme-gutter"><label class="pmme-search-control" for="pmme-directory-search">${icon('search')}<input id="pmme-directory-search" type="search" placeholder="搜索标题或正文" aria-label="搜索当前预设条目" autocomplete="off"></label><button id="pmme-clear-search" class="pmme-icon-button" aria-label="清空搜索" title="清空搜索" hidden>${icon('close')}</button></div>
            <div id="pmme-replace-tools" class="pmme-replace-tools pmme-gutter" hidden><span id="pmme-replace-match-count"></span><button id="pmme-batch-replace" type="button" class="pmme-button pmme-secondary">${icon('replace')}批量替换</button></div>
            <div id="pmme-replace-result-line" class="pmme-replace-tools pmme-gutter" hidden><span id="pmme-replace-result-note"></span><button id="pmme-replace-review" type="button" class="pmme-button pmme-quiet">查看替换结果</button></div>
            <div class="pmme-toolbar pmme-gutter"><label class="pmme-search-scope" for="pmme-search-titles"><input id="pmme-search-titles" type="checkbox">仅标题</label><span class="pmme-grow"></span><button id="pmme-library" class="pmme-button">${icon('library')}添加已有</button><button id="pmme-groups" class="pmme-button">${icon('folder')}分组</button><button id="pmme-organize" class="pmme-icon-button" aria-label="整理排列" title="整理排列">${icon('grip')}</button></div>
            <div class="pmme-caption pmme-gutter"><span id="pmme-hint">点击条目快改，展开全屏长写</span><span id="pmme-count"></span></div>
            <div id="pmme-scroll" class="pmme-scroll pmme-gutter"><main id="pmme-list" aria-label="预设排列"></main><p class="pmme-footnote">草稿在本次页面中保留；刷新前请保存。</p></div>
          </aside>
          <div id="pmme-splitter" class="pmme-splitter" role="separator" aria-orientation="vertical" aria-label="调整条目目录宽度" aria-controls="pmme-directory-pane" tabindex="0" title="拖动调整目录宽度；方向键微调，双击恢复默认"></div>
          <section id="pmme-detail-pane" class="pmme-detail-pane" aria-label="当前条目编辑">
            <header class="pmme-detail-header"><div class="pmme-detail-heading"><p id="pmme-detail-context" class="pmme-detail-context"></p><h3 id="pmme-detail-title">选择一个条目</h3></div><div id="pmme-detail-actions" class="pmme-detail-actions" hidden><button id="pmme-detail-expand" class="pmme-button pmme-quiet" aria-label="全屏编辑正文" aria-controls="pmme-full-view">${icon('expand')}全屏</button><button id="pmme-detail-menu" class="pmme-icon-button" aria-label="当前条目的更多操作">${icon('more')}</button></div></header>
            <p id="pmme-detail-filter-note" class="pmme-detail-filter-note" hidden>当前条目不在搜索结果中，可以继续编辑。</p>
            <div id="pmme-detail-empty" class="pmme-empty pmme-detail-empty"><p>从左侧选择条目开始编辑</p></div>
            <div id="pmme-detail-slot" class="pmme-detail-slot" hidden></div>
          </section>
        </div>
      </div>
      <section id="pmme-full-view" class="pmme-full-view" aria-label="正文全屏编辑" hidden>
        <header class="pmme-full-header pmme-gutter"><button id="pmme-collapse" type="button" class="pmme-button pmme-quiet" aria-label="退出正文全屏，返回条目编辑" title="退出全屏（Esc）">${icon('back')}<span>退出全屏</span></button><div class="pmme-full-heading"><strong id="pmme-full-title"></strong><span id="pmme-full-status"></span></div><div class="pmme-full-actions"><button id="pmme-full-theme-control" type="button" class="pmme-button pmme-theme-control" aria-label="选择界面主题"></button><button id="pmme-full-save" type="button" class="pmme-button pmme-primary" title="保存当前条目（Ctrl / ⌘ + S），不更新命名预设">保存条目</button></div></header>
        <div id="pmme-full-slot" class="pmme-full-slot"></div>
      </section>
      <div id="pmme-parking" hidden><section id="pmme-editor" class="pmme-editor" aria-label="条目编辑">
        <div class="pmme-editor-meta"><label class="pmme-field pmme-grow" for="pmme-name"><span>条目标题</span><input id="pmme-name" type="text" placeholder="先写内容，标题稍后补" autocomplete="off"></label><label class="pmme-field pmme-role-field" for="pmme-role"><span>消息角色</span><select id="pmme-role"><option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option></select></label></div>
        <div id="pmme-body-field" class="pmme-body-field"><label for="pmme-content"><span>正文</span><output id="pmme-chars"></output></label><textarea id="pmme-content" aria-label="条目正文" placeholder="从这里开始写……" spellcheck="false" data-macros></textarea></div>
        <div id="pmme-source" class="pmme-source" hidden></div>
        <details id="pmme-advanced" class="pmme-advanced"><summary>高级设置${icon('chevron')}</summary><div class="pmme-advanced-fields"><label class="pmme-field" for="pmme-injection"><span>注入位置</span><select id="pmme-injection"><option value="0">按预设排列</option><option value="1">聊天内注入</option></select></label><div id="pmme-depth-fields" class="pmme-row" hidden><label class="pmme-field pmme-grow" for="pmme-depth"><span>聊天深度</span><input id="pmme-depth" type="number" min="0" max="9999" step="1"></label><label class="pmme-field pmme-grow" for="pmme-order"><span>注入顺序</span><input id="pmme-order" type="number" min="0" max="9999" step="1"></label></div><p id="pmme-depth-note" class="pmme-small" hidden>聊天内注入受深度和顺序控制，不只取决于目录位置。</p><div class="pmme-field"><span>触发条件（不选则不限制）</span><div class="pmme-triggers">${TRIGGERS.map((trigger,i)=>`<label for="pmme-trigger-${trigger}"><input id="pmme-trigger-${trigger}" type="checkbox" value="${trigger}">${['普通发送','继续','代写','滑动','重新生成','静默'][i]}</label>`).join('')}</div></div><label id="pmme-override-field" class="pmme-check" for="pmme-overrides" hidden><input id="pmme-overrides" type="checkbox">禁止角色卡覆盖此条目</label></div></details>
        <label id="pmme-enable-field" class="pmme-check" for="pmme-enable-new" hidden><input id="pmme-enable-new" type="checkbox">首次保存后启用（草稿不参与发送）</label>
        <div class="pmme-editor-footer"><span id="pmme-editor-status" class="pmme-editor-status"></span><button id="pmme-discard" class="pmme-button pmme-quiet">放弃</button><button id="pmme-expand" class="pmme-button" aria-label="全屏编辑正文" aria-controls="pmme-full-view">${icon('expand')}全屏</button><button id="pmme-save" class="pmme-button pmme-primary pmme-grow">保存条目</button></div>
      </section></div>
    </div><div id="pmme-sheet-layer" class="pmme-sheet-layer" hidden><div id="pmme-backdrop" class="pmme-backdrop"></div><section class="pmme-sheet pmme-gutter" role="dialog" aria-modal="true" aria-labelledby="pmme-sheet-title"><div class="pmme-sheet-handle"></div><header><h3 id="pmme-sheet-title"></h3><button id="pmme-sheet-close" class="pmme-icon-button" aria-label="关闭操作面板">${icon('close')}</button></header><div id="pmme-sheet-body"></div></section></div><div id="pmme-toast" class="pmme-toast" role="status" aria-live="polite" hidden></div>`;
    document.body.appendChild(root);
    applyAppearance();applyLayout();
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
function needsAttention() {
    if(!workspace)return false;
    if(pendingIds().length>0||workspace.settingsUnconfirmed||workspace.versionDirty||native.presetNeedsUpdate())return true;
    try{const name=native.presetName(),basis=versionById(historyStore(),name,workspace.baseVersionId);return Boolean(basis&&(native.currentPresetDiffers(workspace.scope,basis.preset)||JSON.stringify(groupsForPreset(config().groupsByScope,name))!==JSON.stringify(basis.groupsByScope)));}
    catch{return false;}
}
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
function initializeVersionBasis(owner) {
    owner.versionBasisReset=false;owner.baseVersionId=null;owner.baseVersionLabel=null;owner.versionDirty=false;owner.historyLoaded=false;owner.replacementResult=null;
    try {
        const name=native.presetName(),named=native.captureNamedPreset(owner.scope),store=historyStore();
        const head=headVersion(store,name),working=versionById(store,name,store.workingByScope[owner.scope]);
        const basis=working || (head && JSON.stringify(head.preset)===JSON.stringify(named) ? head : null);
        owner.presetBase=copy(basis?.preset || named);
        owner.initialGroupsByScope=groupsForPreset(config().groupsByScope,name);
        owner.baseVersionId=basis?.id || null;owner.baseVersionLabel=basis?.version || null;
        owner.historyLoaded=Boolean(working && JSON.stringify(working.preset)!==JSON.stringify(named));
        owner.versionDirty=Boolean(working && JSON.stringify(native.captureCurrentPreset(owner.scope,owner.presetBase))!==JSON.stringify(named));
    } catch { owner.presetBase=null;owner.initialGroupsByScope={}; }
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
    if(workspace.presetBase===undefined || workspace.versionBasisReset)initializeVersionBasis(workspace);
    workspace.presetValue=document.getElementById('settings_preset_openai')?.value;
    syncWorkspace();
}
function rememberCursor() {
    // Fullscreen moves only the body field; its metadata editor stays hidden.
    // Never replace a stable cursor with the zero scroll of a parked textarea.
    const editor=$('editor'),id=editor.dataset.entryId;
    if(!id||!workspace||!(workspace.full?$('body-field'):editor).getClientRects().length)return;
    // Resize reflow can squeeze the outgoing desktop pane before its event fires.
    const width=document.documentElement.clientWidth || window.innerWidth;
    if(!workspace.full&&root.dataset.pmmeLayout!==resolveLayout(config().layout,width))return;
    workspace.cursors.set(id,{start:$('content').selectionStart,end:$('content').selectionEnd,direction:$('content').selectionDirection,scroll:$('content').scrollTop,nameStart:$('name').selectionStart,nameEnd:$('name').selectionEnd,nameDirection:$('name').selectionDirection});
}
function restoreCursor() {
    const cursor=workspace.cursors.get(workspace.selected);if(!cursor)return;
    $('content').setSelectionRange(cursor.start,cursor.end,cursor.direction||'none');$('content').scrollTop=cursor.scroll;
    $('name').setSelectionRange(cursor.nameStart,cursor.nameEnd,cursor.nameDirection||'none');
}
function setView() {
    const prompt=workspace.selected&&promptFor(workspace.selected);
    const canExpand=Boolean(prompt&&(workspace.drafts.has(workspace.selected)||native.permissions(prompt).content));
    if(!canExpand)workspace.full=false;
    // Reparent the same textarea, never copy it into a second editor.
    const body=$('body-field'),target=workspace.full?$('full-slot'):$('editor');
    if(body.parentElement!==target){if(workspace.full)target.appendChild(body);else target.insertBefore(body,$('source'));}
    $('directory-view').hidden=workspace.full;$('full-view').hidden=!workspace.full;
    root.classList.toggle('pmme-full',workspace.full);
    $('expand').hidden=!canExpand;$('detail-expand').hidden=!canExpand;
    const selected=Boolean(workspace.selected&&(!workspace.organizing||isDesktop()));
    $('detail-slot').hidden=!selected;$('detail-empty').hidden=selected;$('detail-actions').hidden=!selected;
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
function replacementEntries(withRevision=true) {
    return workspace.ids.map(id=>{
        const prompt=promptFor(id),buffer=bufferFor(id);if(!prompt||!buffer)return null;
        const draft=workspace.drafts.has(id),allowed=draft?{edit:true,content:true}:native.permissions(prompt);
        return {id,name:buffer.values.name||'未命名条目',content:buffer.values.content,editable:Boolean(allowed.edit&&allowed.content&&!prompt.marker),reason:prompt.marker?'内容占位符，正文不能替换':'正文只读，跳过',revision:withRevision?JSON.stringify([draft,buffer.base.content,draft?null:String(prompt.content??'')]):undefined};
    }).filter(Boolean);
}
function replacementSignature(entries=replacementEntries()) {
    return JSON.stringify([workspace.ids,entries.map(entry=>[entry.id,entry.name,entry.content,entry.editable,entry.revision])]);
}
function paintReplacementControls() {
    if(!workspace)return;
    const searching=hasSearch(),matches=searching&&!workspace.titleOnly?replacementEntries(false).filter(entry=>textMatch(entry.content,workspace.query)):[];
    $('replace-tools').hidden=!searching||(!workspace.titleOnly&&!matches.length);
    $('replace-match-count').textContent=workspace.titleOnly?'仅标题搜索不替换正文':`正文匹配 ${matches.length} 条`;
    $('batch-replace').disabled=busy||workspace.titleOnly||!matches.some(entry=>entry.editable);
    $('batch-replace').title=workspace.titleOnly?'请取消“仅标题”再替换正文':matches.some(entry=>entry.editable)?'预览并替换正文，先留为未保存修改':'匹配正文均只读，不能替换';
    const receipt=workspace.replacementResult;
    $('replace-result-line').hidden=!receipt;
    if(receipt){const pending=receipt.changes.filter(change=>workspace.ids.includes(change.id)&&hasDraft(change.id)).length;$('replace-result-note').textContent=receipt.undone?'本次替换已撤销':`上次替换 ${receipt.changes.length} 条 · ${pending} 条有未保存修改`;}
}
function openContentReplacement() {
    if(busy)return;
    try{
        if(!hasSearch()||workspace.titleOnly)throw new Error('请先搜索正文，并取消“仅标题”选项。');
        rememberCursor();native.assertScope(workspace.scope);syncWorkspace();
        const entries=replacementEntries(),panel={owner:workspace,scope:workspace.scope,epoch,query:workspace.query.trim(),entries,signature:replacementSignature(entries),excluded:new Set(),stale:false};
        showSheet('批量替换正文',`<p>只替换当前目录中可编辑的正文，包含已关闭条目和本页草稿；标题、角色、开关、排列及历史版本不变。确认后先留为未保存修改。</p><div class="pmme-replace-fields"><label class="pmme-field" for="pmme-replace-find"><span>查找内容（来自当前搜索）</span><textarea id="pmme-replace-find" rows="1" readonly>${escape(panel.query)}</textarea></label><label class="pmme-field" for="pmme-replace-with"><span>替换为（支持多行；留空表示删除）</span><textarea id="pmme-replace-with" rows="2" placeholder="填写替换文本；留空删除匹配内容" spellcheck="false"></textarea></label><label class="pmme-check" for="pmme-replace-case"><input id="pmme-replace-case" type="checkbox">区分大小写（默认与搜索一致，忽略大小写）</label></div><p id="pmme-replace-summary" role="status" aria-live="polite"></p><label class="pmme-check" for="pmme-replace-all"><input id="pmme-replace-all" type="checkbox" checked>全选可修改条目</label><div id="pmme-replace-preview"></div><div id="pmme-replace-skipped"></div><label id="pmme-replace-delete-label" class="pmme-check pmme-danger" for="pmme-replace-delete-check"><input id="pmme-replace-delete-check" type="checkbox">我确认删除所选正文中的全部匹配内容</label><p id="pmme-replace-error" class="pmme-version-error" role="alert" hidden></p><button class="pmme-button" data-pmme-action="replace-refresh">重新读取正文并预览</button><button id="pmme-replace-apply" class="pmme-button pmme-primary" data-pmme-action="replace-apply">替换所选，留为未保存修改</button><button class="pmme-button pmme-quiet" data-pmme-action="close">取消替换</button>`);
        replacementPanel=panel;renderReplacementPreview();
    }catch(error){notify(error.message,true);}
}
function replacementSnippet(content,start,end,deletion=false) {
    const left=Math.max(0,start-40),right=Math.min(content.length,end+40),token=content.slice(start,end);
    const marked=token?`<mark>${escape(token.length>160?token.slice(0,160)+'…':token)}</mark>`:deletion?'<span class="pmme-replace-deletion">（删除）</span>':'';
    return `${left?'…':''}${escape(content.slice(left,start))}${marked}${escape(content.slice(end,right))}${right<content.length?'…':''}`;
}
function selectedReplacementChanges() { return replacementPanel?.plan?.changes.filter(change=>!replacementPanel.excluded.has(change.id)) || []; }
function paintReplacementSelection() {
    const panel=replacementPanel;if(!panel?.plan)return;
    const selected=selectedReplacementChanges(),count=selected.reduce((sum,change)=>sum+change.count,0),deleting=panel.plan.replacement==='';
    $('replace-summary').textContent=`将修改 ${selected.length} 个条目，共${deleting?'删除':'替换'} ${count} 处；跳过 ${panel.plan.skipped.length} 个条目。`;
    $('replace-all').checked=selected.length===panel.plan.changes.length&&selected.length>0;
    $('replace-all').indeterminate=selected.length>0&&selected.length<panel.plan.changes.length;
    $('replace-all').disabled=!panel.plan.changes.length;
    $('replace-delete-label').hidden=!deleting;
    $('replace-apply').disabled=busy||panel.stale||!selected.length||(deleting&&!$('replace-delete-check').checked);
    $('replace-apply').textContent=deleting?'删除匹配内容，留为未保存修改':'替换所选，留为未保存修改';
    $('replace-apply').classList.toggle('pmme-danger',deleting);$('replace-apply').classList.toggle('pmme-primary',!deleting);
}
function replacementFailure(error) {
    if(replacementPanel)replacementPanel.stale=true;
    const field=$('replace-error');if(field){field.textContent=error.message;field.hidden=false;}
    if($('replace-apply'))$('replace-apply').disabled=true;
    notify(error.message,true);
}
function renderReplacementPreview() {
    const panel=replacementPanel;if(!panel)return;
    try{
        panel.plan=planContentReplacement(panel.entries,panel.query,$('replace-with').value,{caseSensitive:$('replace-case').checked});
        $('replace-preview').innerHTML=panel.plan.changes.map(change=>`<article class="pmme-replace-candidate"><label class="pmme-replace-choice" for="pmme-replace-target-${escape(change.id)}"><input id="pmme-replace-target-${escape(change.id)}" type="checkbox" data-pmme-replace-id="${escape(change.id)}" ${panel.excluded.has(change.id)?'':'checked'}><span><strong>${escape(change.name)}</strong><small>${change.count} 处匹配</small></span></label>${change.matches.slice(0,3).map(match=>`<div class="pmme-replace-pair"><div><span>替换前</span><pre>${replacementSnippet(change.before,match.start,match.end)}</pre></div><div><span>替换后</span><pre>${replacementSnippet(change.after,match.afterStart,match.afterEnd,panel.plan.replacement==='')}</pre></div></div>`).join('')}${change.count>3?`<p class="pmme-small">另有 ${change.count-3} 处也将替换；勾选条目即替换正文中的全部匹配。</p>`:''}</article>`).join('')||'<p class="pmme-history-empty">没有需要修改的正文。请检查大小写选项或替换文本。</p>';
        $('replace-skipped').innerHTML=panel.plan.skipped.length?`<details class="pmme-replace-skipped"><summary>查看跳过的 ${panel.plan.skipped.length} 个条目</summary><ul>${panel.plan.skipped.map(item=>`<li>${escape(item.name)}：${escape(item.reason)}（${item.count} 处匹配）</li>`).join('')}</ul></details>`:'';
        paintReplacementSelection();
    }catch(error){replacementFailure(error);}
}
function refreshReplacementPreview() {
    const panel=replacementPanel;if(!panel)return;
    try{
        if(panel.owner!==workspace||panel.epoch!==epoch)throw new Error('预设已切换，请重新打开批量替换。');
        native.assertScope(panel.scope);if(!hasSearch()||workspace.titleOnly)throw new Error('请先搜索正文，并取消“仅标题”选项。');
        syncWorkspace();panel.entries=replacementEntries();panel.signature=replacementSignature(panel.entries);panel.query=workspace.query.trim();panel.stale=false;
        $('replace-find').value=panel.query;$('replace-error').hidden=true;$('replace-delete-check').checked=false;renderReplacementPreview();
    }catch(error){replacementFailure(error);}
}
function writeReplacementDrafts(changes,reverse=false) {
    // Acquire every buffer and cursor mapping before changing a single body.
    const prepared=changes.map(change=>{
        const buffer=workspace.buffers.get(change.id);if(!buffer)throw new Error('条目缓冲已变化，未改动任何正文。');
        const cursor=workspace.cursors.get(change.id);
        return {change,buffer,cursor:cursor?{...cursor,start:mapReplacementOffset(cursor.start,change.matches,reverse),end:mapReplacementOffset(cursor.end,change.matches,reverse)}:null};
    });
    for(const {change,buffer,cursor} of prepared){buffer.values.content=change.after;if(cursor)workspace.cursors.set(change.id,cursor);}
}
function applyContentReplacement() {
    const panel=replacementPanel;if(!panel||busy)return;
    try{
        if(panel.owner!==workspace||panel.epoch!==epoch||workspace.titleOnly||workspace.query.trim()!==panel.query)throw new Error('预设或搜索条件已变化，请重新打开批量替换。');
        native.assertScope(panel.scope);syncWorkspace();const entries=replacementEntries();
        if(panel.stale||replacementSignature(entries)!==panel.signature)throw new Error('正文、条目或编辑权限已变化，未替换任何条目。请重新读取正文并预览。');
        if(panel.plan.replacement===''&&!$('replace-delete-check').checked)throw new Error('请先确认删除匹配内容。');
        const changes=prepareReplacementPatch(panel.plan,selectedReplacementChanges().map(change=>change.id),entries);
        rememberCursor();writeReplacementDrafts(changes);
        workspace.replacementResult={scope:panel.scope,epoch:panel.epoch,query:panel.query,replacement:panel.plan.replacement,changes,undone:false};
        renderList(false);showReplacementResult();notify(`已替换 ${changes.length} 个条目，全部先留为未保存修改。`);
    }catch(error){replacementFailure(error);}
}
function replacementUndoProblem(receipt,entries) {
    if(receipt.undone)return '本次替换已经撤销。';
    if(receipt.scope!==workspace.scope||receipt.epoch!==epoch)return '预设已经重新载入或切换，本次撤销不再可用。';
    try{prepareReplacementUndo(receipt,entries);return null;}catch(error){return error.message;}
}
function showReplacementResult() {
    if(busy)return;
    const receipt=workspace?.replacementResult;if(!receipt){notify('当前没有批量替换结果。');return;}
    const entries=replacementEntries(),current=new Map(entries.map(entry=>[entry.id,entry])),problem=replacementUndoProblem(receipt,entries);
    const count=receipt.changes.reduce((sum,change)=>sum+change.count,0);
    showSheet('批量替换结果',`<p>本次涉及 ${receipt.changes.length} 个条目、${count} 处匹配。替换先留在草稿中，手动保存条目后才写入运行配置，完整更新预设时才产生历史版本。</p><div class="pmme-replace-results">${receipt.changes.map(change=>{
        const entry=current.get(change.id),state=receipt.undone?'本次替换已撤销':!entry?'条目已移出当前目录':entry.content===change.after&&entry.revision===change.revision?'未保存修改':entry.content===change.after&&!hasDraft(change.id)?'条目已保存':'正文或保存基线又有变化';
        return `<article class="pmme-replace-result-row"><div><strong>${escape(entry?.name||change.name)}</strong><small>${change.count} 处 · ${state}</small></div><button class="pmme-button" data-pmme-action="replace-open-entry" data-pmme-replace-entry="${escape(change.id)}" ${entry?'':'disabled'}>查看条目</button></article>`;
    }).join('')}</div>${problem?`<p class="pmme-group-warning">${escape(problem)}</p>`:''}<button class="pmme-button" data-pmme-action="replace-undo" ${problem?'disabled':''}>${icon('undo')}撤销本次替换</button><button class="pmme-button pmme-secondary" data-pmme-action="replace-clear-search">清空搜索查看修改</button><button class="pmme-button pmme-quiet" data-pmme-action="close">继续编辑</button>`);
}
function undoContentReplacement() {
    const receipt=workspace?.replacementResult;if(!receipt||busy)return;
    try{
        native.assertScope(receipt.scope);if(receipt.epoch!==epoch)throw new Error('预设已重新载入，本次撤销不再可用。');
        syncWorkspace();const changes=prepareReplacementUndo(receipt,replacementEntries());
        rememberCursor();writeReplacementDrafts(changes,true);receipt.undone=true;
        renderList(false);showReplacementResult();notify('已撤销本次正文替换，替换前已有的草稿和其他属性修改仍保留。');
    }catch(error){notify(error.message,true);showReplacementResult();}
}
function openReplacedEntry(id) {
    if(!workspace.replacementResult?.changes.some(change=>change.id===id)||!workspace.ids.includes(id))throw new Error('这个条目已不在当前目录中。');
    closeSheet(false);workspace.query='';workspace.searchScroll=null;workspace.organizing=false;revealEntry(id,true);workspace.selected=id;
    renderList();$('content').focus({preventScroll:true});
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
    const selected=workspace.selected===id&&(!workspace.organizing||isDesktop());
    return `<article id="pmme-row-${key}" class="pmme-item ${boundary?'pmme-boundary':'pmme-sort-unit'} ${selected?'pmme-selected':''}" data-pmme-id="${key}" ${boundary?'':`data-pmme-sort-key="entry:${key}"`}>
      <div class="pmme-item-top">${workspace.organizing&&!boundary?`<button class="pmme-drag-handle pmme-icon-button" aria-label="拖动${escape(titleFor(id))}排序" title="按住拖动">${icon('grip')}</button>`:''}
        <button class="pmme-item-main" data-pmme-select="${key}" ${isDesktop()?`aria-controls="pmme-detail-pane" ${selected?'aria-current="true"':''}`:`aria-expanded="${selected}"`}>
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
function renderList(captureCursor=true) {
    if(!workspace)return;
    const editor=$('editor'),active=document.activeElement,focus=editor.contains(active)||$('body-field').contains(active)?active.id:null,scroll=$('scroll').scrollTop;
    if(captureCursor)rememberCursor();sorter?.cancel();syncWorkspace();setView();
    const selected=Boolean(workspace.selected&&(!workspace.organizing||isDesktop()));
    const persistentSlot=isDesktop()?$('detail-slot'):null;
    // The metadata editor stays in its normal pane, even in body-only fullscreen.
    if(!isDesktop()||!selected||editor.parentElement!==persistentSlot)$('parking').appendChild(editor);
    const view=resolveWorkspaceGroups();workspace.orderMap=new Map(native.nativeOrder().map(entry=>[entry.identifier,entry]));
    workspace.searchMatches=searchEntries(currentEntries(),workspace.query,{titleOnly:workspace.titleOnly});
    workspace.visibleIds=new Set(workspace.searchMatches.keys());
    if(hasSearch())for(const group of view.groups)if(textMatch(group.name,workspace.query))for(const id of group.ids)workspace.visibleIds.add(id);
    $('directory-search').value=workspace.query;$('directory-search').placeholder=workspace.titleOnly?'搜索条目标题':'搜索标题或正文';$('search-titles').checked=workspace.titleOnly;$('clear-search').hidden=!workspace.query;
    $('list').innerHTML=renderTree(view.tree);
    if(!workspace.ids.length)$('list').innerHTML='<div class="pmme-empty"><p>当前排列还没有条目</p><button class="pmme-button pmme-primary" data-pmme-create-first>创建第一个条目</button></div>';
    else if(hasSearch()&&!workspace.visibleIds.size)$('list').innerHTML='<div class="pmme-empty"><p>没有匹配条目，试试其他关键词</p><button class="pmme-button" data-pmme-clear-query>清空搜索</button></div>';
    if(selected){
        const slot=persistentSlot||$(`slot-${workspace.selected}`);
        if(slot&&editor.parentElement!==slot)slot.appendChild(editor);
        // Body edits can stop matching a mobile search while fullscreen stays open.
        if(slot||workspace.full)loadEditor();
    }
    $('scroll').scrollTop=scroll;
    const focused=focus&&document.getElementById(focus);
    if(selected&&focused?.getClientRects().length)focused.focus({preventScroll:true});
    paintStatus();paintBusy();
}
function loadEditor() {
    const id=workspace.selected,prompt=promptFor(id),buffer=bufferFor(id);if(!prompt||!buffer)return;
    const draft=workspace.drafts.get(id),allowed=draft?{edit:true,content:true,overrides:false}:native.permissions(prompt),v=buffer.values;
    $('editor').dataset.entryId=id;
    for(const [field,value]of Object.entries({name:v.name,role:v.role,content:v.content,injection:v.injection_position,depth:v.injection_depth,order:v.injection_order})){
        const control=$(field);if(control.value!==String(value))control.value=value;
    }
    $('overrides').checked=v.forbid_overrides;
    TRIGGERS.forEach(t=>{$(`trigger-${t}`).checked=v.injection_trigger.includes(t);});
    $('enable-new').checked=Boolean(draft?.enableOnSave);
    $('name').disabled=!allowed.edit;$('role').disabled=!allowed.edit;
    $('body-field').hidden=!allowed.content;$('source').hidden=allowed.content;
    $('source').textContent=allowed.edit?'正文由角色卡、世界书或其他来源提供，不能在这里改写；可调整其他原生允许的属性。':'该占位符内容由酒馆生成，保留原生编辑限制。可在目录中整理它的位置。';
    $('advanced').hidden=!allowed.edit;$('override-field').hidden=!allowed.overrides;$('enable-field').hidden=!draft;
    $('save').hidden=!allowed.edit;$('discard').hidden=!allowed.edit;$('save').textContent=draft?'保存并加入':'保存条目';
    $('full-save').hidden=!allowed.content;$('full-save').textContent=$('save').textContent;
    updateAdvanced();restoreCursor();paintStatus();
}
function updateAdvanced(){const chat=$('injection').value==='1';$('depth-fields').hidden=!chat;$('depth-note').hidden=!chat;}
function paintStatus() {
    if(!workspace)return;
    $('preset-name').textContent=native.presetName()||'当前配置';
    const pending=pendingIds().length;
    const status=busy?busyLabel:historyError?'历史版本未确认保存，请重试':workspace.settingsSaveFailed?'后台保存失败，修改仍保留':preferencesError?'界面偏好未确认保存，请重试':pending?`${pending} 个条目有草稿或修改`:historySaving?'正在保存历史版本…':workspace.backgroundSaving?'当前配置 · 命名预设待更新':workspace.settingsUnconfirmed?'当前设置尚未确认保存，请重试':workspace.versionDirty?'历史版本已载入 · 命名预设待更新':native.presetNeedsUpdate()?'条目已保存 · 命名预设待更新':'当前条目与命名预设一致';
    $('status').textContent=workspace.baseVersionLabel?`基于 ${workspace.baseVersionLabel} 编辑 · ${status}`:status;
    $('retry').hidden=!(workspace.settingsSaveFailed||preferencesError||historyError)||busy;
    $('status').classList.toggle('pmme-pending',Boolean(pending||workspace.settingsUnconfirmed||preferencesError||historyError||historySaving||workspace.versionDirty||native.presetNeedsUpdate()));
    $('hint').textContent=workspace.dragging?workspace.dragTarget||'拖到目标位置后松手':workspace.pendingGroupStart?`选择结束边界：${titleFor(workspace.pendingGroupStart)}`:workspace.organizing?'拖动组或条目；展开组可拖入、拖出':hasSearch()?'搜索包含草稿和已关闭条目':isDesktop()?'左侧选择条目，右侧编辑正文':'点击条目快改，展开全屏长写';
    $('count').textContent=hasSearch()?`找到 ${workspace.visibleIds?.size||0} / ${workspace.ids.length} 条`:`${workspace.ids.length} 条${workspace.groupView?.groups.length?` · ${workspace.groupView.groups.length} 组`:''}`;
    $('organize').innerHTML=icon(workspace.organizing?'check':'grip');$('organize').setAttribute('aria-label',workspace.organizing?'完成整理':hasSearch()?'清空搜索并整理排列':'整理排列');$('organize').title=workspace.organizing?'完成整理':hasSearch()?'清空搜索并整理排列':'整理排列';
    for(const id of workspace.ids){const buffer=bufferFor(id);if(!buffer)continue;const title=$(`title-${id}`),badge=$(`dirty-${id}`);if(title)title.innerHTML=highlightText(buffer.values.name||'未命名条目',hasSearch()?textMatch(buffer.values.name,workspace.query):null);if(badge)badge.hidden=workspace.drafts.has(id)||!draftChanged(buffer);}
    paintGroupStates();paintReplacementControls();
    $('preset-name').title=$('preset-name').textContent;$('status').title=$('status').textContent;
    $('detail-filter-note').hidden=!isDesktop()||!workspace.selected||!hasSearch()||workspace.visibleIds?.has(workspace.selected);
    if(!workspace.selected){$('detail-title').textContent='选择一个条目';$('detail-context').textContent='条目目录';return;}
    const id=workspace.selected,buffer=bufferFor(id),index=workspace.ids.indexOf(id);if(!buffer)return;
    const chars=`${Array.from(buffer.values.content).length} 字`,changed=hasDraft(id);
    const entryStatus=workspace.drafts.has(id)?'草稿 · 尚未加入发送':draftChanged(buffer)?'修改未保存':workspace.settingsSaveFailed?'修改已应用 · 后台保存失败':workspace.backgroundSaving?'修改已应用 · 正在后台保存':workspace.settingsUnconfirmed?'修改已应用 · 等待保存确认':'条目已保存';
    $('chars').textContent=chars;$('discard').disabled=busy||!changed;
    $('full-title').textContent=titleFor(id);$('full-title').title=titleFor(id);
    $('full-status').textContent=`${chars} · ${entryStatus}`;$('full-status').title=$('full-status').textContent;
    $('full-status').classList.toggle('pmme-pending',changed||workspace.settingsUnconfirmed);
    const context=index?`位于「${titleFor(workspace.ids[index-1])}」之后`:'位于预设开头';
    $('detail-title').textContent=titleFor(id);$('detail-title').title=titleFor(id);
    $('detail-context').textContent=workspace.groupView?.groups.filter(group=>group.ids.includes(id)).sort((a,b)=>b.ids.length-a.ids.length).map(group=>group.name).join(' / ')||context;
    $('editor-status').textContent=`${chars} · ${entryStatus}`;$('editor-status').classList.toggle('pmme-pending',changed||workspace.settingsUnconfirmed);
}
function paintBusy(){if(!busy)return;for(const control of root.querySelectorAll('button,input,select,textarea')){if(!disabledControls.has(control))disabledControls.set(control,control.disabled);control.disabled=true;}}
function setBusy(value){busy=value;root.classList.toggle('pmme-busy',value);if(value)paintBusy();else{for(const [control,disabled]of disabledControls)if(control.isConnected)control.disabled=disabled;disabledControls.clear();}paintStatus();}
async function operation(action,label='正在处理…'){
    if(busy||!workspace)return false;
    const owner=workspace,version=epoch;busyLabel=label;setBusy(true);
    const check=()=>{if(workspace!==owner||epoch!==version)throw new Error('预设在操作期间发生切换；已阻止继续写入。');native.assertScope(owner.scope);};
    try{check();await action(check);check();return true;}
    catch(error){notify(error.message,true);console.warn('[回声编辑台]',error);if(error.code==='PROMPT_CONFLICT')showConflict();return false;}
    finally{busy=false;root.classList.remove('pmme-busy');for(const[control,disabled]of disabledControls)if(control.isConnected)control.disabled=disabled;disabledControls.clear();if(workspace&&!root.hidden){renderList();paintStatus();}native.refreshNative();}
}
function markApplied(ids){for(const id of ids){workspace.drafts.delete(id);const prompt=native.findPrompt(id);if(prompt){const base=normalizePrompt(prompt);workspace.buffers.set(id,{base,values:copy(base)});}}storeGroupPreferences();}
function validateEditor(){
    for(const control of[$('depth'),$('order')]){
        const visible=control.offsetParent||(workspace.full&&$('advanced').open&&!$('advanced').hidden&&!$('depth-fields').hidden);
        if(!control.hidden&&visible&&!control.checkValidity()){
            if(workspace.full)collapse();
            control.reportValidity();return false;
        }
    }
    return true;
}
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
function positionSheet() {
    const layer=$('sheet-layer');if(layer.hidden)return;
    const anchored=Boolean(isDesktop()&&sheetAnchor?.isConnected&&sheetAnchor.getClientRects().length);
    layer.classList.toggle('pmme-popover',anchored);
    if(!anchored){layer.style.removeProperty('--pmme-sheet-left');layer.style.removeProperty('--pmme-sheet-top');return;}
    const frame=root.getBoundingClientRect(),anchor=sheetAnchor.getBoundingClientRect(),sheet=layer.querySelector('.pmme-sheet').getBoundingClientRect();
    const right=anchor.right-frame.left+8,left=right+sheet.width<=frame.width-16?right:anchor.left-frame.left-sheet.width-8;
    layer.style.setProperty('--pmme-sheet-left',`${Math.max(16,Math.min(left,frame.width-sheet.width-16))}px`);
    layer.style.setProperty('--pmme-sheet-top',`${Math.max(16,Math.min(anchor.top-frame.top,frame.height-sheet.height-16))}px`);
}
function showSheet(title,html,anchor=null) {
    deleteConfirmation=null;versionConfirmation=null;historyConfirmation=null;replacementPanel=null;
    if($('sheet-layer').hidden||!isDesktop())sheetFocus=document.activeElement;
    sheetAnchor=anchor;$('sheet-title').textContent=title;$('sheet-body').innerHTML=html;$('sheet-layer').hidden=false;
    positionSheet();$('sheet-close').focus({preventScroll:true});paintBusy();
}
function closeSheet(restore=true) {
    $('sheet-layer').hidden=true;$('sheet-body').replaceChildren();sheetAnchor=null;deleteConfirmation=null;versionConfirmation=null;historyConfirmation=null;replacementPanel=null;$('sheet-layer').classList.remove('pmme-popover');
    if(restore&&sheetFocus?.isConnected)sheetFocus.focus({preventScroll:true});
}
function versionFields(note='') {
    const store=historyStore(),name=native.presetName();
    return `<div class="pmme-version-fields"><label class="pmme-field" for="pmme-version-number"><span>版本号</span><input id="pmme-version-number" type="text" value="${escape(suggestVersion(store,name))}" maxlength="${VERSION_LIMIT}" required autocomplete="off" aria-describedby="pmme-version-help"></label><label class="pmme-field" for="pmme-version-note"><span>更新说明（可选）</span><textarea id="pmme-version-note" maxlength="${NOTE_LIMIT}" rows="2" placeholder="这次改了什么？">${escape(note)}</textarea></label><p id="pmme-version-help">完整保存时新增一个历史版本，不覆盖旧版本。版本号可手动修改。</p><p id="pmme-version-error" class="pmme-version-error" role="alert" hidden></p></div>`;
}
function versionIdFactory() {
    const used=new Set(historyStore().versions.map(record=>record.id));
    return ()=>{
        for(let attempt=0;attempt<=used.size;attempt++){
            const id=native.newId();if(!used.has(id)){used.add(id);return id;}
        }
        throw new Error('无法生成唯一的历史版本标识，请重试保存。');
    };
}
function readVersionInputs() {
    const field=$('version-number');
    return validateVersion(historyStore(),native.presetName(),field?field.value:suggestVersion(historyStore(),native.presetName()),$('version-note')?.value || '');
}
function versionInputError(error) {
    const field=$('version-error');if(field){field.textContent=error.message;field.hidden=false;}
    notify(error.message,true);$('version-number')?.focus({preventScroll:true});
}
function requestUpdate(){
    if(busy)return;
    try {
        native.captureNamedPreset(workspace.scope);
        const pending=pendingIds().length;
        showSheet(`保存「${native.presetName()}」的新版本`,`<p>这会更新当前命名预设，包含当前参数、已保存条目和排列。${pending?`还有 ${pending} 个条目未保存。`:''}${!versionsFor(historyStore(),native.presetName()).length?'原命名预设会先保留为“初始版本”。':''}</p>${versionFields()}<button class="pmme-button pmme-primary" data-pmme-action="update-all">${pending?'保存修改并更新预设':'确认更新预设'}</button>${pending?'<button class="pmme-button" data-pmme-action="update-saved">只更新已保存条目</button>':''}<button class="pmme-button pmme-quiet" data-pmme-action="close">继续编辑</button>`);
        versionConfirmation={owner:workspace,epoch,scope:workspace.scope};
    } catch(error) { notify(error.message,true); }
}
async function commitVersion(includeDrafts,metadata,check) {
    const owner=workspace,name=native.presetName(),initialPreset=native.captureNamedPreset(owner.scope);
    if(historyError || historySaving){await persistCurrentSettings(historyOwner);check();}
    if(includeDrafts&&pendingIds().length)await saveIds(pendingIds(),check);
    else if(owner.settingsUnconfirmed){await persistCurrentSettings(owner);check();}
    else {await settingsSaver.wait(owner);check();}
    storeGroupPreferences(owner);
    const snapshot=native.captureCurrentPreset(owner.scope,owner.historyLoaded?owner.presetBase:initialPreset);
    const planned=planVersionSave(historyStore(),{presetName:name,...metadata,preset:snapshot,groupsByScope:config().groupsByScope,initialPreset,initialGroupsByScope:owner.initialGroupsByScope || config().groupsByScope,parentId:owner.baseVersionId,scope:owner.scope,idFactory:versionIdFactory()});
    check();
    if(planned.initial){
        // The first original must be durable BEFORE overwriting its only named file.
        const initialStore=copy(historyStore());initialStore.versions.push(copy(planned.initial));
        initialStore.heads[JSON.stringify(name)]=planned.initial.id;initialStore.workingByScope[owner.scope]=planned.initial.id;
        config().presetHistory=initialStore;
        owner.baseVersionId=planned.initial.id;owner.baseVersionLabel=planned.initial.version;
        try{await persistCurrentSettings(historyOwner);check();}
        catch(error){throw new Error('初始版本未确认保存，尚未覆盖原命名预设。请重试保存，不要关闭页面。',{cause:error});}
    }
    const savedName=await native.saveNamedPreset(owner.scope,snapshot);
    // The file write has completed: preserve its exact snapshot even if a programmatic
    // preset switch happened while the request was in flight. History is global data.
    config().presetHistory=planned.store;
    owner.presetBase=copy(snapshot);owner.baseVersionId=planned.record.id;owner.baseVersionLabel=planned.record.version;owner.versionDirty=false;owner.historyLoaded=false;
    try { await persistCurrentSettings(historyOwner); }
    catch(error) { throw new Error(`预设「${savedName}」已更新，但版本 ${planned.record.version} 未确认写入历史。记录仍在当前页面，请重试保存，不要关闭页面。`,{cause:error}); }
    check();
    owner.versionDirty=JSON.stringify(native.captureCurrentPreset(owner.scope,snapshot))!==JSON.stringify(snapshot);
    return {record:planned.record,name:savedName};
}
async function updateNamed(includeDrafts=true){
    let metadata;
    try {
        if(versionConfirmation&&(versionConfirmation.owner!==workspace||versionConfirmation.epoch!==epoch))throw new Error('预设已切换，请重新确认保存。');
        if(versionConfirmation)native.assertScope(versionConfirmation.scope);
        if(includeDrafts&&!validateEditor())return false;
        metadata=readVersionInputs();
    } catch(error) { versionInputError(error);return false; }
    closeSheet(false);
    return operation(async check=>{const result=await commitVersion(includeDrafts,metadata,check);notify(`已更新预设「${result.name}」，并保存历史版本 ${result.record.version}。`);},'正在保存预设版本…');
}
function historyTime(value) {
    const date=new Date(value);return Number.isNaN(date.getTime())?String(value||''):date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function renderHistoryList(query='') {
    const name=native.presetName(),store=historyStore(),versions=versionsFor(store,name),needle=query.trim().toLocaleLowerCase();
    const matches=[...versions].reverse().filter(record=>`${record.version} ${record.note} ${historyTime(record.createdAt)}`.toLocaleLowerCase().includes(needle));
    $('history-list').innerHTML=matches.map(record=>{
        const parent=versionById(store,name,record.parentId),current=record.id===workspace.baseVersionId;
        return `<article class="pmme-history-record" data-pmme-version-id="${escape(record.id)}"><div class="pmme-history-heading"><strong>${escape(record.version)}</strong>${current?'<span class="pmme-history-current">编辑起点</span>':''}</div><time datetime="${escape(record.createdAt)}">${escape(historyTime(record.createdAt))}</time><p class="pmme-history-note">${escape(record.note||'未填写更新说明')}</p><small>${record.preset?.prompts?.length||0} 条库内条目${parent?` · 基于 ${escape(parent.version)}`:''}</small><div class="pmme-history-actions"><button type="button" class="pmme-button" data-pmme-action="history-view">查看</button><button type="button" class="pmme-button pmme-secondary" data-pmme-action="history-load">载入此版本</button><button type="button" class="pmme-icon-button pmme-danger" data-pmme-action="history-delete" aria-label="删除历史版本 ${escape(record.version)}" title="删除历史记录">${icon('trash')}</button></div></article>`;
    }).join('') || `<p class="pmme-history-empty">${versions.length?'没有匹配版本，试试版本号或更新说明。':'还没有历史版本。首次更新预设时，会保留原版并开始记录。'}</p>`;
}
function showHistory() {
    if(busy)return;
    try {
        const store=historyStore(),size=historyBytes(store);
        showSheet(`「${native.presetName()}」的历史版本`,`<p>完整保存的版本都保留在这里。载入旧版后可以继续编辑，再保存为新版本；不会删除后续版本。</p>${historyError?'<p class="pmme-version-error">历史变更尚未确认保存，请先点击顶部“重试保存”。</p>':''}${size>HISTORY_WARNING_BYTES?`<p class="pmme-group-warning">历史占用约 ${(size/1024/1024).toFixed(1)} MiB，会随酒馆设置一起保存。可手动删除不再需要的记录，不会自动清理版本。</p>`:''}<label class="pmme-field" for="pmme-history-search"><span>查找版本</span><input id="pmme-history-search" type="search" placeholder="版本号或更新说明" autocomplete="off"></label><div id="pmme-history-list"></div>`);
        renderHistoryList();
    } catch(error) { notify(error.message,true); }
}
function showHistoryVersion(id) {
    const record=versionById(historyStore(),native.presetName(),id);
    if(!record)throw new Error('历史版本已不存在，请重新打开列表。');
    showSheet(`查看 ${record.version}`,`<p>${escape(historyTime(record.createdAt))} · ${escape(record.note||'未填写更新说明')}</p><p>只读预览。包含全部条目库、角色排列、预设参数和分组记录。</p><div class="pmme-history-preview">${(record.preset?.prompts||[]).map(prompt=>`<details><summary>${escape(prompt.name||prompt.identifier)} <small>${escape(prompt.role||'占位符')}</small></summary><pre>${escape(prompt.content||'（无正文）')}</pre></details>`).join('')}</div><button class="pmme-button pmme-primary" data-pmme-action="history-load" data-pmme-version-id="${escape(id)}">载入此版本</button><button class="pmme-button" data-pmme-action="history-list">返回历史列表</button>`);
}
function historySignature() {
    return JSON.stringify([native.captureCurrentPreset(workspace.scope,workspace.historyLoaded?workspace.presetBase:null),workspace.ids,[...workspace.buffers].map(([id,buffer])=>[id,buffer.values]),[...workspace.drafts],workspace.groupDefinitions,groupsForPreset(config().groupsByScope,native.presetName())]);
}
function requestHistoryLoad(id) {
    const name=native.presetName(),record=versionById(historyStore(),name,id);
    if(!record)throw new Error('历史版本已不存在，请重新打开列表。');
    syncWorkspace();const attention=needsAttention(),signature=historySignature();
    showSheet(`载入 ${record.version}？`,`<p>这会用 ${escape(record.version)} 替换当前工作配置，包含条目库、所有角色排列、参数和分组。命名预设文件暂不覆盖，编辑满意后再“更新预设”。连接参数遵循酒馆的“绑定连接”设置。</p>${attention?`<p>当前工作区还有未完成的改动，可先完整保存为新版本，或明确放弃后载入。本页其他角色的草稿仍保留，不会自动保存。</p>${versionFields(`载入 ${record.version} 前保存当前修改`)}<button class="pmme-button pmme-primary" data-pmme-action="history-save-load">保存为新版本后载入</button><button class="pmme-button pmme-danger" data-pmme-action="history-discard-load">放弃当前改动并载入</button>`:'<button class="pmme-button pmme-primary" data-pmme-action="history-confirm-load">确认载入此版本</button>'}<button class="pmme-button pmme-quiet" data-pmme-action="history-list">取消，返回历史列表</button>`);
    historyConfirmation={mode:'load',owner:workspace,epoch,scope:workspace.scope,name,record:copy(record),signature};
}
function checkHistoryConfirmation(confirmation) {
    if(!confirmation || confirmation.owner!==workspace || confirmation.epoch!==epoch)throw new Error('预设已切换，请重新选择历史版本。');
    native.assertScope(confirmation.scope);
    const current=versionById(historyStore(),confirmation.name,confirmation.record.id);
    if(!current || JSON.stringify(current)!==JSON.stringify(confirmation.record))throw new Error('历史记录已变化，请重新选择版本。');
    if(confirmation.mode==='load' && historySignature()!==confirmation.signature)throw new Error('当前配置或草稿已变化，请重新确认载入，未丢弃任何修改。');
}
async function loadHistory(saveBefore=false) {
    const confirmation=historyConfirmation;let metadata;
    try { checkHistoryConfirmation(confirmation);if(saveBefore){if(!validateEditor())return;metadata=readVersionInputs();} }
    catch(error) { versionInputError(error);return; }
    closeSheet(false);
    return operation(async check=>{
        const owner=workspace;
        if(historyError||historySaving){await persistCurrentSettings(historyOwner);check();}
        if(owner.settingsUnconfirmed){await persistCurrentSettings(owner);check();}else{await settingsSaver.wait(owner);check();}
        checkHistoryConfirmation(confirmation);
        if(saveBefore){
            const saved=await commitVersion(true,metadata,check);
            if(owner.versionDirty || JSON.stringify(groupsForPreset(config().groupsByScope,confirmation.name))!==JSON.stringify(saved.record.groupsByScope))throw new Error('保存期间当前配置又有变化。新版本已保存，请重新确认载入。');
        }
        const record=confirmation.record,selected=owner.selected;
        check();native.applyPresetSnapshot(owner.scope,record.preset);check();
        config().groupsByScope=replacePresetGroups(config().groupsByScope,confirmation.name,record.groupsByScope);
        owner.presetBase=copy(record.preset);owner.baseVersionId=record.id;owner.baseVersionLabel=record.version;owner.versionDirty=true;owner.historyLoaded=true;
        owner.buffers.clear();owner.drafts.clear();owner.cursors.clear();owner.replacementResult=null;owner.ids=native.nativeOrder().map(entry=>entry.identifier);
        owner.selected=owner.ids.includes(selected)?selected:owner.ids[0]||null;owner.query='';owner.searchScroll=null;owner.organizing=false;owner.full=false;
        owner.groupDefinitions=copy(config().groupsByScope[owner.scope]||[]);owner.pendingGroupStart=null;owner.groupPreview=null;
        const store=historyStore();store.workingByScope[owner.scope]=record.id;
        for(const archived of new Set(archives.values())){
            if(archived===owner || scopePresetName(archived.scope)!==confirmation.name)continue;
            archived.presetBase=copy(record.preset);archived.baseVersionId=record.id;archived.baseVersionLabel=record.version;archived.versionDirty=true;archived.historyLoaded=true;archived.replacementResult=null;
            archived.buffers=new Map([...archived.buffers].filter(([id,buffer])=>archived.drafts.has(id)||draftChanged(buffer)));
            archived.groupDefinitions=copy(config().groupsByScope[archived.scope]||[]);archived.pendingGroupStart=null;archived.groupPreview=null;
            store.workingByScope[archived.scope]=record.id;
        }
        renderList(false);paintBusy();
        try{await persistCurrentSettings(owner);check();}
        catch(error){throw new Error(`已载入 ${record.version} 到工作配置，但后台保存未确认。内容仍保留，请重试保存。`,{cause:error});}
        notify(`已载入 ${record.version}，可以继续编辑；满意后更新预设保存为新版本。`);
    },'正在载入历史版本…');
}
function requestHistoryDelete(id) {
    const name=native.presetName(),record=versionById(historyStore(),name,id);
    if(!record)throw new Error('历史版本已不存在，请重新打开列表。');
    showSheet(`删除历史版本 ${record.version}？`,`<p>只删除这条历史记录，不改变当前工作配置或命名预设文件。删除后无法再从历史列表载入这一版。</p><button class="pmme-button pmme-danger" data-pmme-action="history-confirm-delete">确认删除历史记录</button><button class="pmme-button" data-pmme-action="history-list">保留，返回历史列表</button>`);
    historyConfirmation={mode:'delete',owner:workspace,epoch,scope:workspace.scope,name,record:copy(record)};
}
async function deleteHistoryVersion() {
    const confirmation=historyConfirmation;
    try{checkHistoryConfirmation(confirmation);}catch(error){notify(error.message,true);return;}
    closeSheet(false);
    const success=await operation(async check=>{config().presetHistory=removeVersion(historyStore(),confirmation.name,confirmation.record.id);await persistCurrentSettings(historyOwner);check();notify('已删除历史记录，当前预设内容未改变。');},'正在保存历史变更…');
    if(success)showHistory();
}
function showConflict(){if(!workspace.selected)return;showSheet('条目发生编辑冲突','<p>其他编辑器改动了同一个字段。当前草稿保留，你可以继续检查，或明确载入最新的原生内容。</p><button class="pmme-button" data-pmme-action="reload-latest">放弃本条草稿，载入最新内容</button><button class="pmme-button pmme-quiet" data-pmme-action="close">保留草稿继续查看</button>');}
function select(id,toggle=false){if(busy||workspace.organizing)return;rememberCursor();workspace.selected=toggle&&!isDesktop()&&workspace.selected===id&&!workspace.full?null:id;if(workspace.selected&&!isDesktop())revealEntry(id);renderList();}
function createDraft(anchor,before=false,source=null){
    if(busy)return;
    rememberCursor();const id=native.newId(),values=source?copy(source):normalizePrompt({name:'',role:'system',content:''});
    if(source)values.name=`${values.name||'未命名条目'}（副本）`;
    const prompt={identifier:id,...values,system_prompt:false,marker:false,enabled:false};
    workspace.drafts.set(id,{prompt,enableOnSave:config().enableNewOnSave});workspace.buffers.set(id,{base:normalizePrompt({}),values:copy(values)});workspace.ids=insertId(workspace.ids,id,anchor,before);workspace.selected=id;workspace.organizing=false;
    revealEntry(id,true);renderList();if(!workspace.full)$(`row-${id}`)?.scrollIntoView({block:'nearest',behavior:'smooth'});$('name').focus({preventScroll:true});$('name').select();notify('草稿已占据位置，首次保存会自动加入排列。');
}
function expand(){
    if(!workspace.selected||busy||workspace.full||$('body-field').hidden)return;
    rememberCursor();workspace.scrollTop=$('scroll').scrollTop;workspace.fullEditorScrollTop=$('editor').scrollTop;
    workspace.full=true;setView();restoreCursor();paintStatus();updateViewport();$('collapse').focus({preventScroll:true});
}
function collapse(){
    if(busy||!workspace.full)return;
    rememberCursor();workspace.full=false;renderList();
    const reveal=!isDesktop()&&hasSearch()&&!workspace.visibleIds.has(workspace.selected);
    if(reveal){revealEntry(workspace.selected,true);renderList(false);notify('正文已不匹配原搜索，已清空搜索并回到当前条目。');}
    $('scroll').scrollTop=workspace.scrollTop;$('editor').scrollTop=workspace.fullEditorScrollTop||0;
    if(reveal)$(`row-${workspace.selected}`)?.scrollIntoView({block:'nearest'});
    (isDesktop()?$('detail-expand'):$('expand')).focus({preventScroll:true});
}
function organize(){if(busy)return;rememberCursor();if(workspace.full){workspace.full=false;setView();}workspace.organizing=!workspace.organizing;if(workspace.organizing){workspace.query='';workspace.searchScroll=null;}else if(workspace.selected&&!isDesktop())revealEntry(workspace.selected);renderList();}
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
function groupMenu(id,anchor=null) {
    syncWorkspace();const group=groupById(id);if(!group){notify('分组边界已变化，请重新识别。',true);return;}
    showSheet(group.name,`<div data-pmme-group-action="${escape(id)}">
      ${action('组内新增','plus','group-new')}${action('在组上方新增','plus','group-before')}${action('在组下方新增','plus','group-after')}
      ${action('全部启用（含首尾边界）','check','group-enable')}${action('全部关闭（含首尾边界）','remove','group-disable')}
      ${action('整理分组与条目','grip','organize')}${action('查看开始边界','pen','group-start')}${action('查看结束边界','pen','group-end')}
      ${action('取消这个分组，保留所有条目','remove','group-remove')}
      </div><p>批量启停跳过未保存草稿和原生禁止切换的条目；启用会把所有可切换成员设为开启，不恢复之前的个别开关组合。</p>`,anchor);
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
function entryMenu(id,anchor=null){
    const prompt=promptFor(id);if(!prompt)return;const draft=workspace.drafts.has(id),allowed=draft?{remove:true,content:true}:native.permissions(prompt);
    const boundary=resolveWorkspaceGroups().groups.some(group=>group.startId===id||group.endId===id);
    showSheet(titleFor(id),`<div data-pmme-entry="${escape(id)}">${action('在上方新增','plus','before')}${action('在下方新增','plus','after')}${allowed.content?action('复制为独立草稿','copy','duplicate'):''}
      ${!boundary?action('设为分组起点','folder','group-mark-start'):''}${workspace.pendingGroupStart&&workspace.pendingGroupStart!==id&&!boundary?action('在此结束分组','folder','group-mark-end'):''}
      ${action('整理条目顺序','grip','organize')}${allowed.remove?action(draft?'放弃草稿':'从当前排列移除','remove','remove','pmme-danger'):''}${!draft&&allowed.remove?action('彻底删除条目','trash','delete','pmme-danger'):''}</div><p>${boundary?'这是分组边界，随整组拖动；单独移动前请先取消分组。':''}移除只改变排列，不会彻底删除已有条目。${boundary?'移除此边界后，该分组将平铺显示。':''}</p>`,anchor);
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
function requestDelete(id) {
    if(busy||!workspace||!id)return;
    if(workspace.drafts.has(id)){discardRequest(id);return;}
    try{
        const owner=workspace;native.assertScope(owner.scope);
        const prompt=native.findPrompt(id);
        if(!prompt||!native.permissions(prompt).remove)throw new Error('原生编辑器不允许删除这个内置或受限条目。');
        const snapshot=JSON.stringify(prompt),boundary=resolveWorkspaceGroups().groups.some(group=>group.startId===id||group.endId===id);
        rememberCursor();
        showSheet('彻底删除条目？',`<p>将从当前配置的条目库中删除「${escape(titleFor(id))}」，并清除所有角色排列中对它的引用。</p><p>删除后无法通过“添加已有”找回。${hasDraft(id)?'本条未保存的修改也会被丢弃。':''}其他条目及其草稿保持不变。</p>${boundary?'<p class="pmme-group-warning">这是分组边界，相关分组会取消，其他成员条目仍保留。</p>':''}<p>此操作不能在编辑台内撤销。删除后仍需更新命名预设；其他已保存预设文件不会自动改动。</p><button class="pmme-button pmme-danger" data-pmme-action="delete-confirm" data-pmme-entry="${escape(id)}">确认彻底删除</button><button class="pmme-button" data-pmme-action="close">保留条目</button>`);
        deleteConfirmation={owner,id,version:epoch,snapshot};
    }catch(error){notify(error.message,true);}
}
function deleteExisting(id) {
    const confirmation=deleteConfirmation;closeSheet(false);
    try{
        if(!confirmation||confirmation.id!==id||confirmation.owner!==workspace||confirmation.version!==epoch)throw new Error('删除上下文已变化，请重新选择条目。');
        const owner=confirmation.owner;rememberCursor();native.deletePrompt(owner.scope,id,confirmation.snapshot);
        const index=owner.ids.indexOf(id);
        owner.buffers.delete(id);owner.cursors.delete(id);owner.ids=owner.ids.filter(candidate=>candidate!==id);
        if(owner.selected===id)owner.selected=owner.ids[Math.min(index,owner.ids.length-1)]||null;
        if(!owner.selected)owner.full=false;
        if($('editor').dataset.entryId===id)delete $('editor').dataset.entryId;
        owner.groupDefinitions=owner.groupDefinitions.filter(group=>group?.startId!==id&&group?.endId!==id);
        if(owner.pendingGroupStart===id)owner.pendingGroupStart=null;
        owner.groupPreview=null;storeGroupPreferences(owner);
        settingsSaver.request(owner);renderList(false);updateViewport();native.refreshNative();
        notify('删除已应用；仍需更新命名预设。');
    }catch(error){notify(error.message,true);}
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
        const reopening=root.hidden;
        makeWorkspace();native.assertScope(workspace.scope);navigationVersion++;returningVersion=0;
        applyAppearance();applyLayout(false);
        if(reopening){
            returnLocation=capturePresetLocation();originalOverflow=document.body.style.overflow;
            root.hidden=false;document.body.style.overflow='hidden';
        }
        if(id&&workspace.ids.includes(id)){workspace.selected=id;workspace.organizing=false;revealEntry(id,true);}
        renderList(!reopening);updateViewport();
        if(id&&!workspace.full)requestAnimationFrame(()=>$(`row-${id}`)?.scrollIntoView({block:'nearest'}));
    }catch(error){notify(error.message,true);}
}
async function close(showNotice=true,force=false,restorePreset=true){
    if(root.hidden||(!force&&(busy||returningVersion)))return;
    const version=++navigationVersion,location=returnLocation;
    returningVersion=version;
    rememberCursor();finishDirectoryResize(true);sorter?.cancel();closeSheet(false);
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
    root.hidden=true;document.body.style.overflow=originalOverflow;
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
    showSheet('切换预设前处理修改',`<p>当前预设有草稿或尚未更新的配置。直接切换会用目标预设覆盖当前配置；保存时会新增一个历史版本。</p>${versionFields()}<button class="pmme-button pmme-primary" data-pmme-action="save-switch">保存修改并更新后切换</button><button class="pmme-button pmme-danger" data-pmme-action="discard-switch">放弃当前改动并切换</button><button class="pmme-button pmme-quiet" data-pmme-action="close">取消切换</button>`);
    versionConfirmation={owner:workspace,epoch,scope:workspace.scope};
}
function interceptNativeCreate(event){
    // Keep the legacy preference key for creation; native edit pencils never redirect.
    if(!config().enabled||!config().interceptNative||event.shiftKey)return;
    const target=event.target instanceof Element?event.target:null,managerRoot=target?.closest('#completion_prompt_manager');if(!managerRoot)return;
    const create=target.closest('.completion_prompt_manager_footer .fa-plus-square');if(!create)return;
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    open();if(!root.hidden)createDraft(workspace.selected);
}
function updateViewport(){
    if(!root||root.hidden)return;const viewport=window.visualViewport;
    if(viewport){root.style.setProperty('--pmme-height',`${viewport.height}px`);root.style.setProperty('--pmme-top',`${viewport.offsetTop}px`);}
    applyLayout();
}
function mountEntryButton(){
    const manager=document.getElementById('completion_prompt_manager');if(!manager)return;
    const existing=document.getElementById('pmme-open');if(existing){existing.hidden=!config().enabled;return;}
    const host=manager.querySelector('.completion_prompt_manager_header');if(!host)return;
    const button=document.createElement('button');button.id='pmme-open';button.type='button';button.className='menu_button pmme-entry-button';button.innerHTML=`${icon('echo')}<span>回声编辑台</span>`;button.title='回声编辑台 · 预设编辑';button.setAttribute('aria-label','打开回声编辑台预设编辑器');button.hidden=!config().enabled;button.addEventListener('click',()=>open());host.appendChild(button);
}
function bindUI(){
    $('retry').addEventListener('click',()=>{if(workspace?.settingsSaveFailed)settingsSaver.request(workspace);if(preferencesError)settingsSaver.request(preferencesOwner);if(historyError)settingsSaver.request(historyOwner);});
    $('history').addEventListener('click',showHistory);
    $('batch-replace').addEventListener('click',openContentReplacement);$('replace-review').addEventListener('click',()=>{try{showReplacementResult();}catch(error){notify(error.message,true);}});
    $('theme-control').addEventListener('click',showAppearancePicker);$('full-theme-control').addEventListener('click',showAppearancePicker);$('layout-control').addEventListener('click',showLayoutPicker);
    $('close').addEventListener('click',()=>close());$('library').addEventListener('click',openLibrary);$('organize').addEventListener('click',organize);$('expand').addEventListener('click',expand);$('collapse').addEventListener('click',collapse);$('save').addEventListener('click',saveSelected);$('full-save').addEventListener('click',saveSelected);$('update').addEventListener('click',requestUpdate);$('discard').addEventListener('click',()=>discardRequest());
    $('desktop-close').addEventListener('click',()=>close());
    $('detail-expand').addEventListener('click',expand);$('detail-menu').addEventListener('click',()=>entryMenu(workspace.selected,$('detail-menu')));
    $('directory-search').addEventListener('input',event=>{if(!busy)setSearchQuery(event.target.value);});
    $('clear-search').addEventListener('click',()=>{if(busy)return;setSearchQuery('');$('directory-search').focus();});
    $('search-titles').addEventListener('change',event=>{if(busy)return;workspace.titleOnly=event.target.checked;renderList();});
    $('groups').addEventListener('click',()=>{if(busy)return;try{showGroupTools();}catch(error){notify(error.message,true);}});
    $('list').addEventListener('click',event=>{
        if(busy)return;const button=event.target.closest('button');if(!button||button.disabled)return;
        if(button.hasAttribute('data-pmme-create-first')){createDraft(null);return;}
        if(button.hasAttribute('data-pmme-clear-query')){setSearchQuery('');$('directory-search').focus();return;}
        if(button.dataset.pmmeFold){foldGroup(button.dataset.pmmeFold);return;}
        if(button.dataset.pmmeGroupMenu){groupMenu(button.dataset.pmmeGroupMenu,button);return;}
        if(button.dataset.pmmeGroupToggle){setGroupEnabled(button.dataset.pmmeGroupToggle);return;}
        if(button.dataset.pmmeSelect)select(button.dataset.pmmeSelect,true);
        if(button.dataset.pmmeMenu)entryMenu(button.dataset.pmmeMenu,button);
        if(button.dataset.pmmeToggle){const id=button.dataset.pmmeToggle;if(workspace.drafts.has(id)){notify('草稿不参与发送；保存时可选择启用。');return;}try{const enabled=native.togglePrompt(workspace.scope,id);paintToggle(id,enabled);settingsSaver.request(workspace);native.refreshNative();}catch(error){notify(error.message,true);}}
    });
    root.addEventListener('input',event=>{
        if(!event.target.closest('#pmme-editor, #pmme-body-field')||busy||!workspace.selected)return;
        const buffer=bufferFor(workspace.selected),name=event.target.id.replace('pmme-',''),map={name:'name',role:'role',content:'content',injection:'injection_position',depth:'injection_depth',order:'injection_order',overrides:'forbid_overrides'};
        if(map[name])buffer.values[map[name]]=name==='overrides'?event.target.checked:['injection','depth','order'].includes(name)?Number(event.target.value):event.target.value;
        if(name.startsWith('trigger-'))buffer.values.injection_trigger=[...buffer.values.injection_trigger.filter(t=>!TRIGGERS.includes(t)),...TRIGGERS.filter(t=>$(`trigger-${t}`).checked)];
        if(name==='enable-new')workspace.drafts.get(workspace.selected).enableOnSave=event.target.checked;
        updateAdvanced();rememberCursor();paintStatus();
    });
    root.addEventListener('focusout',()=>{rememberCursor();requestAnimationFrame(updateViewport);});root.addEventListener('focusin',updateViewport);$('content').addEventListener('select',rememberCursor);$('content').addEventListener('scroll',rememberCursor);
    $('sheet-close').addEventListener('click',()=>closeSheet());$('backdrop').addEventListener('click',()=>{if(!busy)closeSheet();});
    $('sheet-body').addEventListener('input',event=>{
        if(event.target.id==='pmme-search')renderLibrary(event.target.value);if(event.target.id==='pmme-history-search')renderHistoryList(event.target.value);
        const panel=replacementPanel;if(!panel||busy)return;
        if(event.target.id==='pmme-replace-with'||event.target.id==='pmme-replace-case'){$('replace-delete-check').checked=false;renderReplacementPreview();}
        else if(event.target.dataset.pmmeReplaceId){const id=event.target.dataset.pmmeReplaceId;if(event.target.checked)panel.excluded.delete(id);else panel.excluded.add(id);$('replace-delete-check').checked=false;paintReplacementSelection();}
        else if(event.target.id==='pmme-replace-all'){
            for(const change of panel.plan.changes)if(event.target.checked)panel.excluded.delete(change.id);else panel.excluded.add(change.id);
            for(const checkbox of $('replace-preview').querySelectorAll('[data-pmme-replace-id]'))checkbox.checked=!panel.excluded.has(checkbox.dataset.pmmeReplaceId);
            $('replace-delete-check').checked=false;paintReplacementSelection();
        }else if(event.target.id==='pmme-replace-delete-check')paintReplacementSelection();
    });
    $('sheet-body').addEventListener('click',async event=>{
        if(busy)return;const button=event.target.closest('button');if(!button)return;
        if(button.dataset.pmmeTheme){setAppearance(button.dataset.pmmeTheme);closeSheet();return;}
        if(button.dataset.pmmeLayout){setLayout(button.dataset.pmmeLayout);closeSheet();return;}
        if(button.dataset.pmmeAdd){await addExisting(button.dataset.pmmeAdd);return;}
        const kind=button.dataset.pmmeAction,id=button.closest('[data-pmme-entry]')?.dataset.pmmeEntry,groupId=button.closest('[data-pmme-group-action]')?.dataset.pmmeGroupAction;
        if(kind==='close'){closeSheet();return;}
        try{
            if(kind==='replace-refresh'){refreshReplacementPreview();return;}
            if(kind==='replace-apply'){applyContentReplacement();return;}
            if(kind==='replace-undo'){undoContentReplacement();return;}
            if(kind==='replace-clear-search'){closeSheet(false);setSearchQuery('');$('directory-search').focus({preventScroll:true});return;}
            if(kind==='replace-open-entry'){openReplacedEntry(button.dataset.pmmeReplaceEntry);return;}
            const versionId=button.closest('[data-pmme-version-id]')?.dataset.pmmeVersionId;
            if(kind==='history-list'){showHistory();return;}
            if(kind==='history-view'){showHistoryVersion(versionId);return;}
            if(kind==='history-load'){requestHistoryLoad(versionId);return;}
            if(kind==='history-save-load'||kind==='history-discard-load'||kind==='history-confirm-load'){await loadHistory(kind==='history-save-load');return;}
            if(kind==='history-delete'){requestHistoryDelete(versionId);return;}
            if(kind==='history-confirm-delete'){await deleteHistoryVersion();return;}
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
        if(kind==='delete'){requestDelete(id);return;}
        if(kind==='delete-confirm'){deleteExisting(id);return;}
        if(kind==='remove'){
            if(workspace.drafts.has(id)){discardRequest(id);return;}
            showSheet('从当前排列移除？',`<p>「${escape(titleFor(id))}」仍保留在已有条目库中。${hasDraft(id)?'本条未保存的修改会被放弃。':''}</p><button class="pmme-button pmme-danger" data-pmme-action="remove-confirm" data-pmme-entry="${escape(id)}">确认移除</button><button class="pmme-button" data-pmme-action="close">保留条目</button>`);return;
        }
        if(kind==='remove-confirm'){await removeExisting(id);return;}
        if(kind==='save-switch'){const value=workspace.switchValue;if(await updateNamed(true))performPresetSwitch(value);return;}
        if(kind==='discard-switch'){const value=workspace.switchValue;settingsSaver.cancel(workspace);archives.delete(workspace.scope);workspace.buffers.clear();workspace.drafts.clear();workspace.backgroundSaving=false;workspace.settingsSaveFailed=false;workspace.settingsUnconfirmed=false;closeSheet(false);performPresetSwitch(value);}
    });
    root.addEventListener('keydown',event=>{
        if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(!$('sheet-layer').hidden)return;if(workspace.selected)void saveSelected();else requestUpdate();}
        if(event.key==='Escape'&&!busy){event.preventDefault();event.stopPropagation();if(!$('sheet-layer').hidden)closeSheet();else if(workspace.full)collapse();else if(hasSearch()){setSearchQuery('');$('directory-search').focus();}else close();}
        if(event.key==='Tab'&&!$('sheet-layer').hidden){const focusable=[...$('sheet-layer').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')].filter(control=>control.getClientRects().length),first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
    });
    // Keep the native configuration drawer open while interacting with our own page.
    root.addEventListener('click',event=>event.stopPropagation());
    window.addEventListener('click',interceptNativeCreate,true);window.addEventListener('change',interceptPresetChange,true);
    window.visualViewport?.addEventListener('resize',updateViewport);window.visualViewport?.addEventListener('scroll',updateViewport);window.addEventListener('resize',updateViewport);
    window.addEventListener('beforeunload',event=>{if(!config().enabled)return;const workspaces=new Set([...archives.values(),workspace].filter(Boolean));const unsaved=settingsSaver.isPending(preferencesOwner)||settingsSaver.isPending(historyOwner)||[...workspaces].some(w=>w.settingsUnconfirmed||w.drafts.size||[...w.buffers.values()].some(draftChanged));if(unsaved){event.preventDefault();event.returnValue='';}});
    bindSorter();bindDirectoryResize();
}
async function mountSettings(){
    const context=getContext(),host=document.getElementById('extensions_settings2')||document.getElementById('extensions_settings');if(!host)return;
    host.insertAdjacentHTML('beforeend',await context.renderExtensionTemplateAsync(`third-party/${EXTENSION_FOLDER}`,'settings'));
    const settings=config();$('setting-enabled').checked=settings.enabled;$('setting-intercept').checked=settings.interceptNative;$('setting-enable-new').checked=settings.enableNewOnSave;
    $('setting-theme').value=settings.theme;$('setting-theme').addEventListener('change',()=>setAppearance($('setting-theme').value));
    $('setting-layout').value=settings.layout;$('setting-layout').addEventListener('change',()=>setLayout($('setting-layout').value));
    for(const[id,key]of[['setting-enabled','enabled'],['setting-intercept','interceptNative'],['setting-enable-new','enableNewOnSave']])$(id).addEventListener('change',()=>{settings[key]=$(id).checked;if(key==='enabled'&&!settings.enabled&&!root.hidden)close();saveConfig();});
    $('setting-open').addEventListener('click',()=>open());
}
function resetVersionBasis(name) {
    if(typeof name!=='string')return;
    for(const owner of new Set([...archives.values(),workspace].filter(Boolean)))if(scopePresetName(owner.scope)===name){owner.versionBasisReset=true;owner.versionDirty=false;}
    try{const store=historyStore();for(const scope of Object.keys(store.workingByScope))if(scopePresetName(scope)===name)delete store.workingByScope[scope];}catch{}
}
async function initialize(){
    if(initialized)return;initialized=true;
    const migration=migrateLegacySettings();config();
    if(migration.disabled){if(migration.changed)settingsSaver.request(preferencesOwner);return;}
    makeRoot();bindUI();
    const context=getContext();
    context.eventSource.on(context.eventTypes.OAI_PRESET_CHANGED_BEFORE,event=>{resetVersionBasis(event?.presetName);epoch++;sorter.cancel();if(workspace)archives.set(workspace.scope,workspace);if(!root.hidden)close(false,true,false);workspace=null;});
    context.eventSource.on(context.eventTypes.OAI_PRESET_CHANGED_AFTER,()=>{workspace=null;mountEntryButton();});
    context.eventSource.on(context.eventTypes.MAIN_API_CHANGED,()=>{if(!root.hidden&&getContext().mainApi!=='openai'){epoch++;close(false,true,false);notify('已返回酒馆；草稿在本次页面中保留。');}});
    const manager=document.getElementById('completion_prompt_manager');if(manager){observer=new MutationObserver(()=>{if(!scheduledMount)scheduledMount=requestAnimationFrame(()=>{scheduledMount=0;mountEntryButton();});});observer.observe(manager,{childList:true,subtree:true});}
    mountEntryButton();try{await mountSettings();}catch(error){console.warn('[回声编辑台] 设置面板加载失败',error);}
    if(migration.changed)settingsSaver.request(preferencesOwner);
}
getContext().eventSource.on(getContext().eventTypes.APP_READY,initialize);
