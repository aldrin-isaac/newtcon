// topology-links.test.js — link-truth derivations (uplift 4.2):
// LLDP verification verdicts, speed→thickness, underlay aggregation.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseLldpTable, parsePortSpeeds, classifyLink,
  linkStrokeWidth, linkSpeedForLink, parseBgpCheckOk, linkUnderlayState,
  parsePortStates, portDotState, portDotTooltip,
} from "../dist/topology-links.js";

const LINK = { local_device: "switch1", local_interface: "Ethernet0", remote_device: "switch2", remote_interface: "Ethernet0" };

describe("parseLldpTable()", () => {
  test("bare and prefixed keys both resolve to ports", () => {
    const rows = parseLldpTable({
      "Ethernet0": { lldp_rem_sys_name: "switch2", lldp_rem_port_id: "Ethernet0" },
      "LLDP_ENTRY_TABLE:Ethernet4": { lldp_rem_sys_name: "switch3" },
    });
    assert.deepEqual(rows.map((r) => r.port).sort(), ["Ethernet0", "Ethernet4"]);
    assert.equal(rows.find((r) => r.port === "Ethernet0").remoteSystem, "switch2");
  });

  test("junk shapes return empty", () => {
    assert.deepEqual(parseLldpTable(null), []);
    assert.deepEqual(parseLldpTable([1, 2]), []);
    assert.deepEqual(parseLldpTable("x"), []);
  });
});

describe("classifyLink()", () => {
  test("LLDP hearing the intended far end → verified", () => {
    const lldp = new Map([["switch1", [{ port: "Ethernet0", remoteSystem: "switch2", remotePort: "Ethernet0" }]]]);
    assert.equal(classifyLink(LINK, lldp), "verified");
  });

  test("either direction suffices", () => {
    const lldp = new Map([["switch2", [{ port: "Ethernet0", remoteSystem: "switch1", remotePort: "Ethernet0" }]]]);
    assert.equal(classifyLink(LINK, lldp), "verified");
  });

  test("silence → intent-only", () => {
    assert.equal(classifyLink(LINK, new Map()), "intent-only");
    const lldpOtherPort = new Map([["switch1", [{ port: "Ethernet8", remoteSystem: "switch3" }]]]);
    assert.equal(classifyLink(LINK, lldpOtherPort), "intent-only");
  });

  test("hearing a DIFFERENT device → mismatch (mis-cable)", () => {
    const lldp = new Map([["switch1", [{ port: "Ethernet0", remoteSystem: "switch3", remotePort: "Ethernet0" }]]]);
    assert.equal(classifyLink(LINK, lldp), "mismatch");
  });

  test("right device, wrong port → mismatch", () => {
    const lldp = new Map([["switch1", [{ port: "Ethernet0", remoteSystem: "switch2", remotePort: "Ethernet8" }]]]);
    assert.equal(classifyLink(LINK, lldp), "mismatch");
  });

  test("mismatch beats a verified opposite direction", () => {
    const lldp = new Map([
      ["switch1", [{ port: "Ethernet0", remoteSystem: "switch2", remotePort: "Ethernet0" }]],
      ["switch2", [{ port: "Ethernet0", remoteSystem: "switch3" }]],
    ]);
    assert.equal(classifyLink(LINK, lldp), "mismatch");
  });
});

describe("speed → thickness", () => {
  test("parsePortSpeeds skips the vs sentinel and junk", () => {
    const speeds = parsePortSpeeds({
      "Ethernet0": { speed: "100000" },
      "Ethernet4": { speed: "4294967295" },
      "Ethernet8": { speed: "nope" },
    });
    assert.equal(speeds.get("Ethernet0"), 100000);
    assert.equal(speeds.has("Ethernet4"), false);
    assert.equal(speeds.has("Ethernet8"), false);
  });

  test("linkStrokeWidth tiers", () => {
    assert.equal(linkStrokeWidth(undefined), 1.5);
    assert.equal(linkStrokeWidth(1000), 1.5);
    assert.equal(linkStrokeWidth(10000), 2);
    assert.equal(linkStrokeWidth(40000), 2.5);
    assert.equal(linkStrokeWidth(100000), 3);
    assert.equal(linkStrokeWidth(400000), 3);
  });

  test("linkSpeedForLink takes the min of both ends", () => {
    const byDevice = new Map([
      ["switch1", new Map([["Ethernet0", 100000]])],
      ["switch2", new Map([["Ethernet0", 10000]])],
    ]);
    assert.equal(linkSpeedForLink(LINK, byDevice), 10000);
    assert.equal(linkSpeedForLink(LINK, new Map()), undefined);
  });
});

describe("underlay state", () => {
  test("parseBgpCheckOk tolerant shapes", () => {
    assert.equal(parseBgpCheckOk({ ok: true }), "ok");
    assert.equal(parseBgpCheckOk({ ok: false }), "down");
    assert.equal(parseBgpCheckOk({ status: "pass" }), "ok");
    assert.equal(parseBgpCheckOk({ status: "failed" }), "down");
    assert.equal(parseBgpCheckOk({ checks: [{ status: "ok" }, { status: "ok" }] }), "ok");
    assert.equal(parseBgpCheckOk({ checks: [{ status: "ok" }, { status: "failed" }] }), "down");
    assert.equal(parseBgpCheckOk([{ check: "bgp-sessions", status: "ok" }]), "ok", "bare rows array (live shape)");
    assert.equal(parseBgpCheckOk([{ check: "bgp-sessions", status: "failed" }]), "down");
    assert.equal(parseBgpCheckOk([]), "unknown");
    assert.equal(parseBgpCheckOk({}), "unknown");
    assert.equal(parseBgpCheckOk("nope"), "unknown");
  });

  test("linkUnderlayState is worst-of-ends", () => {
    const by = new Map([["switch1", "ok"], ["switch2", "down"]]);
    assert.equal(linkUnderlayState(LINK, by), "down");
    assert.equal(linkUnderlayState(LINK, new Map([["switch1", "ok"], ["switch2", "ok"]])), "ok");
    assert.equal(linkUnderlayState(LINK, new Map([["switch1", "ok"]])), "unknown");
  });
});

describe("interface-state endpoint dots", () => {
  test("parsePortStates reads admin/oper/speed/mtu, normalizes keys, skips empty", () => {
    const m = parsePortStates({
      "Ethernet0": { admin_status: "up", oper_status: "up", speed: "100000", mtu: "9100" },
      "PORT_TABLE:Ethernet4": { admin_status: "up", oper_status: "down" },
      "Ethernet8": { fec: "rs" },        // no admin/oper/speed/mtu → skipped
      "Ethernet12": { speed: "4294967295" }, // sentinel speed dropped, but mtu absent → skipped
    });
    assert.deepEqual(m.get("Ethernet0"), { admin: "up", oper: "up", speedMbps: 100000, mtu: "9100" });
    assert.deepEqual(m.get("Ethernet4"), { admin: "up", oper: "down" });
    assert.equal(m.has("Ethernet8"), false);
    assert.equal(m.has("Ethernet12"), false);
  });

  test("portDotState tiers", () => {
    assert.equal(portDotState({ admin: "up", oper: "up" }), "ok");
    assert.equal(portDotState({ admin: "up", oper: "down" }), "down");
    assert.equal(portDotState({ admin: "down", oper: "down" }), "admin-down");
    assert.equal(portDotState({ admin: "down", oper: "up" }), "admin-down", "admin wins — it's out of service");
    assert.equal(portDotState({ oper: "up" }), "ok", "oper alone suffices");
    assert.equal(portDotState({}), "unknown");
    assert.equal(portDotState(undefined), "unknown");
  });

  test("portDotTooltip lists what's known, dashes what isn't", () => {
    assert.equal(portDotTooltip("Ethernet0", { admin: "up", oper: "down", speedMbps: 100000, mtu: "9100" }),
      "Ethernet0 · admin: up · oper: down · 100000 Mbps · MTU 9100");
    assert.equal(portDotTooltip("Vlan100", undefined), "Vlan100 · admin: — · oper: —");
  });
});
