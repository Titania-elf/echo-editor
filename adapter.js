import { getContext } from '../../../extensions.js';
import { saveSettings } from '../../../../script.js';
import { promptManager, oai_settings, getChatCompletionPreset, openai_settings, openai_setting_names } from '../../../openai.js';
import { normalizePrompt, buildPromptPatch, projectOrder, copy } from './model.js';

export function getManager() {
    if (getContext().mainApi !== 'openai') throw new Error('回声编辑台用于聊天补全预设，请先切换到聊天补全 API。');
    if (!promptManager || !Array.isArray(promptManager.serviceSettings?.prompts) || !promptManager.activeCharacter) throw new Error('原生预设编辑器尚未就绪，请稍后再打开。');
    return promptManager;
}
export function presetName() { return String(oai_settings.preset_settings_openai || ''); }
export function scopeKey() {
    const manager = getManager();
    return JSON.stringify([presetName(), manager.configuration.promptOrder.strategy, String(manager.activeCharacter.id)]);
}
export function assertScope(expected) { if (scopeKey() !== expected) throw new Error('预设已经切换，已阻止将草稿写入其他预设。'); }
export function nativeOrder() {
    const manager = getManager(), order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    if (!Array.isArray(order) || !manager.serviceSettings.prompt_order.some(bucket => bucket.order === order)) throw new Error('当前预设排列尚未初始化。请切换预设后重试。');
    return order;
}
export function findPrompt(id) { return getManager().getPromptById(id); }
export function allPrompts() { return getManager().serviceSettings.prompts.filter(Boolean); }
export function permissions(prompt) {
    const manager = getManager();
    return {
        edit: manager.isPromptEditAllowed(prompt), content: manager.isPromptEditAllowed(prompt) && !prompt.marker,
        remove: manager.isPromptDeletionAllowed(prompt), toggle: manager.isPromptToggleAllowed(prompt),
        overrides: manager.overridablePrompts.includes(prompt.identifier),
    };
}
export function newId() { return getManager().getUuidv4(); }
function promptState(settings) { return JSON.stringify([settings?.prompts || [], settings?.prompt_order || []]); }
export function presetNeedsUpdate() {
    const name = presetName(), index = openai_setting_names?.[name];
    return index === undefined || !openai_settings?.[index] || promptState(oai_settings) !== promptState(openai_settings[index]);
}

export function persistSettings(expected, timeout = 15000, immediate = false) {
    if (expected !== null) assertScope(expected);
    const context = getContext(), event = context.eventTypes.SETTINGS_UPDATED;
    return new Promise((resolve, reject) => {
        let updated = false, invocationFinished = !immediate, settled = false;
        const clean = () => { clearTimeout(timer); context.eventSource.removeListener(event, saved); };
        const complete = () => { if (!settled && updated && invocationFinished) { settled = true; clean(); resolve(); } };
        const saved = () => { updated = true; complete(); };
        const failed = error => { if (!settled) { settled = true; clean(); reject(error); } };
        const timer = setTimeout(() => failed(new Error('当前设置保存未得到确认。修改仍保留，请检查连接后重试保存。')), timeout);
        context.eventSource.on(event, saved);
        try {
            if (immediate) {
                // Do not let an unrelated SETTINGS_UPDATED event advance our write queue
                // before this native save invocation has finished its request.
                Promise.resolve(saveSettings()).then(() => { invocationFinished = true; complete(); }, failed);
            } else context.saveSettingsDebounced();
        } catch (error) { failed(error); }
    });
}
export function refreshNative() { promptManager?.renderDebounced?.(); }
function updateQuickEdit(prompt) {
    if (!['main','nsfw','jailbreak'].includes(prompt.identifier)) return;
    const field = document.getElementById(`${prompt.identifier}_prompt_quick_edit_textarea`);
    if (field) field.value = prompt.content ?? '';
}

// Prepare every patch before applying any of them: a conflict must not partially save a batch.
export function applyBuffers({ scope, ids, buffers, drafts, visibleOrder }) {
    assertScope(scope);
    const manager = getManager(), prepared = [];
    for (const id of ids) {
        const buffer = buffers.get(id); if (!buffer) continue;
        const draft = drafts.get(id);
        if (draft) {
            if (findPrompt(id)) throw new Error('草稿标识已存在，请复制成新草稿后重试。');
            const values = normalizePrompt(buffer.values); values.name = values.name.trim() || '未命名条目';
            prepared.push({id, draft, values});
        } else {
            const prompt = findPrompt(id); if (!prompt) throw new Error('该条目已经被其他编辑器移除，草稿未写入。');
            const allowed = permissions(prompt); if (!allowed.edit) continue;
            prepared.push({id, prompt, patch:buildPromptPatch(buffer,prompt,{contentEditable:allowed.content,overridesEditable:allowed.overrides})});
        }
    }
    // Check the complete projection before adding prompts or changing any native objects.
    const virtual = [...nativeOrder(), ...prepared.filter(item=>item.draft).map(item=>({identifier:item.id,enabled:item.draft.enableOnSave}))];
    projectOrder(virtual,visibleOrder);
    for (const item of prepared) {
        if (item.draft) {
            manager.addPrompt(item.values,item.id);
            manager.appendPrompt(findPrompt(item.id),manager.activeCharacter);
            manager.getPromptOrderEntry(manager.activeCharacter,item.id).enabled = Boolean(item.draft.enableOnSave);
        } else {
            manager.updatePromptByIdentifier(item.id,item.patch);
            updateQuickEdit(findPrompt(item.id));
        }
    }
    if (prepared.some(item=>item.draft)) {
        const order = nativeOrder(), reordered = projectOrder(order,visibleOrder);
        order.splice(0,order.length,...reordered);
    }
    return prepared.map(item=>item.id);
}

export function applyReorder(scope, visibleOrder, expectedNativeIds) {
    assertScope(scope);
    const order = nativeOrder();
    if (JSON.stringify(order.map(entry=>entry.identifier)) !== JSON.stringify(expectedNativeIds)) throw new Error('原生排列在拖动期间发生变化，已取消这次排序。');
    const next = projectOrder(order,visibleOrder);
    const changed = JSON.stringify(order.map(entry=>entry.identifier)) !== JSON.stringify(next.map(entry=>entry.identifier));
    if (changed) order.splice(0,order.length,...next);
    return changed;
}
export function togglePrompt(scope,id) {
    assertScope(scope);
    const prompt=findPrompt(id), manager=getManager();
    if (!prompt || !permissions(prompt).toggle) throw new Error('原生编辑器不允许切换这个条目。');
    const entry=manager.getPromptOrderEntry(manager.activeCharacter,id); if (!entry) throw new Error('条目不在当前排列中。');
    entry.enabled=!entry.enabled;
    return entry.enabled;
}
export function insertExisting(scope,id,visibleOrder) {
    assertScope(scope);
    const manager=getManager(), prompt=findPrompt(id);
    if (!prompt || prompt.system_prompt) throw new Error('该已有条目不可添加。');
    if (nativeOrder().some(entry=>entry.identifier===id)) throw new Error('该条目已经在排列中。');
    projectOrder([...nativeOrder(),{identifier:id,enabled:false}],visibleOrder);
    manager.appendPrompt(prompt,manager.activeCharacter);
    const order=nativeOrder(),next=projectOrder(order,visibleOrder);order.splice(0,order.length,...next);
}
export function removePrompt(scope,id) {
    assertScope(scope);
    const manager=getManager(),prompt=findPrompt(id);
    if (!prompt || !permissions(prompt).remove) throw new Error('原生编辑器不允许移除这个内置条目。');
    manager.detachPrompt(prompt,manager.activeCharacter);
}

// Match native “update preset”: save a snapshot and refresh the native cache WITHOUT reapplying the preset.
export async function saveNamedPreset(scope) {
    assertScope(scope);
    const name=presetName(), index=openai_setting_names?.[name];
    if (!name || index===undefined || !openai_settings?.[index]) throw new Error('请先在酒馆中选择一个已命名的预设。');
    const snapshot=getChatCompletionPreset(oai_settings),controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    let data;
    try {
        const response=await fetch('/api/presets/save',{method:'POST',headers:getContext().getRequestHeaders(),body:JSON.stringify({apiId:'openai',name,preset:snapshot}),signal:controller.signal});
        if (!response.ok) throw new Error(`预设更新失败（HTTP ${response.status}），当前条目和草稿仍保留。`);
        data=await response.json();
    } catch(error) {
        if(controller.signal.aborted)throw new Error('预设更新超时。当前内容保留，请检查连接后重试。');
        throw error;
    } finally { clearTimeout(timer); }
    const savedIndex=openai_setting_names?.[data.name];
    if (savedIndex!==undefined && openai_settings?.[savedIndex]) Object.assign(openai_settings[savedIndex],copy(snapshot));
    return String(data.name || name);
}
