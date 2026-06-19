// test/topology-palette.test.js — unit tests for the pure palette
// resolver (slice #210.A).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  resolvePalette,
  resolveDevicePalette,
  resolveLabDevicePalette,
  resolvePhysicalDevicePalette,
  resolveLinkPalette,
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

describe("resolveLabDevicePalette() — Spec+Lab view (slice #210.D)", () => {
  test("null lab → spec-only (no lab actuating the spec — blue, not grey)", () => {
    assert.equal(resolveLabDevicePalette(null, "leaf1"), "spec-only");
  });

  test("lab doesn't know about device → spec-only", () => {
    assert.equal(
      resolveLabDevicePalette({ nodes: {} }, "leaf1"),
      "spec-only",
    );
  });

  test("lab node stopped → actuated-down", () => {
    assert.equal(
      resolveLabDevicePalette({ nodes: { leaf1: { status: "stopped" } } }, "leaf1"),
      "actuated-down",
    );
  });

  test("lab node error → actuated-down", () => {
    assert.equal(
      resolveLabDevicePalette({ nodes: { leaf1: { status: "error" } } }, "leaf1"),
      "actuated-down",
    );
  });

  test("lab node with phase → unknown (mid-transition)", () => {
    assert.equal(
      resolveLabDevicePalette(
        { nodes: { leaf1: { status: "running", phase: "boot" } } },
        "leaf1",
      ),
      "unknown",
    );
  });

  test("lab node running, no phase → actuated-ok", () => {
    assert.equal(
      resolveLabDevicePalette({ nodes: { leaf1: { status: "running" } } }, "leaf1"),
      "actuated-ok",
    );
  });

  test("does NOT surface drift (drift is a physical-side concept)", () => {
    // Lab view intentionally ignores drift even if a drift signal
    // existed — CONFIG_DB drift is meaningful only against a physical
    // device's running config.
    assert.equal(
      resolveLabDevicePalette({ nodes: { leaf1: { status: "running" } } }, "leaf1"),
      "actuated-ok",
    );
  });
});

describe("resolvePhysicalDevicePalette() — Spec+Physical view (slice #210.C)", () => {
  test("online undefined → unknown (probe in flight)", () => {
    assert.equal(resolvePhysicalDevicePalette(undefined, 0), "unknown");
  });

  test("!online → spec-only (no actuation evidence)", () => {
    assert.equal(resolvePhysicalDevicePalette(false, 0), "spec-only");
    assert.equal(resolvePhysicalDevicePalette(false, 5), "spec-only");
  });

  test("online + drift > 0 → drift", () => {
    assert.equal(resolvePhysicalDevicePalette(true, 3), "drift");
  });

  test("online + drift = 0 → actuated-ok", () => {
    assert.equal(resolvePhysicalDevicePalette(true, 0), "actuated-ok");
  });
});

describe("resolveLinkPalette() — worst-of-two endpoint state", () => {
  test("symmetric — order does not change result", () => {
    assert.equal(
      resolveLinkPalette("actuated-ok", "drift"),
      resolveLinkPalette("drift", "actuated-ok"),
    );
  });

  test("down beats everything", () => {
    assert.equal(resolveLinkPalette("actuated-down", "actuated-ok"), "actuated-down");
    assert.equal(resolveLinkPalette("actuated-down", "drift"), "actuated-down");
    assert.equal(resolveLinkPalette("actuated-down", "spec-only"), "actuated-down");
    assert.equal(resolveLinkPalette("actuated-down", "unknown"), "actuated-down");
  });

  test("drift beats spec-only / ok / unknown", () => {
    assert.equal(resolveLinkPalette("drift", "spec-only"), "drift");
    assert.equal(resolveLinkPalette("drift", "actuated-ok"), "drift");
    assert.equal(resolveLinkPalette("drift", "unknown"), "drift");
  });

  test("spec-only beats actuated-ok / unknown", () => {
    assert.equal(resolveLinkPalette("spec-only", "actuated-ok"), "spec-only");
    assert.equal(resolveLinkPalette("spec-only", "unknown"), "spec-only");
  });

  test("actuated-ok beats unknown", () => {
    assert.equal(resolveLinkPalette("actuated-ok", "unknown"), "actuated-ok");
  });

  test("equal endpoints return that state", () => {
    assert.equal(resolveLinkPalette("drift", "drift"), "drift");
    assert.equal(resolveLinkPalette("actuated-ok", "actuated-ok"), "actuated-ok");
  });
});
