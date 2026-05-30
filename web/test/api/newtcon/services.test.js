// test/api/newtcon/services.test.js — unit tests for the fetchServices() client.
//
// Tests run under Node.js's built-in node:test module (web/README.md §Test runner).
// The module under test is imported from dist/ (compiled output of src/).
//
// Scenarios covered:
//   1. Success path — 200 response, correct ServiceListResponse decoding.
//   2. ApiError path — non-200 response with a structured error envelope.
//   3. Network failure — fetch() rejects; plain Error is thrown.
//   4. cache: "no-store" — verifies the no-cache discipline (newtcon#105 D8).
//
// fetch() is shimmed via globalThis.fetch before each test and restored after.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Import from dist/ — tests import compiled output per web/README.md.
import {
  fetchServices,
  ApiError,
} from "../../../dist/api/newtcon/services.js";

// ---- helpers -------------------------------------------------------------

/** Build a minimal Response-like object that mimics the Fetch API. */
function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(body);
    },
  };
}

/** Install a fetch stub that returns the given response, capturing call args. */
function stubFetch(response) {
  let _lastUrl;
  let _lastInit;
  globalThis.fetch = async (url, init) => {
    _lastUrl = url;
    _lastInit = init;
    return response;
  };
  // Expose call args for assertion.
  globalThis.fetch._lastUrl = () => _lastUrl;
  globalThis.fetch._lastInit = () => _lastInit;
}

/** Stub fetch to reject with the given error. */
function stubFetchNetworkError(err) {
  globalThis.fetch = async (_url) => {
    throw err;
  };
}

let _origFetch;

beforeEach(() => {
  _origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = _origFetch;
});

// ---- tests ---------------------------------------------------------------

describe("fetchServices()", () => {
  test("decodes a 200 response into ServiceListResponse", async () => {
    const payload = {
      services: [
        {
          name: "core-l3",
          type: "routed",
          instance_count: 0,
          health: { healthy: 0, degraded: 0, failed: 0 },
          last_modified: "0001-01-01T00:00:00Z",
        },
        {
          name: "edge-irb",
          type: "irb",
          instance_count: 0,
          health: { healthy: 0, degraded: 0, failed: 0 },
          last_modified: "0001-01-01T00:00:00Z",
        },
      ],
    };
    stubFetch(mockResponse(200, JSON.stringify(payload)));

    const result = await fetchServices();

    assert.equal(result.services.length, 2);
    assert.equal(result.services[0].name, "core-l3");
    assert.equal(result.services[0].type, "routed");
    assert.equal(result.services[1].name, "edge-irb");
    assert.equal(result.services[1].type, "irb");
    // Zero-valued aggregates are present in the decoded shape.
    assert.equal(result.services[0].instance_count, 0);
    assert.deepEqual(result.services[0].health, {
      healthy: 0,
      degraded: 0,
      failed: 0,
    });
  });

  test("decodes an empty services list without error", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ services: [] })));

    const result = await fetchServices();

    assert.equal(result.services.length, 0);
  });

  test("throws ApiError on 503 newtron_unavailable", async () => {
    const envelope = {
      error: {
        kind: "newtron_unavailable",
        message: "newtron-server unreachable during listing services: connection refused",
        details: {
          underlying_error: "connection_refused",
          correlation_id: "test-correlation-id",
        },
      },
    };
    stubFetch(mockResponse(503, JSON.stringify(envelope)));

    await assert.rejects(
      () => fetchServices(),
      (err) => {
        assert.ok(err instanceof ApiError, "should be ApiError");
        assert.equal(err.kind, "newtron_unavailable");
        assert.equal(err.status, 503);
        assert.ok(
          err.message.includes("newtron-server unreachable"),
          "message should be from envelope"
        );
        return true;
      }
    );
  });

  test("throws ApiError on 500 internal error", async () => {
    const envelope = {
      error: {
        kind: "internal",
        message: "unexpected error",
        details: { correlation_id: "abc123" },
      },
    };
    stubFetch(mockResponse(500, JSON.stringify(envelope)));

    await assert.rejects(
      () => fetchServices(),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.kind, "internal");
        assert.equal(err.status, 500);
        return true;
      }
    );
  });

  test("throws plain Error on network failure (fetch rejects)", async () => {
    stubFetchNetworkError(new TypeError("Failed to fetch"));

    await assert.rejects(
      () => fetchServices(),
      (err) => {
        assert.ok(!(err instanceof ApiError), "should NOT be ApiError");
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("network error"),
          "message should mention network error"
        );
        return true;
      }
    );
  });

  test("throws plain Error on non-JSON error response body", async () => {
    // Non-2xx with an HTML body (e.g., a proxy error page).
    const badResponse = {
      ok: false,
      status: 502,
      async json() {
        throw new SyntaxError("Unexpected token");
      },
    };
    stubFetch(badResponse);

    await assert.rejects(
      () => fetchServices(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("502"),
          "message should include status code"
        );
        return true;
      }
    );
  });

  test("passes cache: 'no-store' to fetch (D8 — no client-side caching)", async () => {
    const payload = { services: [] };
    stubFetch(mockResponse(200, JSON.stringify(payload)));

    await fetchServices();

    const init = globalThis.fetch._lastInit();
    assert.ok(
      init !== undefined && init !== null,
      "fetch should be called with an init object"
    );
    assert.equal(
      init.cache,
      "no-store",
      "fetch init.cache must be 'no-store' to prevent stale service lists"
    );
  });
});
