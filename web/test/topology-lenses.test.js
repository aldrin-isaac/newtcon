// topology-lenses.test.js — lens derivations (uplift 4.3): VLAN membership
// from intent steps, available-VLAN discovery, halo/dim/badge resolution.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { vlanMembership, availableVlans, lensEffect } from "../dist/topology-lenses.js";

const DEVICES = {
  switch1: { steps: [
    { url: "/create-vlan", params: { vlan_id: 100 } },
    { url: "/interfaces/Ethernet1/apply-service", params: { service: "EVPNIRB", vlan: 100 }, spec_name: "EVPNIRB" },
    { url: "/interfaces/Ethernet0/apply-service", params: { service: "TRANSIT" }, spec_name: "TRANSIT" },
  ] },
  switch2: { steps: [
    { url: "/create-vlan", params: { vlan_id: 100 } },
  ] },
  switch3: { steps: [
    { url: "/interfaces/Ethernet2/apply-service", params: { vlan: 200 } },
  ] },
  host1: { steps: [] },
};
const ALL = Object.keys(DEVICES);

describe("vlanMembership()", () => {
  test("create-vlan and per-port vlan params both join", () => {
    const m = vlanMembership(DEVICES, 100);
    assert.deepEqual([...m.keys()].sort(), ["switch1", "switch2"]);
    assert.deepEqual(m.get("switch1"), ["Ethernet1"]);
    assert.deepEqual(m.get("switch2"), [], "participates without member ports");
  });

  test("uninvolved VLAN → empty", () => {
    assert.equal(vlanMembership(DEVICES, 999).size, 0);
  });
});

describe("availableVlans()", () => {
  test("collects and sorts every vlan named in steps", () => {
    assert.deepEqual(availableVlans(DEVICES), [100, 200]);
  });
  test("empty topology → empty", () => {
    assert.deepEqual(availableVlans({}), []);
  });
});

describe("lensEffect()", () => {
  test("null lens leaves the canvas untouched", () => {
    const e = lensEffect({ kind: null }, { allDevices: ALL });
    assert.equal(e.halo.size, 0);
    assert.equal(e.dim.size, 0);
  });

  test("vni lens: members halo with port badges, the rest dim", () => {
    const e = lensEffect({ kind: "vni", vlanId: 100 }, { allDevices: ALL, vlanMembers: vlanMembership(DEVICES, 100) });
    assert.deepEqual([...e.halo].sort(), ["switch1", "switch2"]);
    assert.deepEqual([...e.dim].sort(), ["host1", "switch3"]);
    assert.equal(e.badge.get("switch1"), "Ethernet1");
    assert.equal(e.badge.has("switch2"), false, "no ports, no badge");
  });

  test("vni lens without a chosen vlan is inert", () => {
    const e = lensEffect({ kind: "vni" }, { allDevices: ALL, vlanMembers: new Map() });
    assert.equal(e.halo.size + e.dim.size, 0);
  });

  test("underlay lens: down halos, unknown dims, ok stays calm", () => {
    const under = new Map([["switch1", "down"], ["switch2", "ok"]]);
    const e = lensEffect({ kind: "underlay" }, { allDevices: ALL, underlayByDevice: under });
    assert.deepEqual([...e.halo], ["switch1"]);
    assert.deepEqual([...e.dim].sort(), ["host1", "switch3"]);
  });

  test("drift lens: drifted halo with count badge, clean dims", () => {
    const drift = new Map([["switch2", 3]]);
    const e = lensEffect({ kind: "drift" }, { allDevices: ALL, driftByDevice: drift });
    assert.deepEqual([...e.halo], ["switch2"]);
    assert.equal(e.badge.get("switch2"), "3 drift items");
    assert.equal(e.dim.size, 3);
  });

  test("halo and dim never overlap", () => {
    for (const lens of [
      { kind: "vni", vlanId: 100 },
      { kind: "underlay" },
      { kind: "drift" },
    ]) {
      const e = lensEffect(lens, {
        allDevices: ALL,
        vlanMembers: vlanMembership(DEVICES, 100),
        underlayByDevice: new Map([["switch1", "down"]]),
        driftByDevice: new Map([["switch2", 1]]),
      });
      for (const d of e.halo) assert.equal(e.dim.has(d), false, `${lens.kind}: ${d} in both sets`);
    }
  });
});
