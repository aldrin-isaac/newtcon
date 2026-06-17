// test/smart-defaults.test.js — unit tests for the pure helpers in
// smart-defaults.ts (slice #172.D). The async fetch path
// (computePrefillForKind) is exercised via the integration smoke test.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { nextAvailable, extractIntField, strategiesFor } from "../dist/smart-defaults.js";

describe("nextAvailable()", () => {
  test("empty used → minStart", () => {
    assert.equal(nextAvailable(new Set(), 10000, 16777215), 10000);
  });

  test("used = {minStart} → minStart + 1", () => {
    assert.equal(nextAvailable(new Set([10000]), 10000, 16777215), 10001);
  });

  test("used = {minStart, minStart+1} → minStart + 2 (monotonic growth)", () => {
    assert.equal(nextAvailable(new Set([10000, 10001]), 10000, 16777215), 10002);
  });

  test("used has gap but room above max → favours max(used) + 1 over filling the gap", () => {
    // Operators expect new specs to slot above the highest existing, not
    // to backfill an old hole — the deleted hole might be deliberate.
    assert.equal(nextAvailable(new Set([10000, 10002, 10003]), 10000, 16777215), 10004);
  });

  test("used entirely below minStart → minStart", () => {
    assert.equal(nextAvailable(new Set([1, 50, 999]), 10000, 16777215), 10000);
  });

  test("range top reached → falls back to first gap from minStart", () => {
    // Tight range: minStart=10, max=12, used={11,12}. max(used)+1 = 13
    // exceeds max, so scan finds 10.
    assert.equal(nextAvailable(new Set([11, 12]), 10, 12), 10);
  });

  test("entire range exhausted → null", () => {
    assert.equal(nextAvailable(new Set([10, 11, 12]), 10, 12), null);
  });

  test("accepts an Iterable, not just a Set", () => {
    assert.equal(nextAvailable([10000, 10001], 10000, 16777215), 10002);
  });
});

describe("extractIntField()", () => {
  test("number value returned as-is", () => {
    assert.equal(extractIntField({ vni: 10001 }, "vni"), 10001);
  });

  test("string-encoded number parsed", () => {
    assert.equal(extractIntField({ vni: "10001" }, "vni"), 10001);
  });

  test("missing field → null", () => {
    assert.equal(extractIntField({ other: 1 }, "vni"), null);
  });

  test("non-numeric string → null", () => {
    assert.equal(extractIntField({ vni: "ten thousand" }, "vni"), null);
  });

  test("float number → null (must be integer)", () => {
    assert.equal(extractIntField({ vni: 10000.5 }, "vni"), null);
  });

  test("negative number → null (use cases are non-negative IDs)", () => {
    assert.equal(extractIntField({ vni: -1 }, "vni"), null);
  });

  test("non-object detail → null", () => {
    assert.equal(extractIntField(null, "vni"), null);
    assert.equal(extractIntField(42, "vni"), null);
    assert.equal(extractIntField([1, 2, 3], "vni"), null);
  });

  test("string with trailing garbage → null (parseInt would accept '10001x')", () => {
    assert.equal(extractIntField({ vni: "10001x" }, "vni"), null);
  });
});

describe("strategiesFor()", () => {
  test("ipvpns has an l3vni strategy", () => {
    const s = strategiesFor("ipvpns");
    assert.ok(s);
    assert.equal(s.length, 1);
    assert.equal(s[0].field, "l3vni");
  });

  test("macvpns has a vni strategy", () => {
    const s = strategiesFor("macvpns");
    assert.ok(s);
    assert.equal(s[0].field, "vni");
  });

  test("services has no smart defaults (operator chooses the type)", () => {
    assert.equal(strategiesFor("services"), undefined);
  });

  test("zones has no smart defaults", () => {
    assert.equal(strategiesFor("zones"), undefined);
  });
});
