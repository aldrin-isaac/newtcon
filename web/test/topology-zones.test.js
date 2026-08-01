// Unit tests for topology-zones.ts — the pure zone-collapse graph transform
// behind the collapsible zone grouping on the canvas.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { collapseZones, zoneNodeId, zoneOfNodeId } from "../dist/topology-zones.js";

// amer: leaf1, leaf2 | emea: leaf3 | spine1 is zoneless.
const NODES = [
  { name: "spine1", type: "switch" },
  { name: "leaf1", type: "switch" },
  { name: "leaf2", type: "switch" },
  { name: "leaf3", type: "switch" },
];
const ZONES = new Map([["leaf1", "amer"], ["leaf2", "amer"], ["leaf3", "emea"]]);
const LINKS = [
  { local_device: "leaf1", local_interface: "Ethernet0", remote_device: "spine1", remote_interface: "Ethernet1" },
  { local_device: "leaf2", local_interface: "Ethernet0", remote_device: "spine1", remote_interface: "Ethernet2" },
  { local_device: "leaf1", local_interface: "Ethernet4", remote_device: "leaf2", remote_interface: "Ethernet4" }, // intra-amer
  { local_device: "leaf3", local_interface: "Ethernet0", remote_device: "spine1", remote_interface: "Ethernet3" },
];

describe("zone node ids", () => {
  test("round-trip", () => {
    assert.equal(zoneNodeId("amer"), "zone:amer");
    assert.equal(zoneOfNodeId("zone:amer"), "amer");
    assert.equal(zoneOfNodeId("spine1"), null);
  });
});

describe("collapseZones()", () => {
  test("nothing collapsed → graph passes through untouched", () => {
    const g = collapseZones(NODES, LINKS, ZONES, new Set());
    assert.equal(g.nodes.length, 4);
    assert.equal(g.links.length, 4);
    assert.equal(g.memberCount.size, 0);
  });

  test("collapsing a zone replaces its members with one node", () => {
    const g = collapseZones(NODES, LINKS, ZONES, new Set(["amer"]));
    const names = g.nodes.map((n) => n.name);
    assert.ok(!names.includes("leaf1") && !names.includes("leaf2"), "members gone");
    assert.ok(names.includes("zone:amer"), "zone node present");
    assert.ok(names.includes("spine1") && names.includes("leaf3"), "others untouched");
    const zn = g.nodes.find((n) => n.name === "zone:amer");
    assert.equal(zn.type, "zone");
    assert.equal(zn.label, "amer");
    assert.equal(zn.sublabel, "2 devices");
    assert.equal(g.memberCount.get("amer"), 2);
  });

  test("parallel crossing links merge into ONE aggregate edge with a count", () => {
    const g = collapseZones(NODES, LINKS, ZONES, new Set(["amer"]));
    const crossing = g.links.filter((l) =>
      (l.local_device === "zone:amer" && l.remote_device === "spine1")
      || (l.local_device === "spine1" && l.remote_device === "zone:amer"));
    assert.equal(crossing.length, 1, "leaf1->spine1 and leaf2->spine1 merged");
    assert.equal(crossing[0].aggregate, 2, "carries the underlying link count");
  });

  test("the folded end loses its interface; the outside end keeps it", () => {
    const g = collapseZones(NODES, LINKS, ZONES, new Set(["amer"]));
    const edge = g.links.find((l) => l.local_device === "zone:amer" || l.remote_device === "zone:amer");
    // leaf1's Ethernet0 is meaningless on an aggregate; spine1's port survives.
    assert.equal(edge.local_interface, undefined);
    assert.equal(edge.remote_interface, "Ethernet1");
  });

  test("intra-zone links vanish and are counted", () => {
    const g = collapseZones(NODES, LINKS, ZONES, new Set(["amer"]));
    const internal = g.links.filter((l) =>
      l.local_device === "leaf1" || l.remote_device === "leaf2");
    assert.equal(internal.length, 0, "leaf1<->leaf2 is inside the fold");
    assert.equal(g.internalCount.get("amer"), 1);
  });

  test("collapsing two zones merges the link between them", () => {
    const links = [
      ...LINKS,
      { local_device: "leaf1", local_interface: "Ethernet9", remote_device: "leaf3", remote_interface: "Ethernet9" },
      { local_device: "leaf2", local_interface: "Ethernet9", remote_device: "leaf3", remote_interface: "Ethernet8" },
    ];
    const g = collapseZones(NODES, links, ZONES, new Set(["amer", "emea"]));
    const between = g.links.filter((l) =>
      [l.local_device, l.remote_device].sort().join() === ["zone:amer", "zone:emea"].sort().join());
    assert.equal(between.length, 1);
    assert.equal(between[0].aggregate, 2);
  });

  test("a collapsed zone with no devices on this canvas contributes no node", () => {
    const g = collapseZones(NODES, LINKS, ZONES, new Set(["apac"]));
    assert.ok(!g.nodes.some((n) => n.name === "zone:apac"));
    assert.equal(g.nodes.length, 4);
  });

  test("single-member zone pluralises correctly", () => {
    const g = collapseZones(NODES, LINKS, ZONES, new Set(["emea"]));
    assert.equal(g.nodes.find((n) => n.name === "zone:emea").sublabel, "1 device");
  });
});
