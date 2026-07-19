// test/device-steps.test.js — the single topology step-parser (uplift 1.5).
// Fixtures mirror real exported topology steps from a provisioned fabric.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseDeviceSteps } from "../dist/device-steps.js";

const REAL_STEPS = [
  { url: "/setup-device", params: null },
  { url: "/create-vlan", params: { vlan_id: "100" } },
  { url: "/bind-macvpn", params: { macvpn: "MACVPN", vlan_id: "100", vni: "10100" }, spec_name: "MACVPN" },
  { url: "/interfaces/Ethernet0/apply-service", params: { service: "TRANSIT", ip_address: "10.255.255.0/31" }, spec_name: "TRANSIT" },
  { url: "/interfaces/Ethernet2/add-trunk-vlan", params: { tagged: "true", vlan_id: "100" } },
  { url: "/interfaces/Vlan100/apply-service", params: { service: "EVPNIRB", vlan_id: "100" } },
];

describe("parseDeviceSteps", () => {
  test("normalizes real wire steps: url/verb/iface/params/specName", () => {
    const p = parseDeviceSteps(REAL_STEPS);
    assert.equal(p.length, 6);
    assert.deepEqual(p[0], { url: "/setup-device", params: {}, verb: "setup-device" });
    assert.equal(p[1].verb, "create-vlan");
    assert.equal(p[1].iface, undefined);
    assert.equal(p[2].specName, "MACVPN");
    assert.deepEqual({ iface: p[3].iface, verb: p[3].verb, specName: p[3].specName },
      { iface: "Ethernet0", verb: "apply-service", specName: "TRANSIT" });
    assert.deepEqual({ iface: p[4].iface, verb: p[4].verb }, { iface: "Ethernet2", verb: "add-trunk-vlan" });
    assert.deepEqual({ iface: p[5].iface, verb: p[5].verb }, { iface: "Vlan100", verb: "apply-service" });
  });
  test("null params → {}; steps without url dropped; tolerant of garbage", () => {
    assert.deepEqual(parseDeviceSteps(undefined), []);
    assert.deepEqual(parseDeviceSteps("nope"), []);
    assert.deepEqual(parseDeviceSteps([null, 42, {}, { url: "" }]), []);
  });
  test("interface URL split keeps multi-segment verbs out of iface", () => {
    const [s] = parseDeviceSteps([{ url: "/interfaces/Ethernet1/configure-interface", params: { ip: "10.10.1.1/24" } }]);
    assert.equal(s.iface, "Ethernet1");
    assert.equal(s.verb, "configure-interface");
  });
});
