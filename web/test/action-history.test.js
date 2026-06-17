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
    { id: "1", effect: "create", kind: "spec", title: "transit-2026", scope: "services", danger: false, body: null },
    { id: "2", effect: "action", kind: "device action", title: "create-vlan", scope: "r1", danger: false, body: null },
    { id: "3", effect: "delete", kind: "spec", title: "old", scope: "zones", danger: true, body: null },
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
