// device-resources.test.js — the resource lens derivation (service → interfaces).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deviceServiceUsage, countServiceInstances, shapeResourceRows, VRF_COLUMNS, VLAN_COLUMNS, ACL_COLUMNS, LAG_COLUMNS, HEALTH_COLUMNS, BGP_NEIGHBOR_COLUMNS, isHealthCheckList } from "../dist/device-resources.js";

describe("shapeResourceRows() — LAG / health / bgp-neighbor columns", () => {
  test("LAG members derived as active/total; status columns present", () => {
    const t = shapeResourceRows([{ name: "PortChannel1", admin_status: "up", oper_status: "down", members: ["Ethernet0", "Ethernet4"], active_members: ["Ethernet0"], mtu: 9100 }], LAG_COLUMNS);
    assert.deepEqual(t.headers, ["LAG", "Admin", "Oper", "Members", "MTU"]);
    assert.deepEqual(t.rows, [["PortChannel1", "up", "down", "1/2", "9100"]]);
  });
  test("health-check rows: status/check/message", () => {
    const t = shapeResourceRows([{ check: "bgp", status: "warn", message: "No BGP neighbors configured" }], HEALTH_COLUMNS);
    assert.deepEqual(t.rows, [["warn", "bgp", "No BGP neighbors configured"]]);
  });
  test("bgp neighbor address falls back to neighbor_ip", () => {
    const t = shapeResourceRows([{ neighbor_ip: "10.0.0.2", remote_as: 65010, admin_status: "up" }], BGP_NEIGHBOR_COLUMNS);
    assert.equal(t.rows[0][0], "10.0.0.2");
    assert.equal(t.rows[0][4], "up");
  });
});

describe("isHealthCheckList()", () => {
  test("true for check+status items, false otherwise", () => {
    assert.equal(isHealthCheckList([{ check: "bgp", status: "ok" }]), true);
    assert.equal(isHealthCheckList([{ address: "10.0.0.1" }]), false);
    assert.equal(isHealthCheckList([]), false);
    assert.equal(isHealthCheckList(null), false);
  });
});

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
