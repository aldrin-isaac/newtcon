// schema-form.test.js — tests for renderSchemaForm (newtron #240).
//
// Uses the same minimal DOM shim shape that confirm-inline/toast tests
// use. The renderer touches: document.createElement, appendChild,
// .className, .textContent, .placeholder, .value, .checked, .name,
// .type, .required, .step, .disabled, querySelector / Array.from.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { renderSchemaForm } from "../dist/schema-form.js";

function setupDOM() {
  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      children: [],
      attrs: {},
      listeners: new Map(),
      parent: null,
      // Inputs
      value: "",
      name: "",
      type: tag === "input" ? "text" : "",
      required: false,
      disabled: false,
      step: "",
      checked: false,
      placeholder: "",
      // Form
      reportValidity: () => true,
      appendChild(child) {
        this.children.push(child);
        child.parent = this;
        return child;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        child.parent = null;
        return child;
      },
      remove() {
        if (this.parent) {
          const i = this.parent.children.indexOf(this);
          if (i >= 0) this.parent.children.splice(i, 1);
        }
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      },
    };
    return el;
  }
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
  };
}

function findInputs(form) {
  const out = [];
  function walk(node) {
    if (node.tagName === "INPUT" || node.tagName === "SELECT") out.push(node);
    for (const c of node.children) walk(c);
  }
  walk(form);
  return out;
}

function findFirstByClass(root, cls) {
  if (root.className && root.className.split(/\s+/).includes(cls)) return root;
  for (const c of root.children) {
    const hit = findFirstByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

function findAllByClass(root, cls, out = []) {
  if (root.className && root.className.split(/\s+/).includes(cls)) out.push(root);
  for (const c of root.children) findAllByClass(c, cls, out);
  return out;
}

const IPVPN_SCHEMA = {
  kind: "IPVPNSpec",
  label: "IP-VPN",
  description: "Layer-3 VPN",
  fields: [
    { name: "description", label: "Description", type: "string", required: false,
      description: "Operator-facing description" },
    { name: "vrf", label: "VRF Name", type: "string", required: true,
      description: "SONiC VRF name" },
    { name: "l3vni", label: "L3VNI", type: "int", required: true,
      description: "1–16M" },
    { name: "l3vni_vlan", label: "L3VNI Transit VLAN", type: "int", required: false },
    { name: "route_targets", label: "Route Targets", type: "array", required: true,
      item_type: "string", description: "BGP route targets" },
  ],
};

describe("renderSchemaForm() — IPVPNSpec coverage", () => {
  beforeEach(() => { setupDOM(); });
  afterEach(() => { delete globalThis.document; });

  test("renders one row per field with the schema label", async () => {
    const { form } = await renderSchemaForm({ schema: IPVPN_SCHEMA });
    const labels = findAllByClass(form, "schema-form-label").map((l) => l.textContent);
    assert.deepEqual(labels, [
      "Description",
      "VRF Name *",
      "L3VNI *",
      "L3VNI Transit VLAN",
      "Route Targets *",
    ]);
  });

  test("description text renders as a help line per field that has one", async () => {
    const { form } = await renderSchemaForm({ schema: IPVPN_SCHEMA });
    const helps = findAllByClass(form, "schema-form-help").map((h) => h.textContent);
    assert.equal(helps.length, 4); // 4 of the 5 fields have a description
    assert.ok(helps.includes("SONiC VRF name"));
  });

  test("int field renders as a number input with step=1", async () => {
    const { form } = await renderSchemaForm({ schema: IPVPN_SCHEMA });
    const inputs = findInputs(form);
    const l3vni = inputs.find((i) => i.name === "l3vni");
    assert.equal(l3vni.type, "number");
    assert.equal(l3vni.step, "1");
    assert.equal(l3vni.required, true);
  });

  test("getValues() returns int for int fields and string for string fields", async () => {
    const { form, getValues } = await renderSchemaForm({ schema: IPVPN_SCHEMA });
    const inputs = findInputs(form);
    inputs.find((i) => i.name === "vrf").value = "Vrf-Customer-A";
    inputs.find((i) => i.name === "l3vni").value = "10001";
    inputs.find((i) => i.name === "route_targets").value = "65000:1, 65000:2";
    const v = getValues();
    assert.equal(v.vrf, "Vrf-Customer-A");
    assert.equal(v.l3vni, 10001);
    assert.deepEqual(v.route_targets, ["65000:1", "65000:2"]);
  });

  test("getValues() omits empty optional fields (no quiet '' transmission)", async () => {
    const { form, getValues } = await renderSchemaForm({ schema: IPVPN_SCHEMA });
    const inputs = findInputs(form);
    inputs.find((i) => i.name === "vrf").value = "Vrf-X";
    inputs.find((i) => i.name === "l3vni").value = "1";
    inputs.find((i) => i.name === "route_targets").value = "rt-1";
    const v = getValues();
    assert.equal("description" in v, false);
    assert.equal("l3vni_vlan" in v, false);
  });

  test("smart-default override fills the field when no prefill is present", async () => {
    const { form } = await renderSchemaForm({
      schema: IPVPN_SCHEMA,
      overrides: { l3vni: { smartDefault: () => 12345 } },
    });
    const inputs = findInputs(form);
    assert.equal(inputs.find((i) => i.name === "l3vni").value, "12345");
  });

  test("prefill wins over smart-default (edit-mode is authoritative)", async () => {
    const { form } = await renderSchemaForm({
      schema: IPVPN_SCHEMA,
      prefill: { l3vni: 99 },
      overrides: { l3vni: { smartDefault: () => 12345 } },
    });
    const inputs = findInputs(form);
    assert.equal(inputs.find((i) => i.name === "l3vni").value, "99");
  });

  test("array of strings — getValues splits + trims + drops empty", async () => {
    const { form, getValues } = await renderSchemaForm({ schema: IPVPN_SCHEMA });
    const inputs = findInputs(form);
    inputs.find((i) => i.name === "vrf").value = "V";
    inputs.find((i) => i.name === "l3vni").value = "1";
    inputs.find((i) => i.name === "route_targets").value = "65000:1,   ,65000:2 ,";
    assert.deepEqual(getValues().route_targets, ["65000:1", "65000:2"]);
  });

  test("array of ints — getValues parses each item", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [{ name: "ports", label: "Ports", type: "array", item_type: "int", required: true }],
    };
    const { form, getValues } = await renderSchemaForm({ schema });
    const input = findInputs(form)[0];
    input.value = "10, 20, 30";
    assert.deepEqual(getValues().ports, [10, 20, 30]);
  });

  test("skipFields suppresses rendering for synthetic identifier fields", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "name", label: "Name", type: "string", required: true },
        { name: "x", label: "X", type: "int", required: false },
      ],
    };
    const { form } = await renderSchemaForm({
      schema,
      skipFields: new Set(["name"]),
    });
    const labels = findAllByClass(form, "schema-form-label").map((l) => l.textContent);
    assert.deepEqual(labels, ["X"]);
  });

  test("hidden override suppresses a specific field", async () => {
    const { form } = await renderSchemaForm({
      schema: IPVPN_SCHEMA,
      overrides: { l3vni_vlan: { hidden: true } },
    });
    const labels = findAllByClass(form, "schema-form-label").map((l) => l.textContent);
    assert.equal(labels.includes("L3VNI Transit VLAN"), false);
  });

  test("enum field renders <select> with one option per enum value", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [{
        name: "type", label: "Type", type: "enum", required: true,
        enum: ["evpn-irb", "irb", "routed"],
      }],
    };
    const { form, getValues } = await renderSchemaForm({ schema });
    const sel = findInputs(form)[0];
    assert.equal(sel.tagName, "SELECT");
    assert.equal(sel.children.length, 3);
    sel.value = "irb";
    assert.equal(getValues().type, "irb");
  });

  test("ref / object / map types render disabled placeholders for now", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "ipvpn", label: "IP-VPN", type: "ref", required: false, ref_kind: "IPVPNSpec" },
        { name: "routing", label: "Routing", type: "object", required: false, item_kind: "RoutingSpec" },
      ],
    };
    const { form, getValues } = await renderSchemaForm({ schema });
    const inputs = findAllByClass(form, "schema-form-input--unsupported");
    assert.equal(inputs.length, 2);
    assert.equal(inputs.every((i) => i.disabled === true), true);
    // Body never contains placeholder fields.
    assert.deepEqual(getValues(), {});
  });
});
