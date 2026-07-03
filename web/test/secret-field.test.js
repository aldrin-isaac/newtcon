// test/secret-field.test.js — unit tests for the pure secret-credential helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  secretReference,
  isSecretReference,
  secretReferenceKey,
  deriveSecretKey,
  planSecretFields,
} from "../dist/secret-field.js";

test("secretReference wraps a key", () => {
  assert.equal(secretReference("switch1_ssh_pass"), "${secret:switch1_ssh_pass}");
});

test("isSecretReference distinguishes pointers from plaintext", () => {
  assert.equal(isSecretReference("${secret:k}"), true);
  assert.equal(isSecretReference("  ${secret:k}  "), true);
  assert.equal(isSecretReference("hunter2"), false);
  assert.equal(isSecretReference("${secret:}"), false); // empty key
  assert.equal(isSecretReference(""), false);
});

test("secretReferenceKey extracts the key or null", () => {
  assert.equal(secretReferenceKey("${secret:leaf1_ssh_pass}"), "leaf1_ssh_pass");
  assert.equal(secretReferenceKey("plain"), null);
});

test("deriveSecretKey follows the <node>_<field> convention", () => {
  assert.equal(deriveSecretKey("switch1", "ssh_pass"), "switch1_ssh_pass");
});

test("planSecretFields: plaintext → store write + reference in body", () => {
  const { writes, body } = planSecretFields(
    "switch1",
    { hostname: "switch1", ssh_user: "admin", ssh_pass: "hunter2" },
    ["ssh_pass"],
  );
  assert.deepEqual(writes, [{ key: "switch1_ssh_pass", value: "hunter2" }]);
  assert.equal(body.ssh_pass, "${secret:switch1_ssh_pass}");
  // non-secret fields untouched
  assert.equal(body.hostname, "switch1");
  assert.equal(body.ssh_user, "admin");
});

test("planSecretFields: empty secret is dropped (keep inherited default)", () => {
  const { writes, body } = planSecretFields(
    "switch1",
    { hostname: "switch1", ssh_pass: "   " },
    ["ssh_pass"],
  );
  assert.deepEqual(writes, []);
  assert.ok(!("ssh_pass" in body), "empty secret field removed from body");
});

test("planSecretFields: existing ${secret:} reference is left as-is", () => {
  const { writes, body } = planSecretFields(
    "switch1",
    { ssh_pass: "${secret:switch1_ssh_pass}" },
    ["ssh_pass"],
  );
  assert.deepEqual(writes, []);
  assert.equal(body.ssh_pass, "${secret:switch1_ssh_pass}");
});

test("planSecretFields: does not mutate the input body", () => {
  const input = { ssh_pass: "hunter2" };
  planSecretFields("n1", input, ["ssh_pass"]);
  assert.equal(input.ssh_pass, "hunter2", "input body unchanged");
});
