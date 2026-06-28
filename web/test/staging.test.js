// staging.test.js — queue semantics for spec edits (enqueueSpecUpdate) and
// their interaction with pending creates/deletes. Pure queue ops; no DOM,
// no network (apply isn't exercised here).

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  enqueueSpecCreate,
  enqueueSpecUpdate,
  enqueueSpecDelete,
  enqueueSubCreate,
  enqueueSubUpdate,
  enqueueSubDelete,
  enqueueSubReorder,
  enqueueTopologyAddDevice,
  enqueueTopologyRemoveDevice,
  enqueueTopologyAddLink,
  enqueueTopologyRemoveLink,
  enqueueDeviceAction,
  enqueueInterfaceAction,
  enqueuePortConfig,
  pendingSubMutations,
  pendingPortConfigs,
  deviceQueue,
  isSpecPendingUpdate,
  isSpecPendingDelete,
  getQueue,
  discardAll,
} from "../dist/staging.js";

describe("enqueueSpecDelete() — scoped override deletes", () => {
  beforeEach(() => discardAll());

  test("scoped delete carries scope in the path + on the Pending", () => {
    enqueueSpecDelete("ipvpns", "IPVPN", "zone", "myzone");
    const [p] = getQueue();
    assert.equal(p.method, "DELETE");
    assert.equal(p.path, "ipvpns/IPVPN?scope=zone&scope_instance=myzone");
    assert.equal(p.scope, "zone");
    assert.equal(p.scopeInstance, "myzone");
    // inverse recreates on the same scope
    assert.equal(p.inverse.scope, "zone");
    assert.equal(p.inverse.scopeInstance, "myzone");
  });

  test("base and scoped deletes of the same name coexist (distinct identity)", () => {
    enqueueSpecDelete("ipvpns", "IPVPN");                 // base
    enqueueSpecDelete("ipvpns", "IPVPN", "zone", "myzone"); // override
    assert.equal(getQueue().length, 2);
  });

  test("a second scoped × toggles (cancels) the queued delete", () => {
    enqueueSpecDelete("ipvpns", "IPVPN", "zone", "myzone");
    assert.equal(getQueue().length, 1);
    const r = enqueueSpecDelete("ipvpns", "IPVPN", "zone", "myzone");
    assert.equal(r, null);
    assert.equal(getQueue().length, 0);
  });

  test("network base delete is unaffected by a scoped delete (path has no query)", () => {
    enqueueSpecDelete("ipvpns", "IPVPN");
    assert.equal(getQueue()[0].path, "ipvpns/IPVPN");
  });

  test("isSpecPendingDelete is scope-aware", () => {
    enqueueSpecDelete("ipvpns", "IPVPN", "zone", "myzone");
    assert.equal(isSpecPendingDelete("ipvpns", "IPVPN", "zone", "myzone"), true);
    assert.equal(isSpecPendingDelete("ipvpns", "IPVPN"), false); // base not pending-deleted
  });
});

describe("enqueueSpecUpdate() — edits queue like create/delete", () => {
  beforeEach(() => discardAll());

  test("queues a spec update op", () => {
    enqueueSpecUpdate("ipvpns", "IRB", { l3vni: 50400 });
    const q = getQueue();
    assert.equal(q.length, 1);
    assert.equal(q[0].group, "mutation");
    assert.equal(q[0].effect, "update");
    assert.equal(q[0].method, "PUT");
    assert.equal(q[0].name, "IRB");
    assert.deepEqual(q[0].body, { l3vni: 50400 });
    assert.equal(isSpecPendingUpdate("ipvpns", "IRB"), true);
  });

  test("repeated edits of the same spec collapse to the latest body", () => {
    enqueueSpecUpdate("ipvpns", "IRB", { l3vni: 1 });
    enqueueSpecUpdate("ipvpns", "IRB", { l3vni: 2 });
    const q = getQueue();
    assert.equal(q.length, 1, "one update entry, not two");
    assert.deepEqual(q[0].body, { l3vni: 2 }, "latest edit wins");
  });

  test("editing a pending-create folds into the create (no separate update)", () => {
    enqueueSpecCreate("ipvpns", "NEW", { l3vni: 1, scope: "zone", scope_instance: "amer" });
    enqueueSpecUpdate("ipvpns", "NEW", { l3vni: 9 });
    const q = getQueue();
    assert.equal(q.length, 1, "still a single create");
    assert.equal(q[0].effect, "create");
    assert.equal(q[0].body.l3vni, 9, "edit applied to the create body");
    assert.equal(q[0].body.scope, "zone", "create-only fields (scope) preserved");
  });

  test("deleting a spec drops a pending edit of it", () => {
    enqueueSpecUpdate("ipvpns", "IRB", { l3vni: 1 });
    enqueueSpecDelete("ipvpns", "IRB");
    const q = getQueue();
    assert.equal(q.length, 1, "the update is gone, only the delete remains");
    assert.equal(q[0].effect, "delete");
    assert.equal(isSpecPendingUpdate("ipvpns", "IRB"), false);
  });

  test("edits to different specs queue independently", () => {
    enqueueSpecUpdate("ipvpns", "A", { l3vni: 1 });
    enqueueSpecUpdate("ipvpns", "B", { l3vni: 2 });
    assert.equal(getQueue().length, 2);
  });
});

describe("sub-rule ops queue as flat mutations", () => {
  beforeEach(() => discardAll());

  test("enqueueSubCreate → POST mutation under the parent path", () => {
    enqueueSubCreate("filters", "ACL", "rules", 10, { seq: 10, action: "permit" }, "10");
    const q = getQueue();
    assert.equal(q.length, 1);
    assert.equal(q[0].group, "mutation");
    assert.equal(q[0].method, "POST");
    assert.equal(q[0].path, "filters/ACL/rules");
    assert.equal(q[0].name, "ACL");
    assert.deepEqual(q[0].sub, { endpoint: "rules", key: 10 });
  });

  test("enqueueSubUpdate/Delete target the keyed row path", () => {
    enqueueSubUpdate("filters", "ACL", "rules", 10, { action: "deny" }, "10");
    enqueueSubDelete("qos-policies", "Q", "queues", 3, "3");
    const q = getQueue();
    assert.equal(q[0].method, "PUT");
    assert.equal(q[0].path, "filters/ACL/rules/10");
    assert.equal(q[1].method, "DELETE");
    assert.equal(q[1].path, "qos-policies/Q/queues/3");
  });

  test("repeated edits of the same sub-row collapse", () => {
    enqueueSubUpdate("filters", "ACL", "rules", 10, { action: "permit" }, "10");
    enqueueSubUpdate("filters", "ACL", "rules", 10, { action: "deny" }, "10");
    const q = getQueue();
    assert.equal(q.length, 1);
    assert.deepEqual(q[0].body, { action: "deny" });
  });

  test("deleting a sub-row drops its pending edit", () => {
    enqueueSubUpdate("filters", "ACL", "rules", 10, { action: "permit" }, "10");
    enqueueSubDelete("filters", "ACL", "rules", 10, "10");
    const q = getQueue();
    assert.equal(q.length, 1);
    assert.equal(q[0].effect, "delete");
  });

  test("pendingSubMutations scopes to the right collection", () => {
    enqueueSubCreate("filters", "ACL", "rules", 10, { seq: 10 }, "10");
    enqueueSubCreate("filters", "OTHER", "rules", 20, { seq: 20 }, "20");
    enqueueSubDelete("qos-policies", "Q", "queues", 1, "1");
    const acl = pendingSubMutations("filters", "ACL", "rules");
    assert.equal(acl.length, 1);
    assert.equal(acl[0].effect, "create");
    assert.deepEqual(acl[0].body, { seq: 10 });
  });
});

describe("mutations carry their own inverse (born together)", () => {
  beforeEach(() => discardAll());

  test("spec create → inverse delete", () => {
    const p = enqueueSpecCreate("ipvpns", "IRB", { l3vni: 1 });
    assert.deepEqual(p.inverse, { group: "mutation", method: "DELETE", path: "ipvpns/IRB", effect: "delete", kind: "ipvpns", name: "IRB", title: "IRB" });
  });

  test("spec update with preBody → inverse update restoring preBody", () => {
    const p = enqueueSpecUpdate("ipvpns", "IRB", { l3vni: 2 }, { l3vni: 1 });
    assert.equal(p.inverse.method, "PUT");
    assert.equal(p.inverse.path, "ipvpns/IRB");
    assert.deepEqual(p.inverse.body, { l3vni: 1 });
  });

  test("spec delete → inverse create, body backfilled later", () => {
    const p = enqueueSpecDelete("ipvpns", "IRB");
    assert.equal(p.inverse.method, "POST");
    assert.equal(p.inverse.path, "ipvpns");      // POST to the collection
    assert.equal(p.inverse.effect, "create");
    assert.equal(p.inverse.body, undefined);     // filled at apply from preBody
  });

  test("sub create → inverse delete by key", () => {
    const p = enqueueSubCreate("filters", "ACL", "rules", 10, { seq: 10 }, "10");
    assert.equal(p.inverse.method, "DELETE");
    assert.equal(p.inverse.path, "filters/ACL/rules/10");
  });

  test("sub delete with preBody → inverse re-create on the collection", () => {
    const p = enqueueSubDelete("filters", "ACL", "rules", 10, "10", { seq: 10, action: "permit", filter: "ACL" });
    assert.equal(p.inverse.method, "POST");
    assert.equal(p.inverse.path, "filters/ACL/rules");
    assert.deepEqual(p.inverse.body, { seq: 10, action: "permit", filter: "ACL" });
  });

  test("reorder → inverse is the opposite renumber, keyed by the target", () => {
    const p = enqueueSubReorder("filters", "ACL", "rules", 10, 20, { new_seq: 20 }, { new_seq: 10 }, "10");
    assert.equal(p.path, "filters/ACL/rules/10", "forward addresses the current seq");
    assert.deepEqual(p.body, { new_seq: 20 });
    assert.equal(p.inverse.path, "filters/ACL/rules/20", "inverse addresses the target seq");
    assert.deepEqual(p.inverse.body, { new_seq: 10 });
  });
});

describe("topology + action ops carry their own inverse", () => {
  beforeEach(() => discardAll());

  test("topology add-device → inverse remove-device", () => {
    const p = enqueueTopologyAddDevice("r1", { ports: {} });
    assert.deepEqual(p.inverse, { group: "topology", op: "remove-device", name: "r1" });
  });

  test("topology remove-device → inverse add-device (body backfilled at apply)", () => {
    const p = enqueueTopologyRemoveDevice("r1");
    assert.deepEqual(p.inverse, { group: "topology", op: "add-device", name: "r1" });
  });

  test("topology add-link → inverse remove-link by the A endpoint", () => {
    const p = enqueueTopologyAddLink("r1:eth0", "r2:eth0");
    assert.deepEqual(p.inverse, { group: "topology", op: "remove-link", device: "r1", iface: "eth0" });
  });

  test("topology remove-link → inverse add-link (endpoints backfilled at apply)", () => {
    const p = enqueueTopologyRemoveLink("r1", "eth0");
    assert.deepEqual(p.inverse, { group: "topology", op: "add-link" });
  });

  test("interface apply-service → inverse remove-service", () => {
    const p = enqueueInterfaceAction("r1", "eth0", "apply-service", "Apply X", { service: "X" });
    assert.equal(p.inverse.actionId, "remove-service");
    assert.equal(p.inverse.group, "interface");
  });

  test("configure-interface trunk-add → inverse remove-trunk-vlan with vlan_id", () => {
    const p = enqueueInterfaceAction("r1", "eth0", "configure-interface", "Trunk +100", { tagged: true, vlan_id: 100 });
    assert.equal(p.inverse.actionId, "remove-trunk-vlan");
    assert.deepEqual(p.inverse.body, { vlan_id: 100 });
  });

  test("configure-interface access/routed → inverse unconfigure-interface", () => {
    const a = enqueueInterfaceAction("r1", "eth0", "configure-interface", "Access 100", { tagged: false, vlan_id: 100 });
    assert.equal(a.inverse.actionId, "unconfigure-interface");
    discardAll();
    const r = enqueueInterfaceAction("r1", "eth1", "configure-interface", "Routed", { vrf: "V", ip: "1.1.1.1/30" });
    assert.equal(r.inverse.actionId, "unconfigure-interface");
  });

  test("non-invertible action → no inverse (not undoable)", () => {
    const p = enqueueInterfaceAction("r1", "eth0", "configure-interface", "weird", {});
    assert.equal(p.inverse, undefined);
    discardAll();
    const d = enqueueDeviceAction("r1", "reboot", "Reboot", {});
    assert.equal(d.inverse, undefined);
  });
});

describe("enqueuePortConfig() — port edits fold into one whole-device update", () => {
  beforeEach(() => discardAll());

  const dev = () => ({ steps: [{ url: "/setup-device" }], ports: { Ethernet0: { mtu: 9100 } } });

  test("first edit stages an update-device with the merged body + restore inverse", () => {
    const p = enqueuePortConfig("switch1", "Ethernet4", { admin_status: "up" }, dev());
    const q = getQueue();
    assert.equal(q.length, 1);
    assert.equal(p.group, "topology");
    assert.equal(p.op, "update-device");
    assert.equal(p.name, "switch1");
    assert.deepEqual(p.body.ports, { Ethernet0: { mtu: 9100 }, Ethernet4: { admin_status: "up" } });
    assert.deepEqual(p.body.steps, [{ url: "/setup-device" }], "steps preserved in the PUT body");
    // Inverse restores the pre-edit device (full {steps, ports}).
    assert.equal(p.inverse.op, "update-device");
    assert.deepEqual(p.inverse.body.ports, { Ethernet0: { mtu: 9100 } });
  });

  test("a second port folds into the same update-device (no clobber)", () => {
    enqueuePortConfig("switch1", "Ethernet4", { admin_status: "up" }, dev());
    enqueuePortConfig("switch1", "Ethernet8", { admin_status: "down" }, dev());
    const q = getQueue();
    assert.equal(q.length, 1, "one update op for the device, not two");
    assert.deepEqual(Object.keys(q[0].body.ports).sort(), ["Ethernet0", "Ethernet4", "Ethernet8"]);
    // Earliest inverse stands — restores the original pre-edit device.
    assert.deepEqual(q[0].inverse.body.ports, { Ethernet0: { mtu: 9100 } });
  });

  test("editing a port on a still-pending new device folds into the add (one POST)", () => {
    enqueueTopologyAddDevice("spine1", { steps: [], ports: {} });
    enqueuePortConfig("spine1", "Ethernet0", { admin_status: "up" }, {});
    const q = getQueue();
    assert.equal(q.length, 1, "still a single add-device");
    assert.equal(q[0].op, "add-device");
    assert.deepEqual(q[0].body.ports, { Ethernet0: { admin_status: "up" } });
  });

  test("pendingPortConfigs surfaces staged ports (update + add paths)", () => {
    enqueuePortConfig("switch1", "Ethernet4", { admin_status: "up" }, dev());
    assert.deepEqual(pendingPortConfigs("switch1").Ethernet4, { admin_status: "up" });
    discardAll();
    enqueueTopologyAddDevice("spine1", { steps: [], ports: { Ethernet0: { mtu: 1500 } } });
    assert.deepEqual(pendingPortConfigs("spine1").Ethernet0, { mtu: 1500 });
  });

  test("deviceQueue includes the update-device op so the per-device panel sees it", () => {
    enqueuePortConfig("switch1", "Ethernet4", { admin_status: "up" }, dev());
    const dq = deviceQueue("switch1");
    assert.equal(dq.length, 1);
    assert.equal(dq[0].op, "update-device");
    assert.equal(deviceQueue("other").length, 0, "scoped to the target device");
  });
});
