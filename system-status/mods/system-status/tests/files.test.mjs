import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, operateFile, parseFilePacket, browsePath, parentPath, FILE_LIMIT, FILE_LIST_SCRIPT } from "../files.js";

const execute = promisify(execFile);
// Exercise the actual scripts through the same JSON/base64 envelope as hc.
async function localHc(args) {
  const [program, ...argv] = args.slice(args.indexOf("--") + 1);
  const result = await execute(program, argv, { maxBuffer: 2 * 1024 * 1024, timeout: 30000 });
  return { code: 0, stdout: JSON.stringify({ result: { code: 0, stdout: Buffer.from(result.stdout).toString("base64") } }), stderr: "" };
}
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "system-files-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test("listing preserves unusual filenames, dotfiles and symlinks, with directories first", async t => {
  const path = await fixture(t);
  const names = ["中文 文件.txt", "quote'\";$(touch injected)`x`", "line\nbreak\t.txt", "-n", ".hidden"];
  for (const name of names) await writeFile(join(path, name), "data");
  await mkdir(join(path, "folder"));
  await symlink("folder", join(path, "linked-folder"));
  await symlink("missing", join(path, "broken-link"));
  const result = await listFiles(localHc, null, path);
  assert.equal(result.path, path);
  assert.equal(result.limited, false);
  assert.deepEqual(new Set(result.entries.map(entry => entry.name)), new Set([...names, "folder", "linked-folder", "broken-link"]));
  assert.ok(result.entries.slice(0, 2).every(entry => entry.directory));
  assert.equal(result.entries.find(entry => entry.name === "linked-folder").kind, "l");
  assert.equal(result.entries.find(entry => entry.name === "broken-link").directory, false);
  assert.equal(result.entries.find(entry => entry.name === names[0]).size, 4);
  assert.equal((await readdir(path)).includes("injected"), false);
});

test("listing handles empty, missing and newline-terminated directory paths", async t => {
  const path = await fixture(t), unusual = join(path, "directory\n");
  await mkdir(unusual);
  const result = await listFiles(localHc, null, unusual);
  assert.equal(result.path, unusual);
  assert.deepEqual(result.entries, []);
  await rejectsCode(listFiles(localHc, null, join(path, "missing")), "cannot-open");
});

test("copy and move support literal punctuation, relative destinations and directory targets", async t => {
  const path = await fixture(t), name = "中文 ' \" ;$(touch sentinel)\n.txt", source = join(path, name);
  await writeFile(source, "payload");
  await mkdir(join(path, "target"));
  assert.equal(await operateFile(localHc, null, "cp", source, "target", path), join(path, "target", name));
  assert.equal(await readFile(join(path, "target", name), "utf8"), "payload");
  assert.equal(await operateFile(localHc, null, "mv", source, "-renamed", path), join(path, "-renamed"));
  assert.equal(await readFile(join(path, "-renamed"), "utf8"), "payload");
  assert.equal((await readdir(path)).includes(name), false);
  assert.equal((await readdir(path)).includes("sentinel"), false);
});

test("recursive copies preserve hidden children and symlinks, and moves rename directories", async t => {
  const path = await fixture(t), source = join(path, "tree");
  await mkdir(join(source, "child"), { recursive: true });
  await writeFile(join(source, ".hidden"), "hidden");
  await writeFile(join(source, "child", "data"), "content");
  await symlink("child/data", join(source, "link"));
  await operateFile(localHc, null, "cp", source, "copy", path);
  assert.equal(await readFile(join(path, "copy", ".hidden"), "utf8"), "hidden");
  assert.equal(await readlink(join(path, "copy", "link")), "child/data");
  await operateFile(localHc, null, "mv", join(path, "copy"), "renamed", path);
  assert.equal(await readFile(join(path, "renamed", "child", "data"), "utf8"), "content");
});

test("cp and mv refuse existing files, directory children and dangling symlink targets", async t => {
  const path = await fixture(t), source = join(path, "source");
  await writeFile(source, "new");
  await writeFile(join(path, "existing"), "keep");
  await mkdir(join(path, "container"));
  await writeFile(join(path, "container", "source"), "nested");
  await symlink("missing", join(path, "dangling"));
  for (const action of ["cp", "mv"]) {
    for (const destination of ["existing", "container", "dangling", "source"]) {
      await rejectsCode(operateFile(localHc, null, action, source, destination, path), "destination-exists");
    }
  }
  assert.equal(await readFile(source, "utf8"), "new");
  assert.equal(await readFile(join(path, "existing"), "utf8"), "keep");
  assert.equal(await readFile(join(path, "container", "source"), "utf8"), "nested");
});

test("directories cannot be copied into themselves, including through an alias", async t => {
  const path = await fixture(t), source = join(path, "source");
  await mkdir(join(source, "child"), { recursive: true });
  await symlink(source, join(path, "alias"));
  for (const action of ["cp", "mv"]) {
    for (const destination of [source, join(source, "child", "nested"), join(path, "alias", "nested")]) {
      await rejectsCode(operateFile(localHc, null, action, source, destination, path), "inside-source");
    }
  }
});

test("copying a directory symlink preserves the link rather than traversing it", async t => {
  const path = await fixture(t);
  await mkdir(join(path, "tree"));
  await symlink("tree", join(path, "link"));
  await operateFile(localHc, null, "cp", join(path, "link"), "link-copy", path);
  assert.equal(await readlink(join(path, "link-copy")), "tree");
});

test("invalid paths/actions and missing sources fail before modifying files", async t => {
  const path = await fixture(t), source = join(path, "source");
  await writeFile(source, "keep");
  await rejectsCode(operateFile(localHc, null, "rm", source, "dest", path), "invalid-action");
  await rejectsCode(operateFile(localHc, null, "cp", source, "bad\0name", path), "invalid-path");
  await rejectsCode(operateFile(localHc, null, "mv", source, "", path), "invalid-path");
  await rejectsCode(operateFile(localHc, null, "mv", "/", "dest", path), "invalid-path");
  await rejectsCode(operateFile(localHc, null, "cp", join(path, "missing"), "dest", path), "source-missing");
  assert.equal(await readFile(source, "utf8"), "keep");
});

test("output limits are explicit instead of silently dropping files", async t => {
  const path = await fixture(t);
  // Lower only the test script's cap to exercise the actual limit branch quickly.
  for (const name of ["a", "b", "c"]) await writeFile(join(path, name), "");
  const result = await execute("sh", ["-c", FILE_LIST_SCRIPT.replace(`[ "$count" -ge ${FILE_LIMIT} ]`, '[ "$count" -ge 2 ]'), "test", path]);
  const parsed = parseFilePacket(result.stdout);
  assert.equal(parsed.limited, true);
  assert.equal(parsed.entries.length, 2);
});

test("the protocol rejects malformed, duplicate, traversal and non-UTF-8 entries", () => {
  for (const output of ["", "HERDR_FILES_V1\nPATH 2f\n", "HERDR_FILES_V1\nPATH 2f\nLIMIT 0\nEND\nextra"]) {
    assert.throws(() => parseFilePacket(output), error => error.code === "invalid-response");
  }
  for (const name of ["2e2e", "612f62", "00", "ff"]) {
    assert.throws(() => parseFilePacket(`HERDR_FILES_V1\nPATH 2f\nENTRY f 0 1 0 ${name}\nLIMIT 0\nEND`));
  }
  assert.throws(() => parseFilePacket("HERDR_FILES_V1\nPATH 2f\nENTRY f 0 1 0 61\nENTRY f 0 1 0 61\nLIMIT 0\nEND"));
});

test("routing preserves the machine and paths as arguments, with transport failures surfaced", async () => {
  const calls = [];
  await listFiles(async args => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ code: 0, stdout: "HERDR_FILES_V1\nPATH 2f\nLIMIT 0\nEND\n" }) };
  }, "remote host", "/some ' path");
  assert.deepEqual(calls[0].slice(4, 6), ["--on", "remote host"]);
  assert.equal(calls[0].at(-1), "/some ' path");
  assert.equal(calls[0][calls[0].indexOf("-c") + 1], FILE_LIST_SCRIPT);
  for (const [state, code] of [[{ timed_out: true }, "timeout"], [{ truncated: true }, "too-large"], [{ code: 1 }, "exec-failed"]]) {
    await rejectsCode(listFiles(async () => ({ code: 0, stdout: JSON.stringify(state) }), null, "/"), code);
  }
});

test("path helpers preserve meaningful whitespace and symlink traversal", () => {
  assert.equal(browsePath("../other", "/a/link"), "/a/link/../other");
  assert.equal(browsePath("~/中文 文件", "/"), "~/中文 文件");
  assert.equal(browsePath(" folder ", "/"), "/ folder ");
  assert.equal(parentPath("/a"), "/");
  assert.equal(parentPath("/"), "/");
});
