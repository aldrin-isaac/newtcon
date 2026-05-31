// test/api/newtcon/nodes.test.js — unit tests for the node/topology API client.
//
// Tests run under Node.js's built-in node:test module (web/README.md §Test runner).
// Imports compiled output from dist/; scenarios cover the shared fetchNodeRaw
// helper path (success, ApiError, network error, cache: "no-store") through the
// exported entry points.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchTopology,
  fetchNodeInfo,
  fetchNodeConfigDBEntry,
  postTopologyDevice,
  deleteTopologyDevice,
  postTopologyLink,
  deleteTopologyLink,
  postBindService,
  postUnbindService,
  postRefreshService,
} from "../../../dist/api/newtcon/nodes.js";

import { ApiError } from "../../../dist/api/newtcon/services.js";

// ---- helpers ----------------------------------------------------------------

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_) => "application/json" },
    async json() {
      return JSON.parse(body);
    },
  };
}

function stubFetch(response) {
  let _lastUrl;
  let _lastInit;
  globalThis.fetch = async (url, init) => {
    _lastUrl = url;
    _lastInit = init;
    return response;
  };
  globalThis.fetch._lastUrl = () => _lastUrl;
  globalThis.fetch._lastInit = () => _lastInit;
}

function stubFetchNetworkError(err) {
  globalThis.fetch = async () => {
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

// ---- fetchTopology ----------------------------------------------------------

describe("fetchTopology()", () => {
  test("returns parsed data on 200", async () => {
    const payload = { nodes: [{ name: "switch1", type: "switch" }], links: [] };
    stubFetch(mockResponse(200, JSON.stringify(payload)));

    const result = await fetchTopology();

    assert.deepEqual(result, payload);
  });

  test("calls /api/topology", async () => {
    stubFetch(mockResponse(200, JSON.stringify({})));
    await fetchTopology();
    assert.equal(globalThis.fetch._lastUrl(), "/api/topology");
  });

  test("passes cache: 'no-store'", async () => {
    stubFetch(mockResponse(200, JSON.stringify({})));
    await fetchTopology();
    assert.equal(globalThis.fetch._lastInit()?.cache, "no-store");
  });

  test("throws ApiError on 503 newtron_unavailable", async () => {
    const envelope = {
      error: {
        kind: "newtron_unavailable",
        message: "unreachable",
        details: { correlation_id: "x" },
      },
    };
    stubFetch(mockResponse(503, JSON.stringify(envelope)));

    await assert.rejects(
      () => fetchTopology(),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.kind, "newtron_unavailable");
        return true;
      }
    );
  });

  test("throws plain Error on network failure", async () => {
    stubFetchNetworkError(new TypeError("Failed to fetch"));

    await assert.rejects(
      () => fetchTopology(),
      (err) => {
        assert.ok(!(err instanceof ApiError));
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("network error"));
        return true;
      }
    );
  });
});

// ---- fetchNodeInfo ----------------------------------------------------------

describe("fetchNodeInfo()", () => {
  test("calls /api/nodes/{device}/info", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ hostname: "switch1" })));
    await fetchNodeInfo("switch1");
    assert.equal(globalThis.fetch._lastUrl(), "/api/nodes/switch1/info");
  });

  test("URL-encodes device name with special chars", async () => {
    stubFetch(mockResponse(200, JSON.stringify({})));
    await fetchNodeInfo("my device");
    assert.equal(globalThis.fetch._lastUrl(), "/api/nodes/my%20device/info");
  });

  test("throws ApiError on 404", async () => {
    const envelope = {
      error: { kind: "internal", message: "not found", details: {} },
    };
    stubFetch(mockResponse(404, JSON.stringify(envelope)));

    await assert.rejects(
      () => fetchNodeInfo("nodevice"),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      }
    );
  });
});

// ---- fetchNodeConfigDBEntry -------------------------------------------------

describe("fetchNodeConfigDBEntry()", () => {
  test("calls the correct 3-segment URL", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ speed: "100G" })));
    await fetchNodeConfigDBEntry("switch1", "PORT", "Ethernet0");
    assert.equal(
      globalThis.fetch._lastUrl(),
      "/api/nodes/switch1/configdb/PORT/Ethernet0"
    );
  });

  test("URL-encodes table and key", async () => {
    stubFetch(mockResponse(200, JSON.stringify({})));
    await fetchNodeConfigDBEntry("sw", "MY TABLE", "key/with/slash");
    assert.equal(
      globalThis.fetch._lastUrl(),
      "/api/nodes/sw/configdb/MY%20TABLE/key%2Fwith%2Fslash"
    );
  });
});

// ---- postTopologyDevice ------------------------------------------------------

describe("postTopologyDevice()", () => {
  test("POSTs to /api/topology/nodes with JSON body", async () => {
    stubFetch(mockResponse(201, JSON.stringify({ steps: [], ports: {} })));
    const body = { name: "spine1", device: { steps: [], ports: {} } };
    await postTopologyDevice(body);
    assert.equal(globalThis.fetch._lastUrl(), "/api/topology/nodes");
    assert.equal(globalThis.fetch._lastInit()?.method, "POST");
    assert.equal(globalThis.fetch._lastInit()?.headers?.["Content-Type"], "application/json");
  });

  test("throws ApiError on 400 validation_failure", async () => {
    const envelope = {
      error: { kind: "validation_failure", message: "name required", details: {} },
    };
    stubFetch(mockResponse(400, JSON.stringify(envelope)));
    await assert.rejects(
      () => postTopologyDevice({}),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.kind, "validation_failure");
        return true;
      }
    );
  });
});

// ---- deleteTopologyDevice ----------------------------------------------------

describe("deleteTopologyDevice()", () => {
  test("DELETEs /api/topology/nodes/{name}", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ deleted: "spine1" })));
    await deleteTopologyDevice("spine1");
    assert.equal(globalThis.fetch._lastUrl(), "/api/topology/nodes/spine1");
    assert.equal(globalThis.fetch._lastInit()?.method, "DELETE");
  });

  test("appends ?force=true when force=true", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ deleted: "spine1" })));
    await deleteTopologyDevice("spine1", true);
    assert.equal(globalThis.fetch._lastUrl(), "/api/topology/nodes/spine1?force=true");
  });
});

// ---- postTopologyLink --------------------------------------------------------

describe("postTopologyLink()", () => {
  test("POSTs to /api/topology/links with {a,z} body", async () => {
    stubFetch(mockResponse(201, JSON.stringify({ a: "spine1:Ethernet0", z: "leaf1:Ethernet0" })));
    await postTopologyLink({ a: "spine1:Ethernet0", z: "leaf1:Ethernet0" });
    assert.equal(globalThis.fetch._lastUrl(), "/api/topology/links");
    assert.equal(globalThis.fetch._lastInit()?.method, "POST");
    const sent = JSON.parse(globalThis.fetch._lastInit()?.body);
    assert.equal(sent.a, "spine1:Ethernet0");
    assert.equal(sent.z, "leaf1:Ethernet0");
  });
});

// ---- deleteTopologyLink ------------------------------------------------------

describe("deleteTopologyLink()", () => {
  test("DELETEs /api/topology/links/{device}/{interface}", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ deleted: "spine1:Ethernet0" })));
    await deleteTopologyLink("spine1", "Ethernet0");
    assert.equal(globalThis.fetch._lastUrl(), "/api/topology/links/spine1/Ethernet0");
    assert.equal(globalThis.fetch._lastInit()?.method, "DELETE");
  });

  test("encodes slash in interface name as %2F", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ deleted: "sw:Eth0/1" })));
    await deleteTopologyLink("sw", "Eth0/1");
    assert.equal(globalThis.fetch._lastUrl(), "/api/topology/links/sw/Eth0%2F1");
  });
});

// ---- postBindService ---------------------------------------------------------

describe("postBindService()", () => {
  test("POSTs to the bind-service URL with body", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ status: "ok" })));
    await postBindService("switch1", "Ethernet0", { service: "transit", vlan: 100 });
    assert.equal(
      globalThis.fetch._lastUrl(),
      "/api/nodes/switch1/interfaces/Ethernet0/bind-service"
    );
    assert.equal(globalThis.fetch._lastInit()?.method, "POST");
  });

  test("encodes slash in interface name as %2F", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ status: "ok" })));
    await postBindService("sw", "Eth0/1", { service: "transit" });
    assert.equal(
      globalThis.fetch._lastUrl(),
      "/api/nodes/sw/interfaces/Eth0%2F1/bind-service"
    );
  });
});

// ---- postUnbindService -------------------------------------------------------

describe("postUnbindService()", () => {
  test("POSTs to the unbind-service URL (no body)", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ status: "ok" })));
    await postUnbindService("switch1", "Ethernet0");
    assert.equal(
      globalThis.fetch._lastUrl(),
      "/api/nodes/switch1/interfaces/Ethernet0/unbind-service"
    );
    assert.equal(globalThis.fetch._lastInit()?.method, "POST");
  });
});

// ---- postRefreshService ------------------------------------------------------

describe("postRefreshService()", () => {
  test("POSTs to the refresh-service URL (no body)", async () => {
    stubFetch(mockResponse(200, JSON.stringify({ status: "ok" })));
    await postRefreshService("switch1", "Ethernet0");
    assert.equal(
      globalThis.fetch._lastUrl(),
      "/api/nodes/switch1/interfaces/Ethernet0/refresh-service"
    );
    assert.equal(globalThis.fetch._lastInit()?.method, "POST");
  });
});
