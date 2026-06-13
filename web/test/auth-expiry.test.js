// test/auth-expiry.test.js — unit tests for the session-expiry helpers.
//
// Pure functions of (expiresAt, now); tests inject `now` directly so no
// timer mocking is needed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  EXPIRY_WARN_THRESHOLD_MS,
  formatExpiryRelative,
  isNearExpiry,
  isExpired,
} from "../dist/auth-expiry.js";

// Anchor "now" so the tests are reproducible.
const NOW = new Date("2026-06-12T10:00:00Z");
const offsetMin = (n) => new Date(NOW.getTime() + n * 60_000);

describe("formatExpiryRelative()", () => {
  test('8h-out → "in 8 h"', () => {
    assert.equal(formatExpiryRelative(offsetMin(8 * 60), NOW), "in 8 h");
  });

  test('4h 12min out → "in 4 h 12 min"', () => {
    assert.equal(formatExpiryRelative(offsetMin(4 * 60 + 12), NOW), "in 4 h 12 min");
  });

  test('45 min out → "in 45 min"', () => {
    assert.equal(formatExpiryRelative(offsetMin(45), NOW), "in 45 min");
  });

  test('1 min out → "in 1 min"', () => {
    assert.equal(formatExpiryRelative(offsetMin(1), NOW), "in 1 min");
  });

  test('45 sec out → "in less than a minute"', () => {
    assert.equal(formatExpiryRelative(new Date(NOW.getTime() + 45_000), NOW), "in less than a minute");
  });

  test("already expired → labelled 'expired' with the wall-clock time", () => {
    const expired = offsetMin(-5);
    const s = formatExpiryRelative(expired, NOW);
    assert.match(s, /^expired \(was /);
  });
});

describe("isNearExpiry()", () => {
  test("more than threshold remaining → false", () => {
    assert.equal(isNearExpiry(offsetMin(60), NOW), false);
  });

  test("exactly at threshold → true (≤ boundary)", () => {
    const at = new Date(NOW.getTime() + EXPIRY_WARN_THRESHOLD_MS);
    assert.equal(isNearExpiry(at, NOW), true);
  });

  test("inside threshold → true", () => {
    assert.equal(isNearExpiry(offsetMin(5), NOW), true);
  });

  test("already expired → false (not 'near', already past)", () => {
    assert.equal(isNearExpiry(offsetMin(-1), NOW), false);
  });

  test("threshold default is 15 minutes", () => {
    assert.equal(EXPIRY_WARN_THRESHOLD_MS, 15 * 60 * 1000);
  });
});

describe("isExpired()", () => {
  test("future → false", () => {
    assert.equal(isExpired(offsetMin(5), NOW), false);
  });

  test("past → true", () => {
    assert.equal(isExpired(offsetMin(-1), NOW), true);
  });

  test("exact moment → true (boundary is inclusive)", () => {
    assert.equal(isExpired(NOW, NOW), true);
  });
});
