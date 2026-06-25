// staging.test.js — queue semantics for spec edits (enqueueSpecUpdate) and
// their interaction with pending creates/deletes. Pure queue ops; no DOM,
// no network (apply isn't exercised here).

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  enqueueSpecCreate,
  enqueueSpecUpdate,
  enqueueSpecDelete,
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
    assert.equal(q[0].group, "spec");
    assert.equal(q[0].op, "update");
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
    assert.equal(q[0].op, "create");
    assert.equal(q[0].body.l3vni, 9, "edit applied to the create body");
    assert.equal(q[0].body.scope, "zone", "create-only fields (scope) preserved");
  });

  test("deleting a spec drops a pending edit of it", () => {
    enqueueSpecUpdate("ipvpns", "IRB", { l3vni: 1 });
    enqueueSpecDelete("ipvpns", "IRB");
    const q = getQueue();
    assert.equal(q.length, 1, "the update is gone, only the delete remains");
    assert.equal(q[0].op, "delete");
    assert.equal(isSpecPendingUpdate("ipvpns", "IRB"), false);
  });

  test("edits to different specs queue independently", () => {
    enqueueSpecUpdate("ipvpns", "A", { l3vni: 1 });
    enqueueSpecUpdate("ipvpns", "B", { l3vni: 2 });
    assert.equal(getQueue().length, 2);
  });
});
