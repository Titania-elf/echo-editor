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

// Preflight the entire batch before changing any enabled flags.
export function planEnabledChange(order, ids, enabled, canToggle = () => true) {
    if (typeof enabled !== 'boolean') throw new Error('启停目标必须是明确的开关状态。');
    const entries = new Map(order.map(entry => [entry.identifier, entry]));
    if (entries.size !== order.length || new Set(ids).size !== ids.length) throw new Error('条目标识重复，已取消批量启停。');
    const changes = [], skipped = [];
    for (const id of ids) {
        const entry = entries.get(id);
        if (!entry) throw new Error('分组中的条目已移出排列，请重新检查分组。');
        if (!canToggle(id)) skipped.push(id);
        else if (Boolean(entry.enabled) !== enabled) changes.push({ entry, enabled });
    }
    return { changes, skipped };
}

// Preflight deletion from the shared prompt library and every character order.
// Keep the native arrays/objects intact; the adapter applies only these splices.
export function planPromptDeletion(prompts, buckets, id, canDelete = () => true) {
    if (typeof id !== 'string' || !id || !Array.isArray(prompts) || !Array.isArray(buckets)) {
        throw new Error('条目或排列数据无效，已取消删除。');
    }
    const matches = prompts.flatMap((prompt, index) => prompt?.identifier === id ? [index] : []);
    if (matches.length !== 1) throw new Error(matches.length ? '条目标识重复，已取消删除。' : '条目已不存在，请刷新目录后重试。');
    const index = matches[0], prompt = prompts[index];
    if (prompt.system_prompt !== false || !canDelete(prompt)) throw new Error('原生编辑器不允许删除这个内置或受限条目。');
    const references = [];
    for (const bucket of buckets) {
        if (!bucket || !Array.isArray(bucket.order)) throw new Error('角色排列数据无效，已取消删除。');
        const indices = bucket.order.flatMap((entry, position) => entry?.identifier === id ? [position] : []);
        if (indices.length) references.push({ order: bucket.order, indices });
    }
    return { index, prompt, references };
}
