// topology-live.test.js — live-layer derivations (uplift 4.4): COUNTERS_DB
// parsing, utilization, heat tiers, and the poll gate.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parsePortNameMap, parseRates, portUtilization, heatTier, linkHeat, shouldPollLive,
} from "../dist/topology-live.js";

const LINK = { local_device: "switch1", local_interface: "Ethernet0", remote_device: "switch2", remote_interface: "Ethernet0" };

describe("parsePortNameMap()", () => {
  test("empty-key nesting (live shape) and flat maps both parse", () => {
    const nested = parsePortNameMap({ "": { Ethernet0: "oid:0x1", Ethernet4: "oid:0x2" } });
    assert.equal(nested.get("Ethernet0"), "oid:0x1");
    const flat = parsePortNameMap({ Ethernet0: "oid:0x1" });
    assert.equal(flat.get("Ethernet0"), "oid:0x1");
  });
  test("non-oid values and junk skipped", () => {
    assert.equal(parsePortNameMap({ Ethernet0: "nope" }).size, 0);
    assert.equal(parsePortNameMap(null).size, 0);
  });
});

describe("parseRates()", () => {
  test("oid rows parse; config rows (PORT/RIF) are skipped", () => {
    const rates = parseRates({
      "oid:0x1": { RX_BPS: "128000", TX_BPS: "0" },
      PORT: { PORT_ALPHA: "0.18" },
      RIF: { RIF_ALPHA: "0.18" },
    });
    assert.equal(rates.size, 1);
    assert.deepEqual(rates.get("oid:0x1"), { rxBps: 128000, txBps: 0 });
  });
});

describe("portUtilization()", () => {
  const nameMap = new Map([["Ethernet0", "oid:0x1"]]);
  const rates = new Map([["oid:0x1", { rxBps: 500_000_000, txBps: 100 }]]);
  test("busiest direction over speed", () => {
    assert.equal(portUtilization("Ethernet0", nameMap, rates, 1000), 0.5);
  });
  test("caps at 1", () => {
    assert.equal(portUtilization("Ethernet0", nameMap, rates, 100), 1);
  });
  test("unknown port / speed → undefined", () => {
    assert.equal(portUtilization("Ethernet9", nameMap, rates, 1000), undefined);
    assert.equal(portUtilization("Ethernet0", nameMap, rates, undefined), undefined);
  });
});

describe("heat tiers", () => {
  test("thresholds", () => {
    assert.equal(heatTier(0), "idle");
    assert.equal(heatTier(0.04), "idle");
    assert.equal(heatTier(0.05), "low");
    assert.equal(heatTier(0.4), "med");
    assert.equal(heatTier(0.8), "high");
    assert.equal(heatTier(1), "high");
  });

  test("linkHeat takes the busiest end; silence → undefined", () => {
    const util = new Map([
      ["switch1", new Map([["Ethernet0", 0.1]])],
      ["switch2", new Map([["Ethernet0", 0.9]])],
    ]);
    assert.equal(linkHeat(LINK, util), "high");
    assert.equal(linkHeat(LINK, new Map()), undefined);
  });
});

describe("shouldPollLive()", () => {
  test("polls only when visible AND live lens on", () => {
    assert.equal(shouldPollLive({ tabVisible: true, liveLensOn: true }), true);
    assert.equal(shouldPollLive({ tabVisible: false, liveLensOn: true }), false);
    assert.equal(shouldPollLive({ tabVisible: true, liveLensOn: false }), false);
  });
});
