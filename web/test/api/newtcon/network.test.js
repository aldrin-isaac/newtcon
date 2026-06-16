// test/api/newtcon/network.test.js — unit tests for network.ts write helpers.
// Focused on the updateSpec client added with the in-place edit slice;
// createSpec / deleteSpec / addSubRule share the same apiSend pathway and
// are exercised end-to-end by the puppeteer smokes.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { updateSpec } from "../../../dist/api/newtcon/network.js";

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
});
afterEach(() => { globalThis.fetch = _origFetch; });

describe("updateSpec()", () => {
  test("sends PUT with JSON body to /api/networks/{network}/{kind}/{name}", async () => {
    let lastUrl, lastInit;
    globalThis.fetch = async (url, init) => {
      lastUrl = url; lastInit = init;
      return mockResponse(200, `{"name":"transit"}`);
    };
    await updateSpec("services", "transit", { type: "routed", description: "updated" }, "1node-vs-auth");
    assert.equal(lastUrl, "/api/networks/1node-vs-auth/services/transit");
    assert.equal(lastInit.method, "PUT");
    assert.equal(lastInit.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(lastInit.body), { type: "routed", description: "updated" });
  });

  test("URL-encodes the name path-param so spec names with special chars round-trip", async () => {
    let lastUrl;
    globalThis.fetch = async (url) => {
      lastUrl = url;
      return mockResponse(200, `{"name":"x/y"}`);
    };
    await updateSpec("services", "spec with space", { description: "x" }, "default");
    assert.match(lastUrl, /spec%20with%20space/);
  });

  test("returns the decoded JSON on success", async () => {
    globalThis.fetch = async () => mockResponse(200, `{"data":{"name":"foo"}}`);
    const result = await updateSpec("services", "foo", { description: "x" });
    assert.deepEqual(result, { data: { name: "foo" } });
  });

  test("throws on non-2xx so the form can surface the error inline", async () => {
    globalThis.fetch = async () => mockResponse(400,
      `{"error":{"kind":"validation_failure","message":"bad","details":{}}}`);
    await assert.rejects(updateSpec("services", "foo", {}), (err) => err.status === 400);
  });
});
