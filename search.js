// Search and replacement share literal matching; query characters never become regex syntax.
export function literalSearchPattern(query, { caseSensitive=false, all=false } = {}) {
    const needle=String(query ?? '').trim();
    if (!needle) return null;
    const pattern=needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(pattern,`${all?'g':''}${caseSensitive?'':'i'}u`);
}
export function textMatch(text, query) {
    const match=literalSearchPattern(query)?.exec(String(text ?? ''));
    return match ? { start:match.index, end:match.index + match[0].length } : null;
}

export function matchSnippet(text, range, context = 32) {
    if (!range) return null;
    const source = String(text ?? '');
    const start = Math.max(0, range.start - context), end = Math.min(source.length, range.end + context);
    const clean = value => value.replace(/\s+/gu, ' ');
    return {
        before:clean(source.slice(start, range.start)), match:clean(source.slice(range.start, range.end)),
        after:clean(source.slice(range.end, end)), leading:start > 0, trailing:end < source.length,
    };
}

export function searchEntries(entries, query, { titleOnly = false } = {}) {
    const searching = Boolean(String(query ?? '').trim()), matches = new Map();
    for (const entry of entries) {
        const titleMatch = searching ? textMatch(entry.name, query) : null;
        const contentMatch = searching && !titleOnly ? textMatch(entry.content, query) : null;
        if (!searching || titleMatch || contentMatch) {
            matches.set(entry.id, { titleMatch, contentMatch, snippet:matchSnippet(entry.content, contentMatch) });
        }
    }
    return matches;
}
