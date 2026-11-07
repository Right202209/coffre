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
const packet = body => ({ code: 0, stdout: JSON.stringify({ code: 0, stdout: `HERDR_FILES_V1\n${body}\nEND\n` }) });
const listing = (path, name = "file") => packet(`PATH ${hex(path)}\nENTRY d 1 0 0 ${hex("folder")}\nENTRY f 0 1 0 ${hex(name)}\nLIMIT 0`);
const target = (machine, space = "one", connection = "ready") => ({ machine, name: machine || "local", space, connection });
const on = args => args.includes("--on") ? args[args.indexOf("--on") + 1] : null;
function setup(machine = null) {
  host.calls = []; host.saved = {};
  const cx = context(), current = { target: target(machine) };
  host.handler = async args => listing(on(args) ? "/remote" : "/local");
  const browser = new FileBrowser(cx, "en", () => current.target);
  return { cx, current, browser };
}

test("only a machine change switches the tree; revisiting restores tree, selection and scroll", async () => {
  const { cx, current, browser } = setup();
  browser.sync(true, cx); await cx.settle();
  browser.tree.expanded.add("/local/folder");
  browser.tree.setChildren("/local/folder", { path: "/local/folder", entries: [] });
  browser.selected = "/local/file"; browser.scrollOffset = 81;
  browser.begin("mv", cx); browser.destinationInput.set_value("new-name");
  const tree = browser.tree;
  current.target = { ...target(null, "two"), terminal: "another", cwd: "/somewhere" };
  browser.sync(true, cx); await cx.settle();
  assert.equal(browser.tree, tree); assert.equal(browser.scrollOffset, 81);
  assert.equal(browser.destinationInput.value(), "new-name"); assert.equal(host.calls.length, 1);
  current.target = target("server"); browser.sync(true, cx); await cx.settle();
  assert.equal(on(host.calls.at(-1)), "server"); assert.equal(host.calls.at(-1).at(-1), "~");
  assert.equal(browser.path, "/remote"); assert.equal(browser.operation, null);
  current.target = target(null, "three"); browser.sync(true, cx); await cx.settle();
  assert.equal(browser.path, "/local"); assert.equal(browser.tree, tree);
  assert.ok(browser.tree.expanded.has("/local/folder"));
  assert.equal(browser.selected, "/local/file"); assert.equal(browser.scrollOffset, 81);
  assert.equal(host.calls.length, 2); browser.close();
});

test("late root and branch responses stay on their original machine", async () => {
  const { cx, current, browser } = setup("a"); let finishRoot, finishBranch;
  host.handler = args => on(args) === "a" ? new Promise(resolve => { finishRoot = resolve; }) : Promise.resolve(listing("/same", "b-file"));
  browser.sync(true, cx); await Promise.resolve();
  current.target = target("b"); browser.sync(true, cx); await Promise.resolve();
  finishRoot(listing("/same", "a-file")); await cx.settle();
  assert.equal(browser.path, "/same"); assert.ok(browser.visibleEntries().some(row => row.name === "b-file"));
  host.handler = args => on(args) === "b" ? new Promise(resolve => { finishBranch = resolve; }) : Promise.resolve(listing("/same", "a-file"));
  browser.toggle("/same/folder", cx); await Promise.resolve();
  current.target = target("a"); browser.sync(true, cx); await Promise.resolve();
  finishBranch(listing("/same/folder", "old-child")); await cx.settle();
  assert.equal(browser.tree.branches.size, 0); assert.ok(!browser.visibleEntries().some(row => row.name === "old-child"));
  browser.close();
});

test("a stale form cannot run after a machine switch even before sync", async () => {
  const { cx, current, browser } = setup("a");
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/remote/file"; browser.begin("mv", cx);
  current.target = target("b"); browser.confirm(cx); await cx.settle();
  assert.equal(host.calls.length, 1);
  browser.sync(true, cx); await cx.settle();
  assert.equal(browser.operation, null); assert.equal(browser.selected, null);
  browser.close();
});

test("an in-flight move stays on the source machine and cannot be submitted twice on return", async () => {
  const { cx, current, browser } = setup("a"); let finish;
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/remote/file"; browser.begin("mv", cx); browser.destinationInput.set_value("renamed");
  host.handler = args => args.at(-4) === "mv" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(listing("/remote"));
  browser.confirm(cx);
  current.target = target("b"); browser.sync(true, cx); await Promise.resolve();
  assert.equal(on(host.calls.find(args => args.at(-4) === "mv")), "a");
  current.target = target("a"); browser.sync(true, cx); browser.confirm(cx);
  assert.equal(browser.working, true);
  finish(packet(`DONE ${hex("/remote/renamed")}`)); await cx.settle();
  assert.equal(host.calls.filter(args => args.at(-4) === "mv").length, 1);
  assert.equal(browser.working, false); assert.match(browser.notice, /Moved to/);
  browser.close();
});

test("an offline remote never falls back to local execution and reconnects at the saved folder", async () => {
  const { cx, current, browser } = setup("server");
  browser.sync(true, cx); await cx.settle();
  current.target = target("server", "one", "unavailable"); browser.sync(true, cx);
  browser.refresh(cx); browser.selected = "/remote/file"; browser.begin("mv", cx); await cx.settle();
  assert.equal(host.calls.length, 1); assert.equal(browser.available(), false); assert.equal(browser.path, "/remote");
  current.target = target("server", "two"); browser.sync(true, cx); await cx.settle();
  assert.equal(on(host.calls.at(-1)), "server"); assert.equal(host.calls.at(-1).at(-1), "/remote");
  browser.close();
});

test("remote preferences are isolated from the existing local saved directory", async () => {
  const { cx, current, browser } = setup();
  browser.sync(true, cx); await cx.settle();
  current.target = target("server"); browser.sync(true, cx); await cx.settle();
  assert.equal(host.saved["system-status.files.browser"].path, "/local");
  browser.close();
  const restored = new FileBrowser(cx, "en", () => current.target);
  restored.sync(true, cx); await cx.settle();
  assert.equal(host.calls.at(-1).at(-1), "/remote"); assert.equal(on(host.calls.at(-1)), "server");
  restored.close();
});

test("remote branch loads and drag moves use the same machine as the tree", async () => {
  const { cx, browser } = setup("server");
  browser.sync(true, cx); await cx.settle();
  host.handler = async args => args.at(-4) === "mv" ? packet(`DONE ${hex("/remote/folder/file")}`) : listing(args.at(-1));
  browser.toggle("/remote/folder", cx); await cx.settle();
  browser.startPress("/remote/file", { position: { x: 0, y: 0 } }, cx);
  browser.dragOver("/remote/folder", { position: { x: 20, y: 40 } }, cx); browser.drop("/remote/folder", cx);
  await cx.settle();
  assert.ok(host.calls.some(args => args.at(-4) === "mv"));
  assert.ok(host.calls.every(args => on(args) === "server")); browser.close();
});

test("a background move refreshes only its machine when revisited", async () => {
  const { cx, current, browser } = setup("a"); let finish;
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/remote/file"; browser.begin("mv", cx); browser.destinationInput.set_value("renamed");
  host.handler = args => args.at(-4) === "mv" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(listing("/remote"));
  browser.confirm(cx); current.target = target("b"); browser.sync(true, cx); await Promise.resolve();
  finish(packet(`DONE ${hex("/remote/renamed")}`)); await cx.settle();
  assert.equal(browser.working, false); assert.equal(browser.notice, ""); assert.equal(browser.error, "");
  const calls = host.calls.length;
  current.target = target("a"); browser.sync(true, cx); await cx.settle();
  assert.equal(host.calls.length, calls + 1); assert.equal(on(host.calls.at(-1)), "a");
  assert.equal(host.calls.at(-1).at(-1), "/remote"); assert.match(browser.notice, /Moved to/);
  assert.equal(browser.working, false); browser.close();
});

test("a failed background operation releases its machine without reopening the old form", async () => {
  const { cx, current, browser } = setup("a"); let finish;
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/remote/file"; browser.begin("cp", cx); browser.destinationInput.set_value("copy");
  host.handler = args => args.at(-4) === "cp" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(listing("/remote"));
  browser.confirm(cx); current.target = target("b"); browser.sync(true, cx); await Promise.resolve();
  finish(packet("ERROR destination-exists ")); await cx.settle();
  assert.equal(browser.error, "");
  current.target = target("a"); browser.sync(true, cx); await cx.settle();
  assert.equal(browser.working, false); assert.equal(browser.operation, null);
  assert.match(browser.error, /already exists/); browser.begin("cp", cx); assert.ok(browser.operation);
  browser.close();
});

test("a remote starts offline without reading local files; no-session local browsing stays available", async () => {
  const { cx, current, browser } = setup("server");
  current.target = target("server", "one", "loading"); browser.sync(true, cx);
  browser.navigate("/", cx); browser.refresh(cx); await cx.settle();
  assert.equal(host.calls.length, 0); assert.equal(browser.available(), false);
  current.target = target(null, null, "no-session"); browser.sync(true, cx); await cx.settle();
  assert.equal(host.calls.length, 1); assert.equal(on(host.calls[0]), null);
  assert.equal(browser.path, "/local"); assert.equal(browser.available(), true); browser.close();
});

test("reconnecting during a move does not hide its eventual failure", async () => {
  const { cx, current, browser } = setup("a"); let finish;
  browser.sync(true, cx); await cx.settle();
  browser.selected = "/remote/file"; browser.begin("mv", cx); browser.destinationInput.set_value("renamed");
  host.handler = () => new Promise(resolve => { finish = resolve; });
  browser.confirm(cx); await Promise.resolve();
  current.target = target("a", "one", "unavailable"); browser.sync(true, cx);
  current.target = target("a"); browser.sync(true, cx);
  finish(packet("ERROR timeout ")); await cx.settle(); browser.sync(true, cx); await cx.settle();
  assert.equal(host.calls.length, 2); assert.equal(browser.working, false);
  assert.match(browser.error, /partially/); assert.equal(browser.notice, ""); browser.close();
});

test("reloading while all branch slots are occupied restarts expansions under the new generation", async () => {
  const { cx, browser } = setup("server"), finishes = [];
  const folders = packet(`PATH ${hex("/remote")}\n${["a", "b", "c"].map(name => `ENTRY d 1 0 0 ${hex(name)}`).join("\n")}\nLIMIT 0`);
  host.handler = async () => folders; browser.sync(true, cx); await cx.settle();
  host.handler = () => new Promise(resolve => { finishes.push(resolve); });
  for (const name of ["a", "b", "c"]) browser.toggle(`/remote/${name}`, cx);
  await Promise.resolve(); assert.equal(finishes.length, 3);
  host.handler = async args => args.at(-1) === "/remote" ? folders : listing(args.at(-1), "fresh");
  browser.refresh(cx);
  for (const finish of finishes) finish(listing("/remote/a", "old"));
  await cx.settle();
  assert.equal(browser.visibleEntries().filter(row => row.name === "fresh").length, 3);
  assert.ok(!browser.tree.rows(false).some(row => row.message === "loading")); browser.close();
});
