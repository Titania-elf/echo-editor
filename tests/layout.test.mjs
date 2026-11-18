import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DESKTOP_MIN_WIDTH, DEFAULT_DIRECTORY_WIDTH, EDITOR_MIN_WIDTH, SPLITTER_WIDTH,
    normalizeLayout, resolveLayout, normalizeDirectoryWidth, directoryWidthBounds, fitDirectoryWidth,
} from '../layout.js';

test('automatic layout changes at the available-width breakpoint', () => {
    for (const width of [350, 390, 760, DESKTOP_MIN_WIDTH - 1]) assert.equal(resolveLayout('auto', width), 'mobile');
    for (const width of [DESKTOP_MIN_WIDTH, 1366, 1920]) assert.equal(resolveLayout('auto', width), 'desktop');
});

test('a wide viewport can keep the original mobile layout', () => {
    assert.equal(resolveLayout('mobile', 1920), 'mobile');
});

test('an explicit desktop preference still protects narrow windows', () => {
    assert.equal(resolveLayout('desktop', 390), 'mobile');
    assert.equal(resolveLayout('desktop', 1023), 'mobile');
    assert.equal(resolveLayout('desktop', 1024), 'desktop');
    // The stored preference is untouched, so widening restores the desktop layout.
    assert.equal(resolveLayout('desktop', 1366), 'desktop');
});

test('unknown layout preferences fall back to automatic', () => {
    for (const value of [undefined, null, 'invalid', {}, 1]) {
        assert.equal(normalizeLayout(value), 'auto');
        assert.equal(resolveLayout(value, 1366), 'desktop');
    }
});

test('directory widths accept only finite numbers and stay bounded', () => {
    for (const value of [undefined, null, '', '400', NaN, Infinity, {}, []]) {
        assert.equal(normalizeDirectoryWidth(value), DEFAULT_DIRECTORY_WIDTH);
    }
    assert.equal(normalizeDirectoryWidth(100), 300);
    assert.equal(normalizeDirectoryWidth(900), 480);
    assert.equal(normalizeDirectoryWidth(360.7), 361);
});

test('directory resizing always reserves room for the editor', () => {
    for (const width of [1022, 1024, 1100, 1366, 1600]) {
        const bounds = directoryWidthBounds(width);
        assert.equal(bounds.min, 300);
        assert.ok(bounds.max <= 480);
        assert.ok(width - fitDirectoryWidth(480, width) - SPLITTER_WIDTH >= EDITOR_MIN_WIDTH);
    }
});

test('window resizing fits a saved width without changing the preference', () => {
    const preferred = 480;
    assert.equal(fitDirectoryWidth(preferred, 1024), 458);
    assert.equal(fitDirectoryWidth(preferred, 1366), preferred);
    assert.equal(preferred, 480);
    assert.deepEqual(directoryWidthBounds(390), { min: 300, max: 300 });
    assert.equal(fitDirectoryWidth(undefined, 1366), DEFAULT_DIRECTORY_WIDTH);
});
