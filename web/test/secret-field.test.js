// test/secret-field.test.js — unit tests for the pure ${secret:KEY} helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { secretReference, isSecretReference } from "../dist/secret-field.js";

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
