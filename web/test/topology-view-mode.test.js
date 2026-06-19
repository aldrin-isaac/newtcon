// test/topology-view-mode.test.js — unit tests for the per-network
// view-mode helpers (slice #210.B).

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_VIEW_MODES,
  defaultViewMode,
  loadViewMode,
  saveViewMode,
  viewModeLabel,
} from "../dist/topology-view-mode.js";

// Tiny in-memory localStorage shim. The implementation reads from
// globalThis.localStorage and tolerates absence (try/catch) so tests
// install one before exercising load/save.
function installLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  return store;
}

describe("ALL_VIEW_MODES", () => {
  test("contains all three modes in spec → lab → physical order", () => {
    assert.deepEqual(ALL_VIEW_MODES, ["spec", "spec-lab", "spec-physical"]);
  });
});

describe("viewModeLabel()", () => {
  test("operator-facing labels are stable", () => {
    assert.equal(viewModeLabel("spec"), "Spec");
    assert.equal(viewModeLabel("spec-lab"), "Lab");
    assert.equal(viewModeLabel("spec-physical"), "Physical");
  });
});

describe("loadViewMode / saveViewMode", () => {
  beforeEach(() => { installLocalStorage(); });

  test("load returns null when nothing stored", () => {
    assert.equal(loadViewMode("net-a"), null);
  });

  test("save round-trip", () => {
    saveViewMode("net-a", "spec-lab");
    assert.equal(loadViewMode("net-a"), "spec-lab");
  });

  test("per-network isolation — net-b doesn't see net-a's choice", () => {
    saveViewMode("net-a", "spec-physical");
    assert.equal(loadViewMode("net-b"), null);
  });

  test("rejects garbage in storage (returns null)", () => {
    globalThis.localStorage.setItem("newtcon:topology-view:net-a", "not-a-mode");
    assert.equal(loadViewMode("net-a"), null);
  });

  test("tolerates absence of localStorage entirely", () => {
    delete globalThis.localStorage;
    // load returns null rather than throwing
    assert.equal(loadViewMode("net-a"), null);
    // save is a no-op rather than throwing
    saveViewMode("net-a", "spec");
  });
});

describe("defaultViewMode()", () => {
  test("prefers spec-lab when lab has any nodes", () => {
    const lab = { nodes: { leaf1: { status: "running" } } };
    const online = new Map([["leaf1", true]]);
    assert.equal(defaultViewMode(lab, online), "spec-lab");
  });

  test("falls through to spec-physical when no lab nodes but some device online", () => {
    const lab = { nodes: {} };
    const online = new Map([["leaf1", true], ["leaf2", false]]);
    assert.equal(defaultViewMode(lab, online), "spec-physical");
  });

  test("null lab + online device → spec-physical", () => {
    const online = new Map([["leaf1", true]]);
    assert.equal(defaultViewMode(null, online), "spec-physical");
  });

  test("falls through to spec when no signals at all", () => {
    assert.equal(defaultViewMode(null, new Map()), "spec");
    assert.equal(defaultViewMode({ nodes: {} }, new Map([["leaf1", false]])), "spec");
  });
});

