// test/sample-network.test.js — unit tests for the sample-seed
// planner (slice #169.E).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  SAMPLE_SEEDS,
  planLoad,
  summarisePlan,
} from "../dist/sample-network.js";

describe("SAMPLE_SEEDS", () => {
  test("is non-empty and stable", () => {
    assert.ok(SAMPLE_SEEDS.length > 0);
    // Each seed has the four required fields.
    for (const s of SAMPLE_SEEDS) {
      assert.ok(s.kind && s.kind.length > 0);
      assert.ok(s.name && s.name.length > 0);
      assert.ok(s.body && typeof s.body === "object");
      assert.ok(s.description && s.description.length > 0);
    }
  });

  test("uses sample- prefix so seeds are easy to identify + delete", () => {
    for (const s of SAMPLE_SEEDS) {
      assert.ok(s.name.startsWith("sample-"),
        `${s.name} should start with 'sample-' so operators can spot + clean up`);
    }
  });

  test("ipvpn seed exists and the service references it (binding visible)", () => {
    const ipvpn = SAMPLE_SEEDS.find((s) => s.kind === "ipvpns");
    const service = SAMPLE_SEEDS.find((s) => s.kind === "services");
    assert.ok(ipvpn, "expected one ipvpns seed");
    assert.ok(service, "expected one services seed");
    assert.equal(service.body.ipvpn, ipvpn.name,
      "service should reference the ipvpn so the binding is observable");
  });
});

describe("planLoad()", () => {
  test("empty existing map → every seed queued", () => {
    const plan = planLoad(new Map());
    assert.equal(plan.length, SAMPLE_SEEDS.length);
    for (const p of plan) assert.equal(p.action, "queue");
  });

  test("seed name already exists → that seed is skipped, others still queue", () => {
    const existing = new Map([
      ["ipvpns", new Set(["sample-l3vpn"])],
    ]);
    const plan = planLoad(existing);
    const ipvpnPlan = plan.find((p) => p.seed.kind === "ipvpns");
    const servicePlan = plan.find((p) => p.seed.kind === "services");
    assert.equal(ipvpnPlan.action, "skip");
    assert.equal(servicePlan.action, "queue");
  });

  test("missing kind in existing map treated as no conflict", () => {
    const existing = new Map([
      ["ipvpns", new Set()],
      // services not present
    ]);
    const plan = planLoad(existing);
    for (const p of plan) assert.equal(p.action, "queue");
  });

  test("matching name in a different kind does NOT skip (kind-scoped lookup)", () => {
    const existing = new Map([
      ["macvpns", new Set(["sample-l3vpn"])],
    ]);
    const plan = planLoad(existing);
    const ipvpnPlan = plan.find((p) => p.seed.kind === "ipvpns");
    assert.equal(ipvpnPlan.action, "queue");
  });
});

describe("summarisePlan()", () => {
  test("counts queued / skipped", () => {
    const plan = [
      { seed: SAMPLE_SEEDS[0], action: "queue" },
      { seed: SAMPLE_SEEDS[1], action: "skip" },
    ];
    const r = summarisePlan(plan);
    assert.equal(r.queued, 1);
    assert.equal(r.skipped, 1);
    assert.equal(r.lines.length, 2);
    assert.ok(r.lines[0].startsWith("+ "));
    assert.ok(r.lines[1].startsWith("− "));
  });

  test("all-queue plan reports zero skipped + all + lines", () => {
    const plan = SAMPLE_SEEDS.map((seed) => ({ seed, action: "queue" }));
    const r = summarisePlan(plan);
    assert.equal(r.queued, SAMPLE_SEEDS.length);
    assert.equal(r.skipped, 0);
    for (const line of r.lines) assert.ok(line.startsWith("+ "));
  });

  test("all-skip plan reports zero queued", () => {
    const plan = SAMPLE_SEEDS.map((seed) => ({ seed, action: "skip" }));
    const r = summarisePlan(plan);
    assert.equal(r.queued, 0);
    assert.equal(r.skipped, SAMPLE_SEEDS.length);
    for (const line of r.lines) assert.ok(line.startsWith("− "));
  });
});
