import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { context, host } from "./native-stubs.mjs";

registerHooks({ resolve(specifier, ctx, next) {
  return ["gpui-kit", "gpui-base", "herdr"].includes(specifier)
    ? { url: new URL("./native-stubs.mjs", import.meta.url).href, shortCircuit: true } : next(specifier, ctx);
} });
const { FileBrowser } = await import("../file-browser.js");
const { ROW, PAD, baseName, rowMeta, shortcut } = await import("../file-view.js");
const hex = value => Buffer.from(value).toString("hex");
const response = body => ({ code: 0, stdout: JSON.stringify({ code: 0, stdout: `HERDR_FILES_V1\n${body}\nEND\n` }) });
const folderListing = path => response(`PATH ${hex(path)}\nENTRY d 1 0 0 ${hex("folder")}\nENTRY d 1 0 0 ${hex("target")}\nENTRY f 0 4 0 ${hex("file")}\nLIMIT 0`);
const manyListing = (path, count) => response([`PATH ${hex(path)}`,
  ...Array.from({ length: count }, (_, i) => `ENTRY f 0 4 0 ${hex(`file-${String(i).padStart(2, "0")}`)}`), "LIMIT 0"].join("\n"));
const pointer = (x, y) => ({ position: { x, y } });
async function setup(listing = folderListing("/root")) {
  const cx = context();
  host.calls = []; host.saved = {}; host.spaces = []; host.zoom = 1; host.platform = "linux";
  host.handler = async () => listing;
  const browser = new FileBrowser(cx, "en", () => ({ machine: null, connection: "ready" }));
  browser.sync(true, cx); await cx.settle();
  return { cx, browser };
}

test("zoomed pointer and size events map to unzoomed layout positions", async () => {
  const { cx, browser } = await setup(); host.zoom = 1.3;
  browser.resizePanel({ width: 447.2, height: 780 });
  assert.deepEqual(browser.panelSize, { width: 344, height: 600 });
  browser.panelBounds = { x: 0, y: 43, width: 447.2, height: 780 };
  browser.openMenu("/root/file", pointer(130, 563), cx);
  assert.equal(Math.round(browser.menu.x), 100); assert.equal(Math.round(browser.menu.y), 400);
  browser.close();
});

test("keyboard selection scrolls the last row fully into a zoomed viewport", async () => {
  const { cx, browser } = await setup(manyListing("/root", 40)); host.zoom = 1.3;
  browser.resizeViewport({ width: 400, height: 390 }, cx);
  assert.equal(browser.viewportHeight, 300);
  assert.equal(browser.maxScroll(), 40 * ROW + 2 * PAD - 300);
  browser.selected = browser.visibleEntries()[0].path;
  browser.listKey({ key: "end", modifiers: {} }, cx);
  assert.equal(browser.selected, "/root/file-39");
  assert.equal(browser.scrollOffset, browser.maxScroll());
  browser.listKey({ key: "home", modifiers: {} }, cx);
  assert.equal(browser.scrollOffset, 0);
  browser.scrollBy(-1e6, cx); assert.equal(browser.scrollOffset, browser.maxScroll());
  browser.close();
});

test("the status line follows a move gesture and returns to the item count", async () => {
  const { cx, browser } = await setup();
  assert.equal(browser.status(), "3 items · Refresh on demand");
  browser.startPress("/root/file", pointer(10, 10), cx);
  browser.dragOver("/root/file", pointer(30, 30), cx);
  assert.equal(browser.status(), browser.l.dragHint);
  browser.dragOver("/root/target", pointer(30, 40), cx);
  assert.equal(browser.status(), "Release to move into /root/target");
  browser.cancel(cx);
  assert.equal(browser.status(), "3 items · Refresh on demand");
  browser.close();
});

test("context menu items carry the platform's shortcuts", async () => {
  const { cx, browser } = await setup();
  browser.openMenu("/root/file", pointer(20, 50), cx);
  assert.deepEqual(browser.menuItems().map(item => [item.action, item.shortcut ?? ""]),
    [["path", "Ctrl+C"], ["cp", ""], ["mv", "F2"], ["refresh", "R"]]);
  browser.openMenu("/root/folder", pointer(20, 50), cx);
  assert.equal(browser.menuItems().find(item => item.action === "toggle").shortcut, "Enter");
  host.platform = "macos";
  assert.equal(browser.menuItems()[0].shortcut, "⌘C");
  browser.close();
});

test("row metadata leaves folder sizes blank and prints UTC minutes", () => {
  assert.deepEqual(rowMeta({ directory: false, size: 4608, modified: Date.UTC(2026, 10, 5, 14, 32) }),
    { size: "4.5 KiB", modified: "2026-11-05 14:32" });
  assert.deepEqual(rowMeta({ directory: true, size: 0, modified: null }), { size: "", modified: "" });
  assert.equal(rowMeta({ directory: false, size: null, modified: 0 }).size, "--");
});

test("names and shortcuts used by the tree header and tooltips", () => {
  assert.equal(baseName("/tmp/demo-project"), "demo-project");
  assert.equal(baseName("/tmp/demo-project/"), "demo-project");
  assert.equal(baseName("/"), "/");
  host.platform = "linux"; assert.equal(shortcut("mod", "C"), "Ctrl+C");
  host.platform = "macos"; assert.equal(shortcut("mod", "C"), "⌘C");
  assert.equal(shortcut("F2"), "F2");
  host.platform = "linux";
});
