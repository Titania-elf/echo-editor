export const PROMPT_FIELDS = ['name', 'role', 'content', 'injection_position', 'injection_depth', 'injection_order', 'injection_trigger', 'forbid_overrides'];
export const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
export const copy = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const number = (value, fallback) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback;

export function normalizePrompt(prompt) {
    return {
        name: String(prompt.name ?? ''), role: String(prompt.role || 'system'), content: String(prompt.content ?? ''),
        injection_position: number(prompt.injection_position, 0), injection_depth: number(prompt.injection_depth, 4),
        injection_order: number(prompt.injection_order, 100),
        injection_trigger: Array.isArray(prompt.injection_trigger) ? [...prompt.injection_trigger] : [],
        forbid_overrides: Boolean(prompt.forbid_overrides),
    };
}

export function draftChanged(buffer) {
    return PROMPT_FIELDS.some(field => !equal(buffer.base[field], buffer.values[field]));
}

// Only write fields the author actually changed; never replace the complete prompt object.
export function buildPromptPatch(buffer, current, { contentEditable = true, overridesEditable = true } = {}) {
    const latest = normalizePrompt(current), patch = {}, conflicts = [];
    for (const field of PROMPT_FIELDS) {
        if (field === 'content' && !contentEditable || field === 'forbid_overrides' && !overridesEditable) continue;
        if (equal(buffer.base[field], buffer.values[field])) continue;
        if (!equal(latest[field], buffer.base[field]) && !equal(latest[field], buffer.values[field])) conflicts.push(field);
        else patch[field] = copy(buffer.values[field]);
    }
    if (conflicts.length) {
        const error = new Error('这个条目也被其他编辑器修改了。请先处理冲突，避免覆盖对方的修改。');
        error.code = 'PROMPT_CONFLICT'; error.fields = conflicts;
        throw error;
    }
    return patch;
}

export function insertId(ids, newId, anchor, before = false) {
    if (ids.includes(newId)) throw new Error('条目已经在排列中。');
    const result = [...ids], index = result.indexOf(anchor);
    result.splice(index < 0 ? result.length : index + (before ? 0 : 1), 0, newId);
    return result;
}

// Drafts have visible positions, but no native prompt_order entry until their first save.
export function mergeDraftPositions(nativeIds, previousIds, draftIds) {
    const result = [...nativeIds];
    for (let i = 0; i < previousIds.length; i++) {
        const id = previousIds[i];
        if (!draftIds.has(id) || result.includes(id)) continue;
        const next = previousIds.slice(i + 1).find(candidate => nativeIds.includes(candidate));
        if (next) result.splice(result.indexOf(next), 0, id);
        else {
            const previous = previousIds.slice(0, i).reverse().find(candidate => result.includes(candidate));
            result.splice(previous ? result.indexOf(previous) + 1 : result.length, 0, id);
        }
    }
    for (const id of draftIds) if (!result.includes(id)) result.push(id);
    return result;
}

// Keep every native entry, including unknown fields and disabled entries. No DOM-filtered truncation.
export function projectOrder(order, visibleIds) {
    const native = new Map(order.map(entry => [entry.identifier, entry]));
    if (native.size !== order.length || new Set(visibleIds).size !== visibleIds.length) throw new Error('排列中存在重复标识，已取消排序。');
    const projection = visibleIds.filter(id => native.has(id));
    if (projection.length !== order.length) throw new Error('排列在拖动期间发生变化，请重新拖动。');
    return projection.map(id => native.get(id));
}
