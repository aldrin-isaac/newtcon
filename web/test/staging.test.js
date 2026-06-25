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
  pendingSubMutations,
  isSpecPendingUpdate,
  getQueue,
  discardAll,
} from "../dist/staging.js";

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
