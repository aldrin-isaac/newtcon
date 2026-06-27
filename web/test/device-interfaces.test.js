// device-interfaces.test.js — the pure join behind the unified device
// interface table.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSpeed,
  deriveDeviceBindings,
  linksForDevice,
  buildDeviceInterfaceView,
  countView,
  applyFilter,
} from "../dist/device-interfaces.js";

const inv = [
  { name: "Ethernet0", nic_index: 1, speed: "40G" },
  { name: "Ethernet4", nic_index: 2 },
  { name: "Ethernet8", nic_index: 3 },
];

describe("normalizeSpeed()", () => {
  test("Mbps string → G", () => {
    assert.equal(normalizeSpeed("40000"), "40G");
    assert.equal(normalizeSpeed("100000"), "100G");
  });
  test("non-round Mbps → M; passthrough suffixed; empty", () => {
    assert.equal(normalizeSpeed("2500"), "2500M");
    assert.equal(normalizeSpeed("40G"), "40G");
    assert.equal(normalizeSpeed(""), "");
    assert.equal(normalizeSpeed(undefined), "");
  });
});

describe("deriveDeviceBindings()", () => {
  test("apply-service step → service + params", () => {
    const m = deriveDeviceBindings({ steps: [
      { url: "/interfaces/Ethernet0/apply-service", spec_kind: "service", spec_name: "EVPNIRB", params: { ip_address: "10.1.0.1/24", peer_as: "65010" } },
    ] });
    assert.deepEqual(m.get("Ethernet0"), { service: "EVPNIRB", ip: "10.1.0.1/24", peerAs: "65010" });
  });
  test("configure-interface modes", () => {
    const m = deriveDeviceBindings({ steps: [
      { url: "/interfaces/Ethernet0/configure-interface", params: { tagged: false, vlan_id: "100" } },
      { url: "/interfaces/Ethernet4/configure-interface", params: { tagged: true, vlan_id: "200" } },
      { url: "/interfaces/Ethernet8/configure-interface", params: { vrf: "Vrf_X", ip: "10.0.0.1/30" } },
    ] });
    assert.equal(m.get("Ethernet0").mode, "access");
    assert.equal(m.get("Ethernet0").vlan, "100");
    assert.equal(m.get("Ethernet4").mode, "trunk");
    assert.deepEqual(m.get("Ethernet8"), { mode: "routed", vrf: "Vrf_X", ip: "10.0.0.1/30" });
  });
  test("ignores non-interface steps (setup-device)", () => {
    const m = deriveDeviceBindings({ steps: [{ url: "/setup-device", params: { fields: { hwsku: "X" } } }] });
    assert.equal(m.size, 0);
  });
});

describe("linksForDevice()", () => {
  test("maps a device's interfaces to neighbors (either side)", () => {
    const m = linksForDevice([{ a: "switch1:Ethernet0", z: "spine1:Ethernet0" }, { a: "spine2:Ethernet4", z: "switch1:Ethernet4" }], "switch1");
    assert.equal(m.get("Ethernet0"), "spine1:Ethernet0");
    assert.equal(m.get("Ethernet4"), "spine2:Ethernet4");
  });
  test("null links → empty", () => {
    assert.equal(linksForDevice(null, "switch1").size, 0);
  });
});

describe("buildDeviceInterfaceView()", () => {
  const base = () => buildDeviceInterfaceView({
    inventory: inv,
    topoPorts: { Ethernet0: { admin_status: "up", mtu: 9100 }, Ethernet4: { admin_status: "up", mtu: 9100 } },
    live: [
      { name: "Ethernet0", admin_status: "up", oper_status: "", speed: "40000", mtu: 9100 },
      { name: "Ethernet4", admin_status: "up", oper_status: "", speed: "40000", mtu: 9100 },
      { name: "Ethernet8", admin_status: "up", oper_status: "" },
    ],
    bindings: new Map([["Ethernet0", { service: "EVPNIRB", ip: "10.1.0.1/24" }]]),
    links: new Map([["Ethernet4", "spine1:Ethernet0"]]),
  });

  test("one row per inventory port, numerically sorted", () => {
    const rows = base();
    assert.deepEqual(rows.map((r) => r.name), ["Ethernet0", "Ethernet4", "Ethernet8"]);
  });
  test("roles: service→routed, link→linked, config-only→configured, nothing→available", () => {
    const rows = base();
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(by.Ethernet0.role, "routed");      // bound service
    assert.equal(by.Ethernet0.service, "EVPNIRB");
    assert.equal(by.Ethernet0.l2l3, "10.1.0.1/24");
    assert.equal(by.Ethernet4.role, "linked");      // link, no service
    assert.equal(by.Ethernet4.link, "spine1:Ethernet0");
    assert.equal(by.Ethernet8.role, "available");   // no topo config, no service/link
    assert.equal(by.Ethernet8.available, true);
  });
  test("speed normalized; canApplyService inverse of bound service", () => {
    const rows = base();
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(by.Ethernet0.speed, "40G");
    assert.equal(by.Ethernet0.canApplyService, false);
    assert.equal(by.Ethernet4.canApplyService, true);
  });
  test("offline (no live) still builds rows from inventory + topo", () => {
    const rows = buildDeviceInterfaceView({ inventory: inv, topoPorts: { Ethernet0: { mtu: 9100 } }, live: undefined, bindings: new Map(), links: new Map() });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, "Ethernet0");
    assert.equal(rows[0].role, "configured");
  });
});

describe("countView() + applyFilter()", () => {
  const rows = buildDeviceInterfaceView({
    inventory: inv,
    topoPorts: { Ethernet0: { admin_status: "up", mtu: 9100 } },
    live: [{ name: "Ethernet0", admin_status: "up" }, { name: "Ethernet4", admin_status: "down" }],
    bindings: new Map([["Ethernet0", { service: "S" }]]),
    links: new Map(),
  });
  test("counts", () => {
    const c = countView(rows);
    assert.equal(c.total, 3);
    assert.equal(c.configured, 1);   // Ethernet0 (service) ; Ethernet4/8 available
    assert.equal(c.available, 2);
    assert.equal(c.up, 1);           // Ethernet0 admin up
  });
  test("filter: available / configured / up / query", () => {
    assert.deepEqual(applyFilter(rows, "available", "").map((r) => r.name), ["Ethernet4", "Ethernet8"]);
    assert.deepEqual(applyFilter(rows, "configured", "").map((r) => r.name), ["Ethernet0"]);
    assert.deepEqual(applyFilter(rows, "up", "").map((r) => r.name), ["Ethernet0"]);
    assert.deepEqual(applyFilter(rows, "all", "ethernet8").map((r) => r.name), ["Ethernet8"]);
  });
});
