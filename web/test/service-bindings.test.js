// service-bindings.test.js — deriving a service's interface bindings
// from topology steps (pure logic).
//
// Matches on newtron's server-derived spec_kind/spec_name (#282/#283),
// which is the canonical spec identity == the /services list key. So
// serviceName (the list name) matches spec_name exactly — no
// canonicalization.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deriveServiceBindings } from "../dist/service-bindings.js";

// Mirrors the real GET /topology shape post-#282: each step carries
// spec_kind/spec_name; primitives omit them.
const TOPO = {
  nodes: {
    switch1: {
      steps: [
        { url: "/setup-device", params: { fields: {} } }, // primitive, no spec_kind
        // spec_name is canonical (#283) == the /services list key (UPPERCASE).
        { url: "/interfaces/Ethernet0/apply-service", spec_kind: "service", spec_name: "TRANSIT",
          params: { service: "transit", ip_address: "10.1.0.0/31", peer_as: 65002 } },
        { url: "/interfaces/Ethernet16/apply-service", spec_kind: "service", spec_name: "OVERLAY_IRB_A",
          params: { service: "overlay-irb-a" } },
        // an ipvpn bind step for the same service — not an interface application
        { url: "/bind-ipvpn", spec_kind: "ipvpn", spec_name: "IRB", params: { ipvpn: "IRB" } },
      ],
    },
    switch2: {
      steps: [
        { url: "/interfaces/Ethernet16/apply-service", spec_kind: "service", spec_name: "OVERLAY_IRB_A",
          params: { service: "overlay-irb-a", vlan: 400 } },
      ],
    },
    host1: { steps: [] },
    host2: { ports: {} }, // no steps key
  },
};

describe("deriveServiceBindings()", () => {
  test("finds every interface a service is applied to, across devices", () => {
    const b = deriveServiceBindings(TOPO, "OVERLAY_IRB_A");
    assert.equal(b.length, 2);
    assert.deepEqual(b.map((x) => `${x.device}:${x.iface}`), ["switch1:Ethernet16", "switch2:Ethernet16"]);
  });

  test("matches spec_name exactly (list key == canonical spec_name, #283)", () => {
    // The drawer passes the /services list key, which equals the canonical
    // spec_name exactly — no canonicalization. A non-canonical form misses.
    assert.equal(deriveServiceBindings(TOPO, "OVERLAY_IRB_A").length, 2);
    assert.equal(deriveServiceBindings(TOPO, "overlay-irb-a").length, 0);
  });

  test("carries per-binding params (ip / peer_as / vlan) as strings", () => {
    const t = deriveServiceBindings(TOPO, "TRANSIT")[0];
    assert.equal(t.device, "switch1");
    assert.equal(t.iface, "Ethernet0");
    assert.equal(t.ipAddress, "10.1.0.0/31");
    assert.equal(t.peerAs, "65002");
    const v = deriveServiceBindings(TOPO, "OVERLAY_IRB_A").find((x) => x.device === "switch2");
    assert.equal(v.vlan, "400");
  });

  test("ignores non-service steps and service steps that aren't interface applications", () => {
    // The ipvpn bind step (spec_kind=ipvpn) and primitives are not bindings.
    const b = deriveServiceBindings(TOPO, "IRB"); // ipvpn name, not a service
    assert.deepEqual(b, []);
  });

  test("unbound service → empty array", () => {
    assert.deepEqual(deriveServiceBindings(TOPO, "nowhere"), []);
  });

  test("tolerates odd shapes", () => {
    assert.deepEqual(deriveServiceBindings({}, "x"), []);
    assert.deepEqual(deriveServiceBindings(null, "x"), []);
    assert.deepEqual(deriveServiceBindings({ nodes: { d: { steps: "nope" } } }, "x"), []);
  });

  test("results sorted by device then interface", () => {
    const topo = { nodes: {
      b: { steps: [{ url: "/interfaces/Eth2/apply-service", spec_kind: "service", spec_name: "s" }] },
      a: { steps: [
        { url: "/interfaces/Eth2/apply-service", spec_kind: "service", spec_name: "s" },
        { url: "/interfaces/Eth1/apply-service", spec_kind: "service", spec_name: "s" },
      ] },
    } };
    assert.deepEqual(
      deriveServiceBindings(topo, "s").map((x) => `${x.device}:${x.iface}`),
      ["a:Eth1", "a:Eth2", "b:Eth2"],
    );
  });
});
