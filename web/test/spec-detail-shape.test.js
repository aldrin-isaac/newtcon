// test/spec-detail-shape.test.js — pure-logic tests for the per-spec
// detail-drawer row plan.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildSpecDetailShape } from "../dist/spec-detail-shape.js";

const profileFields = [
  { name: "name", label: "Name" },
  { name: "mgmt_ip", label: "Management IP" },
  { name: "loopback_ip", label: "Loopback IP" },
  { name: "zone", label: "Zone" },
  { name: "platform", label: "Platform" },
  { name: "underlay_asn", label: "Underlay ASN" },
  { name: "ssh_user", label: "SSH user" },
];

describe("buildSpecDetailShape() — happy path", () => {
  test("emits schema fields in schema order, with operator labels", () => {
    const shape = buildSpecDetailShape(profileFields, {
      name: "switch1",
      mgmt_ip: "10.0.0.1",
      loopback_ip: "127.0.0.1",
      zone: "amer",
    }, ["name"]);
    assert.equal(shape.rows.length, 6); // 7 fields minus excluded "name"
    assert.equal(shape.rows[0].label, "Management IP");
    assert.equal(shape.rows[0].value, "10.0.0.1");
    assert.equal(shape.rows[1].label, "Loopback IP");
    assert.equal(shape.rows[1].value, "127.0.0.1");
  });

  test("marks missing fields as empty so the DOM render can show '—'", () => {
    const shape = buildSpecDetailShape(profileFields, {
      mgmt_ip: "10.0.0.1",
      // loopback_ip absent
      zone: "",
      platform: null,
    }, ["name"]);
    const byLabel = (l) => shape.rows.find((r) => r.label === l);
    assert.equal(byLabel("Management IP").empty, false);
    assert.equal(byLabel("Loopback IP").empty, true);
    assert.equal(byLabel("Zone").empty, true);
    assert.equal(byLabel("Platform").empty, true);
  });
});

describe("buildSpecDetailShape() — extras (transparency)", () => {
  test("extras carry fields newtron returned that the schema doesn't list", () => {
    // ssh_pass is the canonical "newtron returns it but schema doesn't list it"
    // case — operator must still see it (in the disclosure) so values aren't
    // silently dropped.
    const shape = buildSpecDetailShape(profileFields, {
      mgmt_ip: "10.0.0.1",
      ssh_pass: "secret-thing",
      future_field: 42,
    }, ["name"]);
    const extraNames = shape.extras.map((r) => r.rawName);
    assert.deepEqual(new Set(extraNames), new Set(["ssh_pass", "future_field"]));
    const sshPass = shape.extras.find((r) => r.rawName === "ssh_pass");
    assert.equal(sshPass.label, "ssh_pass", "extras use the wire name as the label");
    assert.equal(sshPass.value, "secret-thing");
  });

  test("excluded names stay out of both rows and extras", () => {
    const shape = buildSpecDetailShape(profileFields, {
      name: "switch1",
      mgmt_ip: "10.0.0.1",
      surprise: "x",
    }, ["name", "surprise"]);
    assert.ok(shape.rows.every((r) => r.rawName !== "name"));
    assert.ok(shape.extras.every((r) => r.rawName !== "surprise"));
  });

  test("empty extras when newtron returns exactly the schema fields", () => {
    const shape = buildSpecDetailShape(profileFields, {
      name: "switch1",
      mgmt_ip: "10.0.0.1",
      loopback_ip: "127.0.0.1",
      zone: "amer",
      platform: "sonic-vs",
      underlay_asn: 65001,
      ssh_user: "admin",
    }, ["name"]);
    assert.equal(shape.extras.length, 0);
  });
});

describe("buildSpecDetailShape() — ref cross-linking (#243)", () => {
  const refFields = [
    { name: "name", label: "Name" },
    { name: "ipvpn", label: "IP-VPN", refKind: "IPVPNSpec" },
    { name: "qos_policy", label: "QoS policy", refKind: "QoSPolicy" },
    { name: "vlan", label: "VLAN" }, // non-ref
  ];

  test("carries refKind through to rows so the renderer can chip them", () => {
    const shape = buildSpecDetailShape(refFields, {
      ipvpn: "Vrf_IRB",
      qos_policy: "gold",
      vlan: 100,
    }, ["name"]);
    const byName = (n) => shape.rows.find((r) => r.rawName === n);
    assert.equal(byName("ipvpn").refKind, "IPVPNSpec");
    assert.equal(byName("qos_policy").refKind, "QoSPolicy");
    assert.equal(byName("vlan").refKind, undefined, "non-ref fields carry no refKind");
  });

  test("empty ref values stay empty (renderer shows '—', not a chip)", () => {
    const shape = buildSpecDetailShape(refFields, { ipvpn: "" }, ["name"]);
    const ipvpn = shape.rows.find((r) => r.rawName === "ipvpn");
    assert.equal(ipvpn.empty, true);
    assert.equal(ipvpn.refKind, "IPVPNSpec", "refKind is still present even when empty");
  });

  test("extras never carry refKind (schema-unknown fields can't be refs)", () => {
    const shape = buildSpecDetailShape(refFields, {
      ipvpn: "Vrf_IRB",
      surprise: "x",
    }, ["name"]);
    const surprise = shape.extras.find((r) => r.rawName === "surprise");
    assert.equal(surprise.refKind, undefined);
  });
});

describe("buildSpecDetailShape() — edge cases", () => {
  test("empty data: every schema row marked empty, no extras", () => {
    const shape = buildSpecDetailShape(profileFields, {}, ["name"]);
    assert.equal(shape.rows.length, 6);
    assert.ok(shape.rows.every((r) => r.empty));
    assert.equal(shape.extras.length, 0);
  });

  test("default excludeNames=[] keeps every schema field", () => {
    const shape = buildSpecDetailShape(profileFields, { name: "x" });
    assert.equal(shape.rows.length, 7);
    assert.equal(shape.rows[0].label, "Name");
  });

  test("field order in rows follows the schema, not the data dict order", () => {
    const shape = buildSpecDetailShape(profileFields, {
      ssh_user: "admin",
      mgmt_ip: "10.0.0.1",
      loopback_ip: "127.0.0.1",
    }, ["name"]);
    // Schema order: mgmt_ip, loopback_ip, zone, platform, underlay_asn, ssh_user
    assert.equal(shape.rows[0].rawName, "mgmt_ip");
    assert.equal(shape.rows[1].rawName, "loopback_ip");
    assert.equal(shape.rows[5].rawName, "ssh_user");
  });
});
