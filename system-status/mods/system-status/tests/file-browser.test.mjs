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
  const browser = new FileBrowser(cx, "en");
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

test("changing the active space does not discard a pending local directory load", async () => {
  const { cx, browser } = setup();
  let finishFirst;
  host.handler = () => new Promise(resolve => { finishFirst = resolve; });
  browser.sync(true, cx); await Promise.resolve();
  host.spaces = [{ id: "remote", machine: "second", folder: "/second", active: true }];
  browser.sync(true, cx); await Promise.resolve();
  finishFirst(listing("/first")); await cx.settle();
  assert.equal(browser.path, "/first");
  assert.equal(host.calls.length, 1);
  assert.equal(browser.loading, false);
  browser.close();
});

test("changing spaces or hiding the panel preserves the selection and pending form", async () => {
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

test("a pending move completes locally and refreshes the same folder after switching spaces", async () => {
  const { cx, browser } = setup();
  let finishOperation;
  host.handler = async () => listing("/first");
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/first/file"; browser.begin("mv", cx); browser.destinationInput.set_value("/moved");
  host.handler = args => args.at(-4) === "mv" ? new Promise(resolve => { finishOperation = resolve; }) : Promise.resolve(listing("/first"));
  browser.confirm(cx); await Promise.resolve();
  host.spaces = [{ id: "remote", machine: "second", folder: "/second", active: true }];
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
  host.spaces = [{ id: "remote", machine: "second", folder: "/second", active: true }];
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
