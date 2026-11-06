import assert from "node:assert/strict";
import test from "node:test";
import { fixture, runtime, findElement, sampleProfiles } from "./runtime.mjs";
const { default: AgentProfiles } = await import("../main.js");
const key = (name, control = false) => ({ key: name, modifiers: { control, platform: false, alt: false, shift: false } });

async function load(f, props = { overlay: "manager-overlay" }) {
  runtime.props = () => props;
  const mod = new AgentProfiles(); mod.init(props, f.cx); await f.flush();
  return mod;
}

test("opening the standalone mod shows the searchable profile manager", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const mod = await load(f);
  const root = mod.render(f.cx);
  assert.ok(findElement(root, "settings-agent-search"));
  assert.ok(findElement(root, "settings-agent-claude"));
  assert.ok(findElement(root, "agent-profiles-open-launcher"));
  assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
});

test("the manager accepts a selected profile and machine", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const mod = await load(f, { view: "profiles", agent: "claude", profile: "work", machine: null });
  assert.equal(mod.editor.machine, null); assert.equal(mod.editor.currentProfile().id, "work");
});

test("launcher mode uses the same standalone mod and has no separate Start button", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const mod = await load(f, { view: "launcher", overlay: "launcher-overlay" });
  const root = mod.render(f.cx);
  assert.ok(findElement(root, "agent-profiles-launcher"));
  assert.ok(findElement(root, "launch-profile:claude:work"));
  assert.equal(findElement(root, "launch-start"), null);
  assert.equal(findElement(root, "settings-agent-search"), null);
});

test("opening and returning from the launcher preserves the manager's unsaved draft", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const manager = await load(f, { agent: "claude", profile: "work", overlay: "manager-overlay" });
  const profile = manager.editor.currentProfile(); profile.input.edit_value("--draft");
  findElement(manager.render(f.cx), "agent-profiles-open-launcher").handlers.on_click({}, f.cx);
  assert.deepEqual(f.overlays[0], { mod: "agent-profiles", kind: "popup", width: 440, height: 480,
    props: { view: "launcher", returnToManager: true } });
  assert.equal(f.closed.length, 0);
  const launcher = await load(f, { ...f.overlays[0].props, overlay: "launcher-popup" });
  findElement(launcher.render(f.cx), "launch-manage").handlers.on_click({}, f.cx);
  assert.deepEqual(f.closed, ["launcher-popup"]); assert.equal(f.overlays.length, 1);
  assert.equal(manager.editor.currentProfile(), profile); assert.equal(profile.input.value(), "--draft");
  assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
});

test("Ctrl+Enter saves from the manager's own keyboard focus", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const mod = await load(f, { agent: "claude", profile: "work", overlay: "manager-overlay" });
  mod.editor.currentProfile().input.edit_value("--verbose");
  mod.render(f.cx).handlers.on_key_down(key("enter", true), f.cx); await f.flush();
  assert.deepEqual(f.json().agents.claude.profiles[0].args, ["--verbose"]);
  assert.equal(f.calls.length, 0);
});

test("Close and Escape affect only this mod's own overlay", async () => {
  const f = fixture(); const mod = await load(f);
  findElement(mod.render(f.cx), "agent-profiles-close").handlers.on_click({}, f.cx);
  assert.deepEqual(f.closed, ["manager-overlay"]);
  const embedded = await load(f, {});
  assert.equal(findElement(embedded.render(f.cx), "agent-profiles-close"), null);
  embedded.render(f.cx).handlers.on_key_down(key("escape"), f.cx);
  assert.deepEqual(f.closed, ["manager-overlay"]);
});
