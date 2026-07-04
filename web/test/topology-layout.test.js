// test/topology-layout.test.js — unit tests for the pod-aware layered (Sugiyama)
// topology layout: rank by tier, hosts on the bottom line, pods kept contiguous,
// no overlaps.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeTopologyLayout } from "../dist/topology-layout.js";

const OPTS = { nodeW: 120, nodeH: 52, hGap: 80, vGap: 60 };
const overlap = (a, b) =>
  Math.abs(a.cx - b.cx) < OPTS.nodeW + OPTS.hGap - 0.5 &&
  Math.abs(a.cy - b.cy) < OPTS.nodeH + OPTS.vGap - 0.5;
const assertNoOverlap = (pos) => {
  const names = [...pos.keys()];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      assert.ok(!overlap(pos.get(names[i]), pos.get(names[j])), `${names[i]} & ${names[j]} overlap`);
};

describe("computeTopologyLayout (layered)", () => {
  test("empty input yields an empty map", () => {
    assert.equal(computeTopologyLayout([], [], OPTS).size, 0);
  });

  test("leaf-spine: spines on top, leaves middle, hosts on the bottom line", () => {
    const nodes = [
      { name: "spine1", isHost: false }, { name: "spine2", isHost: false },
      { name: "leaf1", isHost: false }, { name: "leaf2", isHost: false },
      { name: "host1", isHost: true }, { name: "host2", isHost: true },
    ];
    const edges = [
      { a: "leaf1", z: "spine1" }, { a: "leaf1", z: "spine2" },
      { a: "leaf2", z: "spine1" }, { a: "leaf2", z: "spine2" },
      { a: "host1", z: "leaf1" }, { a: "host2", z: "leaf2" },
    ];
    const p = computeTopologyLayout(nodes, edges, OPTS);
    const cy = (n) => p.get(n).cy;
    // larger cy = lower on screen. hosts lowest, spines highest.
    assert.ok(cy("host1") > cy("leaf1"), "host below leaf");
    assert.ok(cy("leaf1") > cy("spine1"), "leaf below spine");
    // hosts share one bottom line
    assert.equal(cy("host1"), cy("host2"), "hosts colinear");
    // spines share the top line
    assert.equal(cy("spine1"), cy("spine2"), "spines colinear");
    assertNoOverlap(p);
  });

  test("pods stay contiguous — pod A's nodes don't interleave with pod B's", () => {
    // 3-tier, 2 pods under a shared super-spine pair.
    const nodes = [
      { name: "ss1", isHost: false }, { name: "ss2", isHost: false },
      { name: "sa1", isHost: false }, { name: "la1", isHost: false }, { name: "la2", isHost: false },
      { name: "ha1", isHost: true }, { name: "ha2", isHost: true },
      { name: "sb1", isHost: false }, { name: "lb1", isHost: false }, { name: "lb2", isHost: false },
      { name: "hb1", isHost: true }, { name: "hb2", isHost: true },
    ];
    const edges = [
      { a: "ss1", z: "sa1" }, { a: "ss2", z: "sa1" }, { a: "ss1", z: "sb1" }, { a: "ss2", z: "sb1" },
      { a: "sa1", z: "la1" }, { a: "sa1", z: "la2" }, { a: "sb1", z: "lb1" }, { a: "sb1", z: "lb2" },
      { a: "la1", z: "ha1" }, { a: "la2", z: "ha2" }, { a: "lb1", z: "hb1" }, { a: "lb2", z: "hb2" },
    ];
    const p = computeTopologyLayout(nodes, edges, OPTS);
    // leaves tier: pod A = {la1,la2}, pod B = {lb1,lb2}. Sorted by x, one pod's
    // leaves must all precede the other's (no interleaving).
    const leaves = ["la1", "la2", "lb1", "lb2"].sort((a, b) => p.get(a).cx - p.get(b).cx);
    const podOf = (n) => (n.startsWith("la") ? "A" : "B");
    const seq = leaves.map(podOf).join("");
    assert.ok(seq === "AABB" || seq === "BBAA", `leaves interleave across pods: ${seq}`);
    // hosts on one bottom line, super-spines on one top line
    assert.equal(p.get("ha1").cy, p.get("hb2").cy, "all hosts colinear");
    assert.ok(p.get("ha1").cy > p.get("ss1").cy, "hosts below super-spines");
    assertNoOverlap(p);
  });

  test("host-less mesh still lays out with no overlaps", () => {
    const nodes = [
      { name: "a", isHost: false }, { name: "b", isHost: false }, { name: "c", isHost: false },
    ];
    const p = computeTopologyLayout(nodes, [{ a: "a", z: "b" }, { a: "b", z: "c" }, { a: "a", z: "c" }], OPTS);
    assert.equal(p.size, 3);
    assertNoOverlap(p);
  });

  test("is deterministic — same graph yields identical positions", () => {
    const nodes = [
      { name: "s1", isHost: false }, { name: "l1", isHost: false },
      { name: "l2", isHost: false }, { name: "h1", isHost: true },
    ];
    const edges = [{ a: "l1", z: "s1" }, { a: "l2", z: "s1" }, { a: "h1", z: "l1" }];
    const p1 = computeTopologyLayout(nodes, edges, OPTS);
    const p2 = computeTopologyLayout(nodes, edges, OPTS);
    for (const nm of ["s1", "l1", "l2", "h1"]) assert.deepEqual(p1.get(nm), p2.get(nm));
  });
});
