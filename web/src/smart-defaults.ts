// smart-defaults.ts — compute next-available integer defaults for spec
// creation forms (slice #172.D). Suggests sensible starting values for
// integer-ID fields (L3 VNI on ipvpns, VNI on macvpns) so the operator
// doesn't have to grep existing specs to find a free integer.
//
// Strategy per field:
//   - read the existing specs of the kind
//   - extract the integer field from each detail
//   - propose max(used)+1, falling back to minStart when nothing's used
//     and to a gap-scan when max+1 would exceed the range ceiling
//
// Honest fallback: any fetch failure returns an empty prefill — the form
// just renders without a smart default, and the operator can type the
// value the same way they always could.

import { fetchSpecList, fetchSpecDetail, type SpecKind } from "./api/newtcon/network.js";

/** Per-field strategy used by computePrefillForKind. */
export interface SmartDefaultStrategy {
  /** Field name on the create form. */
  field: string;
  /** Field name on the spec-detail wire shape (often identical to field). */
  sourceField: string;
  /**
   * Sensible starting value when no existing spec uses the field. Picked to
   * avoid common reserved / low-range values (e.g. VNI < 10000 collides
   * with reserved L2/L3 ranges in many operator policies).
   */
  minStart: number;
  /** Inclusive upper bound for the field. */
  max: number;
}

const STRATEGIES: Partial<Record<SpecKind, SmartDefaultStrategy[]>> = {
  ipvpns:  [{ field: "l3vni", sourceField: "l3vni", minStart: 10000, max: 16777215 }],
  macvpns: [{ field: "vni",   sourceField: "vni",   minStart: 10000, max: 16777215 }],
};

/** strategiesFor returns the smart-default strategies for a kind, or undefined. */
export function strategiesFor(kind: SpecKind): SmartDefaultStrategy[] | undefined {
  return STRATEGIES[kind];
}

/**
 * nextAvailable returns the smallest integer in [minStart, max] not present
 * in `used`, computed by:
 *
 *   1. If `used` is empty → minStart.
 *   2. If max(used ∩ [minStart, max]) + 1 ≤ max → max + 1 (favours
 *      monotonic growth so the operator can scan a sorted list).
 *   3. Otherwise scan from minStart for the first gap.
 *
 * Returns null when every integer in [minStart, max] is taken — the form
 * stays unprefilled and the operator gets to pick a value (or hit a
 * server-side conflict error if the entire range is genuinely exhausted).
 */
export function nextAvailable(used: Iterable<number>, minStart: number, max: number): number | null {
  const set = used instanceof Set ? used : new Set(used);
  if (set.size === 0) return minStart;
  let candidate = minStart - 1;
  for (const v of set) {
    if (v >= minStart && v <= max && v > candidate) candidate = v;
  }
  // If no used value is in [minStart, max], everything below minStart —
  // the next available is minStart itself.
  if (candidate < minStart) return minStart;
  if (candidate + 1 <= max) return candidate + 1;
  // Range top reached — fall back to a gap-scan from minStart.
  for (let i = minStart; i <= max; i++) {
    if (!set.has(i)) return i;
  }
  return null;
}

/**
 * extractIntField pulls a non-negative integer field from an unknown
 * spec-detail object. Handles `number` and number-as-string (newtron's
 * wire shape uses both depending on the field). Returns null on
 * missing / non-numeric / non-integer / nested.
 */
export function extractIntField(detail: unknown, fieldName: string): number | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const v = (detail as Record<string, unknown>)[fieldName];
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (!isNaN(n) && n >= 0 && String(n) === v.trim()) return n;
  }
  return null;
}

/**
 * computePrefillForKind fetches the existing specs of `kind`, reads their
 * smart-default source fields, and returns a `{fieldName: nextAvailable}`
 * prefill suitable to pass to buildFormFields' `prefill` option.
 *
 * Resolves to {} when the kind has no strategy OR when any HTTP step fails
 * — the form stays unprefilled and the operator can still author manually.
 */
export async function computePrefillForKind(
  kind: SpecKind,
  network?: string,
): Promise<Record<string, unknown>> {
  const strategies = STRATEGIES[kind];
  if (!strategies || strategies.length === 0) return {};
  try {
    const names = await fetchSpecList(kind, network);
    const details = names.length === 0
      ? []
      : await Promise.all(names.map((n) => fetchSpecDetail(kind, n, network).catch(() => null)));
    const out: Record<string, unknown> = {};
    for (const s of strategies) {
      const used = new Set<number>();
      for (const d of details) {
        const v = extractIntField(d, s.sourceField);
        if (v !== null) used.add(v);
      }
      const next = nextAvailable(used, s.minStart, s.max);
      if (next !== null) out[s.field] = next;
    }
    return out;
  } catch {
    return {};
  }
}
