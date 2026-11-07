import test from "node:test";
import assert from "node:assert/strict";
import { FileTree } from "../file-tree.js";
const file = (path, directory = false) => ({ path, name: path.split("/").at(-1), directory, kind: directory ? "d" : "f" });

test("tree expands only requested branches and filters hidden entries at every level", () => {
  const tree = new FileTree();
  tree.reset({ path: "/root", entries: [file("/root/one", true), file("/root/two", true)] });
  tree.expanded.add("/root/one");
  assert.equal(tree.rows(false)[1].message, "loading");
  tree.setChildren("/root/one", { path: "/root/one", entries: [file("/root/one/a"), file("/root/one/.hidden")] });
  assert.deepEqual(tree.rows(false).map(row => [row.name, row.depth]), [["one", 0], ["a", 1], ["two", 0]]);
  assert.equal(tree.rows(true).length, 4);
  tree.expanded.delete("/root/one");
  assert.equal(tree.rows(true).length, 2);
});

test("symlink children retain their visible paths and ancestor cycles stop", () => {
  const tree = new FileTree();
  tree.reset({ path: "/root", entries: [file("/root/link", true)] });
  tree.expanded.add("/root/link");
  tree.setChildren("/root/link", { path: "/elsewhere", entries: [file("/elsewhere/back", true), file("/elsewhere/file")] });
  assert.ok(tree.entry("/root/link/file"));
  tree.expanded.add("/root/link/back");
  tree.setChildren("/root/link/back", { path: "/root", entries: [file("/root/link", true)] });
  assert.equal(tree.branches.get("/root/link/back").error, "symlink-cycle");
  assert.ok(tree.rows(false).some(row => row.message === "symlink-cycle"));
});

test("refresh retains expanded paths; choosing another root resets them", () => {
  const tree = new FileTree(), result = { path: "/root", entries: [file("/root/one", true)] };
  tree.reset(result); tree.expanded.add("/root/one");
  tree.setChildren("/root/one", { path: "/root/one", entries: [] });
  tree.reset(result); assert.ok(tree.expanded.has("/root/one")); assert.equal(tree.branches.size, 0);
  tree.reset({ path: "/other", entries: [] }); assert.equal(tree.expanded.size, 0);
});

test("drag targets exclude files, self, descendants and the existing parent", () => {
  const tree = new FileTree();
  tree.reset({ path: "/root", entries: [file("/root/a", true), file("/root/b", true), file("/root/file")] });
  tree.setChildren("/root/a", { path: "/root/a", entries: [file("/root/a/child", true)] });
  assert.equal(tree.canMove("/root/file", "/root/b"), true);
  assert.equal(tree.canMove("/root/a", "/root/b"), true);
  assert.equal(tree.canMove("/root/a/child", "/root"), true);
  for (const target of ["/root", "/root/a", "/root/a/child", "/root/file", "/missing"]) {
    assert.equal(tree.canMove("/root/a", target), false, target);
  }
});
