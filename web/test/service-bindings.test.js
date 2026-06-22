// service-bindings.test.js — deriving a service's interface bindings
// from topology steps (pure logic).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  deriveServiceBindings,
  canonicalizeServiceName,
} from "../dist/service-bindings.js";

// Mirrors the real GET /topology shape: devices → steps with
// /interfaces/{iface}/apply-service operations.
const TOPO = {
  devices: {
    switch1: {
      steps: [
        { url: "/setup-device", params: { fields: {} } },
        { url: "/interfaces/Ethernet0/apply-service", params: { service: "transit", ip_address: "10.1.0.0/31", peer_as: 65002 } },
        { url: "/interfaces/Ethernet16/apply-service", params: { service: "overlay-irb-a" } },
      ],
    },
    switch2: {
      steps: [
        { url: "/interfaces/Ethernet16/apply-service", params: { service: "overlay-irb-a", vlan: 400 } },
      ],
    },
    host1: { steps: [] },
    host2: { ports: {} }, // no steps key
  },
};

describe("canonicalizeServiceName()", () => {
  test("lowercases + underscores→hyphens (spec name → committed form)", () => {
    assert.equal(canonicalizeServiceName("OVERLAY_IRB_A"), "overlay-irb-a");
    assert.equal(canonicalizeServiceName("transit"), "transit");
  });
});

describe("deriveServiceBindings()", () => {
  test("finds every interface a service is applied to, across devices", () => {
    const b = deriveServiceBindings(TOPO, "OVERLAY_IRB_A");
    assert.equal(b.length, 2);
    assert.deepEqual(b.map((x) => `${x.device}:${x.iface}`), ["switch1:Ethernet16", "switch2:Ethernet16"]);
  });

  test("matches spec name to canonicalized step service (case/underscore)", () => {
    // spec name OVERLAY_IRB_A ↔ step service "overlay-irb-a"
    assert.equal(deriveServiceBindings(TOPO, "OVERLAY_IRB_A").length, 2);
    assert.equal(deriveServiceBindings(TOPO, "overlay-irb-a").length, 2);
  });

  test("carries per-binding params (ip / peer_as / vlan) as strings", () => {
    const t = deriveServiceBindings(TOPO, "transit")[0];
    assert.equal(t.device, "switch1");
    assert.equal(t.iface, "Ethernet0");
    assert.equal(t.ipAddress, "10.1.0.0/31");
    assert.equal(t.peerAs, "65002");
    const v = deriveServiceBindings(TOPO, "overlay-irb-a").find((x) => x.device === "switch2");
    assert.equal(v.vlan, "400");
  });

  test("unbound service → empty array", () => {
    assert.deepEqual(deriveServiceBindings(TOPO, "nowhere"), []);
  });

  test("ignores non-apply-service steps and tolerates odd shapes", () => {
    assert.deepEqual(deriveServiceBindings({}, "x"), []);
    assert.deepEqual(deriveServiceBindings(null, "x"), []);
    assert.deepEqual(deriveServiceBindings({ devices: { d: { steps: "nope" } } }, "x"), []);
  });

  test("results sorted by device then interface", () => {
    const topo = { devices: {
      b: { steps: [{ url: "/interfaces/Eth2/apply-service", params: { service: "s" } }] },
      a: { steps: [
        { url: "/interfaces/Eth2/apply-service", params: { service: "s" } },
        { url: "/interfaces/Eth1/apply-service", params: { service: "s" } },
      ] },
    } };
    assert.deepEqual(
      deriveServiceBindings(topo, "s").map((x) => `${x.device}:${x.iface}`),
      ["a:Eth1", "a:Eth2", "b:Eth2"],
    );
  });
});
