// test/apply-preview.test.js — unit tests for the apply-preview
// derivation (slice #171.A).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { previewQueue } from "../dist/apply-preview.js";

const specCreate  = (id, name, kind = "services") =>
  ({ id, group: "spec", kind, op: "create", name, body: { name } });
const specDelete  = (id, name, kind = "services") =>
  ({ id, group: "spec", kind, op: "delete", name });
const addDevice   = (id, name) =>
  ({ id, group: "topology", op: "add-device", name, body: {} });
const removeDevice = (id, name) =>
  ({ id, group: "topology", op: "remove-device", name });
const addLink     = (id, a, z) =>
  ({ id, group: "topology", op: "add-link", a, z });
const removeLink  = (id, device, iface) =>
  ({ id, group: "topology", op: "remove-link", device, iface });
const deviceAction = (id, device, label, danger = false) =>
  ({ id, group: "device", op: "action", device, actionId: "x", label, body: {}, ...(danger ? { danger: true } : {}) });
const ifaceAction = (id, device, iface, label, danger = false) =>
  ({ id, group: "interface", op: "action", device, iface, actionId: "x", label, body: {}, ...(danger ? { danger: true } : {}) });

describe("previewQueue() — basics", () => {
  test("empty queue returns empty preview with zero counts", () => {
    const p = previewQueue([]);
    assert.equal(p.total, 0);
    assert.deepEqual(p.items, []);
    assert.deepEqual(p.counts, { create: 0, delete: 0, action: 0, danger: 0 });
    assert.equal(p.hasDangerous, false);
    assert.equal(p.hasDeletes, false);
  });

  test("totals reflect the input length, even with mixed kinds", () => {
    const p = previewQueue([
      specCreate("1", "a"), specDelete("2", "b"),
      addDevice("3", "r1"), addLink("4", "r1:e0", "r2:e0"),
    ]);
    assert.equal(p.total, 4);
    assert.equal(p.items.length, 4);
  });
});

describe("previewQueue() — apply ordering", () => {
  test("orders by apply phase: spec creates → add device → add link → device action → interface action → remove link → remove device → spec delete", () => {
    const input = [
      specDelete("8", "old"),
      removeDevice("7", "r-old"),
      removeLink("6", "r1", "eth9"),
      ifaceAction("5", "r1", "eth0", "set MTU"),
      deviceAction("4", "r1", "reboot"),
      addLink("3", "r1:e0", "r2:e0"),
      addDevice("2", "r1"),
      specCreate("1", "new"),
    ];
    const p = previewQueue(input);
    assert.deepEqual(p.items.map((i) => i.id), ["1","2","3","4","5","6","7","8"]);
  });
});

describe("previewQueue() — per-kind shape", () => {
  test("spec create → effect create, no danger, body carried", () => {
    const p = previewQueue([specCreate("1", "transit-2026")]);
    const it = p.items[0];
    assert.equal(it.effect, "create");
    assert.equal(it.kind, "spec");
    assert.equal(it.title, "transit-2026");
    assert.equal(it.scope, "services");
    assert.equal(it.danger, false);
    assert.deepEqual(it.body, { name: "transit-2026" });
  });

  test("spec delete → effect delete, flagged danger, no body", () => {
    const p = previewQueue([specDelete("1", "old", "zones")]);
    const it = p.items[0];
    assert.equal(it.effect, "delete");
    assert.equal(it.scope, "zones");
    assert.equal(it.danger, true);
    assert.equal(it.body, null);
  });

  test("spec kind label converts dashes to spaces", () => {
    const p = previewQueue([specCreate("1", "x", "qos-policies")]);
    assert.equal(p.items[0].scope, "qos policies");
  });

  test("add-link title shows both endpoints", () => {
    const p = previewQueue([addLink("1", "r1:e0", "r2:e0")]);
    assert.ok(p.items[0].title.includes("r1:e0"));
    assert.ok(p.items[0].title.includes("r2:e0"));
  });

  test("remove-link is flagged danger", () => {
    const p = previewQueue([removeLink("1", "r1", "eth0")]);
    assert.equal(p.items[0].danger, true);
    assert.equal(p.items[0].effect, "delete");
  });

  test("remove-device is flagged danger", () => {
    const p = previewQueue([removeDevice("1", "r-old")]);
    assert.equal(p.items[0].danger, true);
  });

  test("device action preserves its danger flag", () => {
    const safe = previewQueue([deviceAction("1", "r1", "show config")]);
    assert.equal(safe.items[0].danger, false);
    const dang = previewQueue([deviceAction("1", "r1", "wipe", true)]);
    assert.equal(dang.items[0].danger, true);
  });

  test("interface action scope is device:iface", () => {
    const p = previewQueue([ifaceAction("1", "r1", "eth0", "shutdown")]);
    assert.equal(p.items[0].scope, "r1:eth0");
  });
});

describe("previewQueue() — counts + flags", () => {
  test("counts.create / delete / action partition the input", () => {
    const p = previewQueue([
      specCreate("1", "a"), specCreate("2", "b"),
      specDelete("3", "c"), removeDevice("4", "r1"),
      deviceAction("5", "r2", "act"),
    ]);
    assert.deepEqual(p.counts, { create: 2, delete: 2, action: 1, danger: 2 });
  });

  test("danger count counts only items flagged danger (incl. implicit deletes)", () => {
    const p = previewQueue([
      specCreate("1", "a"),                  // not danger
      specDelete("2", "b"),                  // implicit danger
      deviceAction("3", "r1", "act", true),  // explicit danger
      deviceAction("4", "r2", "act"),        // not danger
    ]);
    assert.equal(p.counts.danger, 2);
  });

  test("hasDangerous / hasDeletes flags", () => {
    const safe = previewQueue([specCreate("1", "a"), addDevice("2", "r1")]);
    assert.equal(safe.hasDangerous, false);
    assert.equal(safe.hasDeletes, false);
    const mixed = previewQueue([specCreate("1", "a"), specDelete("2", "b")]);
    assert.equal(mixed.hasDangerous, true);
    assert.equal(mixed.hasDeletes, true);
  });
});
