import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments, formatArguments, parsePrograms, agentOverride, saveAgentRun } from "../launch-config.js";

test("settings paths, JSON, and multiple flags become individual arguments", () => {
  assert.deepEqual(parseArguments('--settings "/home/me/work profile.json" --verbose'),
    ["--settings", "/home/me/work profile.json", "--verbose"]);
  assert.deepEqual(parseArguments(`--settings '{"env":{"NAME":"two words"}}' --model sonnet`),
    ["--settings", '{"env":{"NAME":"two words"}}', "--model", "sonnet"]);
  assert.deepEqual(parseArguments(String.raw`--settings "C:\Users\Me\my settings.json"`),
    ["--settings", String.raw`C:\Users\Me\my settings.json`]);
});

test("blank, empty quoted, escaped, and adjacent quoted arguments", () => {
  assert.deepEqual(parseArguments(" \t\n "), []);
  assert.deepEqual(parseArguments(`--name '' --label ""`), ["--name", "", "--label", ""]);
  assert.deepEqual(parseArguments(String.raw`--settings /tmp/my\ profile.json --name 'O'\''Brien'`),
    ["--settings", "/tmp/my profile.json", "--name", "O'Brien"]);
  assert.deepEqual(parseArguments('--settings="/tmp/my profile.json"'), ["--settings=/tmp/my profile.json"]);
  assert.deepEqual(parseArguments("--verbose \\\n --settings /tmp/a.json"), ["--verbose", "--settings", "/tmp/a.json"]);
});

test("shell expressions remain literal data", () => {
  assert.deepEqual(parseArguments("--value '$(touch /tmp/not-executed)' '$HOME' '*.json' ';' '|cat' '`id`'"),
    ["--value", "$(touch /tmp/not-executed)", "$HOME", "*.json", ";", "|cat", "`id`"]);
});

test("unfinished quotes, escapes, and null bytes cannot be saved", () => {
  for (const input of ['--settings "unfinished', "--settings 'unfinished", "--settings trailing\\", "--settings \0"]) {
    assert.throws(() => parseArguments(input));
  }
});

test("formatted saved arguments can be edited without changing their values", () => {
  const args = ["--settings", "/home/me/项目 profile.json", "", "O'Brien", 'a"b', "C:\\path\\", "$HOME", "line\nbreak", "$(id)"];
  assert.deepEqual(parseArguments(formatArguments(args)), args);
});

function memoryFile(initial = null) {
  return {
    raw: initial === null ? null : JSON.stringify(initial), writes: 0,
    async read() { return this.raw; },
    async write(_path, next, expected) {
      assert.equal(expected, this.raw, "writes must use the current snapshot");
      this.writes++;
      this.raw = next;
    },
  };
}

function save(file, options = {}) {
  return saveAgentRun({
    path: "programs.json", key: "claude", argv: ["claude", "--settings", "/tmp/profile.json"],
    previousOverride: null, read: () => file.read(), write: (...args) => file.write(...args), ...options,
  });
}

test("first save creates only the requested launch override", async () => {
  const file = memoryFile();
  await save(file);
  assert.deepEqual(JSON.parse(file.raw), { programs: { claude: { run: ["claude", "--settings", "/tmp/profile.json"] } } });
});

test("saving preserves names, icons, other agents, and unrelated program settings", async () => {
  const file = memoryFile({
    programs: { claude: { name: "My Claude", icon: "my-icons/claude.svg" }, other: { run: ["other", "--keep"] } },
    shells: ["xonsh"], interpreters: ["pipx"], custom: { enabled: true },
  });
  await save(file);
  const result = JSON.parse(file.raw);
  assert.equal(result.programs.claude.name, "My Claude");
  assert.equal(result.programs.claude.icon, "my-icons/claude.svg");
  assert.deepEqual(result.programs.other, { run: ["other", "--keep"] });
  assert.deepEqual(result.shells, ["xonsh"]);
  assert.deepEqual(result.interpreters, ["pipx"]);
  assert.deepEqual(result.custom, { enabled: true });
});

test("clearing arguments keeps the existing executable", async () => {
  const before = ["my-claude", "--settings", "/tmp/old.json"];
  const file = memoryFile({ programs: { claude: { run: before } } });
  await save(file, { argv: ["my-claude"], previousOverride: before });
  assert.deepEqual(JSON.parse(file.raw).programs.claude.run, ["my-claude"]);
});

test("an unrelated concurrent edit is preserved on retry", async () => {
  const file = memoryFile();
  const write = file.write.bind(file);
  let raced = false;
  file.write = async (...args) => {
    if (!raced) {
      raced = true;
      file.raw = JSON.stringify({ shells: ["fish"], programs: { other: { name: "Other" } } });
      throw new Error("stale snapshot");
    }
    await write(...args);
  };
  await save(file);
  const result = JSON.parse(file.raw);
  assert.deepEqual(result.shells, ["fish"]);
  assert.deepEqual(result.programs.other, { name: "Other" });
  assert.deepEqual(result.programs.claude.run, ["claude", "--settings", "/tmp/profile.json"]);
});

test("a concurrent edit to the same agent is never overwritten", async () => {
  const file = memoryFile({ programs: { claude: { run: ["claude", "--newer"] } } });
  const before = file.raw;
  await assert.rejects(save(file), /changed elsewhere/);
  assert.equal(file.raw, before);
  assert.equal(file.writes, 0);
});

test("malformed existing configuration is never replaced", async () => {
  for (const raw of ["{", "[]", "null", '{"programs":[]}', '{"programs":{"claude":null}}', '{"programs":{"claude":{"run":[]}}}']) {
    const file = memoryFile();
    file.raw = raw;
    await assert.rejects(save(file));
    assert.equal(file.raw, raw);
    assert.equal(file.writes, 0);
  }
});

test("write failures are surfaced without replacing the old configuration", async () => {
  const file = memoryFile({ shells: ["zsh"] });
  const before = file.raw;
  file.write = async () => { throw new Error("permission denied"); };
  await assert.rejects(save(file), /permission denied/);
  assert.equal(file.raw, before);
});

test("stored launcher arguments are read as an independent snapshot", () => {
  const config = parsePrograms('{"programs":{"claude":{"run":["claude","--verbose"]}}}');
  const run = agentOverride(config, "claude");
  run.push("--settings");
  assert.deepEqual(config.programs.claude.run, ["claude", "--verbose"]);
  assert.equal(agentOverride(config, "missing"), null);
});
