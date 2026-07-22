// topology-links.test.js — link-truth derivations (uplift 4.2):
// LLDP verification verdicts, speed→thickness, underlay aggregation.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseLldpTable, parsePortSpeeds, classifyLink,
  linkStrokeWidth, linkSpeedForLink, parseBgpCheckOk, linkUnderlayState,
  parsePortStates, portDotState, portDotTooltip, distributeSeats, parseLagMembers,
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

describe("parseLagMembers()", () => {
  test("groups member ports under their PortChannel, numeric-ordered", () => {
    const m = parseLagMembers({
      "PortChannel1:Ethernet4": {},
      "PortChannel1:Ethernet0": {},
      "PortChannel1:Ethernet12": {},
      "PortChannel2:Ethernet8": { status: "enabled" },
    });
    assert.deepEqual(m.get("PortChannel1"), ["Ethernet0", "Ethernet4", "Ethernet12"]);
    assert.deepEqual(m.get("PortChannel2"), ["Ethernet8"]);
  });

  test("tolerates the table-prefixed / colon-less / junk keys", () => {
    const m = parseLagMembers({
      "PortChannel3:Ethernet0": {},
      "Ethernet0": {},      // no lag:member split → skipped
      ":Ethernet4": {},     // empty lag → skipped
      "PortChannel4:": {},  // empty member → skipped
    });
    assert.deepEqual([...m.keys()], ["PortChannel3"]);
    assert.deepEqual(m.get("PortChannel3"), ["Ethernet0"]);
  });

  test("dedupes a repeated member and returns empty on junk", () => {
    const m = parseLagMembers({ "PortChannel1:Ethernet0": {}, "PortChannel1:Ethernet0 ": {} });
    // trailing-space key is a distinct member string; the exact dup is what we fold
    assert.ok(m.get("PortChannel1").includes("Ethernet0"));
    assert.deepEqual(parseLagMembers(null), new Map());
    assert.deepEqual(parseLagMembers([1, 2]), new Map());
    assert.deepEqual(parseLagMembers("x"), new Map());
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


describe("distributeSeats()", () => {
  const c = { x: 100, y: 100 }, hw = 60, hh = 26;
  const seat = (m, id) => m.get(id);

  test("links to different sides land on different edges", () => {
    const m = distributeSeats(c, hw, hh, [
      { id: "up", tx: 100, ty: -400 },
      { id: "down", tx: 100, ty: 400 },
      { id: "right", tx: 500, ty: 100 },
    ]);
    assert.ok(seat(m, "up").y < c.y - hh, "up seat on top edge");
    assert.ok(seat(m, "down").y > c.y + hh, "down seat on bottom edge");
    assert.ok(seat(m, "right").x > c.x + hw, "right seat on right edge");
  });

  test("co-located links on one edge spread without overlap, same edge", () => {
    // three neighbours all roughly to the right → all on the right (vertical) edge.
    // A 52px-tall card packs them to fit; every gap must still exceed the ball
    // diameter (8px) so nothing overlaps.
    const m = distributeSeats(c, hw, hh, [
      { id: "a", tx: 500, ty: 60 },
      { id: "b", tx: 500, ty: 100 },
      { id: "d", tx: 500, ty: 140 },
    ], 2, 16);
    const ys = ["a", "b", "d"].map((id) => seat(m, id).y).sort((p, q) => p - q);
    assert.ok(ys[1] - ys[0] >= 8 && ys[2] - ys[1] >= 8, `no overlap (gaps > ball dia): ${ys}`);
    const xs = new Set(["a", "b", "d"].map((id) => Math.round(seat(m, id).x)));
    assert.equal(xs.size, 1, "all on the same (right) edge x");
  });

  test("a wide (bottom) edge fits the full min gap", () => {
    // bottom edge is 120px wide → three links get the full 16px gap
    const m = distributeSeats(c, hw, hh, [
      { id: "a", tx: 60, ty: 500 },
      { id: "b", tx: 100, ty: 500 },
      { id: "d", tx: 140, ty: 500 },
    ], 2, 16);
    const xs = ["a", "b", "d"].map((id) => seat(m, id).x).sort((p, q) => p - q);
    assert.ok(Math.abs(xs[1] - xs[0] - 16) < 0.01 && Math.abs(xs[2] - xs[1] - 16) < 0.01, `even 16px gaps: ${xs}`);
  });

  test("all seats stay within the padded edge span", () => {
    const m = distributeSeats(c, hw, hh, Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, tx: 500, ty: 100 })), 2, 16, 12);
    for (const [, p] of m) assert.ok(p.y >= c.y - hh + 12 - 0.01 && p.y <= c.y + hh - 12 + 0.01, `within span: ${p.y}`);
  });

  test("a single link on an edge points at its neighbour (not forced to centre)", () => {
    const m = distributeSeats(c, hw, hh, [{ id: "solo", tx: 500, ty: 130 }], 2, 16);
    // one link → centred on its own exit height, so it should be BELOW centre
    assert.ok(seat(m, "solo").y > c.y, "seat tracks the neighbour direction");
  });
});
