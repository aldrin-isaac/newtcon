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
