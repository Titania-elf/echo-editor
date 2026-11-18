// Layout decisions use available CSS pixels, never device or browser names.
export const DESKTOP_MIN_WIDTH = 1024;
export const DEFAULT_DIRECTORY_WIDTH = 360;
export const DIRECTORY_MIN_WIDTH = 300;
export const DIRECTORY_MAX_WIDTH = 480;
export const EDITOR_MIN_WIDTH = 560;
export const SPLITTER_WIDTH = 6;

export function normalizeLayout(value) {
    return ['auto', 'mobile', 'desktop'].includes(value) ? value : 'auto';
}

export function resolveLayout(preference, viewportWidth) {
    return normalizeLayout(preference) !== 'mobile' && viewportWidth >= DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile';
}

export function normalizeDirectoryWidth(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.max(DIRECTORY_MIN_WIDTH, Math.min(DIRECTORY_MAX_WIDTH, value)))
        : DEFAULT_DIRECTORY_WIDTH;
}

export function directoryWidthBounds(availableWidth) {
    const width = Number.isFinite(availableWidth) ? availableWidth : DESKTOP_MIN_WIDTH;
    return {
        min: DIRECTORY_MIN_WIDTH,
        max: Math.max(DIRECTORY_MIN_WIDTH, Math.min(DIRECTORY_MAX_WIDTH, width - EDITOR_MIN_WIDTH - SPLITTER_WIDTH)),
    };
}

export function fitDirectoryWidth(preferredWidth, availableWidth) {
    const { min, max } = directoryWidthBounds(availableWidth);
    return Math.round(Math.max(min, Math.min(max, normalizeDirectoryWidth(preferredWidth))));
}
