// Unit tests for service-params.ts — the pure "which params must the operator
// supply" derivation backing the Bind-service form's dynamic required fields.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { requestedParams } from "../dist/service-params.js";

describe("requestedParams()", () => {
  test("RTD: routing.peer_as == 'request' → ['peer_as']", () => {
    const rtd = {
      name: "RTD",
      service_type: "routed",
      routing: { protocol: "bgp", peer_as: "request" },
    };
    assert.deepEqual(requestedParams(rtd), ["peer_as"]);
  });

  test("bridged/evpn services with fixed refs request nothing", () => {
    assert.deepEqual(requestedParams({ name: "BRD", service_type: "bridged", macvpn: "SVC_VLAN200" }), []);
    assert.deepEqual(requestedParams({ name: "EIRB", service_type: "evpn-irb", ipvpn: "IRB", macvpn: "SVC_VLAN400" }), []);
  });

  test("a fixed (non-'request') peer_as is not required of the operator", () => {
    assert.deepEqual(requestedParams({ routing: { protocol: "bgp", peer_as: 65001 } }), []);
    assert.deepEqual(requestedParams({ routing: { protocol: "bgp", peer_as: "65001" } }), []);
  });

  test("top-level 'request' params are also collected, de-duplicated", () => {
    // A hypothetical spec marking a param at the top level and in routing.
    const spec = { vlan: "request", routing: { peer_as: "request" } };
    assert.deepEqual(requestedParams(spec).sort(), ["peer_as", "vlan"]);
  });

  test("garbled / empty specs yield []", () => {
    assert.deepEqual(requestedParams(null), []);
    assert.deepEqual(requestedParams(undefined), []);
    assert.deepEqual(requestedParams("RTD"), []);
    assert.deepEqual(requestedParams(42), []);
    assert.deepEqual(requestedParams({}), []);
    assert.deepEqual(requestedParams({ routing: null }), []);
  });
});
