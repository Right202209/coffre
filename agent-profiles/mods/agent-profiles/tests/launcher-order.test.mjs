import assert from "node:assert/strict";
import test from "node:test";
import { entryId, orderedEntries, moveOrder } from "../order.js";

const entries = ids => ids.map(id => ({ id }));

test("saved order is stable; new entries append and malformed state is ignored", () => {
  const list = entries(["a", "b", "c"]);
  assert.deepEqual(orderedEntries(list, ["b", "b", null, "a"]).map(e => e.id), ["b", "a", "c"]);
  assert.deepEqual(orderedEntries(list, {}).map(e => e.id), ["a", "b", "c"]);
  assert.deepEqual(list.map(e => e.id), ["a", "b", "c"]);
});

test("moving before and after a target works in either direction", () => {
  const list = entries(["a", "b", "c", "d"]);
  assert.deepEqual(moveOrder(list, null, "a", "c", "after"), ["b", "c", "a", "d"]);
  assert.deepEqual(moveOrder(list, null, "d", "b", "before"), ["a", "d", "b", "c"]);
});

test("a reorder preserves unavailable entries and unrelated saved slots", () => {
  const list = entries(["a", "c", "d"]);
  const next = moveOrder(list, ["a", "offline", "c"], "d", "a", "before");
  assert.deepEqual(next, ["d", "offline", "a", "c"]);
  assert.deepEqual(orderedEntries(entries(["a", "offline", "c", "d"]), next).map(e => e.id), next);
});

test("invalid targets and moves that do not change order do not save", () => {
  const list = entries(["a", "b", "c"]);
  for (const [from, to, side] of [["a", "a", "after"], ["missing", "a", "after"], ["a", "missing", "after"], ["a", "b", "before"], ["a", "c", "invalid"]]) {
    assert.equal(moveOrder(list, null, from, to, side), null);
  }
});

test("entry identities distinguish agents and profiles even with punctuation in ids", () => {
  assert.notEqual(entryId("a:b", "c"), entryId("a", "b:c"));
  assert.notEqual(entryId("claude", "default"), entryId("claude", "work"));
});
