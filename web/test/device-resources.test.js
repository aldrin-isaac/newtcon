// device-resources.test.js — the resource lens derivation (service → interfaces).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deviceServiceUsage, countServiceInstances, shapeResourceRows, VRF_COLUMNS, VLAN_COLUMNS, ACL_COLUMNS } from "../dist/device-resources.js";

describe("shapeResourceRows() — curated State tables", () => {
  test("VRF rows: name/state/interfaces; 0 stays '0'", () => {
    const t = shapeResourceRows([{ name: "Vrf_TEST", interfaces: 0, state: "ok" }], VRF_COLUMNS);
    assert.deepEqual(t.headers, ["VRF", "State", "Interfaces"]);
    assert.deepEqual(t.rows, [["Vrf_TEST", "ok", "0"]]);
  });
  test("VLAN rows: id/name/member_count", () => {
    const t = shapeResourceRows([{ id: 100, name: "test", member_count: 2 }], VLAN_COLUMNS);
    assert.deepEqual(t.rows, [["100", "test", "2"]]);
  });
  test("ACL rows: empty cells → —, real columns kept", () => {
    const t = shapeResourceRows([{ name: "A", type: "L3", stage: "ingress", interfaces: "", rule_count: 0 }], ACL_COLUMNS);
    assert.deepEqual(t.headers, ["ACL", "Type", "Stage", "Rules", "Interfaces"]);
    assert.deepEqual(t.rows, [["A", "L3", "ingress", "0", "—"]]);
  });
  test("null / non-array → empty rows, headers preserved", () => {
    const t = shapeResourceRows(null, VRF_COLUMNS);
    assert.deepEqual(t.headers, ["VRF", "State", "Interfaces"]);
    assert.deepEqual(t.rows, []);
  });
});

describe("deviceServiceUsage()", () => {
  test("groups apply-service steps by service, with per-interface params", () => {
    const usage = deviceServiceUsage({ steps: [
      { url: "/setup-device", params: { fields: { hwsku: "X" } } },
      { url: "/interfaces/Ethernet4/apply-service", spec_name: "EVPNIRB", params: { vlan: "100", ip_address: "10.1.0.1/24" } },
      { url: "/interfaces/Ethernet0/apply-service", spec_name: "EVPNIRB", params: { vlan: "100" } },
      { url: "/interfaces/Ethernet8/apply-service", spec_name: "TRANSIT", params: { peer_as: "65010" } },
    ] });
    assert.equal(usage.length, 2);
    const evpn = usage.find((u) => u.service === "EVPNIRB");
    // instances sorted numerically by interface
    assert.deepEqual(evpn.instances.map((i) => i.iface), ["Ethernet0", "Ethernet4"]);
    assert.deepEqual(evpn.instances[1], { iface: "Ethernet4", vlan: "100", ip: "10.1.0.1/24" });
    const transit = usage.find((u) => u.service === "TRANSIT");
    assert.deepEqual(transit.instances, [{ iface: "Ethernet8", peerAs: "65010" }]);
  });

  test("falls back to params.service when spec_name is absent", () => {
    const usage = deviceServiceUsage({ steps: [
      { url: "/interfaces/Ethernet0/apply-service", params: { service: "S1" } },
    ] });
    assert.deepEqual(usage, [{ service: "S1", instances: [{ iface: "Ethernet0" }] }]);
  });

  test("services sorted by name; ignores non-apply-service steps", () => {
    const usage = deviceServiceUsage({ steps: [
      { url: "/interfaces/Ethernet0/apply-service", spec_name: "Zeta" },
      { url: "/interfaces/Ethernet4/configure-interface", params: { tagged: false, vlan_id: "10" } },
      { url: "/interfaces/Ethernet8/apply-service", spec_name: "Alpha" },
    ] });
    assert.deepEqual(usage.map((u) => u.service), ["Alpha", "Zeta"]);
  });

  test("empty / no-steps → empty", () => {
    assert.deepEqual(deviceServiceUsage({}), []);
    assert.deepEqual(deviceServiceUsage(null), []);
    assert.deepEqual(deviceServiceUsage({ steps: [{ url: "/setup-device" }] }), []);
  });

  test("countServiceInstances totals bindings", () => {
    const usage = deviceServiceUsage({ steps: [
      { url: "/interfaces/Ethernet0/apply-service", spec_name: "A" },
      { url: "/interfaces/Ethernet4/apply-service", spec_name: "A" },
      { url: "/interfaces/Ethernet8/apply-service", spec_name: "B" },
    ] });
    assert.equal(countServiceInstances(usage), 3);
  });
});
