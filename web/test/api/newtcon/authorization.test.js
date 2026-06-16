// test/api/newtcon/authorization.test.js — unit tests for the
// /api/networks/{netID}/authorization client.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchAuthorization } from "../../../dist/api/newtcon/authorization.js";

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async json() { return JSON.parse(body); },
  };
}

let _origFetch;
beforeEach(() => {
  _origFetch = globalThis.fetch;
  globalThis.document = { dispatchEvent: () => true };
  // The apiPath helper reads localStorage; stub a minimal one for the
  // no-network call so it picks "default" silently.
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
});
afterEach(() => { globalThis.fetch = _origFetch; });

describe("fetchAuthorization()", () => {
  test("decodes the AuthorizationDetail shape verbatim", async () => {
    const payload = {
      super_users: ["root"],
      user_groups: { netops: ["alice", "bob"] },
      permissions: {
        "create-vlan": ["netops"],
        "spec.author": { allow: ["netops"], where: { service: "svc-a" } },
      },
    };
    globalThis.fetch = async () => mockResponse(200, JSON.stringify(payload));
    const got = await fetchAuthorization("default");
    assert.deepEqual(got.super_users, ["root"]);
    assert.deepEqual(got.user_groups, { netops: ["alice", "bob"] });
    assert.deepEqual(got.permissions["create-vlan"], ["netops"]);
    assert.deepEqual(got.permissions["spec.author"], {
      allow: ["netops"],
      where: { service: "svc-a" },
    });
  });

  test("targets the network-scoped URL when a network is supplied", async () => {
    let lastUrl;
    globalThis.fetch = async (url) => {
      lastUrl = url;
      return mockResponse(200, `{"super_users":[],"user_groups":{},"permissions":{}}`);
    };
    await fetchAuthorization("1node-vs-auth");
    assert.equal(lastUrl, "/api/networks/1node-vs-auth/authorization");
  });

  test("sends cache: no-store so stale grants never wedge the inspector", async () => {
    let lastInit;
    globalThis.fetch = async (_url, init) => {
      lastInit = init;
      return mockResponse(200, `{"super_users":[],"user_groups":{},"permissions":{}}`);
    };
    await fetchAuthorization("default");
    assert.equal(lastInit.cache, "no-store");
  });

  test("throws on 404 so the renderer surfaces it instead of silently rendering empty", async () => {
    globalThis.fetch = async () => mockResponse(404,
      `{"error":{"kind":"precondition_failure","message":"network not found","details":{}}}`);
    await assert.rejects(fetchAuthorization("no-such"), (err) => err.status === 404);
  });
});
