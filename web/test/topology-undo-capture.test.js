// test/topology-undo-capture.test.js — unit tests for the topology
// pre-body capture helpers (slice #175.C.1 polish).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  captureTopologyBodies,
  extractRemoveDeviceBody,
  extractRemoveLinkEndpoints,
} from "../dist/topology-undo-capture.js";

const TOPO = {
  nodes: {
    "r1": { ports: { eth0: {} }, steps: [{ type: "switch" }] },
    "r2": { ports: { eth0: {}, eth1: {} } },
    "host-a": {},
  },
  links: [
    { a: "r1:eth0", z: "r2:eth0" },
    { a: "r2:eth1", z: "host-a:eth0" },
  ],
};

describe("extractRemoveDeviceBody()", () => {
  test("returns the device record when name matches", () => {
    const body = extractRemoveDeviceBody(TOPO, "r1");
    assert.deepEqual(body, { ports: { eth0: {} }, steps: [{ type: "switch" }] });
  });

  test("returns null when name is absent", () => {
    assert.equal(extractRemoveDeviceBody(TOPO, "nope"), null);
  });

  test("returns null on missing nodes key", () => {
    assert.equal(extractRemoveDeviceBody({ nodes: undefined }, "r1"), null);
    assert.equal(extractRemoveDeviceBody({}, "r1"), null);
  });

  test("empty device body still returns it (empty != absent)", () => {
    const body = extractRemoveDeviceBody(TOPO, "host-a");
    assert.deepEqual(body, {});
  });
});

describe("extractRemoveLinkEndpoints()", () => {
  test("matches on A endpoint", () => {
    const r = extractRemoveLinkEndpoints(TOPO, "r1", "eth0");
    assert.deepEqual(r, { a: "r1:eth0", z: "r2:eth0" });
  });

  test("matches on Z endpoint", () => {
    const r = extractRemoveLinkEndpoints(TOPO, "r2", "eth0");
    assert.deepEqual(r, { a: "r1:eth0", z: "r2:eth0" });
  });

  test("returns null when no link matches", () => {
    assert.equal(extractRemoveLinkEndpoints(TOPO, "r1", "eth9"), null);
  });

  test("returns null when links is missing", () => {
    assert.equal(extractRemoveLinkEndpoints({}, "r1", "eth0"), null);
  });

  test("returns null when links is not an array", () => {
    assert.equal(extractRemoveLinkEndpoints({ links: "nope" }, "r1", "eth0"), null);
  });

  test("skips malformed link entries", () => {
    const broken = {
      links: [{ a: "r1:eth0" }, null, "string", { a: "r2:eth1", z: "host-a:eth0" }],
    };
    const r = extractRemoveLinkEndpoints(broken, "r2", "eth1");
    assert.deepEqual(r, { a: "r2:eth1", z: "host-a:eth0" });
  });
});

describe("captureTopologyBodies()", () => {
  test("captures bodies for remove-device + remove-link items in the queue", () => {
    const queue = [
      { id: "1", group: "topology", op: "remove-device", name: "r1" },
      { id: "2", group: "topology", op: "remove-link", device: "r2", iface: "eth1" },
    ];
    const map = captureTopologyBodies(TOPO, queue);
    assert.equal(map.size, 2);
    assert.deepEqual(map.get("1"), TOPO.nodes["r1"]);
    assert.deepEqual(map.get("2"), { a: "r2:eth1", z: "host-a:eth0" });
  });

  test("skips queue items that aren't topology removals", () => {
    const queue = [
      { id: "1", group: "spec", kind: "services", op: "delete", name: "x" },
      { id: "2", group: "topology", op: "add-device", name: "r3", body: {} },
      { id: "3", group: "topology", op: "remove-device", name: "r1" },
    ];
    const map = captureTopologyBodies(TOPO, queue);
    assert.equal(map.size, 1);
    assert.ok(map.has("3"));
    assert.ok(!map.has("1"));
    assert.ok(!map.has("2"));
  });

  test("skips removals that don't match anything in the topology", () => {
    const queue = [
      { id: "1", group: "topology", op: "remove-device", name: "ghost" },
      { id: "2", group: "topology", op: "remove-link", device: "r1", iface: "eth9" },
    ];
    const map = captureTopologyBodies(TOPO, queue);
    assert.equal(map.size, 0);
  });

  test("empty queue → empty map", () => {
    assert.equal(captureTopologyBodies(TOPO, []).size, 0);
  });
});
