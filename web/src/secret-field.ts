// secret-field.ts — pure helpers for the schema-driven secret-credential flow
// (newtron#371/#379). A field marked `secret:true` (e.g. a node's ssh_pass) is
// never stored inline: its value goes to the network secret store and the spec
// field carries a "${secret:<key>}" reference instead. These helpers are pure so
// they unit-test without a DOM or network; the caller does the actual store POSTs.

const SECRET_REF_RE = /^\$\{secret:([^}]+)\}$/;

// secretReference wraps a store key as the reference string a spec field carries.
export function secretReference(key: string): string {
  return "${secret:" + key + "}";
}

// isSecretReference reports whether a value is a ${secret:KEY} pointer ("already
// set") rather than a plaintext value the operator just typed.
export function isSecretReference(value: string): boolean {
  return SECRET_REF_RE.test(value.trim());
}

// secretReferenceKey extracts KEY from a "${secret:KEY}" reference, or null.
export function secretReferenceKey(value: string): string | null {
  const m = SECRET_REF_RE.exec(value.trim());
  return m ? m[1] : null;
}

// deriveSecretKey builds the stable store key for a node's secret field. Stable
// so a re-save overwrites rather than orphaning. Convention: "<node>_<field>"
// (e.g. "switch1_ssh_pass") — the pattern every working network already uses.
export function deriveSecretKey(nodeName: string, fieldName: string): string {
  return `${nodeName}_${fieldName}`;
}

// SecretWrite is one store write the caller must perform before sending the body.
export interface SecretWrite {
  key: string;
  value: string;
}

// planSecretFields separates, for a create/update body, the plaintext a caller
// must write to the store from the reference to leave in the body. For each
// secret field name:
//   - empty / unset          → drop from the body (don't clobber a platform /
//                              zone / network default or an existing store ref)
//   - already a ${secret:} ref → leave as-is (a pointer, not a secret)
//   - plaintext              → schedule a store write under <node>_<field> and
//                              replace the body value with the reference
// Pure: returns the writes to perform + the rewritten body; the caller POSTs the
// writes to /secrets then sends body to create/update-node.
export function planSecretFields(
  nodeName: string,
  body: Record<string, unknown>,
  secretFieldNames: readonly string[],
): { writes: SecretWrite[]; body: Record<string, unknown> } {
  const out: Record<string, unknown> = { ...body };
  const writes: SecretWrite[] = [];
  for (const name of secretFieldNames) {
    const raw = out[name];
    if (typeof raw !== "string" || raw.trim() === "") {
      delete out[name];
      continue;
    }
    if (isSecretReference(raw)) {
      continue;
    }
    const key = deriveSecretKey(nodeName, name);
    writes.push({ key, value: raw });
    out[name] = secretReference(key);
  }
  return { writes, body: out };
}
