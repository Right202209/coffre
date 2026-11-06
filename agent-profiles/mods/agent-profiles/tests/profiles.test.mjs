import assert from "node:assert/strict";
import test from "node:test";
import { parseProfiles, profileName, agentProfiles, launchChoices, findLaunch, saveProfile } from "../profiles.js";

const work = () => ({ id: "work", name: "Work", args: ["--settings", "/tmp/work settings.json", "--model", "sonnet"] });
const config = () => ({ version: 1, agents: { claude: { profiles: [work()] } } });
function memory(value = null) {
  return { raw: value === null ? null : JSON.stringify(value), writes: 0,
    async read() { return this.raw; },
    async write(_path, next, expected) {
      assert.equal(this.raw, expected); this.raw = next; this.writes++;
    },
  };
}
function save(file, options = {}) {
  return saveProfile({ path: "profiles.json", key: "claude", id: "work", profile: work(), previous: null,
    read: () => file.read(), write: (...args) => file.write(...args), ...options });
}

test("existing commands remain Default, with independent named argument sets", () => {
  const agents = [{ key: "claude", name: "Claude Code", installed: true, run: ["claude"] }];
  const choices = launchChoices(agents, { programs: { claude: { run: ["my-claude", "--verbose"] } } }, config());
  assert.deepEqual(choices[0].profiles.map(p => p.name), ["Default", "Work"]);
  assert.deepEqual(choices[0].profiles[0].argv, ["my-claude", "--verbose"]);
  assert.equal(choices[0].profiles[0].tabName, "Claude Code");
  assert.deepEqual(findLaunch(choices, "claude", "work").profile.argv,
    ["my-claude", "--settings", "/tmp/work settings.json", "--model", "sonnet"]);
  assert.equal(findLaunch(choices, "claude", "work").profile.tabName, "Work");
});

test("creating and renaming profiles preserves other profiles, agents, and metadata", async () => {
  const file = memory({ version: 1, note: "keep", agents: {
    claude: { note: "agent metadata", profiles: [{ id: "review", name: "Review", args: [] }] },
    codex: { profiles: [{ id: "test", name: "Tests", args: ["--model", "o3"] }] },
  } });
  const created = await save(file);
  const renamed = await save(file, { previous: created, profile: { ...created, name: "项目 Work" } });
  const result = JSON.parse(file.raw);
  assert.equal(renamed.id, "work"); assert.equal(renamed.name, "项目 Work");
  assert.deepEqual(result.agents.claude.profiles.map(p => p.name), ["Review", "项目 Work"]);
  assert.equal(result.note, "keep"); assert.equal(result.agents.claude.note, "agent metadata");
  assert.deepEqual(result.agents.codex.profiles[0].args, ["--model", "o3"]);
});

test("a profile can be removed without touching the default command or siblings", async () => {
  const original = config(); original.agents.claude.profiles.push({ id: "review", name: "Review", args: [] });
  const file = memory(original);
  await save(file, { previous: work(), profile: null });
  assert.deepEqual(JSON.parse(file.raw).agents.claude.profiles, [{ id: "review", name: "Review", args: [] }]);
});

test("concurrent additions to different profiles merge", async () => {
  const file = memory(); let raced = false;
  const write = file.write.bind(file);
  file.write = async (...args) => {
    if (!raced) { raced = true; file.raw = JSON.stringify({ version: 1, agents: { claude: { profiles: [{ id: "review", name: "Review", args: [] }] } } }); throw new Error("stale"); }
    return write(...args);
  };
  await save(file);
  assert.deepEqual(JSON.parse(file.raw).agents.claude.profiles.map(p => p.id), ["review", "work"]);
});

test("another edit or deletion of the same profile is not overwritten", async () => {
  const file = memory(config());
  const before = file.raw;
  await assert.rejects(save(file), /changed elsewhere/);
  assert.equal(file.raw, before);
  const deleted = memory({ version: 1, agents: {} });
  await assert.rejects(save(deleted, { previous: work() }), /changed elsewhere/);
  assert.equal(deleted.writes, 0);
});

test("names are editable, unique per agent, and independent of stable ids", async () => {
  assert.equal(profileName("  工作  "), "工作");
  for (const name of ["", "   ", "Default", "default", "a\nb", "x".repeat(65)]) assert.throws(() => profileName(name));
  const file = memory(config());
  await assert.rejects(save(file, { id: "other", profile: { id: "other", name: "work", args: [] } }), /already has/);
  await save(file, { key: "codex" });
  assert.equal(JSON.parse(file.raw).agents.codex.profiles[0].name, "Work");
});

test("malformed profile files and unsupported versions are never replaced", async () => {
  const invalid = ["{", "[]", '{"version":2,"agents":{}}', '{"version":1,"agents":[]}',
    '{"version":1,"agents":{"claude":{"profiles":[{"id":"p","name":"Work","args":[2]}]}}}'];
  for (const raw of invalid) {
    const file = memory(); file.raw = raw;
    await assert.rejects(save(file)); assert.equal(file.raw, raw); assert.equal(file.writes, 0);
  }
  const duplicate = config(); duplicate.agents.claude.profiles.push(work());
  assert.throws(() => parseProfiles(JSON.stringify(duplicate)), /unique/);
});

test("Default cannot be replaced by a named profile; missing and unavailable choices cannot launch", async () => {
  await assert.rejects(save(memory(), { id: "default", profile: null }), /Default/);
  assert.throws(() => findLaunch([], "claude", "work"), /no longer exists/);
  const choices = launchChoices([{ key: "claude", name: "Claude Code", installed: false, run: ["claude"] }], {}, config());
  assert.throws(() => findLaunch(choices, "claude", "work"), /not installed/);
});

test("failed writes are reported without data loss", async () => {
  const file = memory(); file.write = async () => { throw new Error("read only"); };
  await assert.rejects(save(file), /read only/); assert.equal(file.raw, null);
});

test("profile data is copied before use", async () => {
  const original = config(); const result = agentProfiles(original, "claude");
  result[0].args.push("--debug"); assert.deepEqual(original.agents.claude.profiles[0].args, work().args);
});
