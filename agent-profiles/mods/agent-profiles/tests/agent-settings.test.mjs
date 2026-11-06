import assert from "node:assert/strict";
import test from "node:test";
import { fixture, runtime, findElement, sampleProfiles } from "./runtime.mjs";
import { ORDER, entryId } from "../order.js";
const { AgentSettings } = await import("../agent-settings.js");
const { default: NewMenu } = await import("../launcher.js");
const profileRow = (agent, profile) => `settings-profile-${entryId(agent, profile)}`;
const pointer = (y, localY = 23) => ({ button: "left", position: { x: 100, y }, local_position: { x: 100, y: localY }, bounds: { x: 0, y: y - localY, width: 212, height: 46 } });
function texts(root) { return typeof root === "string" ? [root] : (root?.nodes ?? []).flatMap(texts); }

async function load(f, options = {}) {
  const editor = new AgentSettings(options); editor.load(f.cx); await f.flush();
  assert.equal(editor.error, null); return editor;
}
function click(editor, f, id) {
  const button = findElement(editor.render(runtime.theme()), id);
  assert.ok(button, `control ${id} exists`); button.handlers.on_click({}, f.cx);
}

test("existing commands load as Default without writing or losing saved arguments", async () => {
  const f = fixture({ programs: { programs: { claude: { run: ["my-claude", "--settings", "/tmp/my settings.json"] } } }, profiles: sampleProfiles() });
  const editor = await load(f);
  assert.equal(editor.current().command, "my-claude");
  assert.equal(editor.currentProfile().input.value(), "--settings '/tmp/my settings.json'");
  assert.deepEqual(editor.current().profiles.map(p => p.nameInput.value()), ["Default", "Work", "Review"]);
  assert.equal(f.writes.length, 0);
  assert.equal(findElement(editor.render(runtime.theme()), "profile-remove"), null);
});

test("multiple flags on separate lines save with Ctrl+Enter; plain Enter does not save", async () => {
  const f = fixture(); const editor = await load(f); const profile = editor.currentProfile();
  profile.input.edit_value('--settings "/tmp/my settings.json"\n--model sonnet\n--verbose');
  profile.input.submit({ secondary: false }); await f.flush(); assert.equal(f.writes.length, 0);
  profile.input.submit(); await f.flush();
  assert.deepEqual(f.json("programs.json").programs.claude.run,
    ["claude", "--settings", "/tmp/my settings.json", "--model", "sonnet", "--verbose"]);
  assert.equal(profile.input.value(), profile.savedText);
  assert.equal(profile.notice, "Saved");
  assert.equal(f.files.get("agent-launch-profiles.json"), null);
});

test("create, save, rename, and reopen a named profile while preserving Default", async () => {
  const programs = { programs: { claude: { run: ["claude", "--verbose"] } } };
  const f = fixture({ programs }); const editor = await load(f);
  click(editor, f, "profile-add");
  const profile = editor.currentProfile(), id = profile.id;
  profile.nameInput.edit_value("Work");
  profile.input.edit_value('--settings "/tmp/work settings.json"\n--model sonnet');
  assert.equal(f.writes.length, 0);
  click(editor, f, "profile-save"); await f.flush();
  assert.deepEqual(f.json().agents.claude.profiles[0],
    { id, name: "Work", args: ["--settings", "/tmp/work settings.json", "--model", "sonnet"] });
  assert.deepEqual(f.json("programs.json"), programs);
  profile.nameInput.edit_value("Project A");
  click(editor, f, "profile-save"); await f.flush();
  assert.equal(f.json().agents.claude.profiles[0].id, id);
  const reopened = await load(f, { agent: "claude", profile: id });
  assert.equal(reopened.currentProfile().nameInput.value(), "Project A");
});

test("agent and profile list selections preserve unsaved drafts when switching", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const editor = await load(f, { agent: "claude", profile: "work" });
  editor.currentProfile().input.edit_value("--new-draft");
  click(editor, f, profileRow("claude", "review"));
  assert.equal(editor.currentProfile().nameInput.value(), "Review");
  click(editor, f, "settings-agent-codex");
  click(editor, f, "settings-agent-claude");
  click(editor, f, profileRow("claude", "work"));
  assert.equal(editor.currentProfile().input.value(), "--new-draft");
  assert.equal(f.writes.length, 0);
});

test("duplicates have a new id and editable name and can be discarded before saving", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const editor = await load(f, { agent: "claude", profile: "work" });
  const original = editor.currentProfile(); click(editor, f, "profile-duplicate");
  const duplicate = editor.currentProfile();
  assert.notEqual(duplicate.id, original.id);
  assert.equal(duplicate.nameInput.value(), "Work copy");
  assert.deepEqual(duplicate.args, original.args);
  click(editor, f, "profile-remove");
  assert.equal(editor.current().profiles.length, 3); assert.equal(f.writes.length, 0);
});

test("removing a saved profile requires confirmation and preserves its siblings", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const editor = await load(f, { agent: "claude", profile: "work" });
  click(editor, f, "profile-remove"); assert.equal(f.writes.length, 0);
  click(editor, f, "profile-remove-cancel"); assert.equal(f.writes.length, 0);
  click(editor, f, "profile-remove"); click(editor, f, "profile-remove-confirm"); await f.flush();
  assert.deepEqual(f.json().agents.claude.profiles.map(p => p.id), ["review"]);
  assert.equal(editor.currentProfile().id, "default");
});

test("finishing a removal preserves another selected draft and cancels a drag of the removed profile", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const editor = await load(f, { agent: "claude", profile: "work" });
  let finish; const write = runtime.writeTextFile;
  runtime.writeTextFile = async (...args) => { await new Promise(resolve => { finish = resolve; }); return write(...args); };
  click(editor, f, "profile-remove"); click(editor, f, "profile-remove-confirm");
  while (!finish) await Promise.resolve();
  click(editor, f, profileRow("claude", "review"));
  const draft = editor.currentProfile(); draft.input.edit_value("--review-draft");
  const root = editor.render(runtime.theme());
  findElement(root, profileRow("claude", "work")).handlers.on_mouse_down(pointer(23), f.cx);
  findElement(root, profileRow("claude", "review")).handlers.on_mouse_move(pointer(90, 36), f.cx);
  finish(); await f.flush();
  assert.deepEqual(f.json().agents.claude.profiles.map(p => p.id), ["review"]);
  assert.equal(editor.currentProfile(), draft);
  assert.equal(draft.input.value(), "--review-draft"); assert.equal(editor.dirty(draft), true);
  assert.equal(editor.drag, null);
  assert.equal(f.shared.has(ORDER), false); assert.equal(f.calls.length, 0);
});

test("duplicate names and malformed arguments block saves", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const editor = await load(f, { agent: "claude", profile: "work" }); const profile = editor.currentProfile();
  profile.nameInput.edit_value("review"); click(editor, f, "profile-save"); await f.flush();
  assert.match(profile.nameError, /already has/); assert.equal(f.writes.length, 0);
  profile.nameInput.edit_value("Work"); profile.input.edit_value('--settings "unfinished'); profile.input.submit(); await f.flush();
  assert.match(profile.parseError, /Close the double quote/); assert.equal(f.writes.length, 0);
});

test("newer name and argument edits survive an in-flight save", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const editor = await load(f, { agent: "claude", profile: "work" }); const profile = editor.currentProfile();
  let finish; const write = runtime.writeTextFile;
  runtime.writeTextFile = async (...args) => { await new Promise(resolve => { finish = resolve; }); return write(...args); };
  profile.nameInput.edit_value("Work 2"); profile.input.edit_value("--verbose"); profile.input.submit();
  while (!finish) await Promise.resolve();
  profile.nameInput.edit_value("Work 3"); profile.input.edit_value("--verbose --debug"); finish(); await f.flush();
  assert.equal(f.json().agents.claude.profiles[0].name, "Work 2");
  assert.equal(profile.nameInput.value(), "Work 3");
  assert.equal(profile.input.value(), "--verbose --debug"); assert.equal(editor.dirty(profile), true);
});

test("clearing Default flags saves an empty argument list", async () => {
  const f = fixture({ programs: { programs: { claude: { run: ["claude", "--verbose"] } } } });
  const editor = await load(f); editor.currentProfile().input.edit_value("");
  click(editor, f, "profile-save"); await f.flush();
  assert.deepEqual(f.json("programs.json").programs.claude.run, ["claude"]);
});

test("write failures leave the draft editable and show the error", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const editor = await load(f, { agent: "claude", profile: "work" }); const profile = editor.currentProfile();
  runtime.writeTextFile = async () => { throw new Error("permission denied"); };
  profile.input.edit_value("--verbose"); profile.input.submit(); await f.flush();
  assert.match(profile.error, /permission denied/); assert.equal(profile.saving, false);
  assert.equal(editor.dirty(profile), true); assert.equal(f.writes.length, 0);
});

test("the list includes available agents and saved profiles for unavailable agents", async () => {
  const profiles = sampleProfiles(); profiles.agents.missing = { profiles: [{ id: "future", name: "Future setup", args: [] }] };
  const f = fixture({ profiles }); f.agents.push({ key: "missing", name: "Missing Agent", installed: false, run: ["missing"] });
  const editor = await load(f), root = editor.render(runtime.theme());
  assert.ok(findElement(root, "settings-agent-claude")); assert.ok(findElement(root, "settings-agent-codex"));
  assert.equal(findElement(root, "settings-agent-missing"), null);
  assert.ok(findElement(root, profileRow("missing", "future")));
  assert.equal(findElement(root, "settings-agent-tabs"), null);
  assert.ok(findElement(root, "settings-agent-search"));
  click(editor, f, profileRow("missing", "future"));
  assert.equal(editor.currentProfile().id, "future");
  assert.match(texts(editor.render(runtime.theme())).join(" "), /Not available on this device/);
  assert.equal(f.writes.length, 0);
});

test("search matches agent and profile names and preserves hidden drafts", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const editor = await load(f, { agent: "claude", profile: "work" });
  const draft = editor.currentProfile(); draft.input.edit_value("--draft");
  editor.searchInput.edit_value("CLAUDE review");
  assert.deepEqual(editor.visibleEntries().map(e => e.profile.id), ["review"]);
  assert.equal(editor.currentProfile().id, "review");
  assert.equal(findElement(editor.render(runtime.theme()), profileRow("claude", "work")), null);
  editor.searchInput.edit_value("no matching entry");
  assert.match(texts(editor.render(runtime.theme())).join(" "), /No matching/);
  editor.searchInput.edit_value(""); click(editor, f, profileRow("claude", "work"));
  assert.equal(editor.currentProfile(), draft); assert.equal(draft.input.value(), "--draft");
  assert.equal(f.writes.length, 0);
});

test("renaming a profile found by search keeps its editor available until saved", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const editor = await load(f, { agent: "claude", profile: "work" });
  editor.searchInput.edit_value("work");
  const profile = editor.currentProfile(); profile.nameInput.edit_value("Project A");
  assert.ok(findElement(editor.render(runtime.theme()), "profile-name-work"));
  click(editor, f, "profile-save"); await f.flush();
  assert.equal(f.json().agents.claude.profiles[0].name, "Project A");
  editor.searchInput.edit_value("Project A");
  assert.equal(editor.currentProfile(), profile); assert.equal(editor.dirty(profile), false);
});

test("Settings follows the launcher order and dragging updates both views without saving drafts", async () => {
  const f = fixture({ profiles: sampleProfiles() });
  const original = [entryId("claude", "work"), entryId("codex", "default"), entryId("claude", "default"), entryId("claude", "review")];
  f.shared.set(ORDER, { remote: original });
  const editor = await load(f); const draft = editor.currentProfile(); draft.input.edit_value("--unsaved");
  assert.deepEqual(editor.entries().map(e => e.id), original);
  const source = findElement(editor.render(runtime.theme()), profileRow("claude", "work"));
  const target = findElement(editor.render(runtime.theme()), "settings-agent-codex");
  source.handlers.on_mouse_down(pointer(23), f.cx); target.handlers.on_mouse_move(pointer(90, 36), f.cx);
  target.handlers.on_mouse_up(pointer(90, 36), f.cx); target.handlers.on_click({}, f.cx);
  const expected = [original[1], original[0], original[2], original[3]];
  assert.deepEqual(f.shared.get(ORDER).remote, expected);
  assert.equal(editor.currentProfile(), draft); assert.equal(draft.input.value(), "--unsaved");
  assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
  const menu = new NewMenu(); menu.init({}, f.cx); await f.flush();
  assert.deepEqual(menu.entries().map(e => e.id), expected);
  assert.equal(f.json().agents.claude.profiles[0].args[0], "--settings");
});

test("profile names can repeat across agents without colliding in the list", async () => {
  const profiles = sampleProfiles(); profiles.agents.codex = { profiles: [{ id: "work", name: "Work", args: ["--codex-flag"] }] };
  const f = fixture({ profiles }); const editor = await load(f);
  click(editor, f, profileRow("codex", "work")); assert.deepEqual(editor.currentProfile().args, ["--codex-flag"]);
  click(editor, f, profileRow("claude", "work")); assert.equal(editor.current().key, "claude");
});

test("creating a profile clears the search and keeps the new draft visible", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const editor = await load(f);
  editor.searchInput.edit_value("codex"); click(editor, f, "profile-add");
  assert.equal(editor.current().key, "codex"); assert.equal(editor.searchInput.value(), "");
  assert.ok(editor.visibleEntries().some(e => e.profile === editor.currentProfile()));
  assert.equal(f.writes.length, 0);
});

test("renaming a sibling revalidates previously conflicting profile names", async () => {
  const f = fixture({ profiles: sampleProfiles() }); const editor = await load(f, { agent: "claude", profile: "work" });
  const work = editor.currentProfile(); work.nameInput.edit_value("Review"); assert.ok(work.nameError);
  const review = editor.current().profiles.find(p => p.id === "review"); review.nameInput.edit_value("Other");
  assert.equal(work.nameError, null); assert.equal(f.writes.length, 0);
});

test("availability checks and ordering use the device passed from the launcher", async () => {
  const f = fixture({ profiles: sampleProfiles() }); let on;
  runtime.knownAgents = async options => { on = options.on; return f.agents; };
  f.shared.set(ORDER, { "": [entryId("codex", "default")], remote: [entryId("claude", "work")] });
  const editor = await load(f, { machine: null });
  assert.equal(on, null); assert.equal(editor.entries()[0].agent.key, "codex");
});
