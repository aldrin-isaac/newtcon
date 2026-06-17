// test/audit-format.test.js — unit tests for the pure audit
// formatters (slice #175.B).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  shortHash,
  formatTimestamp,
  eventStatusLabel,
  activeFilterCount,
} from "../dist/audit-format.js";

describe("shortHash()", () => {
  test("full SHA-256 → 8 + ellipsis + 8", () => {
    const h = "27bfbff50b48e30730ddd751194e4e9e0cae5bb1939c7b6279334a6e57662044";
    assert.equal(shortHash(h), "27bfbff5…57662044");
  });

  test("short input → returned as-is (never mangles non-hashes)", () => {
    assert.equal(shortHash(""), "");
    assert.equal(shortHash("abc123"), "abc123");
    assert.equal(shortHash("16-character-hex"), "16-character-hex");
    assert.equal(shortHash("17-character-hex!"), "17-character-hex!");
  });
});

describe("formatTimestamp()", () => {
  test("valid RFC3339 → locale string (not the raw input)", () => {
    const out = formatTimestamp("2026-06-17T07:34:43Z");
    assert.notEqual(out, "2026-06-17T07:34:43Z");
    assert.ok(out.length > 0);
  });

  test("empty input → empty string", () => {
    assert.equal(formatTimestamp(""), "");
  });

  test("invalid input → returned as-is", () => {
    assert.equal(formatTimestamp("not-a-date"), "not-a-date");
  });
});

describe("eventStatusLabel()", () => {
  test("success + execute_mode → applied", () => {
    assert.equal(eventStatusLabel({ success: true, execute_mode: true }), "applied");
  });

  test("success + dry_run → dry-run (takes priority over execute_mode)", () => {
    assert.equal(eventStatusLabel({ success: true, dry_run: true, execute_mode: true }), "dry-run");
  });

  test("success + !execute_mode + !dry_run → preview", () => {
    assert.equal(eventStatusLabel({ success: true, execute_mode: false }), "preview");
  });

  test("!success → failed (regardless of other flags)", () => {
    assert.equal(eventStatusLabel({ success: false }), "failed");
    assert.equal(eventStatusLabel({ success: false, dry_run: true }), "failed");
  });

  test("success defaults (no execute_mode field) → applied", () => {
    // execute_mode undefined treated as the common case.
    assert.equal(eventStatusLabel({ success: true }), "applied");
  });
});

describe("activeFilterCount()", () => {
  test("empty filters object → 0", () => {
    assert.equal(activeFilterCount({}), 0);
  });

  test("undefined / null / empty-string values are not counted", () => {
    assert.equal(activeFilterCount({
      device: undefined, user: null, service: "", iface: "",
    }), 0);
  });

  test("populated values are counted", () => {
    assert.equal(activeFilterCount({
      device: "switch1", user: "alice",
    }), 2);
  });

  test("false is a valid filter value (success=false) — counted", () => {
    assert.equal(activeFilterCount({ success: false }), 1);
  });

  test("zero is a valid filter value (limit=0) — counted", () => {
    assert.equal(activeFilterCount({ limit: 0 }), 1);
  });
});
