// test/api/newtcon/config.test.js — unit tests for the /api/config client.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchConfig } from "../../../dist/api/newtcon/config.js";

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
  // _transport.ts dispatches auth:401 on document; provide a stub so
  // import doesn't crash even though config never returns 401.
  globalThis.document = { dispatchEvent: () => true };
});
afterEach(() => { globalThis.fetch = _origFetch; });

describe("fetchConfig()", () => {
  test("returns auth_required=false in playground mode", async () => {
    globalThis.fetch = async () => mockResponse(200, `{"auth_required":false}`);
    const cfg = await fetchConfig();
    assert.equal(cfg.auth_required, false);
  });

  test("returns auth_required=true when newtcon-server is in production mode", async () => {
    globalThis.fetch = async () => mockResponse(200, `{"auth_required":true}`);
    const cfg = await fetchConfig();
    assert.equal(cfg.auth_required, true);
  });

  test("sends cache: no-store so a stale posture never wedges the UI", async () => {
    let lastInit;
    globalThis.fetch = async (_url, init) => {
      lastInit = init;
      return mockResponse(200, `{"auth_required":false}`);
    };
    await fetchConfig();
    assert.equal(lastInit.cache, "no-store");
  });

  test("throws on non-2xx so the caller can render an honest error", async () => {
    globalThis.fetch = async () => mockResponse(500, `{"error":{"kind":"internal","message":"boom","details":{}}}`);
    await assert.rejects(fetchConfig(), (err) => err.status === 500);
  });
});
