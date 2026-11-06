import test from "node:test";
import assert from "node:assert/strict";
import { connectionFrom, machineConnections, parentPath, joinPath, visibleEntries, makeTransfer } from "../mods/sftp/model.js";

test("connection validation preserves SSH defaults and rejects option injection", () => {
  const fields = { name: "", target: "ali", user: "", port: "", key: "", path: "" };
  assert.equal(connectionFrom(fields).port, "");
  assert.equal(connectionFrom({ ...fields, target: "user@[::1]" }).target, "user@[::1]");
  for (const target of ["-bad", "x;whoami", "user@host\n-oProxyCommand=x"]) assert.throws(() => connectionFrom({ ...fields, target }));
  for (const port of ["0", "65536", "abc"]) assert.throws(() => connectionFrom({ ...fields, port }));
});

test("machine picker includes offline saved machines and excludes temporary ones", () => {
  const result = machineConnections([{ name: "local" }, { name: "offline", target: "alias", state: "disconnected" }, { name: "temp", target: "temp", temporary: true }]);
  assert.deepEqual(result.map(c => c.target), ["alias"]);
});

test("path navigation keeps root and literal Unicode or shell characters", () => {
  assert.equal(parentPath("/"), "/");
  assert.equal(parentPath("/tmp/中文 folder"), "/tmp");
  assert.equal(joinPath("/", "a' $(hello)"), "/a' $(hello)");
});

test("filtering and descending sort still put directories first", () => {
  const rows = [{ name: "a", directory: false, size: 20 }, { name: "b", directory: false, size: 40 }, { name: ".hidden", directory: false, size: 10 }, { name: "folder", directory: true, size: 0 }];
  assert.deepEqual(visibleEntries(rows, "", false, "size", true).map(e => e.name), ["folder", "b", "a"]);
  assert.deepEqual(visibleEntries(rows, "HIDDEN", true).map(e => e.name), [".hidden"]);
});

test("queued transfers pin both paths and connection before navigation", () => {
  const connection = { id: "first", name: "first", target: "one" };
  const request = makeTransfer("local", { name: "中文.bin", regular: true }, "/from", "/to", connection);
  connection.target = "two";
  assert.equal(request.connection.target, "one");
  assert.equal(request.source, "/from/中文.bin");
  assert.equal(request.destination, "/to/中文.bin");
  assert.throws(() => makeTransfer("local", { name: "link", regular: true, link: true }, "/", "/", connection));
});
