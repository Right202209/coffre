import assert from "node:assert/strict";
import test from "node:test";
import { fixture, runtime, findElement, sampleProfiles } from "./runtime.mjs";
import { ORDER, entryId } from "../order.js";
const { default: NewMenu } = await import("../launcher.js");

async function load(f) { const menu = new NewMenu(); menu.init({}, f.cx); await f.flush(); return menu; }
function control(menu, f, id) {
  const button = findElement(menu.render(f.cx), `launch-${id}`);
  assert.ok(button, `${id} exists`); return button;
}
function click(menu, f, id) { control(menu, f, id).handlers.on_click({}, f.cx); }
const key = name => ({ key: name, modifiers: { control: false, platform: false, alt: false, shift: false } });
const pointer = (y, localY = 17) => ({ button: "left", position: { x: 100, y }, local_position: { x: 100, y: localY }, bounds: { x: 0, y: y - localY, width: 440, height: 34 } });
const order = menu => menu.entries().map(({ agent, profile }) => [agent.key, profile.id]);
function text(root) {
  if (typeof root === "string") return [root];
  return (root?.nodes ?? []).flatMap(text);
}

test("available agents and their saved profiles both appear in the launcher list", async () => {
  const profiles = sampleProfiles();
  profiles.agents.missing = { profiles: [{ id: "missing", name: "Unavailable", args: [] }] };
  const f = fixture({ profiles, agents: [
    { key: "claude", name: "Claude Code", installed: true, run: ["claude"] },
    { key: "codex", name: "Codex", installed: true, run: ["codex"] },
    { key: "missing", name: "Missing Agent", installed: false, run: ["missing"] },
  ] });
  const menu = await load(f), root = menu.render(f.cx), labels = text(root);
  assert.ok(labels.includes("Work")); assert.ok(labels.includes("Review"));
  assert.ok(labels.includes("Claude Code")); assert.ok(labels.includes("Codex"));
  for (const label of ["Default", "Missing Agent", "Unavailable", "Command"]) assert.ok(!labels.includes(label), `${label} is hidden`);
  assert.ok(findElement(root, "launch-agent:claude")); assert.ok(findElement(root, "launch-agent:codex"));
  assert.equal(findElement(root, "launcher-agent-tabs"), null);
  assert.equal(findElement(root, "launcher-command"), null);
  assert.equal(findElement(root, "launch-start"), null);
});

test("clicking a saved profile launches its named tab immediately and only once", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
  assert.equal(menu.loadError, null);
  const row = control(menu, f, "profile:claude:work");
  row.handlers.on_click({}, f.cx); row.handlers.on_click({}, f.cx); await f.flush();
  assert.deepEqual(f.calls, [{ name: "tab.new", args: {
    name: "Work", space: "space-a", argv: ["claude", "--settings", "/profiles/work settings.json", "--model", "sonnet"],
  } }]);
  assert.equal(f.shared.get("personal-launcher.selection").profiles.claude, "work");
  assert.deepEqual(f.closed, ["launcher-overlay"]);
});

test("an available agent without saved profiles launches its configured command", async () => {
  const f = fixture({ programs: { programs: { claude: { run: ["my-claude", "--verbose"] } } } });
  const menu = await load(f);
  click(menu, f, "agent:claude"); await f.flush();
  assert.deepEqual(f.calls, [{ name: "tab.new", args: { name: "Claude Code", space: "space-a", argv: ["my-claude", "--verbose"] } }]);
});

test("an empty device list cannot launch an unavailable agent or its profiles", async () => {
  const f = fixture({ profiles: sampleProfiles(), agents: [{ key: "claude", name: "Claude Code", installed: false, run: ["claude"] }] });
  const menu = await load(f);
  assert.equal(menu.choices.length, 0);
  assert.match(text(menu.render(f.cx)).join(" "), /No available agents/);
  menu.key(key("1"), f.cx); menu.key(key("enter"), f.cx); await f.flush();
  assert.equal(f.calls.length, 0);
  click(menu, f, "manage"); assert.deepEqual(f.overlays[0].props, { view: "profiles", machine: "remote" });
});

test("a profile edited while the menu is open must be reviewed before launch", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
  const updated = sampleProfiles(); updated.agents.claude.profiles[0].args = ["--settings", "/profiles/new.json"];
  f.files.set("agent-launch-profiles.json", JSON.stringify(updated));
  click(menu, f, "profile:claude:work"); await f.flush();
  assert.equal(f.calls.length, 0); assert.match(menu.message, /settings changed/);
  click(menu, f, "profile:claude:work"); await f.flush();
  assert.deepEqual(f.calls[0].args.argv, ["claude", "--settings", "/profiles/new.json"]);
});

test("renames update the tab title without losing selection", async () => {
  const f = fixture({ profiles: sampleProfiles(), selection: { agent: "claude", profiles: { claude: "work" } } });
  const menu = await load(f); const updated = sampleProfiles(); updated.agents.claude.profiles[0].name = "Project A";
  f.files.set("agent-launch-profiles.json", JSON.stringify(updated));
  click(menu, f, "profile:claude:work"); await f.flush(); assert.equal(f.calls.length, 0);
  assert.equal(menu.profile().id, "work"); assert.equal(menu.profile().name, "Project A");
  click(menu, f, "profile:claude:work"); await f.flush(); assert.equal(f.calls[0].args.name, "Project A");
});

test("deleted profiles do not silently launch Default", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
  const staleRow = control(menu, f, "profile:claude:work");
  const updated = sampleProfiles(); updated.agents.claude.profiles.shift();
  f.files.set("agent-launch-profiles.json", JSON.stringify(updated));
  staleRow.handlers.on_click({}, f.cx); await f.flush();
  assert.equal(f.calls.length, 0); assert.match(menu.message, /no longer exists/);
  assert.equal(menu.profile().id, "review");
  assert.equal(findElement(menu.render(f.cx), "launch-profile:claude:work"), null);
  staleRow.handlers.on_click({}, f.cx); await f.flush(); assert.equal(f.calls.length, 0);
});

test("Edit profiles opens this mod at the selected agent and profile", async () => {
  const f = fixture({ profiles: sampleProfiles(), selection: { agent: "claude", profiles: { claude: "review" } } });
  const menu = await load(f); click(menu, f, "manage");
  assert.deepEqual(f.overlays[0].props, { view: "profiles", machine: "remote", agent: "claude", profile: "review" });
  assert.equal(f.overlays[0].mod, "agent-profiles"); assert.equal(f.calls.length, 0);
});

test("Up and Down follow the visible profile list across agents and Enter launches", async () => {
  const profiles = sampleProfiles(); profiles.agents.codex = { profiles: [{ id: "code", name: "Code", args: ["--model", "custom"] }] };
  const f = fixture({ profiles }); const menu = await load(f);
  assert.equal(menu.profile().id, "default"); assert.equal(menu.current().key, "claude");
  menu.key(key("down"), f.cx); assert.equal(menu.profile().id, "default"); assert.equal(menu.current().key, "codex");
  menu.key(key("down"), f.cx); assert.equal(menu.profile().id, "work");
  menu.key(key("down"), f.cx); assert.equal(menu.profile().id, "review");
  menu.key(key("down"), f.cx); assert.equal(menu.profile().id, "code");
  menu.key(key("up"), f.cx); assert.equal(menu.profile().id, "review");
  menu.key(key("up"), f.cx); menu.key(key("up"), f.cx); menu.key(key("up"), f.cx); menu.key(key("up"), f.cx); assert.equal(menu.profile().id, "code");
  menu.key(key("enter"), f.cx); await f.flush();
  assert.deepEqual(f.calls[0].args, { name: "Code", space: "space-a", argv: ["codex", "--model", "custom"] });
});

test("number shortcuts include both native agent rows and saved profile rows", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
  menu.key(key("4"), f.cx); await f.flush();
  assert.deepEqual(f.calls[0].args, { name: "Review", space: "space-a", argv: ["claude", "--settings", "/profiles/review.json", "--verbose"] });
});

test("malformed profiles block agent launches and offer retry", async () => {
  const f = fixture({ profiles: "{" }); const menu = await load(f);
  assert.match(menu.loadError, /invalid JSON/); menu.start(f.cx); await f.flush(); assert.equal(f.calls.length, 0);
  f.files.set("agent-launch-profiles.json", JSON.stringify(sampleProfiles())); click(menu, f, "retry"); await f.flush();
  assert.equal(menu.loadError, null); assert.equal(menu.profile().id, "default");
});

test("an agent that becomes unavailable while the menu is open is removed and cannot launch", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
  f.agents[0].installed = false;
  click(menu, f, "profile:claude:work"); await f.flush();
  assert.equal(f.calls.length, 0); assert.match(menu.message, /not installed/);
  assert.deepEqual(menu.choices.map(a => a.key), ["codex"]);
  assert.match(text(menu.render(f.cx)).join(" "), /not installed/);
});

test("a closed space cannot receive a profile launch", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f); f.spaces.splice(0);
  click(menu, f, "profile:claude:work"); await f.flush();
  assert.match(menu.message, /space was closed/); assert.equal(f.calls.length, 0);
});

test("Enter on a focused profile row launches that row rather than the remembered profile", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
  control(menu, f, "profile:claude:review").handlers.on_key_down(key("enter"), f.cx); await f.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.name, "Review");
});

test("a normal pointer press launches once regardless of click listener order", async () => {
  for (const earlyClick of [true, false]) {
    const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
    const row = control(menu, f, "profile:claude:work");
    row.handlers.on_mouse_down(pointer(17), f.cx);
    if (earlyClick) row.handlers.on_click({}, f.cx);
    row.handlers.on_mouse_up(pointer(17), f.cx);
    if (!earlyClick) row.handlers.on_click({}, f.cx);
    await f.flush();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.name, "Work");
  }
});

test("dragging can mix agent and profile rows; saved order survives reopening and drives shortcuts", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
  control(menu, f, "agent:claude").handlers.on_mouse_down(pointer(17), f.cx);
  const target = control(menu, f, "profile:claude:work");
  target.handlers.on_mouse_move(pointer(100, 26), f.cx);
  assert.equal(menu.drag.active, true);
  target.handlers.on_mouse_up(pointer(100, 26), f.cx);
  target.handlers.on_click({}, f.cx); await f.flush();
  const expected = [["codex", "default"], ["claude", "work"], ["claude", "default"], ["claude", "review"]];
  assert.deepEqual(order(menu), expected);
  assert.deepEqual(f.shared.get(ORDER).remote, expected.map(([agent, profile]) => entryId(agent, profile)));
  assert.equal(f.calls.length, 0); assert.equal(f.closed.length, 0);
  const reopened = await load(f); assert.deepEqual(order(reopened), expected);
  reopened.key(key("1"), f.cx); await f.flush();
  assert.deepEqual(f.calls[0].args, { name: "Codex", space: "space-a", argv: ["codex"] });
});

test("a grip click or same-row drag does not start an agent and does not swallow the next real click", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
  const row = control(menu, f, "agent:claude");
  const grip = findElement(menu.render(f.cx), "launch-grip-agent:claude");
  grip.handlers.on_mouse_down(pointer(17), f.cx); row.handlers.on_mouse_up(pointer(17), f.cx);
  grip.handlers.on_click({}, f.cx); row.handlers.on_click({}, f.cx); await f.flush();
  assert.equal(f.calls.length, 0); assert.equal(f.shared.has(ORDER), false);
  row.handlers.on_mouse_down(pointer(17), f.cx); row.handlers.on_mouse_move(pointer(24), f.cx);
  row.handlers.on_mouse_up(pointer(24), f.cx); row.handlers.on_click({}, f.cx); await f.flush();
  assert.equal(f.calls.length, 0); assert.equal(f.shared.has(ORDER), false);
  row.handlers.on_mouse_down(pointer(17), f.cx); row.handlers.on_mouse_up(pointer(17), f.cx);
  row.handlers.on_click({}, f.cx); await f.flush(); assert.equal(f.calls.length, 1);
});

test("leaving the popup or pressing Escape cancels a drag without launching or saving", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const menu = await load(f);
  for (const escape of [false, true]) {
    const row = control(menu, f, "agent:claude");
    row.handlers.on_mouse_down(pointer(17), f.cx); row.handlers.on_mouse_move(pointer(24), f.cx);
    if (escape) menu.key(key("escape"), f.cx);
    else menu.render(f.cx).handlers.on_hover(false, f.cx);
    row.handlers.on_click({}, f.cx); await f.flush();
    assert.equal(menu.drag, null); assert.equal(f.calls.length, 0); assert.equal(f.shared.has(ORDER), false);
  }
});

test("each machine retains its own order and unavailable items recover their saved positions", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const saved = [entryId("claude", "review"), entryId("codex", "default"), entryId("claude", "default"), entryId("claude", "work")];
  f.shared.set(ORDER, { remote: saved, "": [entryId("claude", "default")] });
  const menu = await load(f); assert.equal(menu.entries()[0].profile.id, "review");
  f.agents[1].installed = false; menu.reload(f.cx); await f.flush();
  assert.ok(!menu.entries().some(({ agent }) => agent.key === "codex"));
  f.agents[1].installed = true; menu.reload(f.cx); await f.flush();
  assert.deepEqual(menu.entries().map(e => e.id), saved);
  f.spaces[0].machine = null;
  const local = await load(f); assert.equal(local.entries()[0].profile.id, "default");
  assert.deepEqual(f.shared.get(ORDER).remote, saved);
});

test("terminal and worktree actions keep their original behavior and context", async () => {
  const f = fixture(); const menu = await load(f);
  click(menu, f, "terminal"); assert.deepEqual(f.calls[0], { name: "tab.new", args: { space: "space-a" } });
  click(menu, f, "worktree");
  assert.deepEqual(f.overlays[0].props, { space: "space-a", folder: "/repo", action: "new" });
});

test("installation checks follow the machine of the space where the menu opened", async () => {
  const f = fixture({ profiles: sampleProfiles() }); let machine;
  runtime.knownAgents = async options => { machine = options.on; return f.agents; };
  const menu = await load(f); assert.equal(machine, "remote");
  f.spaces.push({ id: "space-b", active: true, machine: null }); f.spaces[0].active = false;
  click(menu, f, "profile:claude:work"); await f.flush(); assert.equal(f.calls[0].args.space, "space-a");
});
