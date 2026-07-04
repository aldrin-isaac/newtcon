// test/undo-plan.test.js — unit tests for the data-layer undo planner
// (slice #175.C.1).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { planUndo } from "../dist/undo-plan.js";

const idGen = (i) => "undo-" + i;

function entry(items) {
  return {
    id: "e1",
    timestamp: "2026-06-17T12:00:00Z",
    user: "alice",
    network: "default",
    summary: { total: items.length, applied: items.length, failed: 0, danger: 0 },
    items,
  };
}
// Every op now carries its inverse from stage time (see staging.test.js for
// the per-op inverse content). planUndo is op-agnostic: it replays the carried
// inverse, reversed, skipping items with no (ready) inverse.

const inv = (over) => ({
  group: "mutation", method: "DELETE", path: "services/x", effect: "delete",
  kind: "services", name: "x", title: "x", ...over,
});
const histItem = (over) => ({
  id: "1", effect: "create", kind: "spec", title: "x", scope: "services",
  danger: false, outcome: "applied", undoable: true, inverse: inv(), ...over,
});

describe("planUndo() — replays the carried inverse (op-agnostic)", () => {
  test("flat-mutation inverse passes through verbatim (+ fresh id)", () => {
    const inverse = inv();
    const plan = planUndo(entry([histItem({ inverse })]), idGen);
    assert.equal(plan.counts.planned, 1);
    assert.deepEqual(plan.items[0].inverse, { id: "undo-0", ...inverse });
  });

  test("topology inverse passes through", () => {
    const inverse = { group: "topology", op: "add-link", a: "r1:eth0", z: "r2:eth0" };
    const plan = planUndo(entry([histItem({ kind: "link", effect: "delete", title: "r1:eth0", inverse })]), idGen);
    assert.deepEqual(plan.items[0].inverse, { id: "undo-0", ...inverse });
  });

  test("interface-action inverse passes through", () => {
    const inverse = { group: "interface", op: "action", device: "r1", iface: "eth0", actionId: "remove-service", label: "Unbind", body: {}, danger: true };
    const plan = planUndo(entry([histItem({ kind: "interface action", effect: "action", title: "Apply X", inverse })]), idGen);
    assert.deepEqual(plan.items[0].inverse, { id: "undo-0", ...inverse });
  });

  test("item with no carried inverse is skipped", () => {
    const plan = planUndo(entry([histItem({ inverse: undefined, undoable: false })]), idGen);
    assert.equal(plan.counts.skipped, 1);
    assert.ok(plan.items[0].reason);
  });

  test("inverses are planned in reverse of the forward apply order", () => {
    const a = histItem({ id: "1", title: "a", inverse: inv({ path: "services/a", name: "a", title: "a" }) });
    const b = histItem({ id: "2", title: "b", inverse: inv({ path: "services/b", name: "b", title: "b" }) });
    const plan = planUndo(entry([a, b]), idGen);
    assert.equal(plan.items[0].inverse.name, "b");
    assert.equal(plan.items[1].inverse.name, "a");
  });

  test("mixed planned + skipped counted accurately", () => {
    const plan = planUndo(entry([
      histItem({ id: "1" }),
      histItem({ id: "2", undoable: false, inverse: undefined }),
      histItem({ id: "3" }),
    ]), idGen);
    assert.equal(plan.counts.planned, 2);
    assert.equal(plan.counts.skipped, 1);
  });

  test("each planned inverse gets a unique id", () => {
    const plan = planUndo(entry([histItem({ id: "1" }), histItem({ id: "2" })]), idGen);
    const ids = plan.items.filter((i) => i.planned).map((i) => i.inverse.id);
    assert.notEqual(ids[0], ids[1]);
  });
});

describe("planUndo() — empty entry", () => {
  test("empty items → empty plan", () => {
    const plan = planUndo(entry([]), idGen);
    assert.deepEqual(plan.items, []);
    assert.deepEqual(plan.counts, { planned: 0, skipped: 0 });
  });
});
