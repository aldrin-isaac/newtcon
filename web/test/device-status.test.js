// device-status.test.js — the per-device status resolver, focused on the
// running-vs-reachable distinction: a lab VM whose process is up but whose live
// /info probe failed resolves to "unreachable", not a green "running".

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveDeviceStatus } from "../dist/device-status.js";

const lab = (node) => ({ nodes: { switch1: node } });

describe("resolveDeviceStatus() — running vs reachable", () => {
  test("lab running + reachable probe → running", () => {
    const s = resolveDeviceStatus("switch1", lab({ status: "running", pid: 1, ssh_port: 22 }), true);
    assert.equal(s.state, "running");
  });

  test("lab running + FAILED probe → unreachable (VM up, live state unreadable)", () => {
    const s = resolveDeviceStatus("switch1", lab({ status: "running", pid: 1, ssh_port: 22 }), false);
    assert.equal(s.state, "unreachable");
    assert.match(s.detail, /can't read/);
    assert.match(s.detail, /pid 1/, "keeps the substrate detail");
  });

  test("lab running + UNDEFINED probe → optimistically running (don't downgrade on unknown)", () => {
    const s = resolveDeviceStatus("switch1", lab({ status: "running", pid: 1 }), undefined);
    assert.equal(s.state, "running");
  });

  test("lab running + phase → booting (mid-boot; reachability not yet meaningful)", () => {
    const s = resolveDeviceStatus("switch1", lab({ status: "running", phase: "boot", pid: 1 }), false);
    assert.equal(s.state, "booting");
  });

  test("lab running + provisioning flag → provisioning (known transition, not a fault)", () => {
    const s = resolveDeviceStatus("switch1", lab({ status: "running", pid: 1 }), false, true);
    assert.equal(s.state, "provisioning");
    assert.match(s.detail, /provisioning/);
  });

  test("provisioning overrides a FAILED probe (would otherwise be unreachable)", () => {
    const s = resolveDeviceStatus("switch1", lab({ status: "running", pid: 1, ssh_port: 22 }), false, true);
    assert.equal(s.state, "provisioning", "a failed live read during provision is expected, not unreachable");
  });

  test("phase (booting) still wins over the provisioning flag", () => {
    const s = resolveDeviceStatus("switch1", lab({ status: "running", phase: "boot", pid: 1 }), false, true);
    assert.equal(s.state, "booting");
  });

  test("provisioning flag ignored when the VM is stopped", () => {
    assert.equal(resolveDeviceStatus("switch1", lab({ status: "stopped" }), undefined, true).state, "down");
  });

  test("lab stopped → down (regardless of probe)", () => {
    assert.equal(resolveDeviceStatus("switch1", lab({ status: "stopped" }), undefined).state, "down");
  });

  test("no lab record + reachable → running (physical / out-of-view lab)", () => {
    assert.equal(resolveDeviceStatus("switch1", { nodes: {} }, true).state, "running");
  });

  test("no lab record + unreachable → unrealized (no substrate realizes it)", () => {
    assert.equal(resolveDeviceStatus("switch1", { nodes: {} }, false).state, "unrealized");
  });
});
