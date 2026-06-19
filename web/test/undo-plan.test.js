// test/undo-plan.test.js — unit tests for the data-layer undo planner
// (slice #175.C.1).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { planUndo } from "../dist/undo-plan.js";

const idGen = (i) => "undo-" + i;

function entry(items) {
  return {
    id: "e1",
    timestamp: "2026-06-17T12:00:00Z",
    user: "alice",
    network: "default",
    summary: { total: items.length, applied: items.length, failed: 0, danger: 0 },
    items,
  };
}

describe("planUndo() — spec ops", () => {
  test("spec.create → spec.delete by name", () => {
    const plan = planUndo(entry([
      { id: "1", effect: "create", kind: "spec", title: "transit-2026", scope: "services", danger: false, outcome: "applied", undoable: true },
    ]), idGen);
    assert.equal(plan.counts.planned, 1);
    const inv = plan.items[0].inverse;
    assert.equal(inv.group, "spec");
    assert.equal(inv.kind, "services");
    assert.equal(inv.op, "delete");
    assert.equal(inv.name, "transit-2026");
  });

  test("spec.delete with preBody → spec.create with body", () => {
    const plan = planUndo(entry([
      { id: "2", effect: "delete", kind: "spec", title: "old", scope: "zones", danger: true, outcome: "applied", undoable: true, preBody: { name: "old", description: "deprecated" } },
    ]), idGen);
    const inv = plan.items[0].inverse;
    assert.equal(inv.op, "create");
    assert.equal(inv.kind, "zones");
    assert.deepEqual(inv.body, { name: "old", description: "deprecated" });
  });

  test("spec.delete without preBody → skipped with body-not-captured reason", () => {
    const plan = planUndo(entry([
      { id: "2", effect: "delete", kind: "spec", title: "old", scope: "zones", danger: true, outcome: "applied", undoable: false },
    ]), idGen);
    assert.equal(plan.counts.skipped, 1);
    assert.ok(plan.items[0].reason && /pre-apply body/.test(plan.items[0].reason));
  });

  test("scope with dashes (qos-policies) round-trips correctly", () => {
    const plan = planUndo(entry([
      { id: "1", effect: "create", kind: "spec", title: "rt-policy", scope: "qos policies", danger: false, outcome: "applied", undoable: true },
    ]), idGen);
    assert.equal(plan.items[0].inverse.kind, "qos-policies");
  });

  test("unknown scope → no inverse", () => {
    const plan = planUndo(entry([
      { id: "1", effect: "create", kind: "spec", title: "x", scope: "unknown-kind", danger: false, outcome: "applied", undoable: true },
    ]), idGen);
    assert.equal(plan.counts.skipped, 1);
    assert.ok(plan.items[0].reason);
  });
});

describe("planUndo() — topology device ops", () => {
  test("device add → remove-device", () => {
    const plan = planUndo(entry([
      { id: "3", effect: "create", kind: "device", title: "r1.lab", scope: "topology", danger: false, outcome: "applied", undoable: true },
    ]), idGen);
    const inv = plan.items[0].inverse;
    assert.equal(inv.group, "topology");
    assert.equal(inv.op, "remove-device");
    assert.equal(inv.name, "r1.lab");
  });

  test("device remove with preBody → add-device with body", () => {
    const plan = planUndo(entry([
      { id: "3", effect: "delete", kind: "device", title: "r-old", scope: "topology", danger: true, outcome: "applied", undoable: true, preBody: { ports: { eth0: {} } } },
    ]), idGen);
    const inv = plan.items[0].inverse;
    assert.equal(inv.op, "add-device");
    assert.deepEqual(inv.body, { ports: { eth0: {} } });
  });
});

describe("planUndo() — topology link ops", () => {
  test("link add → remove-link using A endpoint", () => {
    const plan = planUndo(entry([
      { id: "4", effect: "create", kind: "link", title: "r1:eth0 ↔ r2:eth0", scope: "topology", danger: false, outcome: "applied", undoable: true },
    ]), idGen);
    const inv = plan.items[0].inverse;
    assert.equal(inv.op, "remove-link");
    assert.equal(inv.device, "r1");
    assert.equal(inv.iface, "eth0");
  });

  test("link remove → add-link with both endpoints (title-encoded fallback)", () => {
    const plan = planUndo(entry([
      { id: "4", effect: "delete", kind: "link", title: "r1:eth0 ↔ r2:eth0", scope: "topology", danger: true, outcome: "applied", undoable: true },
    ]), idGen);
    const inv = plan.items[0].inverse;
    assert.equal(inv.op, "add-link");
    assert.equal(inv.a, "r1:eth0");
    assert.equal(inv.z, "r2:eth0");
  });

  test("link remove with cached {a, z} preBody → add-link with cached endpoints (slice #175.C.1 polish)", () => {
    // Real-world title from apply-preview.ts is just "device:iface" —
    // only the queued endpoint. Without preBody this would fail to
    // plan; with preBody (captured from the topology before applyAll),
    // both endpoints are recoverable.
    const plan = planUndo(entry([
      { id: "4", effect: "delete", kind: "link", title: "r2:eth1", scope: "topology", danger: true, outcome: "applied", undoable: true, preBody: { a: "r2:eth1", z: "host-a:eth0" } },
    ]), idGen);
    const inv = plan.items[0].inverse;
    assert.equal(inv.op, "add-link");
    assert.equal(inv.a, "r2:eth1");
    assert.equal(inv.z, "host-a:eth0");
  });

  test("link remove with non-parseable title AND no preBody → skipped", () => {
    const plan = planUndo(entry([
      { id: "4", effect: "delete", kind: "link", title: "r2:eth1", scope: "topology", danger: true, outcome: "applied", undoable: true },
    ]), idGen);
    // No inverse can be composed without both endpoints.
    assert.equal(plan.counts.skipped, 1);
  });

  test("malformed link title → skipped", () => {
    const plan = planUndo(entry([
      { id: "4", effect: "create", kind: "link", title: "no separator", scope: "topology", danger: false, outcome: "applied", undoable: true },
    ]), idGen);
    assert.equal(plan.counts.skipped, 1);
  });
});

describe("planUndo() — device/interface actions (175.C.2)", () => {
  test("device.action with no actionId-inverse mapping → skipped with actionId in reason", () => {
    const plan = planUndo(entry([
      { id: "5", effect: "action", kind: "device action", title: "create-vlan", scope: "r1", danger: false, outcome: "applied", undoable: false, actionId: "create-vlan" },
    ]), idGen);
    assert.equal(plan.counts.skipped, 1);
    assert.ok(plan.items[0].reason && /create-vlan/.test(plan.items[0].reason),
      "skip reason should name the unmapped actionId so the operator knows what to ask for");
  });

  test("interface.action with no actionId-inverse mapping → skipped same way", () => {
    const plan = planUndo(entry([
      { id: "6", effect: "action", kind: "interface action", title: "set-mtu", scope: "r1:eth0", danger: false, outcome: "applied", undoable: false, actionId: "configure-interface", device: "r1", iface: "eth0" },
    ]), idGen);
    assert.equal(plan.items[0].planned, false);
    assert.ok(plan.items[0].reason && /configure-interface/.test(plan.items[0].reason));
  });

  test("apply-service → remove-service with no body (slice 175.C.2.a)", () => {
    const plan = planUndo(entry([
      { id: "7", effect: "action", kind: "interface action", title: "Bind service", scope: "r1:eth0", danger: false, outcome: "applied", undoable: true, actionId: "apply-service", device: "r1", iface: "eth0", body: { service: "svc-x" } },
    ]), idGen);
    assert.equal(plan.counts.planned, 1);
    const inv = plan.items[0].inverse;
    assert.equal(inv.group, "interface");
    assert.equal(inv.op, "action");
    assert.equal(inv.actionId, "remove-service");
    assert.equal(inv.device, "r1");
    assert.equal(inv.iface, "eth0");
    assert.deepEqual(inv.body, {});
    assert.equal(inv.danger, true);
  });

  test("apply-service without device/iface → skipped (defensive)", () => {
    const plan = planUndo(entry([
      { id: "7", effect: "action", kind: "interface action", title: "Bind service", scope: "?", danger: false, outcome: "applied", undoable: true, actionId: "apply-service" },
    ]), idGen);
    assert.equal(plan.counts.skipped, 1);
  });

  test("configure-interface tagged:true (trunk add) → remove-trunk-vlan with vlan_id (slice 175.C.2.b)", () => {
    const plan = planUndo(entry([
      { id: "8", effect: "action", kind: "interface action", title: "Add tagged VLAN (trunk)", scope: "r1:eth0", danger: false, outcome: "applied", undoable: true, actionId: "configure-interface", device: "r1", iface: "eth0", body: { vlan_id: 100, tagged: true } },
    ]), idGen);
    assert.equal(plan.counts.planned, 1);
    const inv = plan.items[0].inverse;
    assert.equal(inv.actionId, "remove-trunk-vlan");
    assert.equal(inv.device, "r1");
    assert.equal(inv.iface, "eth0");
    assert.deepEqual(inv.body, { vlan_id: 100 });
    assert.equal(inv.danger, true);
  });

  test("configure-interface tagged:false (access set) → unconfigure-interface (slice 175.C.2.c)", () => {
    // Per newtron case A: cross-mode rejected, so prior was empty.
    // Clearing the port restores empty.
    const plan = planUndo(entry([
      { id: "8", effect: "action", kind: "interface action", title: "Set to access", scope: "r1:eth0", danger: false, outcome: "applied", undoable: true, actionId: "configure-interface", device: "r1", iface: "eth0", body: { vlan_id: 100, tagged: false } },
    ]), idGen);
    assert.equal(plan.counts.planned, 1);
    const inv = plan.items[0].inverse;
    assert.equal(inv.actionId, "unconfigure-interface");
    assert.equal(inv.device, "r1");
    assert.equal(inv.iface, "eth0");
    assert.deepEqual(inv.body, {});
    assert.equal(inv.danger, true);
  });

  test("configure-interface routed (vrf+ip) → unconfigure-interface (slice 175.C.2.c)", () => {
    const plan = planUndo(entry([
      { id: "8", effect: "action", kind: "interface action", title: "Set to routed", scope: "r1:eth0", danger: false, outcome: "applied", undoable: true, actionId: "configure-interface", device: "r1", iface: "eth0", body: { vrf: "blue", ip: "10.0.0.1/24" } },
    ]), idGen);
    assert.equal(plan.counts.planned, 1);
    assert.equal(plan.items[0].inverse.actionId, "unconfigure-interface");
  });

  test("configure-interface routed with only vrf (no ip) → still undoable via unconfigure-interface", () => {
    const plan = planUndo(entry([
      { id: "8", effect: "action", kind: "interface action", title: "Set vrf", scope: "r1:eth0", danger: false, outcome: "applied", undoable: true, actionId: "configure-interface", device: "r1", iface: "eth0", body: { vrf: "blue" } },
    ]), idGen);
    assert.equal(plan.items[0].inverse.actionId, "unconfigure-interface");
  });

  test("configure-interface with empty body → skipped (no inverse mappable)", () => {
    const plan = planUndo(entry([
      { id: "8", effect: "action", kind: "interface action", title: "Configure", scope: "r1:eth0", danger: false, outcome: "applied", undoable: false, actionId: "configure-interface", device: "r1", iface: "eth0", body: {} },
    ]), idGen);
    assert.equal(plan.counts.skipped, 1);
  });

  test("configure-interface tagged:true but vlan_id not a number → skipped (defensive)", () => {
    const plan = planUndo(entry([
      { id: "8", effect: "action", kind: "interface action", title: "Add tagged VLAN", scope: "r1:eth0", danger: false, outcome: "applied", undoable: true, actionId: "configure-interface", device: "r1", iface: "eth0", body: { tagged: true, vlan_id: "100" } },
    ]), idGen);
    assert.equal(plan.counts.skipped, 1);
  });
});

describe("planUndo() — mixed entry", () => {
  test("mix of planned + skipped is counted accurately", () => {
    const plan = planUndo(entry([
      { id: "1", effect: "create", kind: "spec", title: "a", scope: "services", danger: false, outcome: "applied", undoable: true },
      { id: "2", effect: "delete", kind: "spec", title: "b", scope: "zones", danger: true, outcome: "applied", undoable: false },
      { id: "3", effect: "action", kind: "device action", title: "x", scope: "r1", danger: false, outcome: "applied", undoable: false },
      { id: "4", effect: "create", kind: "device", title: "r-new", scope: "topology", danger: false, outcome: "applied", undoable: true },
    ]), idGen);
    assert.equal(plan.counts.planned, 2);
    assert.equal(plan.counts.skipped, 2);
    assert.equal(plan.items.length, 4);
  });

  test("each planned item gets a unique id from idGen", () => {
    const plan = planUndo(entry([
      { id: "1", effect: "create", kind: "spec", title: "a", scope: "services", danger: false, outcome: "applied", undoable: true },
      { id: "2", effect: "create", kind: "spec", title: "b", scope: "services", danger: false, outcome: "applied", undoable: true },
    ]), idGen);
    const ids = plan.items.filter((i) => i.planned).map((i) => i.inverse.id);
    assert.notEqual(ids[0], ids[1]);
  });
});

describe("planUndo() — empty entry", () => {
  test("empty items → empty plan", () => {
    const plan = planUndo(entry([]), idGen);
    assert.deepEqual(plan.items, []);
    assert.deepEqual(plan.counts, { planned: 0, skipped: 0 });
  });
});
