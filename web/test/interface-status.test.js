// test/interface-status.test.js — unit tests for the per-interface
// diagnostics-panel pure formatters (interface-status.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  formatBps, formatPps, formatCount, formatSpeed, lldpFarEnd, counterPairs,
  hasCounterAlerts, neighborLines, memberSummaries,
} from "../dist/interface-status.js";

describe("formatBps", () => {
  test("scales bps → Kbps → Mbps → Gbps", () => {
    assert.equal(formatBps(1.5), "1.5 bps");
    assert.equal(formatBps(50.44), "50.4 bps");
    assert.equal(formatBps(12300), "12.3 Kbps");
    assert.equal(formatBps(4_200_000), "4.2 Mbps");
    assert.equal(formatBps(1_100_000_000), "1.1 Gbps");
  });
  test("accepts numeric strings; guards garbage/negatives", () => {
    assert.equal(formatBps("22.77"), "22.8 bps");
    assert.equal(formatBps(undefined), "—");
    assert.equal(formatBps("nope"), "—");
    assert.equal(formatBps(-5), "—");
  });
  test("drops the decimal at ≥100 in a unit", () => {
    assert.equal(formatBps(250), "250 bps");
  });
});

describe("formatPps", () => {
  test("scales and formats packets/sec", () => {
    assert.equal(formatPps(0.18), "0.2 pps");
    assert.equal(formatPps(1500), "1.5 Kpps");
  });
});

describe("formatCount", () => {
  test("groups integers; — for missing", () => {
    assert.equal(formatCount(517351), "517,351");
    assert.equal(formatCount("2818"), "2,818");
    assert.equal(formatCount(undefined), "—");
  });
});

describe("lldpFarEnd", () => {
  test("summarizes system · port (the wiring truth)", () => {
    assert.equal(lldpFarEnd({ system_name: "switch2", port_id: "Ethernet0" }), "switch2 · Ethernet0");
  });
  test("falls back to chassis_id / port_description", () => {
    assert.equal(lldpFarEnd({ chassis_id: "52:54:00:61:9f:4d", port_description: "uplink" }), "52:54:00:61:9f:4d · uplink");
  });
  test("null when no neighbor is heard", () => {
    assert.equal(lldpFarEnd(undefined), null);
    assert.equal(lldpFarEnd({}), null);
  });
});

describe("counterPairs", () => {
  const C = {
    rx_octets: 517351, tx_octets: 522655,
    rx_unicast_packets: 2818, tx_unicast_packets: 2885,
    rx_non_unicast_packets: 0, tx_non_unicast_packets: 0,
    rx_discards: 0, tx_discards: 0, rx_errors: 0, tx_errors: 3,
  };
  test("labels rx/tx rows and formats counts", () => {
    const rows = counterPairs(C);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], { label: "Octets", rx: "517,351", tx: "522,655", alert: false });
  });
  test("flags errors/discards when non-zero", () => {
    const rows = counterPairs(C);
    const err = rows.find((r) => r.label === "Errors");
    assert.equal(err.alert, true, "tx_errors=3 → alert");
    const disc = rows.find((r) => r.label === "Discards");
    assert.equal(disc.alert, false, "zero discards → no alert");
  });
  test("empty for missing counters", () => {
    assert.deepEqual(counterPairs(undefined), []);
  });
});

describe("hasCounterAlerts", () => {
  test("true iff any error/discard is non-zero", () => {
    assert.equal(hasCounterAlerts({ rx_errors: 0, tx_errors: 0, rx_discards: 0, tx_discards: 0 }), false);
    assert.equal(hasCounterAlerts({ tx_discards: 2 }), true);
    assert.equal(hasCounterAlerts(null), false);
  });
});

describe("formatSpeed", () => {
  test("renders SONiC Mbps strings as G/M", () => {
    assert.equal(formatSpeed("40000"), "40G");
    assert.equal(formatSpeed("100000"), "100G");
    assert.equal(formatSpeed("2500"), "2.5G");
    assert.equal(formatSpeed("100"), "100M");
  });
  test("guards the -vs STATE_DB sentinel and garbage (newtron #441)", () => {
    assert.equal(formatSpeed("4294967295"), "—", "uint32 sentinel is not a speed");
    assert.equal(formatSpeed(4294967295), "—");
    assert.equal(formatSpeed(undefined), "—");
    assert.equal(formatSpeed("0"), "—");
    assert.equal(formatSpeed("nope"), "—");
  });
});

describe("memberSummaries", () => {
  test("shapes LAG/SVI members: name, up flag, sentinel-guarded speed", () => {
    assert.deepEqual(
      memberSummaries([
        { name: "Ethernet8", admin_status: "up", oper_status: "up", speed: "40000" },
        { name: "Ethernet12", admin_status: "up", oper_status: "down", speed: "4294967295" },
      ]),
      [
        { name: "Ethernet8", up: true, speed: "40G" },
        { name: "Ethernet12", up: false, speed: "—" },
      ],
    );
  });
  test("falls back to admin_status when oper is absent", () => {
    assert.deepEqual(memberSummaries([{ name: "Ethernet0", admin_status: "up" }]),
      [{ name: "Ethernet0", up: true, speed: "—" }]);
  });
  test("drops nameless entries; tolerates non-arrays (physical ports omit members)", () => {
    assert.deepEqual(memberSummaries([{ admin_status: "up" }]), []);
    assert.deepEqual(memberSummaries(undefined), []);
  });
});

describe("neighborLines", () => {
  test("formats resolved ARP as address → mac", () => {
    assert.deepEqual(
      neighborLines([{ address: "10.255.255.1", mac: "22:17:af:0f:8c:a7", family: "IPv4" }]),
      ["10.255.255.1 → 22:17:af:0f:8c:a7"],
    );
  });
  test("skips entries without an address; tolerates non-arrays", () => {
    assert.deepEqual(neighborLines([{ mac: "x" }, { address: "1.2.3.4" }]), ["1.2.3.4 → ?"]);
    assert.deepEqual(neighborLines(undefined), []);
  });
});
