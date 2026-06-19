// test/topology-palette.test.js — unit tests for the pure palette
// resolver (slice #210.A).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  resolvePalette,
  resolveDevicePalette,
} from "../dist/topology-palette.js";

describe("resolvePalette()", () => {
  test("null signal → unknown", () => {
    assert.equal(resolvePalette(null), "unknown");
  });

  test("not observed → spec-only", () => {
    assert.equal(resolvePalette({ observed: false, down: false, drift: false }), "spec-only");
  });

  test("observed + down → actuated-down (down wins over drift)", () => {
    assert.equal(resolvePalette({ observed: true, down: true, drift: false }), "actuated-down");
    assert.equal(resolvePalette({ observed: true, down: true, drift: true  }), "actuated-down");
  });

  test("observed + drift (not down) → drift", () => {
    assert.equal(resolvePalette({ observed: true, down: false, drift: true }), "drift");
  });

  test("observed, neither down nor drifted → actuated-ok", () => {
    assert.equal(resolvePalette({ observed: true, down: false, drift: false }), "actuated-ok");
  });
});

describe("resolveDevicePalette()", () => {
  test("undefined status → unknown (probe in flight)", () => {
    assert.equal(resolveDevicePalette(undefined, 0), "unknown");
  });

  test("unrealized → spec-only", () => {
    assert.equal(
      resolveDevicePalette({ state: "unrealized", detail: "no lab VM" }, 0),
      "spec-only",
    );
  });

  test("down → actuated-down (drift ignored — reachability is more urgent)", () => {
    assert.equal(
      resolveDevicePalette({ state: "down", detail: "lab VM stopped" }, 5),
      "actuated-down",
    );
  });

  test("booting → unknown (mid-transition, neither ok nor down)", () => {
    assert.equal(
      resolveDevicePalette({ state: "booting", detail: "lab VM — boot" }, 0),
      "unknown",
    );
  });

  test("running + drift > 0 → drift", () => {
    assert.equal(
      resolveDevicePalette({ state: "running", detail: "lab VM (pid 1234)" }, 3),
      "drift",
    );
  });

  test("running + drift = 0 → actuated-ok", () => {
    assert.equal(
      resolveDevicePalette({ state: "running", detail: "lab VM (pid 1234)" }, 0),
      "actuated-ok",
    );
  });

  test("running with no drift signal yet (count 0 from default map miss) → actuated-ok", () => {
    // Defensive — driftCount defaults to 0 when the map doesn't have
    // the device. That's "no drift" not "unknown drift" — running
    // dominates.
    assert.equal(
      resolveDevicePalette({ state: "running", detail: "x" }, 0),
      "actuated-ok",
    );
  });
});
