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
      hidden: false,
      // Form
      reportValidity: () => true,
      // Minimal selector support: a comma-separated list where each part
      // is a tag name ("input") or a class (".schema-form-label").
      querySelectorAll(sel) {
        const parts = sel.split(",").map((s) => s.trim());
        const matches = (node) => parts.some((p) =>
          p.startsWith(".")
            ? (node.className || "").split(/\s+/).includes(p.slice(1))
            : node.tagName === p.toUpperCase());
        const out = [];
        const walk = (node) => {
          for (const c of node.children) { if (matches(c)) out.push(c); walk(c); }
        };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
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

  test("ref field renders a <select> dropdown (populated async from the ref kind's list path)", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "ipvpn", label: "IP-VPN", type: "ref", required: true, ref_kind: "IPVPNSpec" },
      ],
    };
    const { form, getValues } = await renderSchemaForm({ schema });
    const inputs = findInputs(form);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].tagName, "SELECT");
    assert.equal(inputs[0].required, true);
    // Unselected → no value, dropped from body.
    assert.deepEqual(getValues(), {});
  });

  test("object field with item_kind renders a nested <fieldset>", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "routing", label: "Routing", type: "object", required: false, item_kind: "RoutingSpec" },
      ],
    };
    const { form } = await renderSchemaForm({ schema });
    // Find the nested fieldset by class.
    const nested = findAllByClass(form, "schema-form-nested");
    assert.equal(nested.length, 1);
    assert.equal(nested[0].tagName, "FIELDSET");
  });

  test("object field without item_kind falls back to disabled placeholder", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "broken", label: "Broken", type: "object", required: false },
      ],
    };
    const { form, getValues } = await renderSchemaForm({ schema });
    const placeholders = findAllByClass(form, "schema-form-input--unsupported");
    assert.equal(placeholders.length, 1);
    assert.equal(placeholders[0].disabled, true);
    assert.deepEqual(getValues(), {});
  });

  test("map type renders a visible 'not authorable' notice naming what newtron expects", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "labels", label: "Labels", type: "map", required: false, item_kind: "FilterSpec" },
      ],
    };
    const { form, getValues } = await renderSchemaForm({ schema });
    const notice = findFirstByClass(form, "schema-form-notice--unsupported");
    assert.ok(notice, "notice element mounted");
    const head = findFirstByClass(notice, "schema-form-notice-head");
    assert.ok(head.textContent.includes("map of FilterSpec"));
    assert.deepEqual(getValues(), {});
  });

  test("array of item_kind renders a 'not authorable' notice (no silent drop)", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "rules", label: "Rules", type: "array", required: false, item_kind: "FilterRule" },
      ],
    };
    const { form, getValues } = await renderSchemaForm({ schema });
    const notice = findFirstByClass(form, "schema-form-notice--unsupported");
    assert.ok(notice, "notice element mounted");
    const head = findFirstByClass(notice, "schema-form-notice-head");
    assert.ok(head.textContent.includes("array of FilterRule"));
    assert.deepEqual(getValues(), {});
  });

  test("notice for required field flags the 400 risk explicitly", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "rules", label: "Rules", type: "array", required: true, item_kind: "FilterRule" },
      ],
    };
    const { form } = await renderSchemaForm({ schema });
    const body = findFirstByClass(form, "schema-form-notice-body");
    assert.ok(body.textContent.includes("required by newtron"),
      `notice body should flag required-by-newtron risk; got: "${body.textContent}"`);
  });

  test("string field with pattern wires input[pattern]", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "name", label: "Name", type: "string", required: true,
          pattern: "^[A-Za-z0-9_-]+$" },
      ],
    };
    const { form } = await renderSchemaForm({ schema });
    const input = findInputs(form)[0];
    // In the DOM shim, `pattern` is set via the property (the renderer
    // assigns input.pattern = ...). Check the shim's recorded value.
    assert.equal(input.pattern, "^[A-Za-z0-9_-]+$");
  });

  test("int field wires min/max attrs from schema", async () => {
    const schema = {
      kind: "X", label: "X", description: "",
      fields: [
        { name: "vni", label: "VNI", type: "int", required: true, min: 1, max: 16777215 },
      ],
    };
    const { form } = await renderSchemaForm({ schema });
    const input = findInputs(form)[0];
    assert.equal(input.min, "1");
    assert.equal(input.max, "16777215");
  });
});

describe("renderSchemaForm() — applies_when (newtron #265)", () => {
  beforeEach(() => { setupDOM(); });
  afterEach(() => { delete globalThis.document; });

  // Mirrors RoutingSpec: a `protocol` discriminator plus BGP-only fields
  // gated by applies_when {field: protocol, equals: bgp}.
  const ROUTING_SCHEMA = {
    kind: "RoutingSpec", label: "Service Routing", description: "",
    fields: [
      { name: "protocol", label: "Protocol", type: "enum", required: true, enum: ["bgp", "static"] },
      { name: "peer_as", label: "Peer AS", type: "string", required: false,
        applies_when: { field: "protocol", equals: "bgp" } },
      { name: "import_prefix_list", label: "Import Prefix List", type: "ref", required: false,
        ref_kind: "PrefixListSpec", applies_when: { field: "protocol", equals: "bgp" } },
      { name: "redistribute", label: "Redistribute", type: "bool", required: false },
    ],
  };

  test("protocol=bgp → BGP-only rows applicable (visible, enabled, submitted)", async () => {
    const { form, getValues } = await renderSchemaForm({
      schema: ROUTING_SCHEMA,
      prefill: { protocol: "bgp", peer_as: "65001" },
    });
    const peerRow = findFirstByClass(form, "schema-form-row"); // first row is protocol; find peer_as row
    const rows = findAllByClass(form, "schema-form-row");
    const peerAsRow = rows.find((r) => findInputs(r).some((i) => i.name === "peer_as"));
    assert.equal(peerAsRow.hidden, false, "peer_as row visible under bgp");
    const v = getValues();
    assert.equal(v.peer_as, "65001", "peer_as submitted under bgp");
    void peerRow;
  });

  test("protocol=static → BGP-only fields hidden, disabled, omitted from getValues", async () => {
    const { form, getValues } = await renderSchemaForm({
      schema: ROUTING_SCHEMA,
      prefill: { protocol: "static", peer_as: "65001" },
    });
    const rows = findAllByClass(form, "schema-form-row");
    const peerAsRow = rows.find((r) => findInputs(r).some((i) => i.name === "peer_as"));
    assert.equal(peerAsRow.hidden, true, "peer_as row hidden under static");
    const peerInput = findInputs(form).find((i) => i.name === "peer_as");
    assert.equal(peerInput.disabled, true, "peer_as input disabled under static (barred from validation + submit)");
    const v = getValues();
    assert.equal("peer_as" in v, false, "peer_as omitted from payload under static");
    assert.equal("import_prefix_list" in v, false, "ref field also omitted under static");
  });

  test("redistribute (no applies_when) always applies", async () => {
    const { form } = await renderSchemaForm({
      schema: ROUTING_SCHEMA,
      prefill: { protocol: "static" },
    });
    const rows = findAllByClass(form, "schema-form-row");
    const redistRow = rows.find((r) => findInputs(r).some((i) => i.name === "redistribute"));
    assert.equal(redistRow.hidden, false, "redistribute stays visible regardless of protocol");
  });

  test("toggling protocol re-evaluates applicability via the change listener", async () => {
    const { form, getValues } = await renderSchemaForm({
      schema: ROUTING_SCHEMA,
      prefill: { protocol: "bgp", peer_as: "65001" },
    });
    const protocolInput = findInputs(form).find((i) => i.name === "protocol");
    const rows = findAllByClass(form, "schema-form-row");
    const peerAsRow = rows.find((r) => findInputs(r).some((i) => i.name === "peer_as"));
    assert.equal(peerAsRow.hidden, false);

    // Flip to static and fire the form's change listener (single
    // delegated listener at the form level).
    protocolInput.value = "static";
    for (const fn of (form.listeners.get("change") || [])) fn();
    assert.equal(peerAsRow.hidden, true, "peer_as hides after flipping to static");
    assert.equal("peer_as" in getValues(), false, "peer_as drops from payload after flip");

    // Flip back to bgp.
    protocolInput.value = "bgp";
    for (const fn of (form.listeners.get("change") || [])) fn();
    assert.equal(peerAsRow.hidden, false, "peer_as reappears under bgp");
    assert.equal(getValues().peer_as, "65001", "peer_as returns to payload under bgp");
  });
});
