// route.test.js — hash-route codec (uplift 2.4): parse/format round-trips,
// per-view params, encoding, and the network-retarget helper.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseHash, formatHash, retargetHashToNetwork } from "../dist/route.js";

describe("parseHash()", () => {
  test("net + view", () => {
    assert.deepEqual(parseHash("#/prod/topology"), { net: "prod", view: "topology" });
  });

  test("specs facet and detail", () => {
    assert.deepEqual(parseHash("#/prod/specs/ipvpns"), { net: "prod", view: "specs", facet: "ipvpns" });
    assert.deepEqual(parseHash("#/prod/specs/ipvpns/blue"), { net: "prod", view: "specs", facet: "ipvpns", detail: "blue" });
  });

  test("general surfaces ride the facet/detail slots", () => {
    assert.deepEqual(parseHash("#/prod/specs/general/ssh"), { net: "prod", view: "specs", facet: "general", detail: "ssh" });
  });

  test("topology device drawer", () => {
    assert.deepEqual(parseHash("#/lab1/topology/device/switch1"), { net: "lab1", view: "topology", device: "switch1" });
  });

  test("resident views take no params", () => {
    assert.deepEqual(parseHash("#/prod/history"), { net: "prod", view: "history" });
    assert.deepEqual(parseHash("#/prod/audit/extra"), { net: "prod", view: "audit" });
  });

  test("percent-encoded segments decode", () => {
    assert.deepEqual(parseHash("#/net%2Fone/specs/ipvpns/name%20with%20spaces"),
      { net: "net/one", view: "specs", facet: "ipvpns", detail: "name with spaces" });
  });

  test("junk returns null", () => {
    assert.equal(parseHash(""), null);
    assert.equal(parseHash("#"), null);
    assert.equal(parseHash("#/"), null);
    assert.equal(parseHash("#/prod"), null, "missing view");
    assert.equal(parseHash("#/prod/nonsense"), null, "unknown view");
    assert.equal(parseHash("#gibberish"), null);
  });

  test("topology device requires the device keyword", () => {
    assert.deepEqual(parseHash("#/prod/topology/switch1"), { net: "prod", view: "topology" },
      "a bare third segment is ignored, not treated as a device");
  });
});

describe("formatHash()", () => {
  test("round-trips every shape", () => {
    for (const route of [
      { net: "prod", view: "specs" },
      { net: "prod", view: "specs", facet: "macvpns" },
      { net: "prod", view: "specs", facet: "macvpns", detail: "m100" },
      { net: "prod", view: "specs", facet: "general", detail: "permissions" },
      { net: "lab1", view: "topology" },
      { net: "lab1", view: "topology", device: "switch2" },
      { net: "prod", view: "history" },
      { net: "prod", view: "audit" },
    ]) {
      assert.deepEqual(parseHash(formatHash(route)), route, JSON.stringify(route));
    }
  });

  test("encodes awkward segment characters", () => {
    const route = { net: "a/b", view: "specs", facet: "ipvpns", detail: "x#y" };
    const h = formatHash(route);
    assert.ok(!h.slice(1).includes("#"), "no raw # inside the hash");
    assert.deepEqual(parseHash(h), route);
  });

  test("irrelevant params are dropped per view", () => {
    assert.equal(formatHash({ net: "p", view: "history", device: "sw1", facet: "ipvpns" }), "#/p/history");
    assert.equal(formatHash({ net: "p", view: "specs", device: "sw1" }), "#/p/specs");
    assert.equal(formatHash({ net: "p", view: "topology", facet: "ipvpns" }), "#/p/topology");
  });

  test("specs detail requires a facet", () => {
    assert.equal(formatHash({ net: "p", view: "specs", detail: "orphan" }), "#/p/specs");
  });
});

describe("retargetHashToNetwork()", () => {
  test("keeps the view, drops params", () => {
    assert.equal(retargetHashToNetwork("#/old/topology/device/sw1", "new"), "#/new/topology");
    assert.equal(retargetHashToNetwork("#/old/specs/ipvpns/blue", "new"), "#/new/specs");
  });

  test("unparseable hash lands on specs", () => {
    assert.equal(retargetHashToNetwork("", "new"), "#/new/specs");
    assert.equal(retargetHashToNetwork("#garbage", "new"), "#/new/specs");
  });
});
