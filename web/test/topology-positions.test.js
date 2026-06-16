// test/topology-positions.test.js — unit tests for the per-network
// node-position persistence helpers. Uses an in-memory localStorage
// stub so tests don't touch real browser storage.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  loadPositions,
  savePosition,
  clearPositions,
} from "../dist/topology-positions.js";

// ---- localStorage stub ----------------------------------------------------

class StorageStub {
  constructor() { this.data = new Map(); }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}

let _origLocalStorage;
beforeEach(() => {
  _origLocalStorage = globalThis.localStorage;
  globalThis.localStorage = new StorageStub();
});
afterEach(() => {
  globalThis.localStorage = _origLocalStorage;
});

// ---- tests ----------------------------------------------------------------

describe("loadPositions()", () => {
  test("returns empty map when nothing's stored", () => {
    const m = loadPositions("default");
    assert.equal(m.size, 0);
  });

  test("reads previously-saved positions back", () => {
    savePosition("default", "switch1", { cx: 100, cy: 200 });
    savePosition("default", "switch2", { cx: 300, cy: 400 });
    const m = loadPositions("default");
    assert.deepEqual(m.get("switch1"), { cx: 100, cy: 200 });
    assert.deepEqual(m.get("switch2"), { cx: 300, cy: 400 });
  });

  test("returns empty map on malformed JSON in storage", () => {
    globalThis.localStorage.setItem("newtcon.topology.positions.default", "{not json");
    const m = loadPositions("default");
    assert.equal(m.size, 0);
  });

  test("ignores entries with wrong-typed cx/cy", () => {
    globalThis.localStorage.setItem(
      "newtcon.topology.positions.default",
      JSON.stringify({ ok: { cx: 1, cy: 2 }, bad: { cx: "x", cy: 3 } }),
    );
    const m = loadPositions("default");
    assert.equal(m.size, 1);
    assert.ok(m.has("ok"));
    assert.ok(!m.has("bad"));
  });
});

describe("savePosition()", () => {
  test("isolates per network", () => {
    savePosition("net-a", "node1", { cx: 1, cy: 2 });
    savePosition("net-b", "node1", { cx: 100, cy: 200 });
    assert.deepEqual(loadPositions("net-a").get("node1"), { cx: 1, cy: 2 });
    assert.deepEqual(loadPositions("net-b").get("node1"), { cx: 100, cy: 200 });
  });

  test("subsequent save merges, doesn't replace whole map", () => {
    savePosition("default", "a", { cx: 1, cy: 1 });
    savePosition("default", "b", { cx: 2, cy: 2 });
    const m = loadPositions("default");
    assert.equal(m.size, 2);
  });

  test("overwrites an existing entry for the same device", () => {
    savePosition("default", "a", { cx: 1, cy: 1 });
    savePosition("default", "a", { cx: 99, cy: 99 });
    assert.deepEqual(loadPositions("default").get("a"), { cx: 99, cy: 99 });
  });
});

describe("clearPositions()", () => {
  test("wipes all pinned positions for a network", () => {
    savePosition("default", "a", { cx: 1, cy: 1 });
    savePosition("default", "b", { cx: 2, cy: 2 });
    clearPositions("default");
    assert.equal(loadPositions("default").size, 0);
  });

  test("doesn't affect other networks", () => {
    savePosition("net-a", "x", { cx: 1, cy: 1 });
    savePosition("net-b", "x", { cx: 2, cy: 2 });
    clearPositions("net-a");
    assert.equal(loadPositions("net-a").size, 0);
    assert.equal(loadPositions("net-b").size, 1);
  });
});

describe("graceful degradation", () => {
  test("loadPositions returns empty when localStorage is unavailable", () => {
    globalThis.localStorage = undefined;
    const m = loadPositions("default");
    assert.equal(m.size, 0);
  });

  test("savePosition is a no-op when localStorage is unavailable", () => {
    globalThis.localStorage = undefined;
    // Should not throw.
    savePosition("default", "x", { cx: 1, cy: 1 });
  });
});
