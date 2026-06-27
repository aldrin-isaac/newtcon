// device-resources.test.js — the resource lens derivation (service → interfaces).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deviceServiceUsage, countServiceInstances } from "../dist/device-resources.js";

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
