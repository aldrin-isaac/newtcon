// required-when.test.js — evaluator + pretty-printer for newtron #243's
// structured required_when metadata.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRequiredWhen,
  formatRequiredWhen,
} from "../dist/required-when.js";

const SERVICE_FIELDS = [
  { name: "name", label: "Name", type: "string", required: true },
  {
    name: "service_type", label: "Service Type", type: "enum", required: true,
    enum: ["evpn-irb", "evpn-bridged", "evpn-routed", "irb", "bridged", "routed"],
  },
  { name: "ipvpn", label: "IP-VPN", type: "ref", required: false, ref_kind: "IPVPNSpec" },
  { name: "macvpn", label: "MAC-VPN", type: "ref", required: false, ref_kind: "MACVPNSpec" },
  { name: "arp_suppression", label: "ARP Suppression", type: "bool", required: false },
];

describe("evaluateRequiredWhen()", () => {
  test("null / undefined → false (no condition = not required)", () => {
    assert.equal(evaluateRequiredWhen(null, {}), false);
    assert.equal(evaluateRequiredWhen(undefined, {}), false);
  });

  test("atomic equals — string match", () => {
    const c = { field: "service_type", equals: "evpn-irb" };
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-irb" }), true);
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-routed" }), false);
  });

  test("atomic not_equals", () => {
    const c = { field: "service_type", not_equals: "irb" };
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-irb" }), true);
    assert.equal(evaluateRequiredWhen(c, { service_type: "irb" }), false);
  });

  test("atomic in — newtron's ServiceSpec.ipvpn example", () => {
    const c = { field: "service_type", in: ["evpn-irb", "evpn-routed"] };
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-irb" }), true);
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-routed" }), true);
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-bridged" }), false);
    assert.equal(evaluateRequiredWhen(c, { service_type: "irb" }), false);
  });

  test("atomic not_in", () => {
    const c = { field: "service_type", not_in: ["evpn-irb", "evpn-routed"] };
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-bridged" }), true);
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-irb" }), false);
  });

  test("unfilled sibling field — evaluates against zero value (false)", () => {
    // Semantic pin #3: required-ness can't trigger on unspecified state.
    const c = { field: "service_type", in: ["evpn-irb"] };
    assert.equal(evaluateRequiredWhen(c, {}), false); // service_type absent
    assert.equal(evaluateRequiredWhen(c, { service_type: "" }), false);
    assert.equal(evaluateRequiredWhen(c, { service_type: null }), false);
    assert.equal(evaluateRequiredWhen(c, { service_type: undefined }), false);
  });

  test("loose equality — number ↔ string coercion", () => {
    const c = { field: "vlan", equals: 100 };
    // Form values come back as strings from text/number inputs.
    assert.equal(evaluateRequiredWhen(c, { vlan: "100" }), true);
    assert.equal(evaluateRequiredWhen(c, { vlan: 100 }), true);
    assert.equal(evaluateRequiredWhen(c, { vlan: 200 }), false);
  });

  test("all_of — every child must be true", () => {
    const c = {
      all_of: [
        { field: "service_type", in: ["evpn-irb"] },
        { field: "arp_suppression", equals: false },
      ],
    };
    assert.equal(
      evaluateRequiredWhen(c, { service_type: "evpn-irb", arp_suppression: false }),
      true,
    );
    assert.equal(
      evaluateRequiredWhen(c, { service_type: "evpn-irb", arp_suppression: true }),
      false,
    );
    assert.equal(
      evaluateRequiredWhen(c, { service_type: "irb", arp_suppression: false }),
      false,
    );
  });

  test("any_of — any child true", () => {
    const c = {
      any_of: [
        { field: "service_type", equals: "evpn-irb" },
        { field: "service_type", equals: "evpn-routed" },
      ],
    };
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-irb" }), true);
    assert.equal(evaluateRequiredWhen(c, { service_type: "evpn-routed" }), true);
    assert.equal(evaluateRequiredWhen(c, { service_type: "irb" }), false);
  });

  test("nested combinators", () => {
    const c = {
      all_of: [
        { field: "service_type", in: ["evpn-irb", "evpn-routed"] },
        {
          any_of: [
            { field: "arp_suppression", equals: false },
            { field: "force_required", equals: true },
          ],
        },
      ],
    };
    assert.equal(
      evaluateRequiredWhen(c, { service_type: "evpn-irb", arp_suppression: false }),
      true,
    );
    assert.equal(
      evaluateRequiredWhen(c, { service_type: "evpn-irb", arp_suppression: true, force_required: true }),
      true,
    );
    assert.equal(
      evaluateRequiredWhen(c, { service_type: "evpn-irb", arp_suppression: true, force_required: false }),
      false,
    );
  });

  test("malformed conditions evaluate false (defensive — newtron validates at registration)", () => {
    assert.equal(evaluateRequiredWhen({ field: "x" }, { x: "y" }), false);
    assert.equal(evaluateRequiredWhen({ all_of: "not-array" }, {}), false);
    assert.equal(evaluateRequiredWhen({}, {}), false);
  });
});

describe("formatRequiredWhen()", () => {
  test("null / undefined → ''", () => {
    assert.equal(formatRequiredWhen(null, SERVICE_FIELDS), "");
    assert.equal(formatRequiredWhen(undefined, SERVICE_FIELDS), "");
  });

  test("uses sibling field's label, not wire name", () => {
    const c = { field: "service_type", equals: "evpn-irb" };
    const out = formatRequiredWhen(c, SERVICE_FIELDS);
    assert.equal(out, "Required when Service Type is evpn-irb.");
  });

  test("two-item in → 'X or Y'", () => {
    const c = { field: "service_type", in: ["evpn-irb", "evpn-routed"] };
    const out = formatRequiredWhen(c, SERVICE_FIELDS);
    assert.equal(out, "Required when Service Type is evpn-irb or evpn-routed.");
  });

  test("three-item in → Oxford-comma 'X, Y, or Z'", () => {
    const c = { field: "service_type", in: ["evpn-irb", "evpn-routed", "evpn-bridged"] };
    const out = formatRequiredWhen(c, SERVICE_FIELDS);
    assert.equal(out, "Required when Service Type is evpn-irb, evpn-routed, or evpn-bridged.");
  });

  test("not_equals → 'is not'", () => {
    const c = { field: "service_type", not_equals: "routed" };
    assert.equal(
      formatRequiredWhen(c, SERVICE_FIELDS),
      "Required when Service Type is not routed.",
    );
  });

  test("not_in → 'is none of'", () => {
    const c = { field: "service_type", not_in: ["irb", "bridged"] };
    assert.equal(
      formatRequiredWhen(c, SERVICE_FIELDS),
      "Required when Service Type is none of irb or bridged.",
    );
  });

  test("all_of — clauses joined with 'and'", () => {
    const c = {
      all_of: [
        { field: "service_type", in: ["evpn-irb"] },
        { field: "arp_suppression", equals: false },
      ],
    };
    assert.equal(
      formatRequiredWhen(c, SERVICE_FIELDS),
      "Required when Service Type is evpn-irb and ARP Suppression is false.",
    );
  });

  test("any_of — clauses joined with 'or'", () => {
    const c = {
      any_of: [
        { field: "service_type", equals: "evpn-irb" },
        { field: "service_type", equals: "evpn-routed" },
      ],
    };
    assert.equal(
      formatRequiredWhen(c, SERVICE_FIELDS),
      "Required when Service Type is evpn-irb or Service Type is evpn-routed.",
    );
  });

  test("falls back to wire name when sibling not found", () => {
    const c = { field: "unknown_field", equals: "foo" };
    assert.equal(
      formatRequiredWhen(c, SERVICE_FIELDS),
      "Required when unknown_field is foo.",
    );
  });
});
