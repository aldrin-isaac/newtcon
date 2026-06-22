// service-references.test.js — reverse index: which services reference a
// given resource, via which field (pure logic).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deriveServiceReferences } from "../dist/service-references.js";

const SERVICES = [
  { name: "OVERLAY_IRB_A", detail: { ipvpn: "IRB", macvpn: "IRB_VLAN400" } },
  { name: "OVERLAY_IRB_B", detail: { ipvpn: "IRB", macvpn: "IRB_VLAN401" } },
  { name: "LOCAL_BRIDGE", detail: { ipvpn: null, macvpn: "BRIDGE_VLAN200" } },
  { name: "EDGE", detail: {
      ingress_filter: "DROP_BOGONS", egress_filter: "DROP_BOGONS",
      qos_policy: "GOLD",
      routing: { import_policy: "IMP", export_policy: "EXP", import_prefix_list: "PL1" },
  } },
];

const IPVPN_FIELDS = [{ path: ["ipvpn"], label: "IP-VPN" }];
const FILTER_FIELDS = [
  { path: ["ingress_filter"], label: "Ingress Filter" },
  { path: ["egress_filter"], label: "Egress Filter" },
];
const RP_FIELDS = [
  { path: ["routing", "import_policy"], label: "Import Policy" },
  { path: ["routing", "export_policy"], label: "Export Policy" },
];

describe("deriveServiceReferences()", () => {
  test("finds services referencing an IP-VPN (exact spec-name match)", () => {
    const r = deriveServiceReferences(SERVICES, IPVPN_FIELDS, "IRB");
    assert.deepEqual(r.map((x) => x.service), ["OVERLAY_IRB_A", "OVERLAY_IRB_B"]);
    assert.deepEqual(r[0].via, ["IP-VPN"]);
  });

  test("a service referencing via two fields lists both (ingress+egress filter)", () => {
    const r = deriveServiceReferences(SERVICES, FILTER_FIELDS, "DROP_BOGONS");
    assert.equal(r.length, 1);
    assert.equal(r[0].service, "EDGE");
    assert.deepEqual(r[0].via, ["Ingress Filter", "Egress Filter"]);
  });

  test("reads nested routing refs (import/export policy)", () => {
    assert.deepEqual(deriveServiceReferences(SERVICES, RP_FIELDS, "IMP").map((x) => x.service), ["EDGE"]);
    assert.deepEqual(deriveServiceReferences(SERVICES, RP_FIELDS, "EXP")[0].via, ["Export Policy"]);
  });

  test("unreferenced resource → empty", () => {
    assert.deepEqual(deriveServiceReferences(SERVICES, IPVPN_FIELDS, "NOPE"), []);
  });

  test("null / missing fields and odd shapes are ignored", () => {
    assert.deepEqual(deriveServiceReferences(SERVICES, [{ path: ["macvpn"], label: "MAC-VPN" }], "BRIDGE_VLAN200")
      .map((x) => x.service), ["LOCAL_BRIDGE"]);
    assert.deepEqual(deriveServiceReferences([{ name: "x", detail: null }], IPVPN_FIELDS, "IRB"), []);
  });

  test("results sorted by service name", () => {
    const svcs = [
      { name: "zeta", detail: { ipvpn: "V" } },
      { name: "alpha", detail: { ipvpn: "V" } },
    ];
    assert.deepEqual(deriveServiceReferences(svcs, IPVPN_FIELDS, "V").map((x) => x.service), ["alpha", "zeta"]);
  });
});
