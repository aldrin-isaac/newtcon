// verb-parser.test.js — Cmd-K verb grammar (uplift 5.1).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseVerb } from "../dist/verb-parser.js";

const CTX = {
  services: ["EVPNIRB", "TRANSIT"],
  devices: ["switch1", "switch2", "host1"],
  interfacesByDevice: new Map([
    ["switch1", ["Ethernet0", "Ethernet2"]],
    ["switch2", ["Ethernet0"]],
  ]),
  networks: ["3node-vs-newtcon", "smoke-fixture"],
};

describe("apply verb", () => {
  test("full sentence completes", () => {
    const s = parseVerb("apply EVPNIRB on switch1:Ethernet2", CTX);
    assert.equal(s.length, 1);
    assert.deepEqual(s[0], {
      kind: "apply", complete: true, label: "apply EVPNIRB on switch1:Ethernet2",
      service: "EVPNIRB", device: "switch1", iface: "Ethernet2",
    });
  });

  test("prefixes suggest along the way", () => {
    assert.ok(parseVerb("app", CTX).length >= 2, "bare verb prefix lists services");
    const svc = parseVerb("apply EV", CTX);
    assert.equal(svc[0].service, "EVPNIRB");
    assert.equal(svc[0].complete, false);
    const dev = parseVerb("apply TRANSIT on sw", CTX);
    assert.deepEqual(dev.map((x) => x.device).sort(), ["switch1", "switch2"]);
    const ifc = parseVerb("apply TRANSIT on switch1:Eth", CTX);
    assert.ok(ifc.every((x) => x.complete && x.device === "switch1"));
    assert.deepEqual(ifc.map((x) => x.iface), ["Ethernet0", "Ethernet2"]);
  });

  test("unknown interface still completes (engine validates at apply)", () => {
    const s = parseVerb("apply TRANSIT on switch1:Vlan100", CTX);
    assert.equal(s.length, 1);
    assert.equal(s[0].complete, true);
    assert.equal(s[0].iface, "Vlan100");
  });

  test("unknown service yields nothing", () => {
    assert.deepEqual(parseVerb("apply NOPE on switch1:Ethernet0", CTX), []);
  });
});

describe("create vlan verb", () => {
  test("full sentence completes", () => {
    const s = parseVerb("create vlan 100 on switch1", CTX);
    assert.equal(s.length, 1);
    assert.deepEqual(s[0], { kind: "create-vlan", complete: true, label: "create vlan 100 on switch1", vlanId: 100, device: "switch1" });
  });
  test("id bounds enforced", () => {
    assert.deepEqual(parseVerb("create vlan 5000 on switch1", CTX), []);
    assert.deepEqual(parseVerb("create vlan 0 on switch1", CTX), []);
  });
  test("device prefix fans out", () => {
    const s = parseVerb("create vlan 200 on s", CTX);
    assert.deepEqual(s.map((x) => x.device).sort(), ["switch1", "switch2"]);
  });
});

describe("deploy verb", () => {
  test("is a navigation verb (lifecycle, not intent)", () => {
    const s = parseVerb("deploy 3node", CTX);
    assert.equal(s.length, 1);
    assert.equal(s[0].network, "3node-vs-newtcon");
    assert.ok(s[0].label.includes("open Topology"), "labels itself as navigation");
  });
});

describe("click-through pickers (6.3)", () => {
  test("bare verb seeds carry advance text", () => {
    const s = parseVerb("app", CTX);
    assert.ok(s.every((x) => x.advance?.startsWith("apply ")));
  });
  test("'apply SVC on' fans out devices with advance", () => {
    const s = parseVerb("apply TRANSIT on", CTX);
    assert.deepEqual(s.map((x) => x.device).sort(), ["host1", "switch1", "switch2"]);
    assert.ok(s.every((x) => !x.complete && x.advance === `apply TRANSIT on ${x.device}:`));
  });
  test("'apply SVC on DEV:' fans out ports as COMPLETE items", () => {
    const s = parseVerb("apply TRANSIT on switch1:", CTX);
    assert.deepEqual(s.map((x) => x.iface), ["Ethernet0", "Ethernet2"]);
    assert.ok(s.every((x) => x.complete));
  });
  test("no known ports → typed-port hint with advance", () => {
    const s = parseVerb("apply TRANSIT on host1:", CTX);
    assert.equal(s.length, 1);
    assert.equal(s[0].complete, false);
    assert.equal(s[0].advance, "apply TRANSIT on host1:");
  });
  test("'create vlan 200 on' fans out devices complete", () => {
    const s = parseVerb("create vlan 200 on", CTX);
    assert.deepEqual(s.map((x) => x.device).sort(), ["host1", "switch1", "switch2"]);
    assert.ok(s.every((x) => x.complete));
  });
});

describe("non-verbs", () => {
  test("ordinary palette text yields nothing", () => {
    assert.deepEqual(parseVerb("switch1", CTX), []);
    assert.deepEqual(parseVerb("qos", CTX), []);
    assert.deepEqual(parseVerb("", CTX), []);
  });
});
