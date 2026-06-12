// test/api/newtcon/auth.test.js — unit tests for the /api/auth/* client.
//
// Tests run under Node.js's built-in node:test module (web/README.md §Test runner).
// The module under test is imported from dist/ (compiled output of src/).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  login,
  logout,
  whoami,
} from "../../../dist/api/newtcon/auth.js";
import { ApiError } from "../../../dist/api/newtcon/services.js";

// ---- helpers -------------------------------------------------------------

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async json() {
      return JSON.parse(body);
    },
  };
}

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  globalThis.fetch._calls = () => calls;
}

let _origFetch;
let _origDispatch;
let _dispatched;

beforeEach(() => {
  _origFetch = globalThis.fetch;
  _dispatched = [];
  // _transport.ts dispatches auth:401 on document. Mock document to capture.
  globalThis.document = {
    dispatchEvent: (ev) => { _dispatched.push(ev.type ?? ev); return true; },
  };
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  // Leave document set on the global; node:test isolates module state per file.
});

// ---- whoami() ------------------------------------------------------------

describe("whoami()", () => {
  test("returns the response on 200", async () => {
    stubFetch(mockResponse(200, `{"user":"alice","expires_at":"2026-06-11T20:00:00Z"}`));
    const me = await whoami();
    assert.equal(me?.user, "alice");
    assert.equal(me?.expires_at, "2026-06-11T20:00:00Z");
  });

  test("returns null on 401 (no session)", async () => {
    stubFetch(mockResponse(401, `{"error":{"kind":"authentication_failure","message":"no session","details":{}}}`));
    const me = await whoami();
    assert.equal(me, null);
  });

  test("suppresses the global auth:401 event", async () => {
    stubFetch(mockResponse(401, `{"error":{"kind":"authentication_failure","message":"no session","details":{}}}`));
    await whoami();
    assert.equal(_dispatched.includes("auth:401"), false,
      "whoami's 401 must not propagate as a global event");
  });

  test("throws on non-401 unexpected status", async () => {
    stubFetch(mockResponse(500, `{"error":{"kind":"internal","message":"oops","details":{}}}`));
    await assert.rejects(whoami(), (err) => err instanceof ApiError && err.status === 500);
  });

  test("sends cache: no-store", async () => {
    stubFetch(mockResponse(200, `{"user":"u","expires_at":"2026-06-11T20:00:00Z"}`));
    await whoami();
    const init = globalThis.fetch._calls()[0].init;
    assert.equal(init.cache, "no-store");
  });
});

// ---- login() -------------------------------------------------------------

describe("login()", () => {
  test("POSTs JSON body and returns the response on 200", async () => {
    stubFetch(mockResponse(200, `{"user":"alice","expires_at":"2026-06-11T20:00:00Z"}`));
    const me = await login("alice", "hunter2");
    assert.equal(me.user, "alice");

    const call = globalThis.fetch._calls()[0];
    assert.equal(call.url, "/api/auth/login");
    assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(call.init.body), { username: "alice", password: "hunter2" });
    assert.equal(call.init.headers["Content-Type"], "application/json");
  });

  test("throws ApiError(401) on bad creds", async () => {
    stubFetch(mockResponse(401, `{"error":{"kind":"authentication_failure","message":"authentication failed","details":{}}}`));
    await assert.rejects(login("alice", "wrong"),
      (err) => err instanceof ApiError && err.status === 401 && err.kind === "authentication_failure");
  });

  test("suppresses the global auth:401 event on bad creds", async () => {
    stubFetch(mockResponse(401, `{"error":{"kind":"authentication_failure","message":"bad","details":{}}}`));
    try { await login("a", "w"); } catch { /* expected */ }
    assert.equal(_dispatched.includes("auth:401"), false,
      "login's 401 must surface inline; the global event is for mid-session expiry");
  });

  test("throws ApiError(404) when L2c is disabled upstream", async () => {
    stubFetch(mockResponse(404, `{"error":{"kind":"precondition_failure","message":"L2c disabled","details":{}}}`));
    await assert.rejects(login("a", "b"),
      (err) => err instanceof ApiError && err.status === 404);
  });
});

// ---- logout() ------------------------------------------------------------

describe("logout()", () => {
  test("POSTs and resolves on 204", async () => {
    stubFetch(mockResponse(204, `{}`));
    await logout(); // must not throw
    const call = globalThis.fetch._calls()[0];
    assert.equal(call.url, "/api/auth/logout");
    assert.equal(call.init.method, "POST");
  });
});
