// In-memory native host doubles only. Editor modules are served without changes.
const MODULE = '回声编辑台';
const PRESET = 'UI Layout Fixture';
const CHARACTER = 'fixture-character';
const clone = value => structuredClone(value);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function fixedSample() {
    const longBody = (label, needle) => Array.from({ length: 90 }, (_, index) => `${String(index + 1).padStart(3, '0')} · ${label}：这是完全本地的固定正文，用来验证长文本、光标和滚动，不会发送给任何模型。 ${needle}`).join('\n');
    const prompt = (identifier, name, content, extra = {}) => ({
        identifier, name, role: 'system', content,
        injection_position: 0, injection_depth: 4, injection_order: 100,
        injection_trigger: [], forbid_overrides: false, system_prompt: false, marker: false,
        fixture_unknown_field: { preserved: true }, ...extra,
    });
    const prompts = [
        prompt('intro', '叙事指引', longBody('叙事指引', 'FIXTURE-NEEDLE-INTRO')),
        prompt('dialogue', '对话节奏', longBody('对话节奏', 'FIXTURE-NEEDLE-DIALOGUE'), { role: 'user' }),
        prompt('disabled-note', '关闭的备用条目', '这是已关闭但仍应能搜索的正文。 DISABLED-ONLY'),
        prompt('group-start', '【世界设定开始】', '固定分组的开始边界。'),
        prompt('group-first', '地理资料', longBody('地理资料', 'FIXTURE-NEEDLE-GROUP')),
        prompt('group-second', '人物资料', '第二个固定分组成员。'),
        prompt('group-end', '【世界设定结束】', '固定分组的结束边界。'),
        ...Array.from({ length: 18 }, (_, index) => prompt(`tail-${String(index + 1).padStart(2, '0')}`, `附录条目 ${String(index + 1).padStart(2, '0')}`, `固定目录条目，用来验证目录位置。 TAIL-ONLY-${String(index + 1).padStart(2, '0')}`)),
        prompt('chatHistory', '聊天记录占位符', '', { marker: true, system_prompt: true }),
        prompt('unused-library', '未加入排列的资料', '只在已有条目库中出现。'),
    ];
    const order = prompts.filter(item => item.identifier !== 'unused-library').map(item => ({
        identifier: item.identifier, enabled: item.identifier !== 'disabled-note', fixture_order_field: 'keep',
    }));
    return {
        preset_settings_openai: PRESET, temperature: 0.73,
        extensions: { fixture_extension: { retained: true } },
        chat_completion_source: 'fixture-original-provider', custom_model: 'fixture-original-model',
        prompts, prompt_order: [{ character_id: CHARACTER, order }],
        fixture_preset_field: 'unchanged',
    };
}

function eventBus() {
    const listeners = new Map();
    const bus = {
        on(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
            return bus;
        },
        removeListener(type, listener) { listeners.get(type)?.delete(listener); return bus; },
        off(type, listener) { return bus.removeListener(type, listener); },
        once(type, listener) {
            const wrapped = (...args) => { bus.removeListener(type, wrapped); return listener(...args); };
            return bus.on(type, wrapped);
        },
        async emit(type, ...args) { await Promise.all([...listeners.get(type) || []].map(listener => listener(...args))); },
    };
    return bus;
}

export function createFixture(seed = {}) {
    const original = fixedSample();
    const serviceSettings = clone(seed.serviceSettings || original);
    serviceSettings.temp_openai ??= serviceSettings.temperature ?? original.temperature;
    serviceSettings.bind_preset_to_connection ??= false;
    delete serviceSettings.temperature;
    const scope = JSON.stringify([PRESET, 'global', CHARACTER]);
    const extensionSettings = clone(seed.extensionSettings || {
        [MODULE]: {
            enabled: true, interceptNative: true, enableNewOnSave: false, theme: 'paper',
            groupsByScope: { [scope]: [{ id: 'group-start', startId: 'group-start', endId: 'group-end', name: '世界设定', collapsed: false }] },
        },
        disabledExtensions: [],
    });
    const source = eventBus();
    const eventTypes = Object.fromEntries([
        'APP_READY', 'SETTINGS_UPDATED', 'OAI_PRESET_CHANGED_BEFORE', 'OAI_PRESET_CHANGED_AFTER', 'MAIN_API_CHANGED',
    ].map(name => [name, name]));
    let nextId = 0;
    const manager = {
        serviceSettings, activeCharacter: { id: CHARACTER }, configuration: { promptOrder: { strategy: 'global' } },
        overridablePrompts: ['intro'],
        getPromptOrderForCharacter(character) {
            return serviceSettings.prompt_order.find(bucket => String(bucket.character_id) === String(character.id))?.order;
        },
        getPromptById(id) { return serviceSettings.prompts.find(item => item.identifier === id); },
        getPromptOrderEntry(character, id) { return manager.getPromptOrderForCharacter(character).find(item => item.identifier === id); },
        isPromptEditAllowed(item) { return Boolean(item && !item.marker); },
        isPromptDeletionAllowed(item) { return Boolean(item && !item.system_prompt); },
        isPromptToggleAllowed(item) { return Boolean(item && !item.marker); },
        getUuidv4() {
            let id;
            do { id = `fixture-draft-${String(++nextId).padStart(4, '0')}`; } while (manager.getPromptById(id));
            return id;
        },
        addPrompt(values, id) { serviceSettings.prompts.push({ identifier: id, ...clone(values), system_prompt: false, marker: false }); },
        appendPrompt(item, character) {
            const order = manager.getPromptOrderForCharacter(character);
            if (!order.some(entry => entry.identifier === item.identifier)) order.push({ identifier: item.identifier, enabled: false });
        },
        updatePromptByIdentifier(id, patch) { Object.assign(manager.getPromptById(id), clone(patch)); },
        detachPrompt(item, character) {
            const order = manager.getPromptOrderForCharacter(character);
            const index = order.findIndex(entry => entry.identifier === item.identifier);
            if (index >= 0) order.splice(index, 1);
        },
        renderDebounced() {
            const host = document.getElementById('completion_prompt_manager_list');
            if (!host) return;
            host.innerHTML = manager.getPromptOrderForCharacter(manager.activeCharacter).map(entry => {
                const item = manager.getPromptById(entry.identifier);
                return `<div data-pm-identifier="${escape(entry.identifier)}"><span>${escape(item?.name || entry.identifier)}</span> <button class="prompt-manager-edit-action" type="button">编辑</button></div>`;
            }).join('');
        },
    };
    const fixture = {
        serviceSettings, manager, extensionSettings,
        savedPresets: [clone(seed.namedPreset || original)], presetNames: { [PRESET]: 0 },
        pendingSettingsSaves: 0, completedSettingsSaves: 0, notices: [],
        openDrawer() {
            document.getElementById('left-nav-panel').hidden = false;
            document.getElementById('left-nav-panel').classList.add('openDrawer');
        },
        showSettings() { document.getElementById('extensions_settings2').hidden = false; },
        async saveSettings() {
            fixture.pendingSettingsSaves++;
            try {
                const response = await fetch('/api/settings/save', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ extension_settings: extensionSettings, oai_settings: serviceSettings }),
                });
                if (!response.ok) throw new Error(`Fixture settings save failed (${response.status})`);
                await response.json();
                fixture.completedSettingsSaves++;
                await source.emit(eventTypes.SETTINGS_UPDATED);
            } finally { fixture.pendingSettingsSaves--; }
        },
    };
    fixture.context = {
        mainApi: 'openai', extensionSettings, eventSource: source, eventTypes,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveSettingsDebounced: () => fixture.saveSettings(),
        async renderExtensionTemplateAsync(folder, template) {
            if (folder !== 'third-party/ui-layout-fixture' || template !== 'settings') throw new Error('Unexpected extension template');
            const response = await fetch(`/scripts/extensions/${folder}/settings.html`);
            if (!response.ok) throw new Error(`Fixture template unavailable (${response.status})`);
            return response.text();
        },
    };
    globalThis.toastr = Object.fromEntries(['info', 'error', 'warning', 'success'].map(kind => [kind, message => fixture.notices.push({ kind, message })]));
    manager.renderDebounced();
    return fixture;
}
