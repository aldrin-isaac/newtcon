// test/render-error.test.js — unit tests for the shared error-rendering helpers.
//
// Covers:
//   - translateErrorKind for every known kind + unknown fallback
//   - formatAuthorizationDetails happy path / missing fields / wrong types
//   - formatErrorBrief for ApiError(authorization_failure) with full details,
//     ApiError(authorization_failure) without details (server-message fallback),
//     other ApiError kinds, plain Error, unknown thrown values

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  translateErrorKind,
  formatAuthorizationDetails,
  formatConflictDetails,
  formatErrorBrief,
} from "../dist/render-error.js";
import { ApiError } from "../dist/api/newtcon/services.js";

describe("formatConflictDetails() — referential-integrity 409 (#319)", () => {
  test("lists referencing endpoints + force hint", () => {
    assert.equal(
      formatConflictDetails({ references: ["switch1:Ethernet0", "switch2:Ethernet0"], force_available: true }),
      "still in use on switch1:Ethernet0, switch2:Ethernet0 — force delete to also remove them",
    );
  });
  test("no force hint when force unavailable; truncates long lists", () => {
    const refs = Array.from({ length: 8 }, (_, i) => `sw:Eth${i}`);
    assert.equal(formatConflictDetails({ references: refs, force_available: false }),
      "still in use on sw:Eth0, sw:Eth1, sw:Eth2, sw:Eth3, sw:Eth4, sw:Eth5, +2 more");
  });
  test("null when there are no structured references (plain drift)", () => {
    assert.equal(formatConflictDetails({}), null);
    assert.equal(formatConflictDetails({ references: [] }), null);
  });
});

describe("formatErrorBrief() — drift_refusal with references", () => {
  test("uses the conflict phrase, not the 'drift detected' label", () => {
    const e = new ApiError(409, { error: { kind: "drift_refusal", message: "x: conflict", details: { references: ["switch1:Ethernet0"], force_available: true } } });
    const s = formatErrorBrief(e);
    assert.match(s, /still in use on switch1:Ethernet0/);
    assert.doesNotMatch(s, /drift detected/);
  });
});

describe("translateErrorKind()", () => {
  test("known kinds map to operator-readable text", () => {
    // Operator taxonomy (uplift 2.2): headlines carry triage meaning —
    // refused / not ready / not permitted / unreachable — never plumbing words.
    assert.equal(translateErrorKind("validation_failure"), "invalid input");
    assert.equal(translateErrorKind("precondition_failure"), "not ready — refused by a precondition");
    assert.equal(translateErrorKind("drift_refusal"), "refused — conflicts with device state");
    assert.equal(translateErrorKind("authorization_failure"), "not permitted");
    assert.equal(translateErrorKind("authentication_failure"), "not signed in");
    assert.equal(translateErrorKind("newtron_unavailable"), "engine unreachable");
    assert.equal(translateErrorKind("internal"), "engine error");
  });

  test("unknown kind falls back to snake-case humanised", () => {
    assert.equal(translateErrorKind("some_future_kind"), "some future kind");
  });
});

describe("formatAuthorizationDetails()", () => {
  test("returns 'caller lacks permission on resource' with full triplet", () => {
    const s = formatAuthorizationDetails({
      caller: "alice",
      permission: "spec.author",
      resource: "svc-b",
    });
    assert.equal(s, "alice lacks spec.author on svc-b");
  });

  test("omits 'on resource' when resource is absent", () => {
    const s = formatAuthorizationDetails({ caller: "alice", permission: "global.admin" });
    assert.equal(s, "alice lacks global.admin");
  });

  test("returns null when caller is missing", () => {
    const s = formatAuthorizationDetails({ permission: "spec.author", resource: "svc-b" });
    assert.equal(s, null);
  });

  test("returns null when permission is missing", () => {
    const s = formatAuthorizationDetails({ caller: "alice", resource: "svc-b" });
    assert.equal(s, null);
  });

  test("ignores wrong-typed fields", () => {
    const s = formatAuthorizationDetails({ caller: 7, permission: "x" });
    assert.equal(s, null);
  });
});

describe("formatErrorBrief()", () => {
  test("authorization_failure with full details renders structured form", () => {
    const err = new ApiError(403, {
      error: {
        kind: "authorization_failure",
        message: "POST /api/networks/x/create-service: authorization denied: alice lacks spec.author on svc-b",
        details: { caller: "alice", permission: "spec.author", resource: "svc-b" },
      },
    });
    assert.equal(formatErrorBrief(err), "not permitted: alice lacks spec.author on svc-b");
  });

  test("authorization_failure without typed details falls back to server message", () => {
    const err = new ApiError(403, {
      error: {
        kind: "authorization_failure",
        message: "some bare 403 from the substrate",
        details: {},
      },
    });
    assert.equal(formatErrorBrief(err), "not permitted: some bare 403 from the substrate");
  });

  test("validation_failure renders translated kind + server message", () => {
    const err = new ApiError(400, {
      error: { kind: "validation_failure", message: "spec name required", details: {} },
    });
    assert.equal(formatErrorBrief(err), "invalid input: spec name required");
  });

  test("authentication_failure renders translated kind + server message", () => {
    const err = new ApiError(401, {
      error: { kind: "authentication_failure", message: "session expired", details: {} },
    });
    assert.equal(formatErrorBrief(err), "not signed in: session expired");
  });

  test("surfaces underlying_error_message (referential 409) over the generic envelope", () => {
    // newtron #285 referenced-spec delete → 409 with the referrers in the
    // underlying message (JSON-wrapped). We unwrap + show them.
    const err = new ApiError(409, {
      error: {
        kind: "drift_refusal",
        message: "DELETE /api/networks/n/ipvpns/IRB: conflict",
        details: { underlying_error_message: '{"error":"IPVPNSpec \'IRB\' has 2 references: ServiceSpec \'OVERLAY_IRB_A\' (ipvpn), ServiceSpec \'OVERLAY_IRB_B\' (ipvpn)"}\n' },
      },
    });
    assert.equal(formatErrorBrief(err),
      "refused — conflicts with device state: IPVPNSpec 'IRB' has 2 references: ServiceSpec 'OVERLAY_IRB_A' (ipvpn), ServiceSpec 'OVERLAY_IRB_B' (ipvpn)");
  });

  test("surfaces underlying unresolved-references (forward 400) over the generic envelope", () => {
    const err = new ApiError(400, {
      error: {
        kind: "validation_failure",
        message: "POST /api/networks/n/services: validation failed",
        details: { underlying_error_message: '{"error":"unresolved references: ipvpn references IPVPNSpec \'GHOST\' which does not exist"}\n' },
      },
    });
    assert.equal(formatErrorBrief(err),
      "invalid input: unresolved references: ipvpn references IPVPNSpec 'GHOST' which does not exist");
  });

  test("falls back to envelope message when no underlying (or non-JSON underlying surfaced raw)", () => {
    // no underlying → envelope message (unchanged behavior)
    const a = new ApiError(400, { error: { kind: "validation_failure", message: "spec name required", details: {} } });
    assert.equal(formatErrorBrief(a), "invalid input: spec name required");
    // non-JSON underlying → surfaced raw
    const b = new ApiError(503, { error: { kind: "newtron_unavailable", message: "x", details: { underlying_error_message: "dial tcp: connection refused" } } });
    assert.equal(formatErrorBrief(b), "engine unreachable: dial tcp: connection refused");
  });

  test("plain Error returns its message", () => {
    assert.equal(formatErrorBrief(new Error("boom")), "boom");
  });

  test("unknown thrown value stringifies", () => {
    assert.equal(formatErrorBrief("string thrown directly"), "string thrown directly");
    assert.equal(formatErrorBrief(42), "42");
  });
});
