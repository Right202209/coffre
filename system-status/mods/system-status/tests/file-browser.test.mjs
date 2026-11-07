import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { context, host } from "./native-stubs.mjs";

registerHooks({ resolve(specifier, ctx, next) {
  return ["gpui-kit", "gpui-base", "herdr"].includes(specifier)
    ? { url: new URL("./native-stubs.mjs", import.meta.url).href, shortCircuit: true } : next(specifier, ctx);
} });
const { FileBrowser } = await import("../file-browser.js");
const hex = value => Buffer.from(value).toString("hex");
const response = body => ({ code: 0, stdout: JSON.stringify({ code: 0, stdout: `HERDR_FILES_V1\n${body}\nEND\n` }) });
const listing = (path, name = "file") => response(`PATH ${hex(path)}\nENTRY f 0 4 0 ${hex(name)}\nLIMIT 0`);
function setup() {
  const cx = context();
  host.calls = []; host.saved = {}; host.spaces = [];
  const browser = new FileBrowser(cx, "en", () => ({ machine: host.spaces.find(space => space.active)?.machine ?? null, connection: "ready" }));
  return { cx, browser };
}

test("files load the local home on activation even without a space or session", async () => {
  const { cx, browser } = setup();
  host.handler = async () => listing("/first");
  browser.sync(false, cx);
  await cx.settle(); assert.equal(host.calls.length, 0);
  browser.sync(true, cx); await cx.settle();
  assert.equal(host.calls[0].at(-1), "~");
  assert.equal(host.calls[0].includes("--on"), false);
  assert.equal(browser.path, "/first");
  browser.sync(true, cx); await cx.settle();
  assert.equal(host.calls.length, 1);
  browser.close();
});

test("changing the active space on the same machine does not discard a pending directory load", async () => {
  const { cx, browser } = setup();
  let finishFirst;
  host.handler = () => new Promise(resolve => { finishFirst = resolve; });
  browser.sync(true, cx); await Promise.resolve();
  host.spaces = [{ id: "second", machine: null, folder: "/second", active: true }];
  browser.sync(true, cx); await Promise.resolve();
  finishFirst(listing("/first")); await cx.settle();
  assert.equal(browser.path, "/first");
  assert.equal(host.calls.length, 1);
  assert.equal(browser.loading, false);
  browser.close();
});

test("changing spaces on the same machine or hiding the panel preserves the selection and pending form", async () => {
  const { cx, browser } = setup();
  host.handler = async () => listing("/first");
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/first/file"; browser.begin("mv", cx);
  assert.ok(browser.operation);
  browser.destinationInput.set_value("renamed");
  host.spaces = [{ id: "two", folder: "/second", active: true }];
  browser.sync(false, cx); browser.sync(true, cx); await cx.settle();
  assert.equal(host.calls.length, 1);
  assert.equal(browser.path, "/first");
  assert.equal(browser.operation.source, "/first/file");
  assert.equal(browser.destinationInput.value(), "renamed");
  assert.equal(browser.selected, "/first/file");
  browser.close();
});

test("copying a path writes the literal selection, or the current folder", async () => {
  const { cx, browser } = setup();
  host.handler = async () => listing("/first", "中文\n'file");
  browser.sync(true, cx); await cx.settle();
  browser.copyPath(cx); assert.equal(cx.clipboard, "/first");
  browser.selected = "/first/中文\n'file";
  browser.copyPath(cx); assert.equal(cx.clipboard, "/first/中文\n'file");
  browser.close();
});

test("operations need confirmation, prevent double submission and refresh after success", async () => {
  const { cx, browser } = setup();
  let finishOperation;
  host.handler = async () => listing("/first");
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/first/file"; browser.begin("cp", cx);
  assert.equal(host.calls.length, 1);
  browser.destinationInput.set_value("/copy");
  host.handler = args => args.at(-4) === "cp" ? new Promise(resolve => { finishOperation = resolve; }) : Promise.resolve(listing("/first"));
  browser.confirm(cx); browser.confirm(cx); await Promise.resolve();
  assert.equal(host.calls.length, 2); assert.equal(browser.working, true);
  assert.equal(browser.cancel(cx), false);
  finishOperation(response(`DONE ${hex("/copy")}`)); await cx.settle();
  assert.equal(host.calls.length, 3);
  assert.equal(browser.working, false); assert.equal(browser.operation, null);
  assert.match(browser.notice, /Copied to \/copy/);
  browser.close();
});

test("a pending move refreshes the same folder after switching spaces on the same machine", async () => {
  const { cx, browser } = setup();
  let finishOperation;
  host.handler = async () => listing("/first");
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/first/file"; browser.begin("mv", cx); browser.destinationInput.set_value("/moved");
  host.handler = args => args.at(-4) === "mv" ? new Promise(resolve => { finishOperation = resolve; }) : Promise.resolve(listing("/first"));
  browser.confirm(cx); await Promise.resolve();
  host.spaces = [{ id: "second", machine: null, folder: "/second", active: true }];
  browser.sync(true, cx); await Promise.resolve();
  finishOperation(response(`DONE ${hex("/moved")}`)); await cx.settle();
  assert.ok(host.calls.every(args => !args.includes("--on")));
  assert.equal(host.calls.length, 3);
  assert.equal(browser.path, "/first"); assert.match(browser.notice, /Moved to \/moved/);
  browser.close();
});

test("failed navigation keeps the previous folder and restores its address", async () => {
  const { cx, browser } = setup();
  host.handler = async () => listing("/first");
  browser.sync(true, cx); await cx.settle();
  host.handler = async () => response("ERROR cannot-open ");
  browser.pathInput.set_value("/missing"); browser.navigate("/missing", cx); await cx.settle();
  assert.equal(browser.path, "/first"); assert.equal(browser.pathInput.value(), "/first");
  assert.equal(host.saved["system-status.files.browser"].path, "/first");
  assert.match(browser.error, /Cannot open/);
  browser.close();
});

test("a new copy restores the last successful local directory and hidden-file preference", async () => {
  const { cx, browser } = setup();
  host.handler = async () => listing("/first");
  browser.sync(true, cx); await cx.settle();
  browser.showHidden = true; browser.remember();
  browser.close();
  host.spaces = [{ id: "second", machine: null, folder: "/second", active: true }];
  const restored = new FileBrowser(cx, "en");
  assert.equal(restored.pathInput.value(), "/first");
  assert.equal(restored.showHidden, true);
  restored.sync(true, cx); await cx.settle();
  assert.equal(host.calls.at(-1).at(-1), "/first");
  assert.equal(host.calls.at(-1).includes("--on"), false);
  restored.close();
});

test("invalid saved paths fall back to the local home", async () => {
  const { cx, browser } = setup(); browser.close();
  for (const path of [null, 42, "relative", "/bad\0path"]) {
    host.saved["system-status.files.browser"] = { path };
    const restored = new FileBrowser(cx, "en");
    assert.equal(restored.pathInput.value(), "~");
    restored.close();
  }
});

test("failed operations keep the form available without reporting success", async () => {
  const { cx, browser } = setup();
  host.handler = async () => listing("/first");
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/first/file"; browser.begin("cp", cx);
  host.handler = async () => response("ERROR destination-exists ");
  browser.confirm(cx); await cx.settle();
  assert.equal(browser.working, false); assert.ok(browser.operation);
  assert.match(browser.error, /already exists/); assert.equal(browser.notice, "");
  browser.close();
});

test("closing the panel invalidates an in-flight load and releases inputs", async () => {
  const { cx, browser } = setup();
  let finish;
  host.handler = () => new Promise(resolve => { finish = resolve; });
  browser.sync(true, cx); await Promise.resolve();
  browser.close(); finish(listing("/first")); await cx.settle();
  assert.equal(browser.path, ""); assert.equal(browser.pathInput.released, true);
});

const folderListing = path => response(`PATH ${hex(path)}\nENTRY d 1 0 0 ${hex("folder")}\nENTRY d 1 0 0 ${hex("target")}\nENTRY f 0 4 0 ${hex("file")}\nLIMIT 0`);
const pointer = (x, y) => ({ position: { x, y } });

test("expansion is lazy, deduplicates loads and keeps the browsing root", async () => {
  const { cx, browser } = setup();
  host.handler = async args => args.at(-1) === "~" ? folderListing("/root") : listing("/root/folder", "nested");
  browser.sync(true, cx); await cx.settle();
  assert.equal(host.calls.length, 1);
  browser.toggle("/root/folder", cx); browser.pumpBranches(cx); await cx.settle();
  assert.equal(host.calls.length, 2); assert.equal(browser.path, "/root");
  assert.ok(browser.visibleEntries().some(row => row.path === "/root/folder/nested" && row.depth === 1));
  browser.selected = "/root/folder/nested";
  browser.toggle("/root/folder", cx);
  assert.equal(browser.selected, "/root/folder");
  browser.toggle("/root/folder", cx); await cx.settle();
  assert.equal(host.calls.length, 2, "cached branches are reused");
  browser.close();
});

test("late branch responses cannot populate a newly selected root", async () => {
  const { cx, browser } = setup(); let finish;
  host.handler = async () => folderListing("/root");
  browser.sync(true, cx); await cx.settle();
  host.handler = args => args.at(-1) === "/root/folder" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(listing("/other"));
  browser.toggle("/root/folder", cx); await Promise.resolve();
  browser.navigate("/other", cx); await Promise.resolve();
  finish(listing("/root/folder", "old")); await cx.settle();
  assert.equal(browser.path, "/other"); assert.equal(browser.tree.branches.size, 0);
  browser.close();
});

test("a failed root navigation restarts interrupted expansions instead of leaving them loading", async () => {
  const { cx, browser } = setup(); let finish, reads = 0;
  host.handler = async () => folderListing("/root");
  browser.sync(true, cx); await cx.settle();
  host.handler = args => args.at(-1) === "/missing" ? Promise.resolve(response("ERROR cannot-open "))
    : ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(listing("/root/folder", "fresh"));
  browser.toggle("/root/folder", cx); await Promise.resolve();
  browser.navigate("/missing", cx); await Promise.resolve();
  finish(listing("/root/folder", "stale")); await cx.settle();
  assert.equal(browser.path, "/root");
  assert.ok(browser.visibleEntries().some(row => row.name === "fresh"));
  assert.ok(!browser.tree.rows(false).some(row => row.message === "loading"));
  browser.close();
});

test("right-click actions target the clicked entry rather than the old selection", async () => {
  const { cx, browser } = setup();
  host.handler = async () => folderListing("/root");
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/root/folder";
  browser.openMenu("/root/file", pointer(20, 50), cx);
  browser.chooseMenu("path", cx);
  assert.equal(cx.clipboard, "/root/file"); assert.equal(browser.menu, null);
  browser.openMenu("/root/folder", pointer(20, 50), cx); browser.chooseMenu("mv", cx);
  assert.equal(browser.operation.source, "/root/folder"); assert.equal(host.calls.length, 1);
  browser.close();
});

test("drag requires a threshold and a valid folder; Escape and leaving the view cancel", async () => {
  const { cx, browser } = setup();
  host.handler = async () => folderListing("/root");
  browser.sync(true, cx); await cx.settle();
  browser.startPress("/root/file", pointer(10, 10), cx);
  browser.dragOver("/root/target", pointer(12, 12), cx); browser.drop("/root/target", cx);
  assert.equal(host.calls.length, 1);
  browser.startPress("/root/folder", pointer(10, 10), cx);
  browser.dragOver("/root/folder", pointer(30, 30), cx); browser.drop("/root/folder", cx);
  assert.equal(host.calls.length, 1);
  browser.startPress("/root/file", pointer(10, 10), cx);
  browser.dragOver("/root/target", pointer(30, 30), cx); browser.cancel(cx); browser.drop("/root/target", cx);
  assert.equal(host.calls.length, 1);
  browser.startPress("/root/file", pointer(10, 10), cx);
  browser.dragOver("/root/target", pointer(30, 30), cx); browser.sync(false, cx); browser.drop("/root/target", cx);
  assert.equal(host.calls.length, 1); browser.close();
});

test("dropping a nested file moves locally and refreshes the same tree root", async () => {
  const { cx, browser } = setup();
  host.handler = async args => args.at(-1) === "~" ? folderListing("/root") : listing("/root/folder", "nested");
  browser.sync(true, cx); await cx.settle();
  browser.toggle("/root/folder", cx); await cx.settle();
  host.handler = async args => args.at(-4) === "mv" ? response(`DONE ${hex("/root/target/nested")}`)
    : args.at(-1) === "/root" ? folderListing("/root") : listing(args.at(-1));
  browser.startPress("/root/folder/nested", pointer(10, 10), cx);
  browser.dragOver("/root/target", pointer(30, 50), cx); browser.drop("/root/target", cx);
  await cx.settle();
  const call = host.calls.find(args => args.at(-4) === "mv");
  assert.deepEqual(call.slice(-4), ["mv", "/root/folder/nested", "/root/target", "/root/folder"]);
  assert.equal(call.includes("--on"), false);
  assert.equal(browser.path, "/root"); assert.ok(browser.tree.expanded.has("/root/target"));
  assert.equal(browser.operation, null); browser.close();
});
