const WRAPPERS = [
    ['【', '】'], ['[', ']'], ['（', '）'], ['(', ')'], ['{', '}'],
    ['「', '」'], ['『', '』'], ['《', '》'], ['〈', '〉'], ['〔', '〕'], ['〖', '〗'],
    ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"],
];
const DECORATION = /^[✦✧★☆◆◇●○■□▲△▼▽※•═─━—–=_*~\-]$/u;
const TEXT = /[\p{L}\p{N}]/u;
const isId = value => typeof value === 'string' && value.length > 0;

// Peel balanced outer wrappers/ornaments, never a catch-all punctuation class.
function trimOuter(value) {
    let name = value.trim();
    while (name) {
        const wrapper = WRAPPERS.find(([left, right]) => name.length >= left.length + right.length && name.startsWith(left) && name.endsWith(right));
        if (wrapper) {
            name = name.slice(wrapper[0].length, -wrapper[1].length).trim();
            continue;
        }
        if (DECORATION.test(name[0]) && DECORATION.test(name[name.length - 1])) {
            name = name.slice(1, -1).trim();
            continue;
        }
        break;
    }
    return name;
}

function parsedName(value, kind) {
    const name = trimOuter(value);
    // Keys are case-sensitive; interior punctuation, whitespace and Unicode stay exact.
    return TEXT.test(name) ? { key: name, name, kind } : null;
}

export function parseGroupName(name) {
    if (typeof name !== 'string') return null;
    const title = trimOuter(name);
    // Angle boundaries are directional, not generic wrapping punctuation.
    const angle = title.match(/^<(\/?)([^<>]*)>$/u);
    if (angle) return parsedName(angle[2], angle[1] ? 'close' : 'open');
    const chinese = title.match(/^([\s\S]*)(开始|结束)$/u);
    if (chinese) return parsedName(chinese[1], chinese[2] === '开始' ? 'open' : 'close');
    // English direction words must be separate trailing words, not suffixes of words.
    const english = title.match(/^([\s\S]*?)\s+(start|end)$/iu);
    if (english) return parsedName(english[1], english[2].toLowerCase() === 'start' ? 'open' : 'close');
    return parsedName(title, 'same');
}

const definition = (start, end) => ({ id: start.id, startId: start.id, endId: end.id, name: start.name });

export function detectGroups(entries) {
    const markers = [], byKey = new Map(), definitions = [], issues = [], mixed = new Set();
    for (const entry of entries) {
        const parsed = parseGroupName(entry?.name);
        if (!parsed) continue;
        const marker = { ...parsed, id: entry.id };
        markers.push(marker);
        if (!byKey.has(marker.key)) byKey.set(marker.key, []);
        byKey.get(marker.key).push(marker);
    }
    for (const [key, matches] of byKey) {
        const same = matches.filter(marker => marker.kind === 'same');
        if (same.length && same.length !== matches.length) {
            mixed.add(key);
            issues.push({ name: matches[0].name, message: 'Mixed explicit and identical-name boundaries; no group inferred for this name.', ids: matches.map(marker => marker.id) });
        }
        if (same.length > 2) {
            issues.push({ name: same[0].name, message: 'Ambiguous identical-name boundaries (more than two occurrences); no pair selected.', ids: same.map(marker => marker.id) });
        } else if (same.length === 2 && !mixed.has(key)) {
            definitions.push(definition(same[0], same[1]));
        }
        // A singleton ordinary title is not evidence of an unfinished group.
    }

    const stack = [];
    for (const marker of markers) {
        if (marker.kind === 'same') continue;
        if (marker.kind === 'open') {
            stack.push({ ...marker, crossed: false });
            continue;
        }
        let matching = stack.length - 1;
        while (matching >= 0 && stack[matching].key !== marker.key) matching--;
        if (matching < 0) {
            issues.push({ name: marker.name, message: 'Closing boundary has no matching preceding opening boundary (missing or reversed).', ids: [marker.id] });
            continue;
        }
        const open = stack[matching];
        if (matching !== stack.length - 1) {
            const crossed = stack.slice(matching);
            for (const boundary of crossed) boundary.crossed = true;
            issues.push({ name: marker.name, message: 'Crossing explicit boundaries; affected groups omitted.', ids: [...crossed.map(boundary => boundary.id), marker.id] });
            // Keep intervening opens to consume their own closes, not an older same-key open.
            stack.splice(matching, 1);
            continue;
        }
        stack.pop();
        if (!open.crossed && !mixed.has(marker.key)) definitions.push(definition(open, marker));
    }
    for (const open of stack) {
        issues.push({ name: open.name, message: 'Opening boundary is missing a closing boundary.', ids: [open.id] });
    }

    // Apply the same noncrossing/unique-endpoint rules to both marker syntaxes together.
    const { groups, invalid } = resolveGroups(entries.map(entry => entry?.id), definitions);
    for (const { group, reason } of invalid) {
        issues.push({ name: group.name, message: reason, startId: group.startId, endId: group.endId });
    }
    return { groups: groups.map(({ id, startId, endId, name }) => ({ id, startId, endId, name })), issues };
}

function addOwner(owners, id, record) {
    if (!isId(id)) return;
    if (!owners.has(id)) owners.set(id, []);
    owners.get(id).push(record);
}

export function resolveGroups(ids, definitions) {
    const groups = [], tree = [], invalid = [];
    if (!Array.isArray(definitions)) {
        return { groups, tree: ids.map(id => ({ type: 'entry', id })), invalid: [{ group: definitions, reason: 'malformed definitions list' }] };
    }
    const positions = new Map(ids.map((id, index) => [id, index]));
    const records = Array.from(definitions, group => {
        const record = { group, reasons: new Set() };
        if (!group || typeof group !== 'object' || Array.isArray(group)) {
            record.reasons.add('malformed definition');
            return record;
        }
        if (!isId(group.id) || !isId(group.startId) || !isId(group.endId) || typeof group.name !== 'string') record.reasons.add('malformed definition');
        if (isId(group.startId) && isId(group.endId)) {
            record.startIndex = positions.get(group.startId);
            record.endIndex = positions.get(group.endId);
            if (record.startIndex === undefined || record.endIndex === undefined) record.reasons.add('missing endpoints');
            else if (record.startIndex >= record.endIndex) record.reasons.add('reversed boundaries');
        }
        return record;
    });

    const groupIds = new Map(), boundaries = new Map();
    for (const record of records) {
        const group = record.group;
        if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
        addOwner(groupIds, group.id, record);
        for (const id of new Set([group.startId, group.endId])) addOwner(boundaries, id, record);
    }
    // Conflicts reject every owner, even if one record also has other invalid metadata.
    for (const [owners, reason] of [[groupIds, 'duplicate group ID'], [boundaries, 'reused boundary']]) {
        for (const matches of owners.values()) {
            if (matches.length > 1) for (const record of matches) record.reasons.add(reason);
        }
    }
    const ordered = records.filter(record => record.startIndex < record.endIndex).sort((a, b) => a.startIndex - b.startIndex);
    for (let i = 0; i < ordered.length; i++) {
        for (let j = i + 1; j < ordered.length; j++) {
            const left = ordered[i], right = ordered[j];
            if (right.startIndex >= left.endIndex) break;
            if (left.startIndex < right.startIndex && left.endIndex < right.endIndex) {
                left.reasons.add('crossing boundaries');
                right.reasons.add('crossing boundaries');
            }
        }
    }
    for (const record of records) {
        if (record.reasons.size) invalid.push({ group: record.group, reason: [...record.reasons].join('; ') });
    }
    for (const record of ordered) {
        if (record.reasons.size) continue;
        const { startIndex, endIndex } = record;
        groups.push({ ...record.group, startIndex, endIndex, ids: ids.slice(startIndex, endIndex + 1), contentIds: ids.slice(startIndex + 1, endIndex), parentId: null });
    }

    // Build iteratively so deeply nested saved groups do not consume the call stack.
    const byStart = new Map(groups.map(group => [group.startIndex, group]));
    const stack = [{ group: null, children: tree }];
    for (let index = 0; index < ids.length; index++) {
        const parent = stack[stack.length - 1];
        if (parent.group && index === parent.group.endIndex) {
            stack.pop();
            continue;
        }
        const group = byStart.get(index);
        if (group) {
            group.parentId = parent.group ? parent.group.id : null;
            const children = [];
            parent.children.push({ type: 'group', group, children });
            stack.push({ group, children });
        } else {
            parent.children.push({ type: 'entry', id: ids[index] });
        }
    }
    return { groups, tree, invalid };
}
