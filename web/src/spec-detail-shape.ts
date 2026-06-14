// spec-detail-shape.ts — pure helper for the per-spec detail-drawer rendering.
//
// The detail drawer (and the Profile sub-tab in the device drawer) used to
// render spec data with a generic recursive key/value tree (renderValue).
// That tree is honest but hard to scan — keys are the wire names
// (mgmt_ip, loopback_ip, …) rather than operator labels.
//
// This module computes the *shape* of a tailored layout: which rows to show
// in the prominent labeled-row section, and which to push into an
// "additional fields" disclosure. The DOM render lives in app.ts (so it
// has access to renderValue + el); this file is the pure logic — unit-
// testable without a DOM.
//
// The "additional fields" disclosure exists for operator-honest reasons:
// newtron may add fields the schema doesn't yet know about, and the
// operator must be able to see them rather than silently lose them.

/**
 * A FieldDef the renderer cares about — narrowed from app.ts's wider
 * FieldDef (which carries form-input metadata not needed here).
 */
export interface SpecField {
  name: string;
  label: string;
}

/** SpecRow is one rendered row in the labeled-row layout. */
export interface SpecRow {
  label: string;     // operator-visible
  rawName: string;   // wire name (used as label for "extra" rows)
  value: unknown;    // the raw value from newtron, passed through to renderValue
  empty: boolean;    // true when value is undefined / null / ""
}

/** SpecDetailShape is what app.ts feeds into the DOM renderer. */
export interface SpecDetailShape {
  /** Rows for fields the schema knows about, in schema order. */
  rows: SpecRow[];
  /**
   * Rows for fields newtron returned that the schema does not list. Rendered
   * inside an "All fields" disclosure so the operator sees them without
   * being overwhelmed.
   */
  extras: SpecRow[];
}

/**
 * buildSpecDetailShape returns the row plan for rendering spec data with a
 * tailored layout.
 *
 * - Schema fields appear in `rows` in the order they appear in `fields`.
 * - Fields named in `excludeNames` are skipped from both rows and extras.
 *   Use this for fields already shown elsewhere in the drawer (e.g. "name"
 *   sits in the drawer header — don't repeat it in the body).
 * - Any extra field newtron returned that the schema doesn't list lands in
 *   `extras` so the operator can still see it via the disclosure.
 */
export function buildSpecDetailShape(
  fields: SpecField[],
  data: Record<string, unknown>,
  excludeNames: string[] = [],
): SpecDetailShape {
  const exclude = new Set(excludeNames);
  const knownNames = new Set<string>();
  const rows: SpecRow[] = [];
  for (const f of fields) {
    if (exclude.has(f.name)) continue;
    knownNames.add(f.name);
    const v = data[f.name];
    rows.push({ label: f.label, rawName: f.name, value: v, empty: isEmpty(v) });
  }
  const extras: SpecRow[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (knownNames.has(k) || exclude.has(k)) continue;
    extras.push({ label: k, rawName: k, value: v, empty: isEmpty(v) });
  }
  return { rows, extras };
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}
