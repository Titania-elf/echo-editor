#!/usr/bin/env python3
"""Offline UI regression using real extension modules and a fixed native host.

Preparation only:
    python -I -B tests/ui-layout.spec.py --smoke --baseline-ref HEAD
Full regression after the layout implementation is ready:
    python -I -B tests/ui-layout.spec.py --baseline-ref HEAD

No server, npm dependency, real settings, git checkout, or network fallback.
--baseline-ref reads committed sources with git show, not the working tree.
Screenshots stay under the project's ignored test-results/ directory.
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import subprocess
import sys
import traceback
import zlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable
from urllib.parse import unquote, urlsplit

from playwright.sync_api import Browser, Error as PlaywrightError, Page, Route, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
ORIGIN = "http://pmme.test"
PREFIX = "/scripts/extensions/third-party/ui-layout-fixture/"
PRESET = "UI Layout Fixture"
MOBILES = ((390, 844), (760, 900))
DESKTOPS = ((1024, 900), (1366, 900), (1920, 1080), (1024, 600), (1366, 768))
CORE_MODULES = {"index.js", "adapter.js", "model.js", "groups.js", "search.js", "drag-sort.js", "save-queue.js", "style.css", "settings.html"}
CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; base-uri 'none'; form-action 'none'"
NATIVE_MODULES = {
    "/scripts/extensions.js": "export function getContext() { return globalThis.__pmmeFixture.context; }",
    "/script.js": "export function saveSettings() { return globalThis.__pmmeFixture.saveSettings(); } export async function doNavbarIconClick() { globalThis.__pmmeFixture.openDrawer(); }",
    "/scripts/openai.js": """
        const fixture = globalThis.__pmmeFixture;
        export const promptManager = fixture.manager;
        export const oai_settings = fixture.serviceSettings;
        export const openai_settings = fixture.savedPresets;
        export const openai_setting_names = fixture.presetNames;
        export const settingsToUpdate = {
            temperature:['','temp_openai',false,false],
            prompts:['','prompts',false,false], prompt_order:['','prompt_order',false,false],
            extensions:['','extensions',false,false],
            chat_completion_source:['','chat_completion_source',false,true],
            custom_model:['','custom_model',false,true],
        };
        export function getChatCompletionPreset(settings) {
            return structuredClone(Object.fromEntries(Object.entries(settingsToUpdate).map(([key,[,setting]]) => [key,settings[setting]])));
        }
    """,
}
DIR_SELECTORS = (".pmme-frame", "#pmme-directory-view", ".pmme-topbar", ".pmme-preset", "#pmme-directory-search", ".pmme-toolbar", ".pmme-caption", "#pmme-scroll", "#pmme-row-intro", "#pmme-row-intro .pmme-item-main")
INLINE_SELECTORS = DIR_SELECTORS + ("#pmme-editor", ".pmme-editor-meta", "#pmme-name", "#pmme-role", "#pmme-body-field", "#pmme-content", "#pmme-advanced", ".pmme-editor-footer", "#pmme-save")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


class Sources:
    """Snapshot only the entry, stylesheet, template, and relative JS imports."""

    def __init__(self, ref: str | None = None):
        self.commit = None
        if ref:
            self.commit = self.git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").strip()
        self.label = f"baseline-{self.commit[:10]}" if self.commit else "current"
        self.files: dict[str, str] = {}
        pending = ["index.js", "style.css", "settings.html"]
        while pending:
            name = pending.pop()
            if name in self.files:
                continue
            require(PurePosixPath(name).name == name and name.endswith((".js", ".css", ".html")), f"Unexpected module path: {name}")
            content = self.git("show", f"{self.commit}:{name}") if self.commit else (ROOT / name).read_text(encoding="utf-8")
            self.files[name] = content
            if name.endswith(".js"):
                for dependency in re.findall(r"(?:from\s*|import\s*)['\"](\./[^'\"]+)['\"]", content):
                    path = PurePosixPath(dependency)
                    require(len(path.parts) == 1 and path.suffix == ".js", f"Unexpected relative dependency: {dependency}")
                    pending.append(path.name)

    @staticmethod
    def git(*args: str) -> str:
        result = subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
        return result.stdout.decode("utf-8")


class Fixture:
    """Every browser request is fulfilled or blocked; nothing calls continue_."""

    def __init__(self, browser: Browser, sources: Sources, width: int, height: int, output: Path, screenshots: list[Path]):
        self.browser, self.sources = browser, sources
        self.width, self.height, self.output = width, height, output
        self.screenshots = screenshots
        self.context = None
        self.page: Page | None = None
        self.errors: list[str] = []
        self.expected_http_failures: set[str] = set()
        self.loaded: set[str] = set()
        self.saves: list[dict] = []
        self.seed: dict = {}
        self.html = (FIXTURES / "ui-layout.html").read_text(encoding="utf-8")
        self.host_js = (FIXTURES / "ui-layout-context.js").read_text(encoding="utf-8")

    def console_message(self, message) -> None:
        if message.type != "error":
            return
        # Only intentional 503 injections at the test's exact save endpoint are expected.
        if message.location.get("url") in self.expected_http_failures and message.text.startswith("Failed to load resource:") and "status of 503" in message.text:
            return
        self.errors.append(f"Console error: {message.text}")

    def route(self, route: Route) -> None:
        request = route.request
        parsed = urlsplit(request.url)
        path = unquote(parsed.path)
        if f"{parsed.scheme}://{parsed.netloc}" != ORIGIN:
            self.errors.append(f"Blocked non-fixture request: {request.method} {request.url}")
            route.abort("blockedbyclient")
            return
        if path == "/" and request.method == "GET":
            route.fulfill(status=200, body=self.html, headers={"Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP, "Cache-Control": "no-store"})
        elif path == "/fixtures/ui-layout-context.js" and request.method == "GET":
            route.fulfill(status=200, body=self.host_js, content_type="text/javascript; charset=utf-8")
        elif path == "/fixtures/ui-layout-seed.json" and request.method == "GET":
            route.fulfill(status=200, body=json.dumps(self.seed, ensure_ascii=False), content_type="application/json")
        elif path in NATIVE_MODULES and request.method == "GET":
            route.fulfill(status=200, body=NATIVE_MODULES[path], content_type="text/javascript; charset=utf-8")
        elif path.startswith(PREFIX) and path[len(PREFIX):] in self.sources.files and request.method == "GET":
            name = path[len(PREFIX):]
            self.loaded.add(name)
            content_type = "text/css" if name.endswith(".css") else "text/html" if name.endswith(".html") else "text/javascript"
            route.fulfill(status=200, body=self.sources.files[name], content_type=f"{content_type}; charset=utf-8")
        elif path in ("/api/settings/save", "/api/presets/save") and request.method == "POST":
            try:
                body = json.loads(request.post_data or "")
                require(isinstance(body, dict), "Save payload must be an object")
                if path == "/api/settings/save":
                    require("extension_settings" in body and "oai_settings" in body, "Settings save omitted fixture state")
                    self.seed["extensionSettings"] = body["extension_settings"]
                    self.seed["serviceSettings"] = body["oai_settings"]
                    kind, response = "settings", {"result": "ok"}
                else:
                    require(body.get("apiId") == "openai" and body.get("name") == PRESET and isinstance(body.get("preset"), dict), "Unexpected named preset save payload")
                    self.seed["namedPreset"] = body["preset"]
                    kind, response = "preset", {"name": PRESET}
                self.saves.append({"kind": kind, "path": path, "body": body})
                route.fulfill(status=200, body=json.dumps(response), content_type="application/json")
            except (ValueError, AssertionError) as error:
                self.errors.append(f"Invalid intercepted save: {error}")
                route.fulfill(status=400, body=json.dumps({"error": str(error)}), content_type="application/json")
        elif path == "/favicon.ico" and request.method == "GET":
            route.fulfill(status=204, body="")
        else:
            self.errors.append(f"Blocked unexpected fixture request: {request.method} {request.url}")
            route.abort("blockedbyclient")

    def __enter__(self) -> Fixture:
        mobile = self.width <= 760
        self.context = self.browser.new_context(
            viewport={"width": self.width, "height": self.height}, device_scale_factor=1,
            locale="zh-CN", timezone_id="UTC", color_scheme="light", reduced_motion="reduce",
            has_touch=mobile, is_mobile=mobile, service_workers="block", accept_downloads=False,
        )
        # Context coverage also blocks requests from any accidentally opened page.
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.route("**/*", self.route)
        self.page.on("pageerror", lambda error: self.errors.append(f"Browser error: {error}"))
        self.page.on("console", self.console_message)
        self.page.on("dialog", lambda dialog: dialog.accept() if dialog.type == "beforeunload" else dialog.dismiss())
        self.page.set_default_timeout(5000)
        self.page.set_default_navigation_timeout(12000)
        try:
            self.boot()
        except Exception:
            self.close()
            raise
        return self

    def boot(self) -> None:
        self.page.goto(ORIGIN + "/", wait_until="networkidle")
        self.page.wait_for_function("document.documentElement.dataset.fixtureReady === 'true' || Boolean(globalThis.__pmmeFixtureBootError)")
        error = self.page.evaluate("globalThis.__pmmeFixtureBootError || null")
        require(not error, f"Fixture boot failed: {error}")
        expect(self.page.locator("#pmme-open")).to_be_visible()
        expect(self.page.locator("#pmme-setting-open")).to_have_count(1)
        self.open()

    def open(self) -> None:
        self.page.locator("#pmme-open").click()
        expect(self.page.locator("#pmme-root")).to_be_visible()
        self.settle()

    def settle(self) -> None:
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        self.page.wait_for_function("globalThis.__pmmeFixture.pendingSettingsSaves === 0")
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")

    def screenshot(self, name: str, selector: str | None = None) -> Path:
        path = self.output / self.sources.label / f"{name}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        if selector:
            self.page.locator(selector).screenshot(path=str(path), animations="disabled", caret="hide")
        else:
            self.page.screenshot(path=str(path), animations="disabled", caret="hide", full_page=False)
        self.screenshots.append(path.resolve())
        return path

    def assert_clean(self) -> None:
        self.settle()
        require(not self.errors, "\n".join(self.errors))
        expected = CORE_MODULES | {name for name in ("history.js", "replace.js") if name in self.sources.files}
        require(expected <= self.loaded, f"Real modules not loaded: {sorted(expected - self.loaded)}")

    def close(self) -> None:
        if self.context:
            self.context.close()
            self.context = None

    def __exit__(self, *_args) -> None:
        self.close()


def one_editor(fixture: Fixture) -> None:
    expect(fixture.page.locator("#pmme-editor")).to_have_count(1)
    expect(fixture.page.locator("#pmme-content")).to_have_count(1)


def select_entry(fixture: Fixture, identifier: str) -> None:
    fixture.page.locator(f'[data-pmme-select="{identifier}"]').click()
    fixture.settle()
    expect(fixture.page.locator("#pmme-editor")).to_have_attribute("data-entry-id", identifier)
    expect(fixture.page.locator("#pmme-content")).to_be_visible()
    one_editor(fixture)


def editor_in(fixture: Fixture, selector: str) -> None:
    require(fixture.page.locator(selector).evaluate("element => element.contains(document.getElementById('pmme-editor'))"), f"The sole editor is not in {selector}")
    one_editor(fixture)


def no_overflow(fixture: Fixture) -> None:
    overflowing = fixture.page.evaluate("""() => {
        const selectors = ['html', 'body', '#pmme-root', '.pmme-frame', '#pmme-directory-view', '#pmme-scroll', '#pmme-detail-pane', '#pmme-editor', '.pmme-sheet', '#pmme-sheet-body', '#pmme-replace-preview', '.pmme-replace-pair'];
        return selectors.flatMap(selector => {
            const element = document.querySelector(selector);
            if (!element || !element.getClientRects().length) return [];
            return element.scrollWidth > element.clientWidth + 1 ? [{selector, client:element.clientWidth, scroll:element.scrollWidth}] : [];
        });
    }""")
    require(not overflowing, f"Horizontal overflow: {overflowing}")


def layout(fixture: Fixture, expected: str) -> None:
    expect(fixture.page.locator("#pmme-root")).to_have_attribute("data-pmme-layout", expected)
    one_editor(fixture)
    no_overflow(fixture)


def wide(fixture: Fixture, expected: bool) -> None:
    actual = fixture.page.locator("#pmme-root").evaluate("element => element.hasAttribute('data-pmme-wide') && element.getAttribute('data-pmme-wide') !== 'false'")
    require(actual == expected, f"data-pmme-wide={actual}; expected {expected}")


def box(fixture: Fixture, selector: str) -> dict:
    bounds = fixture.page.locator(selector).bounding_box()
    require(bounds is not None, f"Missing visible bounds: {selector}")
    return bounds


def visible_inside(fixture: Fixture, selector: str, container: str = "#pmme-root") -> None:
    expect(fixture.page.locator(selector)).to_be_visible()
    bounds, parent = box(fixture, selector), box(fixture, container)
    require(bounds["x"] >= parent["x"] - 1 and bounds["y"] >= parent["y"] - 1 and bounds["x"] + bounds["width"] <= parent["x"] + parent["width"] + 1 and bounds["y"] + bounds["height"] <= parent["y"] + parent["height"] + 1, f"{selector} is clipped by {container}: {bounds} / {parent}")
    require(fixture.page.locator(selector).evaluate("""element => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === element || element.contains(hit);
    }"""), f"{selector} is covered at its center")


def geometry(fixture: Fixture, selectors: tuple[str, ...]) -> dict:
    return fixture.page.evaluate("""selectors => Object.fromEntries(selectors.map(selector => {
        const element = document.querySelector(selector);
        if (!element) return [selector, null];
        const r = element.getBoundingClientRect();
        return [selector, {x:r.x, y:r.y, width:r.width, height:r.height, clientWidth:element.clientWidth, clientHeight:element.clientHeight, scrollWidth:element.scrollWidth, scrollHeight:element.scrollHeight}];
    }))""", list(selectors))


@dataclass
class MobileCapture:
    directory: Path
    inline: Path
    directory_geometry: dict
    inline_geometry: dict


def capture_mobile(fixture: Fixture) -> MobileCapture:
    """Same actions and selectors for committed and working-tree sources."""
    fixture.page.locator("#pmme-scroll").evaluate("element => { element.scrollTop = 0; }")
    fixture.settle()
    directory = fixture.screenshot(f"mobile-{fixture.width}-directory", "#pmme-directory-view")
    directory_geometry = geometry(fixture, DIR_SELECTORS)
    select_entry(fixture, "intro")
    editor_in(fixture, "#pmme-slot-intro")
    fixture.page.locator("#pmme-scroll").evaluate("element => { element.scrollTop = 0; }")
    fixture.settle()
    inline = fixture.screenshot(f"mobile-{fixture.width}-inline", "#pmme-editor")
    inline_geometry = geometry(fixture, INLINE_SELECTORS)
    no_overflow(fixture)
    return MobileCapture(directory, inline, directory_geometry, inline_geometry)


def png_rgb(path: Path) -> tuple[int, int, bytes]:
    """Decode Chromium's noninterlaced RGB/RGBA PNGs using only stdlib."""
    data = path.read_bytes()
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"Not a PNG: {path}")
    offset, compressed = 8, bytearray()
    width = height = channels = 0
    while offset < len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        offset += length + 12
        if kind == b"IHDR":
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            require(depth == 8 and color in (2, 6) and compression == filtering == interlace == 0, f"Unsupported screenshot PNG format: {path}")
            channels = 3 if color == 2 else 4
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
    raw, stride, output = zlib.decompress(compressed), width * channels, bytearray()
    previous, cursor = bytearray(stride), 0
    require(len(raw) == (stride + 1) * height, f"Invalid screenshot data: {path}")
    for _ in range(height):
        filtering = raw[cursor]
        row = bytearray(raw[cursor + 1:cursor + 1 + stride])
        cursor += stride + 1
        require(filtering in range(5), f"Invalid PNG filter: {filtering}")
        for index in range(stride):
            left = row[index - channels] if index >= channels else 0
            up = previous[index]
            upper_left = previous[index - channels] if index >= channels else 0
            if filtering == 1:
                predictor = left
            elif filtering == 2:
                predictor = up
            elif filtering == 3:
                predictor = (left + up) // 2
            elif filtering == 4:
                base = left + up - upper_left
                distances = (abs(base - left), abs(base - up), abs(base - upper_left))
                predictor = (left, up, upper_left)[distances.index(min(distances))]
            else:
                predictor = 0
            row[index] = (row[index] + predictor) & 255
        if channels == 3:
            output.extend(row)
        else:
            for index in range(0, stride, 4):
                require(row[index + 3] == 255, "Screenshot comparison requires opaque backgrounds")
                output.extend(row[index:index + 3])
        previous = row
    return width, height, bytes(output)


def compare_mobile(current: MobileCapture, baseline: MobileCapture, pixel_threshold: float) -> None:
    for name, actual, expected in (("directory", current.directory_geometry, baseline.directory_geometry), ("inline", current.inline_geometry, baseline.inline_geometry)):
        require(actual.keys() == expected.keys(), f"Mobile {name} geometry selector mismatch")
        differences = []
        for selector in expected:
            require(actual[selector] is not None and expected[selector] is not None, f"Missing mobile {name} geometry: {selector}")
            for field, old in expected[selector].items():
                new = actual[selector][field]
                if abs(new - old) > 1:
                    differences.append(f"{selector}.{field}: {old:.2f} -> {new:.2f}")
        require(not differences, f"Mobile {name} geometry changed (>1px): {'; '.join(differences)}")
    for name, actual_path, expected_path in (("directory", current.directory, baseline.directory), ("inline", current.inline, baseline.inline)):
        width, height, actual = png_rgb(actual_path)
        old_width, old_height, expected = png_rgb(expected_path)
        require((width, height) == (old_width, old_height), f"Mobile {name} screenshot size changed: {(old_width, old_height)} -> {(width, height)}")
        changed = sum(max(abs(actual[index + channel] - expected[index + channel]) for channel in range(3)) > 8 for index in range(0, len(actual), 3))
        ratio = changed / (width * height)
        require(ratio <= pixel_threshold, f"Mobile {name} screenshot changed: {ratio:.3%} of pixels (RGB tolerance 8; limit {pixel_threshold:.3%}). Compare {expected_path} and {actual_path}")


def long_draft(label: str) -> str:
    return "\n".join(f"{index:03d} · {label} · 这是尚未保存的本地草稿，用来检查编辑缓冲和正文滚动。" for index in range(100))


def cursor(fixture: Fixture) -> dict:
    return fixture.page.locator("#pmme-content").evaluate("element => ({value:element.value, start:element.selectionStart, end:element.selectionEnd, scroll:element.scrollTop})")


def set_draft(fixture: Fixture, label: str, start: int = 41, end: int = 57, scroll: int = 240) -> dict:
    content = fixture.page.locator("#pmme-content")
    content.fill(long_draft(label))
    content.focus()
    content.evaluate("""(element, state) => {
        element.setSelectionRange(state.start, state.end);
        element.scrollTop = state.scroll;
        element.dispatchEvent(new Event('select'));
        element.dispatchEvent(new Event('scroll'));
    }""", {"start": start, "end": end, "scroll": scroll})
    fixture.settle()
    state = cursor(fixture)
    require(state["scroll"] > 0, "Fixed long body did not become scrollable")
    return state


def retained(fixture: Fixture, expected: dict, check_scroll: bool = True) -> None:
    actual = cursor(fixture)
    require(actual["value"] == expected["value"], "Unsaved body changed or was lost")
    require((actual["start"], actual["end"]) == (expected["start"], expected["end"]), f"Caret/selection changed: {(expected['start'], expected['end'])} -> {(actual['start'], actual['end'])}")
    if check_scroll:
        require(abs(actual["scroll"] - expected["scroll"]) <= 2, f"Body scroll changed at {fixture.page.viewport_size}: {expected['scroll']} -> {actual['scroll']}")
    one_editor(fixture)


def native_state(fixture: Fixture) -> dict:
    return fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.serviceSettings)")


def native_order(settings: dict) -> list[dict]:
    return settings["prompt_order"][0]["order"]


def native_prompt(settings: dict, identifier: str) -> dict:
    return next(item for item in settings["prompts"] if item["identifier"] == identifier)


def choose_layout(fixture: Fixture, mode: str, settings: bool = False) -> None:
    if settings:
        fixture.page.locator("#pmme-close").click()
        expect(fixture.page.locator("#pmme-root")).to_be_hidden()
        fixture.page.evaluate("globalThis.__pmmeFixture.showSettings()")
        control = fixture.page.locator("#pmme-setting-layout")
        expect(control).to_be_visible()
        require(set(control.locator("option").evaluate_all("options => options.map(option => option.value)")) == {"auto", "mobile", "desktop"}, "Setting layout options do not match the contract")
        control.select_option(mode)
        fixture.settle()
        fixture.page.locator("#pmme-setting-open").click()
    else:
        fixture.page.locator("#pmme-layout-control").click()
        options = fixture.page.locator("#pmme-sheet-body button[data-pmme-layout]")
        require(set(options.evaluate_all("buttons => buttons.map(button => button.dataset.pmmeLayout)")) == {"auto", "mobile", "desktop"}, "Layout picker options do not match the contract")
        fixture.page.locator(f'#pmme-sheet-body button[data-pmme-layout="{mode}"]').click()
    fixture.settle()
    expect(fixture.page.locator("#pmme-setting-layout")).to_have_value(mode)


def check_mobile(fixture: Fixture, baseline: MobileCapture | None, pixel_threshold: float) -> None:
    layout(fixture, "mobile")
    wide(fixture, False)
    expect(fixture.page.locator("#pmme-detail-pane")).to_be_hidden()
    expect(fixture.page.locator("#pmme-splitter")).to_be_hidden()
    expect(fixture.page.locator("#pmme-desktop-new")).to_have_count(0)
    expect(fixture.page.locator("#pmme-detail-new")).to_have_count(0)
    capture = capture_mobile(fixture)
    if baseline:
        compare_mobile(capture, baseline, pixel_threshold)
    # Original mobile behavior: the same row closes the inline editor.
    fixture.page.locator('[data-pmme-select="intro"]').click()
    expect(fixture.page.locator("#pmme-content")).to_be_hidden()
    select_entry(fixture, "intro")
    editor_in(fixture, "#pmme-slot-intro")


def check_desktop(fixture: Fixture) -> None:
    layout(fixture, "desktop")
    wide(fixture, True)
    for selector in ("#pmme-detail-pane", "#pmme-splitter", "#pmme-layout-control"):
        visible_inside(fixture, selector)
    expect(fixture.page.locator("#pmme-desktop-new")).to_have_count(0)
    expect(fixture.page.locator("#pmme-detail-new")).to_have_count(0)
    directory, detail, frame = box(fixture, "#pmme-directory-pane"), box(fixture, "#pmme-detail-pane"), box(fixture, ".pmme-frame")
    require(240 <= directory["width"] <= min(560, frame["width"] * 0.55), f"Unusable desktop directory width: {directory}")
    require(detail["width"] >= 420, f"Desktop detail pane is too narrow: {detail}")
    require(detail["x"] >= directory["x"] + directory["width"] - 1 and abs(detail["y"] - directory["y"]) <= 2 and abs(detail["height"] - directory["height"]) <= 2, f"Not side-by-side full-height columns: {directory} / {detail}")
    select_entry(fixture, "intro")
    editor_in(fixture, "#pmme-detail-slot")
    body = box(fixture, "#pmme-content")
    require(body["width"] >= min(560, detail["width"] - 48), f"Desktop body width is too small: {body}")
    require(body["height"] >= max(180, fixture.height * 0.30), f"Desktop body height is too small: {body}")
    visible_inside(fixture, "#pmme-content", "#pmme-detail-pane")
    visible_inside(fixture, "#pmme-save", "#pmme-detail-pane")
    no_overflow(fixture)
    fixture.screenshot(f"desktop-{fixture.width}x{fixture.height}-geometry")
    state = set_draft(fixture, "SAME-ENTRY")
    fixture.page.locator('[data-pmme-select="intro"]').click()
    expect(fixture.page.locator("#pmme-content")).to_be_visible()
    expect(fixture.page.locator("#pmme-editor")).to_have_attribute("data-entry-id", "intro")
    retained(fixture, state)


def check_drafts(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    original = native_state(fixture)
    first = set_draft(fixture, "DRAFT-A")
    select_entry(fixture, "dialogue")
    second = set_draft(fixture, "DRAFT-B", 83, 99, 360)
    select_entry(fixture, "intro")
    retained(fixture, first)
    select_entry(fixture, "dialogue")
    retained(fixture, second)
    require(native_state(fixture) == original, "Switching entries applied unsaved drafts to native settings")
    require(all(request["kind"] == "settings" and request["body"]["oai_settings"] == original for request in fixture.saves), "Switching text drafts persisted changed native content or a named preset")
    fixture.screenshot(f"drafts-{fixture.width}")


def check_search_and_groups(fixture: Fixture) -> None:
    select_entry(fixture, "group-first")
    state = set_draft(fixture, "FILTERED-DRAFT")
    fixture.page.locator("#pmme-directory-search").fill("TAIL-ONLY-17")
    expect(fixture.page.locator("#pmme-row-group-first")).to_have_count(0)
    expect(fixture.page.locator("#pmme-row-tail-17")).to_be_visible()
    editor_in(fixture, "#pmme-detail-slot")
    retained(fixture, state)
    expect(fixture.page.locator("#pmme-content")).to_be_enabled()
    fixture.page.locator("#pmme-content").fill(state["value"] + "\nEDIT-WHILE-FILTERED")
    filtered = fixture.page.locator("#pmme-content").input_value()
    fixture.page.locator("#pmme-clear-search").click()
    fixture.page.locator('[data-pmme-fold="group-start"]').click()
    expect(fixture.page.locator('[data-pmme-fold="group-start"]')).to_have_attribute("aria-expanded", "false")
    expect(fixture.page.locator("#pmme-row-group-first")).to_be_hidden()
    expect(fixture.page.locator("#pmme-content")).to_be_visible()
    editor_in(fixture, "#pmme-detail-slot")
    fixture.page.locator("#pmme-content").fill(filtered + "\nEDIT-WHILE-FOLDED")
    expected = fixture.page.locator("#pmme-content").input_value()
    fixture.page.locator("#pmme-directory-search").fill("FIXTURE-NEEDLE-INTRO")
    expect(fixture.page.locator("#pmme-row-intro")).to_be_visible()
    fixture.page.locator("#pmme-search-titles").check()
    expect(fixture.page.locator("#pmme-row-intro")).to_have_count(0)
    fixture.page.locator("#pmme-search-titles").uncheck()
    fixture.page.locator("#pmme-directory-search").fill("DISABLED-ONLY")
    expect(fixture.page.locator("#pmme-row-disabled-note")).to_be_visible()
    expect(fixture.page.locator('[data-pmme-toggle="disabled-note"]')).to_have_attribute("aria-checked", "false")
    expect(fixture.page.locator("#pmme-content")).to_have_value(expected)
    visible_inside(fixture, "#pmme-save", "#pmme-detail-pane")
    no_overflow(fixture)
    fixture.screenshot("desktop-search-filtered-editor")
    fixture.page.locator("#pmme-clear-search").click()
    expect(fixture.page.locator('[data-pmme-fold="group-start"]')).to_have_attribute("aria-expanded", "false")
    expect(fixture.page.locator("#pmme-content")).to_have_value(expected)


def drag(fixture: Fixture, selector: str, delta: float) -> None:
    bounds = box(fixture, selector)
    x, y = bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2
    fixture.page.mouse.move(x, y)
    fixture.page.mouse.down()
    fixture.page.mouse.move(x + delta, y, steps=12)
    fixture.page.mouse.up()
    fixture.settle()


def check_organize(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    state = set_draft(fixture, "ORGANIZE-DRAFT")
    before = native_state(fixture)
    fixture.page.locator("#pmme-organize").click()
    expect(fixture.page.locator("#pmme-organize")).to_have_attribute("aria-label", "完成整理")
    editor_in(fixture, "#pmme-detail-slot")
    retained(fixture, state)
    expect(fixture.page.locator("#pmme-content")).to_be_visible()
    fixture.page.locator("#pmme-scroll").evaluate("element => { element.scrollTop = 0; }")
    handle = box(fixture, "#pmme-row-intro .pmme-drag-handle")
    target = box(fixture, "#pmme-row-dialogue")
    fixture.page.mouse.move(handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2)
    fixture.page.mouse.down()
    fixture.page.mouse.move(handle["x"] + handle["width"] / 2, target["y"] + target["height"] - 3, steps=12)
    fixture.page.mouse.up()
    fixture.page.wait_for_function("globalThis.__pmmeFixture.manager.getPromptOrderForCharacter(globalThis.__pmmeFixture.manager.activeCharacter)[0].identifier === 'dialogue'")
    fixture.settle()
    after = native_state(fixture)
    before_ids = [item["identifier"] for item in native_order(before)]
    after_ids = [item["identifier"] for item in native_order(after)]
    require(after_ids == [before_ids[1], before_ids[0], *before_ids[2:]], f"Unexpected sorted order: {after_ids}")
    require(after["prompts"] == before["prompts"], "Sorting applied or corrupted unsaved prompt contents")
    require(any(request["kind"] == "settings" for request in fixture.saves) and not any(request["kind"] == "preset" for request in fixture.saves), "Sorting did not exclusively persist settings")
    retained(fixture, state)
    visible_inside(fixture, "#pmme-save", "#pmme-detail-pane")
    fixture.screenshot("desktop-organize-editor")
    fixture.page.locator("#pmme-organize").click()
    editor_in(fixture, "#pmme-detail-slot")
    retained(fixture, state)


def check_fullscreen(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    state = set_draft(fixture, "FULLSCREEN-DRAFT")
    fixture.page.locator("#pmme-directory-search").fill("附录条目")
    fixture.page.locator("#pmme-scroll").evaluate("element => { element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight); }")
    position = fixture.page.locator("#pmme-scroll").evaluate("element => element.scrollTop")
    require(position > 50, "Fixture search results did not provide a scrollable directory")
    for iteration in range(2):
        fixture.page.locator("#pmme-detail-expand").click()
        expect(fixture.page.locator("#pmme-full-view")).to_be_visible()
        editor_in(fixture, "#pmme-full-slot")
        expect(fixture.page.locator("#pmme-content")).to_have_value(state["value"])
        expect(fixture.page.locator("#pmme-directory-search")).to_have_value("附录条目")
        if iteration == 0:
            fixture.screenshot("desktop-fullscreen")
        fixture.page.locator("#pmme-collapse").click()
        fixture.settle()
        layout(fixture, "desktop")
        editor_in(fixture, "#pmme-detail-slot")
        expect(fixture.page.locator("#pmme-directory-search")).to_have_value("附录条目")
        actual = fixture.page.locator("#pmme-scroll").evaluate("element => element.scrollTop")
        require(abs(actual - position) <= 2, f"Fullscreen lost desktop directory position: {position} -> {actual}")
        expect(fixture.page.locator("#pmme-content")).to_have_value(state["value"])
    fixture.screenshot("desktop-fullscreen-return")


def check_layout_switch(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    original = native_state(fixture)
    state = set_draft(fixture, "LAYOUT-SWITCH-DRAFT")
    choose_layout(fixture, "mobile")
    layout(fixture, "mobile")
    wide(fixture, True)
    editor_in(fixture, "#pmme-slot-intro")
    retained(fixture, state)
    choose_layout(fixture, "desktop", settings=True)
    layout(fixture, "desktop")
    editor_in(fixture, "#pmme-detail-slot")
    retained(fixture, state)
    # Even a forced desktop preference must fall back when the window is narrow.
    fixture.page.set_viewport_size({"width": 390, "height": 844})
    fixture.settle()
    layout(fixture, "mobile")
    retained(fixture, state)
    fixture.page.set_viewport_size({"width": 1366, "height": 900})
    fixture.settle()
    layout(fixture, "desktop")
    retained(fixture, state)
    choose_layout(fixture, "auto")
    for width, height, expected in ((760, 900, "mobile"), (390, 844, "mobile"), (1024, 900, "desktop"), (1366, 900, "desktop")):
        previous_layout = fixture.page.locator("#pmme-root").get_attribute("data-pmme-layout")
        fixture.page.set_viewport_size({"width": width, "height": height})
        fixture.settle()
        layout(fixture, expected)
        editor_in(fixture, "#pmme-detail-slot" if expected == "desktop" else "#pmme-slot-intro")
        # Preserve the original browser wrapping/scroll behavior when resizing
        # within one layout, particularly on mobile. Actual layout transitions
        # must retain the last stable pixel scroll as well as text and selection.
        retained(fixture, state, check_scroll=previous_layout != expected)
        state = cursor(fixture)
    require(native_state(fixture) == original, "Layout preferences applied unsaved text to native settings")
    fixture.screenshot("desktop-layout-switch-return")


def check_splitter(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    splitter = fixture.page.locator("#pmme-splitter")
    require(splitter.evaluate("element => element.tabIndex >= 0"), "Splitter is not keyboard focusable")
    initial = box(fixture, "#pmme-directory-pane")["width"]
    drag(fixture, "#pmme-splitter", 72)
    larger = box(fixture, "#pmme-directory-pane")["width"]
    require(larger > initial + 30, f"Pointer splitter did not widen directory: {initial} -> {larger}")
    splitter.focus()
    splitter.press("ArrowRight")
    fixture.settle()
    keyboard = box(fixture, "#pmme-directory-pane")["width"]
    require(keyboard > larger, "ArrowRight did not widen directory")
    splitter.press("ArrowLeft")
    fixture.settle()
    require(abs(box(fixture, "#pmme-directory-pane")["width"] - larger) <= 2, "ArrowLeft did not undo keyboard adjustment")
    # Check bounds with real pointer capture rather than setting a CSS variable.
    drag(fixture, "#pmme-splitter", 1500)
    no_overflow(fixture)
    require(box(fixture, "#pmme-detail-pane")["width"] >= 400, "Splitter allowed an unusably small right pane")
    drag(fixture, "#pmme-splitter", -1500)
    no_overflow(fixture)
    require(box(fixture, "#pmme-directory-pane")["width"] >= 220, "Splitter allowed an unusably small directory")
    current = box(fixture, "#pmme-directory-pane")["width"]
    drag(fixture, "#pmme-splitter", initial + 48 - current)
    remembered = box(fixture, "#pmme-directory-pane")["width"]
    require(abs(remembered - (initial + 48)) <= 2, "Splitter could not restore a deliberate width")
    require(any(request["kind"] == "settings" for request in fixture.saves), "Directory width was not persisted through the intercepted settings API")
    fixture.page.locator("#pmme-close").click()
    expect(fixture.page.locator("#pmme-root")).to_be_hidden()
    fixture.open()
    require(abs(box(fixture, "#pmme-directory-pane")["width"] - remembered) <= 2, "Closing and reopening lost directory width")
    fixture.settle()
    # Reload rehydrates only our in-memory intercepted save, never user settings.
    fixture.page.reload(wait_until="networkidle")
    fixture.page.wait_for_function("document.documentElement.dataset.fixtureReady === 'true' || Boolean(globalThis.__pmmeFixtureBootError)")
    require(not fixture.page.evaluate("globalThis.__pmmeFixtureBootError || null"), "Reloaded fixture failed to boot")
    fixture.open()
    require(abs(box(fixture, "#pmme-directory-pane")["width"] - remembered) <= 2, "Reload lost saved directory width")
    fixture.page.set_viewport_size({"width": 760, "height": 900})
    fixture.settle()
    layout(fixture, "mobile")
    fixture.page.set_viewport_size({"width": 1366, "height": 900})
    fixture.settle()
    layout(fixture, "desktop")
    require(abs(box(fixture, "#pmme-directory-pane")["width"] - remembered) <= 2, "Temporary mobile layout overwrote remembered desktop width")
    select_entry(fixture, "intro")
    visible_inside(fixture, "#pmme-save", "#pmme-detail-pane")
    fixture.screenshot("desktop-splitter-remembered")


def check_menu(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    desktop = fixture.width > 760
    selector = "#pmme-detail-menu" if desktop else '[data-pmme-menu="intro"]'
    anchor = box(fixture, selector)
    fixture.page.locator(selector).click()
    expect(fixture.page.locator("#pmme-sheet-layer")).to_be_visible()
    panel, root = box(fixture, ".pmme-sheet"), box(fixture, "#pmme-root")
    if desktop:
        horizontal_gap = max(panel["x"] - anchor["x"] - anchor["width"], anchor["x"] - panel["x"] - panel["width"], 0)
        vertical_gap = max(panel["y"] - anchor["y"] - anchor["height"], anchor["y"] - panel["y"] - panel["height"], 0)
        require((horizontal_gap <= 24 and vertical_gap <= 1) or (vertical_gap <= 24 and horizontal_gap <= 1), f"Desktop menu is not anchored beside or below its button: {anchor} / {panel}")
        require(panel["width"] <= 440, f"Desktop menu is still a full-width bottom sheet: {panel}")
    else:
        require(abs(panel["y"] + panel["height"] - root["y"] - root["height"]) <= 1, f"Mobile menu is not bottom anchored: {panel}")
        require(abs(panel["width"] - min(680, root["width"])) <= 1, f"Mobile bottom panel width changed: {panel}")
        expect(fixture.page.locator(".pmme-sheet-handle")).to_be_visible()
    no_overflow(fixture)
    fixture.screenshot(f"menu-{fixture.width}")
    fixture.page.keyboard.press("Escape")
    expect(fixture.page.locator("#pmme-sheet-layer")).to_be_hidden()
    expect(fixture.page.locator("#pmme-content")).to_be_visible()
    expect(fixture.page.locator(selector)).to_be_focused()
    one_editor(fixture)


def colors(fixture: Fixture, selector: str) -> dict:
    return fixture.page.locator(selector).evaluate("element => { const style = getComputedStyle(element); return {background:style.backgroundColor, color:style.color}; }")


def check_heading_typography(fixture: Fixture) -> None:
    # Native/custom themes may force a separate heading font and italic style.
    fixture.page.add_style_tag(content="h2, h3 { font-family: monospace !important; font-style: italic !important; }")
    title = fixture.page.locator(".pmme-topbar h2")
    expect(title).to_have_text("回声编辑台")
    expect(title.locator("svg")).to_have_count(1)
    expect(title.locator("svg")).to_have_attribute("aria-hidden", "true")
    require(title.locator("svg").inner_html() == fixture.page.locator("#pmme-open svg").inner_html(), "Title no longer uses the existing entry icon")
    original_font = fixture.page.evaluate("document.documentElement.style.getPropertyValue('--mainFontFamily')")
    expected_size = 16 if fixture.width <= 350 else 18
    for theme in ("paper", "night", "tavern"):
        fixture.page.locator("#pmme-theme-control").click()
        fixture.page.locator(f'#pmme-sheet-body button[data-pmme-theme="{theme}"]').click()
        for family in ('"Arial", sans-serif', '"Georgia", serif'):
            fixture.page.evaluate("family => document.documentElement.style.setProperty('--mainFontFamily', family)", family)
            fixture.settle()
            styles = fixture.page.evaluate("""() => {
                const title = document.querySelector('.pmme-topbar h2');
                const preset = document.getElementById('pmme-preset-name');
                const text = getComputedStyle(title), icon = getComputedStyle(title.querySelector('svg'));
                const presetText = getComputedStyle(preset), content = getComputedStyle(document.getElementById('pmme-content'));
                return {hostFont:getComputedStyle(document.body).fontFamily, titleFont:text.fontFamily,
                    presetFont:presetText.fontFamily, contentFont:content.fontFamily,
                    titleStyle:text.fontStyle, presetStyle:presetText.fontStyle, contentStyle:content.fontStyle,
                    titleSize:parseFloat(text.fontSize),
                    iconWidth:parseFloat(icon.width), iconHeight:parseFloat(icon.height), spacing:text.letterSpacing};
            }""")
            require(styles["titleFont"] == styles["presetFont"] == styles["contentFont"] == styles["hostFont"], f"Headings did not follow the live body font in {theme}: {styles}")
            require(styles["titleStyle"] == styles["presetStyle"] == styles["contentStyle"], f"Headings did not follow the body font style in {theme}: {styles}")
            require(styles["titleSize"] == styles["iconWidth"] == styles["iconHeight"] == expected_size, f"Title and icon sizes differ at {fixture.width}px: {styles}")
            require(styles["spacing"] == "normal", f"Title retained custom letter spacing: {styles}")
            no_overflow(fixture)
        fixture.page.evaluate("family => { if (family) document.documentElement.style.setProperty('--mainFontFamily', family); else document.documentElement.style.removeProperty('--mainFontFamily'); }", original_font)
        fixture.settle()
        fixture.screenshot(f"heading-typography-{theme}-{fixture.width}")


def check_themes(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    host = colors(fixture, "#fixture-host-input")
    seen = {}
    for theme in ("paper", "night", "tavern"):
        fixture.page.locator("#pmme-theme-control").click()
        fixture.page.locator(f'#pmme-sheet-body button[data-pmme-theme="{theme}"]').click()
        fixture.settle()
        expect(fixture.page.locator("#pmme-root")).to_have_attribute("data-pmme-theme", theme)
        expect(fixture.page.locator("#pmme-setting-theme")).to_have_value(theme)
        seen[theme] = colors(fixture, "#pmme-content")
        require(colors(fixture, "#fixture-host-input") == host, "Editor theme modified the host's field colors")
        one_editor(fixture)
        no_overflow(fixture)
        fixture.screenshot(f"theme-{theme}-{fixture.width}")
    require(seen["paper"] == {"background": "rgb(255, 253, 247)", "color": "rgb(48, 59, 62)"}, f"Paper theme lost protected local field colors: {seen['paper']}")
    require(seen["night"] == {"background": "rgb(39, 47, 57)", "color": "rgb(225, 231, 232)"}, f"Night theme lost protected local field colors: {seen['night']}")
    require(seen["tavern"]["color"] == host["color"], f"Tavern theme did not inherit native text colors: {seen['tavern']}")
    fixture.page.evaluate("document.documentElement.style.setProperty('--SmartThemeBodyColor', '#f0d9bd'); document.documentElement.style.setProperty('--SmartThemeBlurTintColor', '#34302e');")
    fixture.settle()
    require(colors(fixture, "#pmme-content")["color"] == "rgb(240, 217, 189)", "Tavern theme did not follow a live host palette change")


def check_new_save(fixture: Fixture) -> None:
    before = native_state(fixture)
    select_entry(fixture, "intro")
    menu = "#pmme-detail-menu" if fixture.width > 760 else '[data-pmme-menu="intro"]'
    fixture.page.locator(menu).click()
    fixture.page.locator('[data-pmme-action="after"]').click()
    expect(fixture.page.locator("#pmme-content")).to_be_visible()
    identifier = fixture.page.locator("#pmme-editor").get_attribute("data-entry-id")
    require(identifier and identifier.startswith("fixture-draft-"), f"New entry did not use the deterministic native ID: {identifier}")
    fixture.page.locator("#pmme-name").fill("新增回归条目")
    fixture.page.locator("#pmme-role").select_option("user")
    fixture.page.locator("#pmme-content").fill("NEW-DRAFT-LOCAL · 仅保存到拦截的固定上下文。")
    fixture.page.locator("#pmme-enable-new").check()
    require(native_state(fixture) == before, "New unsaved draft was already written to native settings")
    fixture.page.locator("#pmme-save").click()
    fixture.page.wait_for_function("id => Boolean(globalThis.__pmmeFixture.manager.getPromptById(id))", arg=identifier)
    fixture.settle()
    requests = [request for request in fixture.saves if request["kind"] == "settings"]
    require(requests and not any(request["kind"] == "preset" for request in fixture.saves), "Saving a new entry must call settings save, not named preset save")
    saved = requests[-1]["body"]["oai_settings"]
    prompt = native_prompt(saved, identifier)
    require(prompt["name"] == "新增回归条目" and prompt["role"] == "user" and prompt["content"].startswith("NEW-DRAFT-LOCAL"), f"Intercepted new-entry payload is wrong: {prompt}")
    order = native_order(saved)
    require(sum(item["identifier"] == identifier for item in order) == 1 and next(item for item in order if item["identifier"] == identifier)["enabled"] is True, "New saved entry order/enabled flag is wrong")
    require({item["identifier"] for item in order} == {item["identifier"] for item in native_order(before)} | {identifier}, "Saving a new entry lost existing native order entries")
    require(all(native_prompt(saved, item["identifier"]) == item for item in before["prompts"]), "Saving a new entry changed unrelated native prompts")
    require(not fixture.page.evaluate("id => globalThis.__pmmeFixture.savedPresets[0].prompts.some(prompt => prompt.identifier === id)", identifier), "Entry save silently changed the named preset cache")
    require(not history_state(fixture)["versions"], "Saving an entry created a full preset history version")
    one_editor(fixture)
    fixture.screenshot(f"new-entry-saved-{fixture.width}")


def check_named_update(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    before = native_state(fixture)
    save_checkpoint = len(fixture.saves)
    body = "NAMED-UPDATE-LOCAL · 未保存修改应先确认设置保存，再更新命名预设。"
    fixture.page.locator("#pmme-content").fill(body)
    require(native_state(fixture) == before and len(fixture.saves) == save_checkpoint, "Typing unexpectedly persisted native settings")
    fixture.page.locator("#pmme-update").click()
    fixture.page.locator('[data-pmme-action="update-all"]').click()
    fixture.page.wait_for_function("() => globalThis.__pmmeFixture.savedPresets[0].prompts.find(prompt => prompt.identifier === 'intro').content.startsWith('NAMED-UPDATE-LOCAL')")
    fixture.settle()
    kinds = [request["kind"] for request in fixture.saves[save_checkpoint:]]
    require(kinds.count("preset") == 1 and kinds[0] == "settings" and kinds[-1] == "settings", f"Named update must confirm entries, save the file, then persist version history: {kinds}")
    request = next(request for request in fixture.saves[save_checkpoint:] if request["kind"] == "preset")
    require(request["path"] == "/api/presets/save" and request["body"]["name"] == PRESET and request["body"]["apiId"] == "openai", "Named update used an incorrect intercepted endpoint/name")
    snapshot = request["body"]["preset"]
    require(native_prompt(snapshot, "intro")["content"] == body, "Named preset payload omitted the pending text edit")
    require(native_order(snapshot) == native_order(before), "Named update corrupted the complete native order")
    require(snapshot["temperature"] == before["temp_openai"] and snapshot["fixture_preset_field"] == before["fixture_preset_field"], "Named update lost unrelated preset parameters")
    require(native_prompt(snapshot, "intro")["fixture_unknown_field"] == {"preserved": True}, "Named update replaced unknown native prompt fields")
    require(fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])") == snapshot, "Real adapter did not refresh its named preset cache")
    history = fixture.seed["extensionSettings"]["回声编辑台"]["presetHistory"]["versions"]
    require([record["version"] for record in history] == ["初始版本", "v1.0"], "Complete save did not register the original and the new version")
    require(history[-1]["preset"] == snapshot, "Version snapshot differs from the successfully saved preset file")
    require(native_prompt(history[0]["preset"], "intro")["content"] == native_prompt(before, "intro")["content"], "Initial version was captured after overwriting the original")
    expect(fixture.page.locator("#pmme-status")).to_contain_text("一致")
    fixture.screenshot("named-preset-updated")


BATCH_QUERY = "BATCH-TOKEN"


def prepare_batch_entries(fixture: Fixture) -> None:
    fixture.page.evaluate("""() => {
        const f=globalThis.__pmmeFixture;
        const bodies={intro:'BATCH-TOKEN batch-token BATCH-TOKEN',dialogue:'BATCH-TOKEN dialogue','disabled-note':'BATCH-TOKEN disabled',chatHistory:'BATCH-TOKEN protected','unused-library':'BATCH-TOKEN library'};
        for(const [id,content] of Object.entries(bodies))f.manager.getPromptById(id).content=content;
        f.manager.getPromptById('tail-01').name='BATCH-TOKEN title-only';
        f.savedPresets[0].prompts=structuredClone(f.serviceSettings.prompts);
    }""")


def ensure_batch_entry(fixture: Fixture, identifier: str = "intro") -> None:
    if fixture.page.locator("#pmme-editor").get_attribute("data-entry-id") != identifier or not fixture.page.locator("#pmme-content").is_visible():
        select_entry(fixture, identifier)


def begin_batch(fixture: Fixture, replacement: str) -> None:
    fixture.page.locator("#pmme-directory-search").fill(BATCH_QUERY)
    expect(fixture.page.locator("#pmme-batch-replace")).to_be_visible()
    fixture.page.locator("#pmme-batch-replace").click()
    expect(fixture.page.locator("#pmme-replace-find")).to_have_value(BATCH_QUERY)
    fixture.page.locator("#pmme-replace-with").fill(replacement)


def inspect_batch_entry(fixture: Fixture, identifier: str) -> None:
    if fixture.page.locator("#pmme-sheet-layer").is_hidden():
        fixture.page.locator("#pmme-replace-review").click()
    fixture.page.locator(f'[data-pmme-action="replace-open-entry"][data-pmme-replace-entry="{identifier}"]').click()
    expect(fixture.page.locator("#pmme-editor")).to_have_attribute("data-entry-id", identifier)
    expect(fixture.page.locator("#pmme-content")).to_be_visible()


def check_batch_replace_drafts(fixture: Fixture) -> None:
    prepare_batch_entries(fixture)
    save_version(fixture, "BATCH-TOKEN batch-token BATCH-TOKEN", "v1.0", "批量替换前的固定版本")
    previous = "BATCH-TOKEN batch-token BATCH-TOKEN · prior draft"
    fixture.page.locator("#pmme-content").fill(previous)
    fixture.page.locator("#pmme-name").fill("Prior edited title")
    fixture.page.locator("#pmme-role").select_option("assistant")
    before, history = native_state(fixture), history_state(fixture)
    named = fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])")
    checkpoint = len(fixture.saves)
    replacement = '$& $1 ' + chr(92) + 'literal\n新正文'
    begin_batch(fixture, replacement)
    expect(fixture.page.locator(".pmme-replace-candidate")).to_have_count(3)
    expect(fixture.page.locator("#pmme-replace-summary")).to_contain_text("5 处")
    expect(fixture.page.locator("#pmme-replace-skipped")).to_contain_text("正文不能替换")
    expect(fixture.page.locator('[data-pmme-replace-id="tail-01"]')).to_have_count(0)
    expect(fixture.page.locator('[data-pmme-replace-id="unused-library"]')).to_have_count(0)
    fixture.page.keyboard.press("Escape")
    expect(fixture.page.locator("#pmme-content")).to_have_value(previous)
    require(native_state(fixture) == before and len(fixture.saves) == checkpoint, "Cancelling preview altered or persisted a draft")
    begin_batch(fixture, replacement)
    fixture.page.locator('[data-pmme-replace-id="dialogue"]').uncheck()
    expect(fixture.page.locator("#pmme-replace-summary")).to_contain_text("2 个条目")
    expect(fixture.page.locator("#pmme-replace-summary")).to_contain_text("4 处")
    require(native_state(fixture) == before and len(fixture.saves) == checkpoint, "Preview/selection wrote native content or saved settings")
    no_overflow(fixture)
    fixture.screenshot(f"batch-replace-preview-{fixture.width}")
    fixture.page.locator("#pmme-replace-apply").click()
    expect(fixture.page.locator("#pmme-sheet-title")).to_have_text("批量替换结果")
    require(native_state(fixture) == before and history_state(fixture) == history, "Staged replacement modified native settings or history")
    require(fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])") == named and len(fixture.saves) == checkpoint, "Replacement silently saved a named preset or settings")
    inspect_batch_entry(fixture, "intro")
    expected = re.sub(re.escape(BATCH_QUERY), lambda _: replacement, previous, flags=re.IGNORECASE)
    expect(fixture.page.locator("#pmme-content")).to_have_value(expected)
    expect(fixture.page.locator("#pmme-name")).to_have_value("Prior edited title")
    expect(fixture.page.locator("#pmme-role")).to_have_value("assistant")
    expect(fixture.page.locator("#pmme-editor-status" if fixture.width > 760 else "#pmme-dirty-intro")).to_contain_text("修改" if fixture.width > 760 else "有修改")
    fixture.page.locator("#pmme-replace-review").click()
    fixture.page.locator('[data-pmme-action="replace-undo"]').click()
    inspect_batch_entry(fixture, "intro")
    expect(fixture.page.locator("#pmme-content")).to_have_value(previous)
    expect(fixture.page.locator("#pmme-name")).to_have_value("Prior edited title")
    expect(fixture.page.locator("#pmme-role")).to_have_value("assistant")
    require(native_state(fixture) == before and history_state(fixture) == history and len(fixture.saves) == checkpoint, "Undo saved content or discarded unrelated prior edits")
    no_overflow(fixture)
    fixture.screenshot(f"batch-replace-undone-{fixture.width}")


def check_batch_replace_deletion(fixture: Fixture) -> None:
    prepare_batch_entries(fixture)
    ensure_batch_entry(fixture)
    before = native_state(fixture)
    fixture.page.locator("#pmme-directory-search").fill(BATCH_QUERY)
    fixture.page.locator("#pmme-search-titles").check()
    expect(fixture.page.locator("#pmme-batch-replace")).to_be_disabled()
    expect(fixture.page.locator("#pmme-replace-match-count")).to_contain_text("仅标题")
    fixture.page.locator("#pmme-search-titles").uncheck()
    fixture.page.locator("#pmme-batch-replace").click()
    expect(fixture.page.locator("#pmme-replace-apply")).to_be_disabled()
    fixture.page.locator("#pmme-replace-case").check()
    expect(fixture.page.locator("#pmme-replace-summary")).to_contain_text("4 处")
    fixture.page.locator("#pmme-replace-case").uncheck()
    fixture.page.locator("#pmme-replace-delete-check").check()
    fixture.page.locator('[data-pmme-replace-id="dialogue"]').uncheck()
    expect(fixture.page.locator("#pmme-replace-delete-check")).not_to_be_checked()
    expect(fixture.page.locator("#pmme-replace-apply")).to_be_disabled()
    fixture.page.locator("#pmme-replace-delete-check").check()
    fixture.page.locator("#pmme-replace-apply").click()
    inspect_batch_entry(fixture, "intro")
    expect(fixture.page.locator("#pmme-content")).to_have_value("  ")
    require(native_state(fixture) == before and not fixture.saves, "Deletion mode saved instead of staging draft content")
    fixture.page.locator("#pmme-directory-search").fill("protected")
    expect(fixture.page.locator("#pmme-batch-replace")).to_be_disabled()
    fixture.page.locator("#pmme-directory-search").fill("世界设定")
    expect(fixture.page.locator("#pmme-replace-tools")).to_be_hidden()


def check_batch_replace_new_draft(fixture: Fixture) -> None:
    prepare_batch_entries(fixture)
    ensure_batch_entry(fixture)
    menu = "#pmme-detail-menu" if fixture.width > 760 else '[data-pmme-menu="intro"]'
    fixture.page.locator(menu).click()
    fixture.page.locator('[data-pmme-action="after"]').click()
    identifier = fixture.page.locator("#pmme-editor").get_attribute("data-entry-id")
    fixture.page.locator("#pmme-name").fill("Unsaved batch draft")
    fixture.page.locator("#pmme-content").fill("BATCH-TOKEN draft")
    before = native_state(fixture)
    begin_batch(fixture, "REPLACED")
    fixture.page.locator("#pmme-replace-all").uncheck()
    fixture.page.locator(f'[data-pmme-replace-id="{identifier}"]').check()
    expect(fixture.page.locator("#pmme-replace-summary")).to_contain_text("1 个条目")
    fixture.page.locator("#pmme-replace-apply").click()
    inspect_batch_entry(fixture, identifier)
    expect(fixture.page.locator("#pmme-content")).to_have_value("REPLACED draft")
    expect(fixture.page.locator("#pmme-save")).to_have_text("保存并加入")
    require(native_state(fixture) == before and not fixture.saves, "Replacing a new draft added it to the native library/order")
    fixture.page.locator("#pmme-replace-review").click()
    fixture.page.locator('[data-pmme-action="replace-undo"]').click()
    inspect_batch_entry(fixture, identifier)
    expect(fixture.page.locator("#pmme-content")).to_have_value("BATCH-TOKEN draft")
    expect(fixture.page.locator("#pmme-save")).to_have_text("保存并加入")
    require(native_state(fixture) == before, "Undo converted a local draft into a native entry")


def check_batch_replace_stale_preview(fixture: Fixture) -> None:
    prepare_batch_entries(fixture)
    ensure_batch_entry(fixture)
    begin_batch(fixture, "FRESH")
    fixture.page.evaluate("globalThis.__pmmeFixture.manager.getPromptById('dialogue').content='EXTERNAL-CHANGE'")
    before = native_state(fixture)
    fixture.page.locator("#pmme-replace-apply").click()
    expect(fixture.page.locator("#pmme-replace-error")).to_contain_text("已变化")
    expect(fixture.page.locator("#pmme-replace-apply")).to_be_disabled()
    require(native_state(fixture) == before and not fixture.saves, "Stale preview overwrote external changes")
    fixture.page.locator('[data-pmme-action="replace-refresh"]').click()
    expect(fixture.page.locator(".pmme-replace-candidate")).to_have_count(2)
    fixture.page.locator("#pmme-replace-apply").click()
    inspect_batch_entry(fixture, "intro")
    expect(fixture.page.locator("#pmme-content")).to_have_value("FRESH FRESH FRESH")
    require(native_prompt(native_state(fixture), "dialogue")["content"] == "EXTERNAL-CHANGE", "Refreshed preview overwrote a nonmatching external body")


def check_batch_replace_stale_scope(fixture: Fixture) -> None:
    prepare_batch_entries(fixture)
    ensure_batch_entry(fixture)
    begin_batch(fixture, "NO-WRITE")
    fixture.page.evaluate("globalThis.__pmmeFixture.serviceSettings.preset_settings_openai='Another local fixture'")
    before = native_state(fixture)
    fixture.page.locator("#pmme-replace-apply").click()
    expect(fixture.page.locator("#pmme-replace-error")).to_contain_text("预设已经切换")
    require(native_state(fixture) == before and not fixture.saves, "Replacement acted on another preset scope")
    fixture.page.evaluate("globalThis.__pmmeFixture.serviceSettings.preset_settings_openai='UI Layout Fixture'")


def check_batch_replace_undo_guard(fixture: Fixture) -> None:
    prepare_batch_entries(fixture)
    ensure_batch_entry(fixture)
    before = native_state(fixture)
    begin_batch(fixture, "AFTER")
    fixture.page.locator("#pmme-replace-apply").click()
    inspect_batch_entry(fixture, "dialogue")
    fixture.page.locator("#pmme-replace-review").click()
    expect(fixture.page.locator('[data-pmme-action="replace-undo"]')).to_be_enabled()
    fixture.page.evaluate("""() => {
        const field=document.getElementById('pmme-content');field.value='MANUAL-LATER';field.dispatchEvent(new Event('input',{bubbles:true}));
    }""")
    fixture.page.locator('[data-pmme-action="replace-undo"]').click()
    expect(fixture.page.locator('[data-pmme-action="replace-undo"]')).to_be_disabled()
    inspect_batch_entry(fixture, "dialogue")
    expect(fixture.page.locator("#pmme-content")).to_have_value("MANUAL-LATER")
    fixture.page.locator("#pmme-replace-review").click()
    inspect_batch_entry(fixture, "intro")
    expect(fixture.page.locator("#pmme-content")).to_have_value("AFTER AFTER AFTER")
    require(native_state(fixture) == before and not fixture.saves, "Failed undo partially reverted or saved the batch")


def check_batch_replace_saved_undo_guard(fixture: Fixture) -> None:
    prepare_batch_entries(fixture)
    ensure_batch_entry(fixture)
    begin_batch(fixture, "SAVED")
    fixture.page.locator("#pmme-replace-apply").click()
    inspect_batch_entry(fixture, "intro")
    fixture.page.locator("#pmme-save").click()
    fixture.settle()
    fixture.page.locator("#pmme-replace-review").click()
    expect(fixture.page.locator('[data-pmme-action="replace-undo"]')).to_be_disabled()
    require(native_prompt(native_state(fixture), "intro")["content"] == "SAVED SAVED SAVED", "Saving a replaced entry lost its staged text")
    require(not history_state(fixture)["versions"], "Saving one replaced entry created a full preset version")


def check_batch_replace_complete_save(fixture: Fixture) -> None:
    prepare_batch_entries(fixture)
    saved = save_version(fixture, "BATCH-TOKEN batch-token BATCH-TOKEN", "v1.0")
    history = history_state(fixture)
    checkpoint = len(fixture.saves)
    begin_batch(fixture, "FINAL")
    fixture.page.locator("#pmme-replace-apply").click()
    require(len(fixture.saves) == checkpoint and history_state(fixture) == history, "Replacement created a version before complete saving")
    fixture.page.locator('[data-pmme-action="replace-clear-search"]').click()
    fixture.page.locator("#pmme-update").click()
    fixture.page.locator('[data-pmme-action="update-all"]').click()
    finish_operation(fixture)
    versions = history_state(fixture)["versions"]
    require([record["version"] for record in versions] == ["初始版本", "v1.0", "v1.1"], "Complete saving did not create a new distinct history version")
    require(versions[1] == saved, "Complete saving after replacement altered the old version")
    for identifier in ("intro", "dialogue", "disabled-note"):
        expected = re.sub(re.escape(BATCH_QUERY), "FINAL", native_prompt(saved["preset"], identifier)["content"], flags=re.IGNORECASE)
        require(native_prompt(versions[-1]["preset"], identifier)["content"] == expected, "Complete saving omitted a staged replacement")
    for identifier in ("chatHistory", "unused-library", "tail-01"):
        require(native_prompt(versions[-1]["preset"], identifier) == native_prompt(saved["preset"], identifier), "Replacement changed a protected, unlisted or title-only entry")
    require(versions[-1]["preset"]["prompt_order"] == saved["preset"]["prompt_order"], "Batch replacement changed entry order or enabled flags")


def history_state(fixture: Fixture) -> dict:
    return fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.extensionSettings['回声编辑台'].presetHistory)")


def finish_operation(fixture: Fixture) -> None:
    fixture.page.wait_for_function("() => !document.getElementById('pmme-root').classList.contains('pmme-busy')")
    fixture.settle()


def save_version(fixture: Fixture, body: str, version: str | None = None, note: str = "") -> dict:
    if not fixture.page.locator("#pmme-content").is_visible() or fixture.page.locator("#pmme-editor").get_attribute("data-entry-id") != "intro":
        select_entry(fixture, "intro")
    fixture.page.locator("#pmme-content").fill(body)
    fixture.page.locator("#pmme-update").click()
    suggested = fixture.page.locator("#pmme-version-number").input_value()
    if version:
        fixture.page.locator("#pmme-version-number").fill(version)
    fixture.page.locator("#pmme-version-note").fill(note)
    fixture.page.locator('[data-pmme-action="update-all"]').click()
    finish_operation(fixture)
    record = history_state(fixture)["versions"][-1]
    require(record["version"] == (version or suggested), "Saved version number differs from the confirmation form")
    require(native_prompt(record["preset"], "intro")["content"] == body, "Full version omitted the current edit")
    return record


def request_history_version(fixture: Fixture, record: dict) -> None:
    fixture.page.locator("#pmme-history").click()
    fixture.page.locator(f'[data-pmme-version-id="{record["id"]}"] [data-pmme-action="history-load"]').click()


def check_history_workflow(fixture: Fixture) -> None:
    original = fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])")
    first = save_version(fixture, "HISTORY-V1 · 第一版正文", "v1.0", "第一版：调整叙事规则")
    stored_first = json.loads(json.dumps(first))
    fixture.page.evaluate("""() => {
        const f=globalThis.__pmmeFixture;
        f.serviceSettings.temp_openai=0.31;
        f.serviceSettings.prompts.find(p=>p.identifier==='unused-library').content='LATER-LIBRARY';
        f.serviceSettings.prompt_order[0].order[0].enabled=false;
        f.serviceSettings.prompt_order.push({character_id:'history-other',foreign:17,order:[{identifier:'intro',enabled:true,extra:'later'}]});
        f.savedPresets[0].fixture_preset_field='later-unknown';
        f.savedPresets[0].later_only={introduced:true};
        f.extensionSettings['回声编辑台'].groupsByScope[JSON.stringify(['Another preset','global','fixture-character'])]=[{id:'other',name:'untouched',startId:'a',endId:'b'}];
    }""")
    fixture.page.locator("#pmme-groups").click()
    fixture.page.locator('[data-pmme-action="groups-clear"]').click()
    fixture.page.locator('[data-pmme-action="groups-clear-confirm"]').click()
    fixture.settle()
    second = save_version(fixture, "HISTORY-V2 · 第二版正文", None, "第二版：不满意的尝试")
    require(second["version"] == "v1.1", "Default version did not advance after the first save")
    require(second["preset"]["temperature"] == 0.31 and second["preset"]["later_only"] == {"introduced": True}, "Current version lost native parameter mapping or unknown file fields")
    require(history_state(fixture)["versions"][1] == stored_first, "Later edits mutated an older version")
    fixture.page.locator("#pmme-history").click()
    fixture.page.locator("#pmme-history-search").fill("第一版")
    expect(fixture.page.locator(".pmme-history-record")).to_have_count(1)
    fixture.page.locator('[data-pmme-action="history-view"]').click()
    fixture.page.locator(".pmme-history-preview summary").first.click()
    expect(fixture.page.locator(".pmme-history-preview pre").first).to_contain_text("HISTORY-V1")
    require(native_prompt(native_state(fixture), "intro")["content"].startswith("HISTORY-V2"), "Read-only preview applied the old version")
    no_overflow(fixture)
    fixture.screenshot(f"history-preview-{fixture.width}")
    fixture.page.keyboard.press("Escape")
    fixture.page.evaluate("globalThis.__pmmeFixture.serviceSettings.chat_completion_source='fixture-current-provider'; globalThis.__pmmeFixture.serviceSettings.custom_model='fixture-current-model'")
    named_before = fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])")
    save_count = sum(request["kind"] == "preset" for request in fixture.saves)
    request_history_version(fixture, first)
    fixture.page.locator('[data-pmme-action="history-confirm-load"]').click()
    finish_operation(fixture)
    state = native_state(fixture)
    require(state["prompts"] == first["preset"]["prompts"] and state["prompt_order"] == first["preset"]["prompt_order"], "Load did not restore the complete library and every character order")
    require(state["temp_openai"] == first["preset"]["temperature"], "Historical temperature was not mapped back to temp_openai")
    require(state["extensions"] == first["preset"]["extensions"], "Load did not restore extension preset data")
    require(state["chat_completion_source"] == "fixture-current-provider" and state["custom_model"] == "fixture-current-model", "History loading ignored the native unbound-connection boundary")
    require(fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])") == named_before, "Loading history overwrote the named preset file/cache")
    require(sum(request["kind"] == "preset" for request in fixture.saves) == save_count, "History loading called the named preset endpoint")
    groups = fixture.seed["extensionSettings"]["回声编辑台"]["groupsByScope"]
    require(all(groups.get(key) == value for key, value in first["groupsByScope"].items()), "Load did not restore versioned group definitions")
    require(any('Another preset' in key for key in groups), "Load overwrote another preset's groups")
    expect(fixture.page.locator("#pmme-status")).to_contain_text("基于 v1.0 编辑")
    expect(fixture.page.locator("#pmme-status")).to_contain_text("待更新")
    no_overflow(fixture)
    fixture.screenshot(f"history-loaded-{fixture.width}")
    fixture.boot()
    fixture.page.locator("#pmme-history").click()
    expect(fixture.page.locator(".pmme-history-record")).to_have_count(3)
    fixture.page.keyboard.press("Escape")
    expect(fixture.page.locator("#pmme-status")).to_contain_text("基于 v1.0 编辑")
    branch = save_version(fixture, "HISTORY-BRANCH · 从旧版重新编辑", None, "基于第一版重新调整")
    require(branch["version"] == "v1.2" and branch["parentId"] == first["id"], "Saving from an older version did not create a new latest version with its editing parent")
    require(branch["preset"]["fixture_preset_field"] == first["preset"]["fixture_preset_field"] and "later_only" not in branch["preset"], "Resaving an old version mixed in newer unknown preset fields")
    require(history_state(fixture)["versions"][1] == stored_first and history_state(fixture)["versions"][2] == second, "Branch save overwrote existing history")
    require(history_state(fixture)["versions"][0]["preset"] == original, "Initial history does not match the original named preset")
    require(fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])") == branch["preset"], "Named cache retained fields absent from the restored version")
    fixture.page.locator("#pmme-history").click()
    fixture.screenshot(f"history-list-{fixture.width}")
    no_overflow(fixture)


def check_history_drafts(fixture: Fixture) -> None:
    first = save_version(fixture, "SAVED-FIRST", "v1.0")
    initial = history_state(fixture)["versions"][0]
    fixture.page.locator("#pmme-content").fill("KEEP-UNSAVED")
    before = native_state(fixture)
    request_history_version(fixture, initial)
    expect(fixture.page.locator('[data-pmme-action="history-save-load"]')).to_be_visible()
    fixture.page.locator('[data-pmme-action="history-list"]').click()
    fixture.page.keyboard.press("Escape")
    expect(fixture.page.locator("#pmme-content")).to_have_value("KEEP-UNSAVED")
    require(native_state(fixture) == before, "Cancelling a history load applied or saved a draft")
    fixture.page.locator("#pmme-update").click()
    fixture.page.locator("#pmme-version-number").fill("v1.0")
    checkpoint = len(fixture.saves)
    fixture.page.locator('[data-pmme-action="update-all"]').click()
    expect(fixture.page.locator("#pmme-version-error")).to_contain_text("已经存在")
    require(len(fixture.saves) == checkpoint and native_state(fixture) == before, "Duplicate version wrote pending text or overwrote a file")
    fixture.page.locator("#pmme-version-number").fill("")
    fixture.page.locator('[data-pmme-action="update-all"]').click()
    expect(fixture.page.locator("#pmme-version-error")).to_contain_text("不能为空")
    require(len(fixture.saves) == checkpoint, "An empty version number silently saved a default version")
    fixture.page.keyboard.press("Escape")
    request_history_version(fixture, initial)
    fixture.page.locator('[data-pmme-action="history-discard-load"]').click()
    finish_operation(fixture)
    require(native_prompt(native_state(fixture), "intro")["content"] == native_prompt(initial["preset"], "intro")["content"], "Explicit discard did not load the initial version")
    fixture.page.locator("#pmme-content").fill("SAVE-BEFORE-LOAD")
    request_history_version(fixture, first)
    expect(fixture.page.locator("#pmme-version-number")).to_have_value("v1.1")
    fixture.page.locator('[data-pmme-action="history-save-load"]').click()
    finish_operation(fixture)
    saved = history_state(fixture)["versions"][-1]
    require(saved["version"] == "v1.1" and native_prompt(saved["preset"], "intro")["content"] == "SAVE-BEFORE-LOAD", "Save-before-load did not preserve the pending work as a full version")
    require(native_prompt(native_state(fixture), "intro")["content"] == "SAVED-FIRST", "Save-before-load failed to load the requested older version")
    require(native_prompt(fixture.page.evaluate("globalThis.__pmmeFixture.savedPresets[0]"), "intro")["content"] == "SAVE-BEFORE-LOAD", "Loading after a safety save overwrote the newly saved named file")


def check_history_failed_file(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    original = fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])")
    endpoint = ORIGIN + "/api/presets/save"
    fixture.expected_http_failures.add(endpoint)
    fixture.page.route(endpoint, lambda route: route.fulfill(status=503, body='{"error":"fixture failure"}', content_type="application/json"))
    fixture.page.locator("#pmme-content").fill("FAILED-FILE-RETRY")
    fixture.page.locator("#pmme-update").click()
    fixture.page.locator('[data-pmme-action="update-all"]').click()
    finish_operation(fixture)
    require([record["kind"] for record in history_state(fixture)["versions"]] == ["initial"], "A failed named file save created a successful edited history version")
    require(fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])") == original, "A failed file save changed the cached original")
    expect(fixture.page.locator("#pmme-toast")).to_contain_text("503")
    fixture.page.unroute(endpoint)
    result = save_version(fixture, "FAILED-FILE-RETRY", "v1.0")
    require(result["version"] == "v1.0" and history_state(fixture)["versions"][0]["preset"] == original, "Retry lost the initial original or skipped the failed version number")


def check_history_failed_storage(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    fail = {"enabled": True}
    def settings_route(route: Route):
        body = json.loads(route.request.post_data or "{}")
        versions = body.get("extension_settings", {}).get("回声编辑台", {}).get("presetHistory", {}).get("versions", [])
        if fail["enabled"] and len(versions) > 1:
            route.fulfill(status=503, body='{"error":"history storage failure"}', content_type="application/json")
        else:
            fixture.route(route)
    fixture.expected_http_failures.add(ORIGIN + "/api/settings/save")
    fixture.page.route(ORIGIN + "/api/settings/save", settings_route)
    fixture.page.locator("#pmme-content").fill("FILE-SAVED-HISTORY-PENDING")
    fixture.page.locator("#pmme-update").click()
    fixture.page.locator('[data-pmme-action="update-all"]').click()
    finish_operation(fixture)
    require(len(history_state(fixture)["versions"]) == 2, "Unconfirmed history was discarded from memory")
    durable = fixture.seed["extensionSettings"]["回声编辑台"]["presetHistory"]["versions"]
    require(len(durable) == 1 and durable[0]["kind"] == "initial", "The original was not durable before overwrite, or failed new history was treated as saved")
    expect(fixture.page.locator("#pmme-toast")).to_contain_text("未确认写入历史")
    expect(fixture.page.locator("#pmme-retry")).to_be_visible()
    fail["enabled"] = False
    fixture.page.locator("#pmme-retry").click()
    fixture.settle()
    require(len(fixture.seed["extensionSettings"]["回声编辑台"]["presetHistory"]["versions"]) == 2, "Retry failed to persist the same versions")
    expect(fixture.page.locator("#pmme-retry")).to_be_hidden()
    require(sum(request["kind"] == "preset" for request in fixture.saves) == 1, "Retrying history storage saved the named file again")


def check_history_initial_storage_guard(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    original = fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])")
    def initial_route(route: Route):
        body = json.loads(route.request.post_data or "{}")
        versions = body.get("extension_settings", {}).get("回声编辑台", {}).get("presetHistory", {}).get("versions", [])
        if versions:
            route.fulfill(status=503, body='{"error":"initial version storage failure"}', content_type="application/json")
        else:
            fixture.route(route)
    fixture.expected_http_failures.add(ORIGIN + "/api/settings/save")
    fixture.page.route(ORIGIN + "/api/settings/save", initial_route)
    fixture.page.locator("#pmme-content").fill("MUST-NOT-OVERWRITE-ORIGINAL")
    fixture.page.locator("#pmme-update").click()
    fixture.page.locator('[data-pmme-action="update-all"]').click()
    finish_operation(fixture)
    require(not any(request["kind"] == "preset" for request in fixture.saves), "The first named file was overwritten before its initial history became durable")
    require(fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])") == original, "Failed initial history storage changed the named original")
    expect(fixture.page.locator("#pmme-toast")).to_contain_text("尚未覆盖原命名预设")
    fixture.page.unroute(ORIGIN + "/api/settings/save")
    fixture.page.locator("#pmme-retry").click()
    fixture.settle()
    require(fixture.seed["extensionSettings"]["回声编辑台"]["presetHistory"]["versions"][0]["preset"] == original, "Retry did not persist the untouched original")


def check_history_inflight_save(fixture: Fixture) -> None:
    first = save_version(fixture, "SERIAL-FIRST", "v1.0")
    held: list[Route] = []
    def gate(route: Route):
        if not held:
            held.append(route)
        else:
            fixture.route(route)
    fixture.page.route(ORIGIN + "/api/settings/save", gate)
    fixture.page.locator("#pmme-content").fill("OLD-INFLIGHT")
    fixture.page.locator("#pmme-save").click()
    fixture.page.wait_for_function("() => globalThis.__pmmeFixture.pendingSettingsSaves === 1")
    require(bool(held), "The old settings write was not held by the fixture")
    request_history_version(fixture, first)
    fixture.page.locator('[data-pmme-action="history-discard-load"]').click()
    require(native_prompt(native_state(fixture), "intro")["content"] == "OLD-INFLIGHT", "History applied before the old request completed")
    fixture.route(held[0])
    finish_operation(fixture)
    require(native_prompt(fixture.seed["serviceSettings"], "intro")["content"] == "SERIAL-FIRST", "An old settings request overwrote the restored version")
    require(len(history_state(fixture)["versions"]) == 2, "Discard-and-load unexpectedly created another formal version")


def check_history_changed_source(fixture: Fixture) -> None:
    first = save_version(fixture, "UNCHANGED-FIRST", "v1.0")
    initial = history_state(fixture)["versions"][0]
    request_history_version(fixture, initial)
    fixture.page.evaluate("globalThis.__pmmeFixture.serviceSettings.prompts.find(p=>p.identifier==='intro').content='EXTERNAL-CHANGE'")
    before = native_state(fixture)
    checkpoint = len(fixture.saves)
    fixture.page.locator('[data-pmme-action="history-confirm-load"]').click()
    expect(fixture.page.locator("#pmme-toast")).to_contain_text("已变化")
    require(native_state(fixture) == before and len(fixture.saves) == checkpoint, "History load overwrote a change made after confirmation opened")
    fixture.page.keyboard.press("Escape")
    request_history_version(fixture, first)
    fixture.page.evaluate("globalThis.__pmmeFixture.serviceSettings.preset_settings_openai='Another local fixture'")
    before = native_state(fixture)
    fixture.page.locator('[data-pmme-action="history-discard-load"]').click()
    expect(fixture.page.locator("#pmme-toast")).to_contain_text("预设已经切换")
    require(native_state(fixture) == before, "Stale history confirmation wrote into another preset")
    fixture.page.evaluate("globalThis.__pmmeFixture.serviceSettings.preset_settings_openai='UI Layout Fixture'")


def check_history_delete(fixture: Fixture) -> None:
    first = save_version(fixture, "DELETE-HISTORY-ONLY", "v1.0")
    before = native_state(fixture)
    named = fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])")
    fixture.page.locator("#pmme-history").click()
    fixture.page.locator(f'[data-pmme-version-id="{first["id"]}"] [data-pmme-action="history-delete"]').click()
    fixture.page.locator('[data-pmme-action="history-list"]').click()
    require(len(history_state(fixture)["versions"]) == 2, "Cancelling history deletion removed a version")
    fixture.page.locator(f'[data-pmme-version-id="{first["id"]}"] [data-pmme-action="history-delete"]').click()
    fixture.page.locator('[data-pmme-action="history-confirm-delete"]').click()
    finish_operation(fixture)
    require(len(history_state(fixture)["versions"]) == 1, "Confirmed history deletion did not persist")
    require(native_state(fixture) == before and fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])") == named, "Deleting a history record changed current content or the named file")


def open_delete_confirmation(fixture: Fixture, identifier: str) -> None:
    if fixture.width > 760 and fixture.page.locator("#pmme-editor").get_attribute("data-entry-id") == identifier:
        fixture.page.locator("#pmme-detail-menu" if fixture.page.locator("#pmme-full-view").is_hidden() else "#pmme-full-menu").click()
    elif fixture.page.locator("#pmme-full-view").is_visible():
        fixture.page.locator("#pmme-full-menu").click()
    else:
        fixture.page.locator(f'[data-pmme-menu="{identifier}"]').click()
    fixture.page.locator('[data-pmme-action="delete"]').click()
    expect(fixture.page.locator("#pmme-sheet-title")).to_have_text("彻底删除条目？")
    expect(fixture.page.locator('[data-pmme-action="delete-confirm"]')).to_have_attribute("data-pmme-entry", identifier)


def add_shared_character_order(fixture: Fixture) -> None:
    fixture.page.evaluate("""() => {
        const f = globalThis.__pmmeFixture, first = f.serviceSettings.prompt_order[0].order;
        f.serviceSettings.prompt_order.push({character_id:'other-fixture-character', extra:'preserved', order:[
            {...first.find(entry => entry.identifier === 'dialogue'), extra:17},
            {...first.find(entry => entry.identifier === 'intro'), extra:23},
        ]});
        f.savedPresets[0] = structuredClone(f.serviceSettings);
    }""")


def check_delete(fixture: Fixture) -> None:
    add_shared_character_order(fixture)
    select_entry(fixture, "dialogue")
    other = set_draft(fixture, "KEEP-OTHER-DRAFT", 83, 99, 360)
    select_entry(fixture, "intro")
    local = set_draft(fixture, "DELETE-LOCAL-DRAFT")
    before = native_state(fixture)
    saved_before = fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])")
    checkpoint = len(fixture.saves)
    open_delete_confirmation(fixture, "intro")
    expect(fixture.page.locator("#pmme-sheet-body")).to_contain_text("未保存的修改")
    require(native_state(fixture) == before and len(fixture.saves) == checkpoint, "Opening deletion confirmation already changed or persisted data")
    fixture.screenshot(f"delete-confirmation-{fixture.width}")
    fixture.page.locator('[data-pmme-action="close"]').click()
    retained(fixture, local)
    require(native_state(fixture) == before and len(fixture.saves) == checkpoint, "Cancelling deletion changed data")
    open_delete_confirmation(fixture, "intro")
    fixture.page.locator('[data-pmme-action="delete-confirm"]').click()
    fixture.settle()
    after = native_state(fixture)
    require(not any(item["identifier"] == "intro" for item in after["prompts"]), "Deleted entry is still in the native library")
    require(after["prompts"] == [item for item in before["prompts"] if item["identifier"] != "intro"], "Deleting an entry changed unrelated prompt content")
    expected_orders = [{**bucket, "order": [item for item in bucket["order"] if item["identifier"] != "intro"]} for bucket in before["prompt_order"]]
    require(after["prompt_order"] == expected_orders, "Deletion left dangling character references or changed unrelated order fields")
    expect(fixture.page.locator("#pmme-row-intro")).to_have_count(0)
    expect(fixture.page.locator('[data-pmme-id^="fixture-draft-"]')).to_have_count(0)
    expect(fixture.page.locator("#pmme-editor")).to_have_attribute("data-entry-id", "dialogue")
    retained(fixture, other)
    requests = fixture.saves[checkpoint:]
    require(requests and all(request["kind"] == "settings" for request in requests), "Deleting must persist current settings, not overwrite a named preset")
    require(requests[-1]["body"]["oai_settings"] == after, "Confirmed deletion was not sent to the intercepted settings save")
    require(fixture.page.evaluate("structuredClone(globalThis.__pmmeFixture.savedPresets[0])") == saved_before, "Deletion silently overwrote the named preset cache")
    fixture.page.locator("#pmme-library").click()
    expect(fixture.page.locator('[data-pmme-add="intro"]')).to_have_count(0)
    expect(fixture.page.locator('[data-pmme-add="unused-library"]')).to_have_count(1)
    fixture.page.locator("#pmme-sheet-close").click()
    fixture.screenshot(f"deleted-entry-{fixture.width}")


def check_delete_boundary(fixture: Fixture) -> None:
    select_entry(fixture, "group-first")
    other = set_draft(fixture, "KEEP-GROUP-MEMBER")
    select_entry(fixture, "group-start")
    before = native_state(fixture)
    open_delete_confirmation(fixture, "group-start")
    expect(fixture.page.locator("#pmme-sheet-body")).to_contain_text("其他成员条目仍保留")
    fixture.page.locator('[data-pmme-action="delete-confirm"]').click()
    fixture.settle()
    after = native_state(fixture)
    require(after["prompts"] == [item for item in before["prompts"] if item["identifier"] != "group-start"], "Deleting a boundary removed its group members")
    expect(fixture.page.locator('[data-pmme-group="group-start"]')).to_have_count(0)
    expect(fixture.page.locator("#pmme-row-group-end")).to_have_count(1)
    expect(fixture.page.locator("#pmme-editor")).to_have_attribute("data-entry-id", "group-first")
    retained(fixture, other)
    scope = fixture.page.evaluate("JSON.stringify([globalThis.__pmmeFixture.serviceSettings.preset_settings_openai, 'global', String(globalThis.__pmmeFixture.manager.activeCharacter.id)])")
    require(fixture.saves[-1]["body"]["extension_settings"]["回声编辑台"]["groupsByScope"][scope] == [], "Deleted boundary was retained in saved group preferences")
    fixture.screenshot("deleted-group-boundary")


def check_delete_last_fullscreen(fixture: Fixture) -> None:
    fixture.page.locator("#pmme-close").click()
    fixture.page.evaluate("""() => {
        const f = globalThis.__pmmeFixture;
        f.serviceSettings.prompt_order[0].order.splice(1);
        f.savedPresets[0] = structuredClone(f.serviceSettings);
        f.manager.renderDebounced();
    }""")
    fixture.open()
    select_entry(fixture, "intro")
    fixture.page.locator("#pmme-detail-expand" if fixture.width > 760 else "#pmme-expand").click()
    expect(fixture.page.locator("#pmme-full-view")).to_be_visible()
    open_delete_confirmation(fixture, "intro")
    fixture.page.locator('[data-pmme-action="delete-confirm"]').click()
    fixture.settle()
    expect(fixture.page.locator("#pmme-full-view")).to_be_hidden()
    expect(fixture.page.locator("#pmme-directory-view")).to_be_visible()
    expect(fixture.page.locator("#pmme-list .pmme-empty")).to_be_visible()
    expect(fixture.page.locator("#pmme-content")).to_be_hidden()
    require(native_order(native_state(fixture)) == [], "Deleting the last entry left an order reference")
    if fixture.width > 760:
        expect(fixture.page.locator("#pmme-detail-empty")).to_be_visible()
    one_editor(fixture)
    fixture.screenshot(f"deleted-last-fullscreen-{fixture.width}")


def check_remove_still_keeps_library(fixture: Fixture) -> None:
    add_shared_character_order(fixture)
    select_entry(fixture, "intro")
    before = native_state(fixture)
    fixture.page.locator("#pmme-detail-menu").click()
    fixture.page.locator('[data-pmme-action="remove"]').click()
    fixture.page.locator('[data-pmme-action="remove-confirm"]').click()
    fixture.settle()
    after = native_state(fixture)
    require(after["prompts"] == before["prompts"], "The original remove action became permanent deletion")
    require(after["prompt_order"][1] == before["prompt_order"][1], "Removing from this order changed another character order")
    require(not any(item["identifier"] == "intro" for item in native_order(after)), "Remove failed to detach the current order")
    fixture.page.locator("#pmme-library").click()
    expect(fixture.page.locator('[data-pmme-add="intro"]')).to_be_enabled()


def check_delete_protected(fixture: Fixture) -> None:
    fixture.page.locator('[data-pmme-select="chatHistory"]').click()
    before = native_state(fixture)
    fixture.page.locator("#pmme-detail-menu").click()
    expect(fixture.page.locator('[data-pmme-action="delete"]')).to_have_count(0)
    fixture.page.locator("#pmme-sheet-close").click()
    error = fixture.page.evaluate("""async () => {
        const adapter = await import('/scripts/extensions/third-party/ui-layout-fixture/adapter.js');
        try { adapter.deletePrompt(adapter.scopeKey(), 'chatHistory'); return null; }
        catch (error) { return error.message; }
    }""")
    require(error and "内置" in error, "Adapter allowed deletion of a protected native entry")
    require(native_state(fixture) == before and not fixture.saves, "Protected deletion changed or persisted data")


def check_delete_changed_source(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    local = set_draft(fixture, "KEEP-LOCAL-AFTER-EXTERNAL-EDIT")
    open_delete_confirmation(fixture, "intro")
    fixture.page.evaluate("globalThis.__pmmeFixture.manager.getPromptById('intro').content = 'EXTERNAL-CHANGE-AFTER-CONFIRMATION'")
    before = native_state(fixture)
    fixture.page.locator('[data-pmme-action="delete-confirm"]').click()
    require(native_state(fixture) == before and not fixture.saves, "Deletion ignored a changed prompt after confirmation")
    expect(fixture.page.locator("#pmme-toast")).to_contain_text("重新确认删除")
    retained(fixture, local)


def check_delete_changed_scope(fixture: Fixture) -> None:
    select_entry(fixture, "intro")
    open_delete_confirmation(fixture, "intro")
    fixture.page.evaluate("globalThis.__pmmeFixture.serviceSettings.preset_settings_openai = 'Another local fixture'")
    before = native_state(fixture)
    fixture.page.locator('[data-pmme-action="delete-confirm"]').click()
    require(native_state(fixture) == before and not fixture.saves, "Stale deletion acted on another preset scope")
    expect(fixture.page.locator("#pmme-toast")).to_contain_text("预设已经切换")
    fixture.page.evaluate("globalThis.__pmmeFixture.serviceSettings.preset_settings_openai = 'UI Layout Fixture'")


class Runner:
    def __init__(self, browser: Browser, output: Path, verbose: bool, selected: str | None):
        self.browser, self.output, self.verbose, self.selected = browser, output, verbose, selected
        self.passed = 0
        self.failed = 0
        self.screenshots: list[Path] = []

    def run(self, name: str, sources: Sources, width: int, height: int, action: Callable[[Fixture], object], always: bool = False):
        if self.selected and self.selected not in name and not always:
            return None
        fixture = Fixture(self.browser, sources, width, height, self.output, self.screenshots)
        try:
            with fixture:
                try:
                    result = action(fixture)
                    fixture.assert_clean()
                except Exception:
                    try:
                        fixture.screenshot(f"FAIL-{name}")
                    except Exception:
                        pass
                    raise
            self.passed += 1
            print(f"PASS {name}", flush=True)
            return result
        except Exception as error:
            self.failed += 1
            message = str(error).replace("\n", " ")
            print(f"FAIL {name}: {message[:700]}", flush=True)
            if self.verbose:
                traceback.print_exc()
            return None

    def summary(self, smoke: bool) -> int:
        print(f"\n{'SMOKE' if smoke else 'REGRESSION'}: {self.passed} passed, {self.failed} failed. All HTTP requests intercepted; no real service/configuration used.")
        for path in dict.fromkeys(self.screenshots):
            print(f"SCREENSHOT {path}")
        if smoke:
            print("Preparation only: future desktop controls and mobile/current visual equivalence were not tested.")
        require(self.passed + self.failed > 0, "No cases matched --case")
        return 1 if self.failed else 0


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--smoke", action="store_true", help="Only boot and capture 390/760px inline mobile UI. With --baseline-ref, inspect that reference only (safe before desktop controls exist).")
    parser.add_argument("--baseline-ref", help="git commit/ref for identical-fixture mobile screenshot and geometry comparison, e.g. HEAD. Never checks out files.")
    parser.add_argument("--case", help="Run cases whose names contain this string; baseline captures still run when requested.")
    parser.add_argument("--browser-executable", type=Path, help="Use an existing local Chromium/Chrome binary. Default tries bundled Chromium, then locally installed Chrome; never downloads a browser.")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "test-results" / "ui-layout", help="Screenshot directory, restricted to this project's test-results/.")
    parser.add_argument("--pixel-threshold", type=float, default=0.001, help="Allowed fraction of changed mobile pixels after RGB tolerance 8 (default 0.001 = 0.1%%); geometry tolerance remains 1px.")
    parser.add_argument("--verbose", action="store_true", help="Print traceback for failed cases.")
    args = parser.parse_args()
    args.output_dir = args.output_dir.resolve()
    allowed = (ROOT / "test-results").resolve()
    if args.output_dir != allowed and allowed not in args.output_dir.parents:
        parser.error("--output-dir must be inside the project's ignored test-results/ directory")
    if not 0 <= args.pixel_threshold <= 1:
        parser.error("--pixel-threshold must be between 0 and 1")
    if args.browser_executable:
        args.browser_executable = args.browser_executable.resolve()
        if not args.browser_executable.is_file():
            parser.error("--browser-executable must point to an existing local Chromium/Chrome binary")
    return args


def launch_browser(playwright, args: argparse.Namespace) -> Browser:
    options = {"headless": True, "args": ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND"]}
    if args.browser_executable:
        return playwright.chromium.launch(executable_path=str(args.browser_executable), **options)
    try:
        return playwright.chromium.launch(**options)
    except PlaywrightError as error:
        if "Executable doesn't exist" not in str(error):
            raise
        # launch() creates a temporary profile; never use a user's browser profile.
        candidates = [Path(playwright.chromium.executable_path)]
        if sys.platform == "win32":
            candidates.extend([Path("C:/Program Files/Google/Chrome/Application/chrome.exe"), Path("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe")])
        executable = next((path for path in candidates if path.is_file()), None)
        if not executable:
            raise RuntimeError("No local Chromium/Chrome binary found. Supply --browser-executable; no browser download was attempted.") from error
        print(f"Using existing local Chromium/Chrome with a temporary profile: {executable}", flush=True)
        return playwright.chromium.launch(executable_path=str(executable), **options)


def main() -> int:
    args = arguments()
    baseline = Sources(args.baseline_ref) if args.baseline_ref else None
    current = None if args.smoke and baseline else Sources()
    expect.set_options(timeout=5000)
    with sync_playwright() as playwright:
        browser = launch_browser(playwright, args)
        try:
            runner = Runner(browser, args.output_dir, args.verbose, args.case)
            if args.smoke:
                source = baseline or current
                print(f"Preparation fixture: {source.label}; headless Chromium; virtual origin {ORIGIN}")
                def smoke_action(fixture: Fixture):
                    capture = capture_mobile(fixture)
                    # Validate the dependency-free PNG/geometry comparison itself;
                    # this is not a comparison with the unfinished working tree.
                    compare_mobile(capture, capture, args.pixel_threshold)
                    return capture
                for width, height in MOBILES:
                    runner.run(f"smoke-mobile-{width}", source, width, height, smoke_action)
            else:
                captures: dict[int, MobileCapture] = {}
                if baseline:
                    print(f"Mobile baseline: {args.baseline_ref} ({baseline.commit}); identical host fixture; 1px geometry / {args.pixel_threshold:.3%} pixel tolerance")
                    for width, height in MOBILES:
                        capture = runner.run(f"baseline-mobile-{width}", baseline, width, height, capture_mobile, always=True)
                        if capture:
                            captures[width] = capture
                else:
                    print("SKIP git-baseline visual comparison: pass --baseline-ref HEAD to enable it.")
                for width, height in MOBILES:
                    def mobile_action(fixture: Fixture, width=width):
                        require(not baseline or width in captures, f"Baseline fixture failed at {width}px")
                        check_mobile(fixture, captures.get(width), args.pixel_threshold)
                    runner.run(f"mobile-single-column-{width}", current, width, height, mobile_action)
                for width, height in DESKTOPS:
                    runner.run(f"desktop-geometry-{width}x{height}", current, width, height, check_desktop)
                for width, height in ((320, 700), (390, 844), (760, 900), (1024, 900), (1366, 900)):
                    runner.run(f"heading-typography-{width}", current, width, height, check_heading_typography)
                for width, height in ((1366, 900), (390, 844)):
                    runner.run(f"drafts-caret-scroll-{width}", current, width, height, check_drafts)
                    runner.run(f"menu-position-{width}", current, width, height, check_menu)
                    runner.run(f"themes-{width}", current, width, height, check_themes)
                    runner.run(f"new-entry-settings-save-{width}", current, width, height, check_new_save)
                    runner.run(f"batch-replace-draft-preview-undo-{width}", current, width, height, check_batch_replace_drafts)
                    runner.run(f"batch-replace-deletion-readonly-{width}", current, width, height, check_batch_replace_deletion)
                    runner.run(f"batch-replace-new-local-draft-{width}", current, width, height, check_batch_replace_new_draft)
                    runner.run(f"history-version-workflow-{width}", current, width, height, check_history_workflow)
                    runner.run(f"history-unsaved-draft-choices-{width}", current, width, height, check_history_drafts)
                    runner.run(f"delete-cancel-and-persist-{width}", current, width, height, check_delete)
                    runner.run(f"delete-last-fullscreen-{width}", current, width, height, check_delete_last_fullscreen)
                for name, action in (
                    ("desktop-search-and-group-fold", check_search_and_groups),
                    ("desktop-organize-and-sort", check_organize),
                    ("desktop-fullscreen-return", check_fullscreen),
                    ("layout-switch-and-narrow-window", check_layout_switch),
                    ("splitter-pointer-keyboard-memory", check_splitter),
                    ("named-preset-separate-save", check_named_update),
                    ("batch-replace-stale-preview", check_batch_replace_stale_preview),
                    ("batch-replace-stale-scope", check_batch_replace_stale_scope),
                    ("batch-replace-later-edit-undo-guard", check_batch_replace_undo_guard),
                    ("batch-replace-saved-entry-undo-guard", check_batch_replace_saved_undo_guard),
                    ("batch-replace-complete-save-boundary", check_batch_replace_complete_save),
                    ("history-failed-preset-save", check_history_failed_file),
                    ("history-failed-storage-retry", check_history_failed_storage),
                    ("history-initial-storage-before-overwrite", check_history_initial_storage_guard),
                    ("history-inflight-settings-save", check_history_inflight_save),
                    ("history-confirmation-source-guards", check_history_changed_source),
                    ("history-delete-record-only", check_history_delete),
                    ("delete-group-boundary", check_delete_boundary),
                    ("delete-vs-remove-library", check_remove_still_keeps_library),
                    ("delete-protected-native", check_delete_protected),
                    ("delete-changed-source", check_delete_changed_source),
                    ("delete-changed-scope", check_delete_changed_scope),
                ):
                    runner.run(name, current, 1366, 900, action)
            return runner.summary(args.smoke)
        finally:
            browser.close()


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    try:
        sys.exit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(2)
