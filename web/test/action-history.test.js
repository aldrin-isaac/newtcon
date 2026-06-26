// test/action-history.test.js — unit tests for the pure action-history
// helpers (slice #175.A). Storage I/O is exercised via a Map-backed
// localStorage shim installed on globalThis.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ENTRIES_PER_NETWORK,
  appendEntry,
  buildEntry,
  clearHistory,
  loadHistory,
  prependEntry,
  saveHistory,
} from "../dist/action-history.js";

// Minimal localStorage shim — Map-backed; mirrors the three calls the
// module makes (getItem / setItem / removeItem).
function installStorageShim() {
  const data = new Map();
  globalThis.localStorage = {
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
  };
  return data;
}

const SAMPLE_PREVIEW = {
  total: 3,
  items: [
    { id: "1", effect: "create", kind: "spec", title: "transit-2026", scope: "services", danger: false, body: null,
      inverse: { group: "mutation", method: "DELETE", path: "services/transit-2026", effect: "delete", kind: "services", name: "transit-2026", title: "transit-2026" } },
    { id: "2", effect: "action", kind: "device action", title: "create-vlan", scope: "r1", danger: false, body: null },
    { id: "3", effect: "delete", kind: "spec", title: "old", scope: "zones", danger: true, body: null,
      inverse: { group: "mutation", method: "POST", path: "zones", effect: "create", kind: "zones", name: "old", title: "old" } },
  ],
  counts: { create: 1, delete: 1, action: 1, danger: 1 },
  hasDangerous: true,
  hasDeletes: true,
};

describe("buildEntry()", () => {
  test("merges preview + result into items with applied/failed outcomes", () => {
    const result = {
      applied: [{ id: "1" }, { id: "2" }],
      failed: [{ pending: { id: "3" }, error: "validation_failure: bad zone" }],
    };
    const entry = buildEntry({
      id: "e1",
      timestamp: "2026-06-16T12:00:00.000Z",
      user: "alice",
      network: "default",
      preview: SAMPLE_PREVIEW,
      result,
    });
    assert.equal(entry.id, "e1");
    assert.equal(entry.user, "alice");
    assert.equal(entry.network, "default");
    assert.deepEqual(entry.summary, { total: 3, applied: 2, failed: 1, danger: 1 });
    assert.equal(entry.items.length, 3);
    assert.equal(entry.items[0].outcome, "applied");
    assert.equal(entry.items[1].outcome, "applied");
    assert.equal(entry.items[2].outcome, "failed");
    assert.equal(entry.items[2].error, "validation_failure: bad zone");
  });

  test("applied items have no error field set", () => {
    const result = { applied: [{ id: "1" }], failed: [] };
    const entry = buildEntry({
      id: "e1", timestamp: "2026-06-16T12:00:00.000Z", user: null, network: "n",
      preview: {
        total: 1, items: [SAMPLE_PREVIEW.items[0]],
        counts: { create: 1, delete: 0, action: 0, danger: 0 },
        hasDangerous: false, hasDeletes: false,
      },
      result,
    });
    assert.equal(entry.items[0].outcome, "applied");
    assert.equal("error" in entry.items[0], false);
  });

  test("null user is preserved (anonymous mode)", () => {
    const entry = buildEntry({
      id: "e1", timestamp: "2026-06-16T12:00:00.000Z", user: null, network: "n",
      preview: SAMPLE_PREVIEW,
      result: { applied: [{ id: "1" }, { id: "2" }, { id: "3" }], failed: [] },
    });
    assert.equal(entry.user, null);
  });

  test("preserves item ordering from the preview", () => {
    const entry = buildEntry({
      id: "e1", timestamp: "2026-06-16T12:00:00.000Z", user: null, network: "n",
      preview: SAMPLE_PREVIEW,
      result: { applied: [], failed: [] },
    });
    assert.deepEqual(entry.items.map((i) => i.id), ["1", "2", "3"]);
  });

  test("undoable=true for create-style spec items; preBody not populated", () => {
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview: SAMPLE_PREVIEW,
      result: { applied: [{ id: "1" }, { id: "2" }, { id: "3" }], failed: [] },
    });
    // Item 1 is a spec create (effect:create, kind:spec). Always undoable.
    const create = entry.items.find((i) => i.id === "1");
    assert.equal(create.undoable, true);
    assert.equal(create.preBody, undefined);
  });

  test("undoable=false for device.action regardless of preBody presence", () => {
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview: SAMPLE_PREVIEW,
      result: { applied: [{ id: "2" }], failed: [] },
      preBodies: new Map([["2", { fake: "body" }]]),
    });
    const action = entry.items.find((i) => i.id === "2");
    // SAMPLE_PREVIEW's id="2" carries kind "device action" but no
    // actionId field, so it lands in the not-mapped bucket.
    assert.equal(action.undoable, false);
  });

  test("undoable=true for interface action with actionId='apply-service' (slice 175.C.2.a)", () => {
    const preview = {
      total: 1,
      items: [{
        id: "applyservice-1", effect: "action", kind: "interface action",
        title: "Bind service", scope: "r1:eth0", danger: false, body: null,
        actionId: "apply-service", device: "r1", iface: "eth0",
        inverse: { group: "interface", op: "action", device: "r1", iface: "eth0", actionId: "remove-service", label: "Unbind", body: {}, danger: true },
      }],
      counts: { create: 0, delete: 0, action: 1, danger: 0 },
      hasDangerous: false, hasDeletes: false,
    };
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview,
      result: { applied: [{ id: "applyservice-1" }], failed: [] },
    });
    const item = entry.items[0];
    assert.equal(item.undoable, true);
    assert.equal(item.actionId, "apply-service");
    assert.equal(item.device, "r1");
    assert.equal(item.iface, "eth0");
  });

  test("undoable=false for interface action whose actionId is not in the supported set", () => {
    const preview = {
      total: 1,
      items: [{
        id: "unknown-1", effect: "action", kind: "interface action",
        title: "Custom op", scope: "r1:eth0", danger: false, body: null,
        actionId: "some-future-verb", device: "r1", iface: "eth0",
      }],
      counts: { create: 0, delete: 0, action: 1, danger: 0 },
      hasDangerous: false, hasDeletes: false,
    };
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview,
      result: { applied: [{ id: "unknown-1" }], failed: [] },
    });
    assert.equal(entry.items[0].undoable, false);
  });

  test("configure-interface tagged:true (trunk add) → undoable=true; body threaded (slice 175.C.2.b)", () => {
    const preview = {
      total: 1,
      items: [{
        id: "ci-trunk-1", effect: "action", kind: "interface action",
        title: "Add tagged VLAN (trunk)", scope: "r1:eth0", danger: false,
        body: { vlan_id: 100, tagged: true },
        actionId: "configure-interface", device: "r1", iface: "eth0",
        inverse: { group: "interface", op: "action", device: "r1", iface: "eth0", actionId: "remove-trunk-vlan", label: "Remove trunk VLAN 100", body: { vlan_id: 100 }, danger: true },
      }],
      counts: { create: 0, delete: 0, action: 1, danger: 0 },
      hasDangerous: false, hasDeletes: false,
    };
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview,
      result: { applied: [{ id: "ci-trunk-1" }], failed: [] },
    });
    assert.equal(entry.items[0].undoable, true);
    assert.deepEqual(entry.items[0].body, { vlan_id: 100, tagged: true });
  });

  test("configure-interface tagged:false (access) → undoable=true via unconfigure-interface (slice 175.C.2.c)", () => {
    // Per newtron case A: cross-mode transitions are rejected, so the
    // prior state was always empty. Clearing the port restores it.
    const preview = {
      total: 1,
      items: [{
        id: "ci-access-1", effect: "action", kind: "interface action",
        title: "Set to access", scope: "r1:eth0", danger: false,
        body: { vlan_id: 100, tagged: false },
        actionId: "configure-interface", device: "r1", iface: "eth0",
        inverse: { group: "interface", op: "action", device: "r1", iface: "eth0", actionId: "unconfigure-interface", label: "Clear port", body: {}, danger: true },
      }],
      counts: { create: 0, delete: 0, action: 1, danger: 0 },
      hasDangerous: false, hasDeletes: false,
    };
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview,
      result: { applied: [{ id: "ci-access-1" }], failed: [] },
    });
    assert.equal(entry.items[0].undoable, true);
  });

  test("configure-interface routed (vrf+ip) → undoable=true via unconfigure-interface (slice 175.C.2.c)", () => {
    const preview = {
      total: 1,
      items: [{
        id: "ci-routed-1", effect: "action", kind: "interface action",
        title: "Set to routed", scope: "r1:eth0", danger: false,
        body: { vrf: "blue", ip: "10.0.0.1/24" },
        actionId: "configure-interface", device: "r1", iface: "eth0",
        inverse: { group: "interface", op: "action", device: "r1", iface: "eth0", actionId: "unconfigure-interface", label: "Clear port", body: {}, danger: true },
      }],
      counts: { create: 0, delete: 0, action: 1, danger: 0 },
      hasDangerous: false, hasDeletes: false,
    };
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview,
      result: { applied: [{ id: "ci-routed-1" }], failed: [] },
    });
    assert.equal(entry.items[0].undoable, true);
  });

  test("configure-interface access without vlan_id → undoable=false (defensive)", () => {
    // tagged:false but no vlan_id — newtron would have rejected the
    // forward call, but the predicate is defensive about partial bodies.
    const preview = {
      total: 1,
      items: [{
        id: "ci-partial-1", effect: "action", kind: "interface action",
        title: "Set to access", scope: "r1:eth0", danger: false,
        body: { tagged: false },
        actionId: "configure-interface", device: "r1", iface: "eth0",
      }],
      counts: { create: 0, delete: 0, action: 1, danger: 0 },
      hasDangerous: false, hasDeletes: false,
    };
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview,
      result: { applied: [{ id: "ci-partial-1" }], failed: [] },
    });
    assert.equal(entry.items[0].undoable, false);
  });

  test("configure-interface with no body → undoable=false (predicate defensively requires body)", () => {
    const preview = {
      total: 1,
      items: [{
        id: "ci-empty-1", effect: "action", kind: "interface action",
        title: "Set port", scope: "r1:eth0", danger: false, body: null,
        actionId: "configure-interface", device: "r1", iface: "eth0",
      }],
      counts: { create: 0, delete: 0, action: 1, danger: 0 },
      hasDangerous: false, hasDeletes: false,
    };
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview,
      result: { applied: [{ id: "ci-empty-1" }], failed: [] },
    });
    assert.equal(entry.items[0].undoable, false);
  });

  test("undoable=true for spec.delete when preBody captured", () => {
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview: SAMPLE_PREVIEW,
      result: { applied: [{ id: "3" }], failed: [] },
      preBodies: new Map([["3", { name: "old", description: "x" }]]),
    });
    const del = entry.items.find((i) => i.id === "3");
    assert.equal(del.undoable, true);
    assert.deepEqual(del.preBody, { name: "old", description: "x" });
  });

  test("undoable=false for spec.delete when preBody NOT captured", () => {
    const entry = buildEntry({
      id: "e1", timestamp: "t", user: null, network: "n",
      preview: SAMPLE_PREVIEW,
      result: { applied: [{ id: "3" }], failed: [] },
      // No preBodies passed
    });
    const del = entry.items.find((i) => i.id === "3");
    assert.equal(del.undoable, false);
    assert.equal(del.preBody, undefined);
  });
});

describe("prependEntry()", () => {
  test("newest entry lands at index 0", () => {
    const existing = [{ id: "a" }, { id: "b" }];
    const out = prependEntry(existing, { id: "c" });
    assert.equal(out[0].id, "c");
    assert.equal(out[1].id, "a");
    assert.equal(out[2].id, "b");
  });

  test("caps at MAX_ENTRIES_PER_NETWORK", () => {
    const existing = Array.from({ length: MAX_ENTRIES_PER_NETWORK }, (_, i) => ({ id: String(i) }));
    const out = prependEntry(existing, { id: "new" });
    assert.equal(out.length, MAX_ENTRIES_PER_NETWORK);
    assert.equal(out[0].id, "new");
    // Oldest fell off.
    assert.equal(out[out.length - 1].id, String(MAX_ENTRIES_PER_NETWORK - 2));
  });
});

describe("storage round-trip", () => {
  let data;
  beforeEach(() => { data = installStorageShim(); });

  test("save → load returns the same entries", () => {
    const entries = [{ id: "a", network: "n", items: [], summary: { total: 0, applied: 0, failed: 0, danger: 0 }, timestamp: "t", user: null }];
    saveHistory("n", entries);
    assert.deepEqual(loadHistory("n"), entries);
  });

  test("load with no data returns []", () => {
    assert.deepEqual(loadHistory("n"), []);
  });

  test("load with malformed JSON returns []", () => {
    data.set("newtcon:history:n", "not-json");
    assert.deepEqual(loadHistory("n"), []);
  });

  test("load with non-array JSON returns []", () => {
    data.set("newtcon:history:n", '{"not":"an array"}');
    assert.deepEqual(loadHistory("n"), []);
  });

  test("appendEntry composes load + prepend + save", () => {
    appendEntry("n", { id: "a" });
    appendEntry("n", { id: "b" });
    const loaded = loadHistory("n");
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].id, "b");
    assert.equal(loaded[1].id, "a");
  });

  test("entries are scoped per network", () => {
    appendEntry("net1", { id: "a" });
    appendEntry("net2", { id: "b" });
    assert.deepEqual(loadHistory("net1").map((e) => e.id), ["a"]);
    assert.deepEqual(loadHistory("net2").map((e) => e.id), ["b"]);
  });

  test("clearHistory removes the storage key for that network", () => {
    appendEntry("n", { id: "a" });
    clearHistory("n");
    assert.deepEqual(loadHistory("n"), []);
  });

  test("clearHistory of one network does not touch others", () => {
    appendEntry("net1", { id: "a" });
    appendEntry("net2", { id: "b" });
    clearHistory("net1");
    assert.deepEqual(loadHistory("net2").map((e) => e.id), ["b"]);
  });
});
