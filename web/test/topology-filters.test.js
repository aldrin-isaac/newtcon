// test/topology-filters.test.js — unit tests for the pure layered-
// filter helpers (slice #174.E).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  emptyFilter,
  isActive,
  matchesFilter,
  applyFilter,
  uniqueZones,
} from "../dist/topology-filters.js";

const METADATA = new Map([
  ["leaf1-ny",  { zone: "amer" }],
  ["spine1-ny", { zone: "amer" }],
  ["leaf2-lon", { zone: "emea" }],
  ["spine1-lon", { zone: "emea" }],
  ["host-spare", { zone: null }],
]);

describe("emptyFilter() / isActive()", () => {
  test("empty filter is not active", () => {
    assert.equal(isActive(emptyFilter()), false);
  });

  test("filter with a zone set is active", () => {
    assert.equal(isActive({ zones: new Set(["amer"]) }), true);
  });
});

describe("matchesFilter()", () => {
  test("inactive filter matches everything (including no-zone devices)", () => {
    const f = emptyFilter();
    assert.equal(matchesFilter("leaf1-ny", f, METADATA), true);
    assert.equal(matchesFilter("host-spare", f, METADATA), true);
  });

  test("active zone filter matches devices whose zone is in the set", () => {
    const f = { zones: new Set(["amer"]) };
    assert.equal(matchesFilter("leaf1-ny", f, METADATA), true);
    assert.equal(matchesFilter("spine1-ny", f, METADATA), true);
    assert.equal(matchesFilter("leaf2-lon", f, METADATA), false);
  });

  test("active zone filter rejects devices missing zone metadata", () => {
    const f = { zones: new Set(["amer"]) };
    assert.equal(matchesFilter("host-spare", f, METADATA), false);
    assert.equal(matchesFilter("unknown-device", f, METADATA), false);
  });

  test("multi-zone selection is OR within the dimension", () => {
    const f = { zones: new Set(["amer", "emea"]) };
    assert.equal(matchesFilter("leaf1-ny", f, METADATA), true);
    assert.equal(matchesFilter("leaf2-lon", f, METADATA), true);
    assert.equal(matchesFilter("host-spare", f, METADATA), false);
  });
});

describe("applyFilter()", () => {
  test("inactive filter → every device visible, hidden empty", () => {
    const r = applyFilter(emptyFilter(), ["leaf1-ny", "host-spare"], METADATA);
    assert.equal(r.visible.size, 2);
    assert.equal(r.hidden.size, 0);
  });

  test("active filter partitions correctly", () => {
    const r = applyFilter(
      { zones: new Set(["amer"]) },
      ["leaf1-ny", "spine1-ny", "leaf2-lon", "host-spare"],
      METADATA,
    );
    assert.deepEqual([...r.visible].sort(), ["leaf1-ny", "spine1-ny"]);
    assert.deepEqual([...r.hidden].sort(), ["host-spare", "leaf2-lon"]);
  });

  test("empty device list → both sets empty", () => {
    const r = applyFilter({ zones: new Set(["amer"]) }, [], METADATA);
    assert.equal(r.visible.size, 0);
    assert.equal(r.hidden.size, 0);
  });
});

describe("uniqueZones()", () => {
  test("extracts + de-dupes + sorts zones present in metadata", () => {
    assert.deepEqual(uniqueZones(METADATA), ["amer", "emea"]);
  });

  test("skips devices with null zone", () => {
    const m = new Map([["host", { zone: null }]]);
    assert.deepEqual(uniqueZones(m), []);
  });

  test("empty metadata → empty list", () => {
    assert.deepEqual(uniqueZones(new Map()), []);
  });
});
