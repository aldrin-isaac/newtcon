// test/irb-interfaces.test.js — unit tests for the IRB-interfaces derivation
// (device drawer → Interfaces → "IRB interfaces (VLAN)" section). Fixtures
// mirror the real wire shapes captured from a provisioned 3node-vs-newtcon
// switch1 with EVPNIRB applied on Vlan100.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deriveIrbRows, pendingCreateVlanIds, macvpnVlanHints } from "../dist/irb-interfaces.js";

// Real exported topology steps (intent/save after the irb composite).
const STEPS = [
  { url: "/setup-device", params: null },
  { url: "/interfaces/Ethernet0/apply-service", params: { service: "TRANSIT", ip_address: "10.255.255.0/31" } },
  { url: "/create-vlan", params: { vlan_id: "100" } },
  { url: "/create-vrf", params: { name: "Vrf_IPVPN" } },
  { url: "/interfaces/Ethernet2/add-trunk-vlan", params: { tagged: "true", vlan_id: "100" } },
  { url: "/bind-macvpn", params: { macvpn: "MACVPN", vlan_id: "100", vni: "10100" } },
  { url: "/configure-irb", params: { ip_address: "10.100.0.1/24", vlan_id: "100", vrf: "Vrf_IPVPN" } },
  { url: "/interfaces/Vlan100/apply-service", params: { service: "EVPNIRB", vlan_id: "100" } },
];

// Real live /vlans read.
const LIVE = [
  { id: 100, l2_vni: 10100, svi: "up", member_count: 1, members: ["Ethernet2(t)"], macvpn: "MACVPN" },
];

describe("deriveIrbRows", () => {
  test("live + intent merge: one row, live wins, service from intent", () => {
    const rows = deriveIrbRows({ steps: STEPS, liveVlans: LIVE });
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.name, "Vlan100");
    assert.equal(r.vlanId, 100);
    assert.equal(r.source, "live");
    assert.equal(r.svi, "up");
    assert.equal(r.l2Vni, 10100);
    assert.equal(r.macvpn, "MACVPN");
    assert.equal(r.memberCount, 1);
    assert.deepEqual(r.members, ["Ethernet2(t)"]);
    assert.equal(r.service, "EVPNIRB", "irb binding comes from the intent's apply-service step");
  });

  test("offline device: intent-only rows still render (inventory-first)", () => {
    const rows = deriveIrbRows({ steps: STEPS, liveVlans: undefined });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "intent");
    assert.equal(rows[0].macvpn, "MACVPN", "macvpn linkage from bind-macvpn step");
    assert.equal(rows[0].l2Vni, 10100);
    assert.equal(rows[0].service, "EVPNIRB");
    assert.equal(rows[0].svi, undefined, "no live overlay");
  });

  test("queued create-vlan appears as a pending row", () => {
    const rows = deriveIrbRows({ steps: [], liveVlans: [], pendingVlanIds: [200] });
    assert.deepEqual(rows.map((r) => [r.name, r.source]), [["Vlan200", "pending"]]);
  });

  test("rows sort ascending by VLAN id across sources", () => {
    const rows = deriveIrbRows({
      steps: [{ url: "/create-vlan", params: { vlan_id: "300" } }],
      liveVlans: [{ id: 100 }],
      pendingVlanIds: [200],
    });
    assert.deepEqual(rows.map((r) => r.vlanId), [100, 200, 300]);
    assert.deepEqual(rows.map((r) => r.source), ["live", "pending", "intent"]);
  });

  test("tolerates malformed inputs", () => {
    assert.deepEqual(deriveIrbRows({}), []);
    assert.deepEqual(deriveIrbRows({ steps: "nope", liveVlans: 42, pendingVlanIds: [0, 9999] }), []);
  });
});

describe("pendingCreateVlanIds", () => {
  test("extracts staged create-vlan device actions", () => {
    const q = [
      { id: "1", group: "device", op: "action", actionId: "create-vlan", label: "Create VLAN 200", body: { id: 200 } },
      { id: "2", group: "device", op: "action", actionId: "save-config", label: "Save", body: {} },
      { id: "3", group: "interface", op: "action", device: "s1", iface: "Ethernet0", actionId: "apply-service", label: "Bind", body: {} },
    ];
    assert.deepEqual(pendingCreateVlanIds(q), [200]);
  });
  test("empty/malformed → empty", () => {
    assert.deepEqual(pendingCreateVlanIds([]), []);
    assert.deepEqual(pendingCreateVlanIds([null, "x"]), []);
  });
});

describe("macvpnVlanHints", () => {
  test("pins from macvpn details", () => {
    assert.deepEqual(
      macvpnVlanHints([{ name: "MACVPN", vlan_id: 100, vni: 10100 }, { name: "NOVLAN" }]),
      ["MACVPN pins VLAN 100"],
    );
  });
});
