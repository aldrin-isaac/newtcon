// secret-field.ts — pure helpers for the ${secret:KEY} store-reference convention.
// A field marked `secret:true` (e.g. the SSH login's ssh_pass) is never stored
// inline: its value goes to the network secret store and the field carries a
// "${secret:<key>}" reference. Used by the schema-form masked rendering and the
// SSH Login control. Pure — unit-testable without a DOM or network.

const SECRET_REF_RE = /^\$\{secret:([^}]+)\}$/;

// secretReference wraps a store key as the reference string a field carries.
export function secretReference(key: string): string {
  return "${secret:" + key + "}";
}

// isSecretReference reports whether a value is a ${secret:KEY} pointer ("already
// set") rather than a plaintext value the operator just typed.
export function isSecretReference(value: string): boolean {
  return SECRET_REF_RE.test(value.trim());
}
