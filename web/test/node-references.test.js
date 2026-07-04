// test/node-references.test.js — unit tests for deriveNodeLinks (delete-flow
// force-cascade detection).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deriveNodeLinks } from "../dist/node-references.js";

const TOPO = {
  nodes: { switch1: {}, switch2: {}, host1: {} },
  links: [
    { a: "switch1:Ethernet0", z: "switch2:Ethernet0" },
    { a: "host1:eth0", z: "switch1:Ethernet4" },
    { a: "switch2:Ethernet8", z: "host1:eth1" },
  ],
};

describe("deriveNodeLinks", () => {
  test("returns every link touching the node, with the peer device", () => {
    const links = deriveNodeLinks(TOPO, "switch1");
    assert.equal(links.length, 2);
    assert.deepEqual(new Set(links.map((l) => l.peer)), new Set(["switch2", "host1"]));
  });

  test("matches on either endpoint (a or z)", () => {
    // host1 appears as `a` in one link and `z` in another.
    const links = deriveNodeLinks(TOPO, "host1");
    assert.equal(links.length, 2);
    assert.deepEqual(new Set(links.map((l) => l.peer)), new Set(["switch1", "switch2"]));
  });

  test("an unlinked node returns no links (bare delete, no force needed)", () => {
    assert.deepEqual(deriveNodeLinks({ ...TOPO, nodes: { ...TOPO.nodes, lonely: {} } }, "lonely"), []);
  });

  test("does NOT match a device whose name is a prefix of the target", () => {
    const topo = { links: [{ a: "switch10:Ethernet0", z: "switch2:Ethernet0" }] };
    assert.deepEqual(deriveNodeLinks(topo, "switch1"), []);
  });

  test("tolerates missing / malformed topology", () => {
    assert.deepEqual(deriveNodeLinks(null, "x"), []);
    assert.deepEqual(deriveNodeLinks({}, "x"), []);
    assert.deepEqual(deriveNodeLinks({ links: "nope" }, "x"), []);
  });
});


const FAB = {
  nodes: {
    switch1: { ports: { Ethernet0: {}, Ethernet4: {}, Ethernet31: {} } },
    switch2: { ports: { Ethernet0: {}, Ethernet4: {} } },
    host1: {}, // no ports
  },
  links: [
    { a: "switch1:Ethernet0", z: "switch2:Ethernet0" },
    { a: "switch1:Ethernet4", z: "switch2:Ethernet4" },
  ],
};

import { hostLikeDevices } from "../dist/node-references.js";

describe("hostLikeDevices", () => {
  test("a device with a setup-device step is a switch (not host-like)", () => {
    const topo = { nodes: {
      switch1: { steps: [{ url: "/setup-device", params: {} }], ports: { Ethernet0: {} } },
      host1: {},                                   // empty entry — host
      host2: { steps: [] },                        // no setup-device step — host
      server1: { ports: { eth0: {} } },            // ports but no setup-device — host-like
    } };
    const hosts = hostLikeDevices(topo);
    assert.ok(!hosts.has("switch1"), "switch1 has setup-device → not host-like");
    assert.ok(hosts.has("host1"), "empty entry → host-like");
    assert.ok(hosts.has("host2"), "no setup-device step → host-like");
    assert.ok(hosts.has("server1"), "no setup-device step → host-like");
  });

  test("tolerates malformed topology", () => {
    assert.equal(hostLikeDevices(null).size, 0);
    assert.equal(hostLikeDevices({}).size, 0);
  });
});
