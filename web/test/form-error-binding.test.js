// test/form-error-binding.test.js — pure-logic tests for the
// validation-error-to-field-name extractor.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { extractFieldFromValidationError } from "../dist/form-error-binding.js";

describe("extractFieldFromValidationError()", () => {
  describe("newtron canonical 'validation error: <field>: <detail>'", () => {
    test("plain required", () => {
      const r = extractFieldFromValidationError("validation error: l3vni: required");
      assert.equal(r.field, "l3vni");
      assert.equal(r.cleaned, "required");
    });
    test("snake_case field name", () => {
      const r = extractFieldFromValidationError("validation error: mgmt_ip: required");
      assert.equal(r.field, "mgmt_ip");
    });
    test("multi-word detail", () => {
      const r = extractFieldFromValidationError("validation error: vlan_id: must be between 1 and 4094");
      assert.equal(r.field, "vlan_id");
      assert.equal(r.cleaned, "must be between 1 and 4094");
    });
  });

  describe("JSON envelope wrapper", () => {
    test("strips outer {'error': '…'} wrapper", () => {
      const r = extractFieldFromValidationError(`{"error":"validation error: type: required"}`);
      assert.equal(r.field, "type");
      assert.equal(r.cleaned, "required");
    });
    test("malformed JSON falls back to the input string", () => {
      const r = extractFieldFromValidationError(`{not json: validation error: foo: bar}`);
      assert.equal(r.field, null);
    });
  });

  describe("fallback patterns", () => {
    test("'<field>: <detail>' without the canonical prefix", () => {
      const r = extractFieldFromValidationError("l3vni: out of range");
      assert.equal(r.field, "l3vni");
      assert.equal(r.cleaned, "out of range");
    });
    test("'<field> is required'", () => {
      const r = extractFieldFromValidationError("name is required");
      assert.equal(r.field, "name");
      assert.equal(r.cleaned, "is required");
    });
    test("'<field> must be …'", () => {
      const r = extractFieldFromValidationError("vlan_id must be 1-4094");
      assert.equal(r.field, "vlan_id");
      assert.match(r.cleaned, /^must be/);
    });
    test("'<field> cannot …'", () => {
      const r = extractFieldFromValidationError("name cannot contain spaces");
      assert.equal(r.field, "name");
      assert.match(r.cleaned, /^cannot/);
    });
  });

  describe("no match → field is null", () => {
    test("resource-not-found shape (different concern, not validation)", () => {
      const r = extractFieldFromValidationError("QoS policy 'MISSING' not found");
      assert.equal(r.field, null);
      assert.equal(r.cleaned, "QoS policy 'MISSING' not found");
    });
    test("empty string", () => {
      const r = extractFieldFromValidationError("");
      assert.equal(r.field, null);
    });
    test("uppercase-prefix word is NOT a field name", () => {
      // 'QoS' starts uppercase → strict regex rejects, so QoS isn't named.
      const r = extractFieldFromValidationError("QoS: failed to apply");
      assert.equal(r.field, null);
    });
  });
});
