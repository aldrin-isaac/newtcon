// test/topology-layout.test.js — unit tests for the connectivity-aware topology
// layout: neighbours close, distance grows with hops, hosts at the bottom, no
// overlaps, pinned nodes fixed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeTopologyLayout } from "../dist/topology-layout.js";

const OPTS = { nodeW: 120, nodeH: 52, hGap: 80, vGap: 60 };
const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
// Two boxes overlap only if they're inside BOTH the min x and min y separation.
const overlap = (a, b) =>
  Math.abs(a.cx - b.cx) < OPTS.nodeW + OPTS.hGap - 0.5 &&
  Math.abs(a.cy - b.cy) < OPTS.nodeH + OPTS.vGap - 0.5;

describe("computeTopologyLayout", () => {
  test("empty input yields an empty map", () => {
    assert.equal(computeTopologyLayout([], [], OPTS).size, 0);
  });

  test("directly-connected neighbours end up closer than unconnected nodes", () => {
    // a-b linked; c is isolated. dist(a,b) should be < dist(a,c).
    const nodes = [
      { name: "a", isHost: false },
      { name: "b", isHost: false },
      { name: "c", isHost: false },
    ];
    const pos = computeTopologyLayout(nodes, [{ a: "a", z: "b" }], OPTS);
    const ab = dist(pos.get("a"), pos.get("b"));
    const ac = dist(pos.get("a"), pos.get("c"));
    assert.ok(ab < ac, `neighbour dist ${ab.toFixed(0)} should be < isolated dist ${ac.toFixed(0)}`);
  });

  test("distance grows with hop count (a-b-c line: a..c farther than a..b)", () => {
    const nodes = [
      { name: "a", isHost: false },
      { name: "b", isHost: false },
      { name: "c", isHost: false },
    ];
    const pos = computeTopologyLayout(nodes, [{ a: "a", z: "b" }, { a: "b", z: "c" }], OPTS);
    const ab = dist(pos.get("a"), pos.get("b"));
    const ac = dist(pos.get("a"), pos.get("c"));
    assert.ok(ac > ab * 1.3, `2-hop a..c ${ac.toFixed(0)} should clearly exceed 1-hop a..b ${ab.toFixed(0)}`);
  });

  test("hosts are placed below every switch", () => {
    const nodes = [
      { name: "spine1", isHost: false },
      { name: "leaf1", isHost: false },
      { name: "leaf2", isHost: false },
      { name: "host1", isHost: true },
      { name: "host2", isHost: true },
    ];
    const edges = [
      { a: "spine1", z: "leaf1" },
      { a: "spine1", z: "leaf2" },
      { a: "leaf1", z: "host1" },
      { a: "leaf2", z: "host2" },
    ];
    const pos = computeTopologyLayout(nodes, edges, OPTS);
    const switchYs = ["spine1", "leaf1", "leaf2"].map((n) => pos.get(n).cy);
    const hostYs = ["host1", "host2"].map((n) => pos.get(n).cy);
    const lowestSwitch = Math.max(...switchYs);
    for (const hy of hostYs) {
      assert.ok(hy > lowestSwitch, `host y ${hy.toFixed(0)} should be below lowest switch ${lowestSwitch.toFixed(0)}`);
    }
  });

  test("no two node boxes overlap", () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({ name: `n${i}`, isHost: i >= 6 }));
    const edges = [
      { a: "n0", z: "n1" }, { a: "n0", z: "n2" }, { a: "n1", z: "n3" },
      { a: "n2", z: "n4" }, { a: "n3", z: "n5" }, { a: "n4", z: "n6" }, { a: "n5", z: "n7" },
    ];
    const pos = computeTopologyLayout(nodes, edges, OPTS);
    const names = nodes.map((n) => n.name);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        assert.ok(!overlap(pos.get(names[i]), pos.get(names[j])), `${names[i]} and ${names[j]} overlap`);
      }
    }
  });

  test("pinned nodes stay exactly at their pinned position", () => {
    const nodes = [
      { name: "a", isHost: false },
      { name: "b", isHost: false },
      { name: "c", isHost: false },
    ];
    const pinned = new Map([["a", { cx: 500, cy: 300 }]]);
    const pos = computeTopologyLayout(nodes, [{ a: "a", z: "b" }], { ...OPTS, pinned });
    assert.deepEqual(pos.get("a"), { cx: 500, cy: 300 });
  });

  test("is deterministic — same graph yields identical positions", () => {
    const nodes = [
      { name: "a", isHost: false },
      { name: "b", isHost: false },
      { name: "c", isHost: true },
    ];
    const edges = [{ a: "a", z: "b" }, { a: "b", z: "c" }];
    const p1 = computeTopologyLayout(nodes, edges, OPTS);
    const p2 = computeTopologyLayout(nodes, edges, OPTS);
    for (const name of ["a", "b", "c"]) {
      assert.deepEqual(p1.get(name), p2.get(name));
    }
  });
});
