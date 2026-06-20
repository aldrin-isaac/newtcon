// required-when.ts — pure evaluator + tooltip pretty-printer for the
// `required_when` schema metadata newtron ships per newtron PR #243.
//
// Wire shape (structured JSON tree, not a string DSL — see the
// /tmp/newtron-reply-to-newtcon-engine-followup.md exchange):
//
//   atomic:    {field: <string>, equals|not_equals: <value>}
//              {field: <string>, in|not_in: <value[]>}
//   combinator:{all_of: <RequiredWhen[]>}
//              {any_of: <RequiredWhen[]>}
//
// Atomic nodes have exactly one operand; combinator nodes have exactly
// one of `all_of` / `any_of`. Newtron validates these shapes at
// registration time (server start panics on malformed specs), so the
// browser evaluator treats malformed input as "no constraint" rather
// than throwing — defensive against future schema additions.
//
// Semantic pins (from the reply doc, confirmed by newtron):
//   1. `field` references a sibling on the same SchemaMeta. Nested
//      forms (object/array of item_kind) evaluate against their own
//      field set, not the parent's.
//   2. Static `required: true` wins — the caller only consults this
//      module when the schema's static required is false.
//   3. Unfilled sibling values evaluate against the zero value
//      (empty string), so `{field: 'service_type', in: ['evpn-irb']}`
//      evaluates false until the operator picks evpn-irb.
//   4. No server-side per-request evaluation — newtron's 400 stays as
//      the back-stop; this module is UX so the operator sees the
//      constraint before submitting.

import type { SchemaField } from "./api/newtcon/schema.js";

// ─── Wire-shape types ──────────────────────────────────────────────

export interface RequiredWhenAtomic {
  field: string;
  equals?: unknown;
  not_equals?: unknown;
  in?: readonly unknown[];
  not_in?: readonly unknown[];
}

export interface RequiredWhenAllOf {
  all_of: readonly RequiredWhen[];
}

export interface RequiredWhenAnyOf {
  any_of: readonly RequiredWhen[];
}

export type RequiredWhen = RequiredWhenAtomic | RequiredWhenAllOf | RequiredWhenAnyOf;

// ─── Evaluator ─────────────────────────────────────────────────────

/**
 * evaluateRequiredWhen — true when the condition resolves to required.
 *
 *   condition: the `required_when` tree from a FieldMeta. null /
 *              undefined → returns false (no condition = not required
 *              from this metadata's perspective).
 *
 *   values:    current form-field values keyed by wire name. Missing
 *              keys read as "" (the zero value for strings; numbers
 *              fall through as "" too — `in: [1, 2]` against an
 *              unfilled number compares numeric 1 to string "" and
 *              evaluates false, which is the right answer per
 *              semantic pin #3).
 */
export function evaluateRequiredWhen(
  condition: RequiredWhen | null | undefined,
  values: Readonly<Record<string, unknown>>,
): boolean {
  if (!condition) return false;
  if (isAllOf(condition)) {
    if (!Array.isArray(condition.all_of)) return false;
    return condition.all_of.every((c) => evaluateRequiredWhen(c, values));
  }
  if (isAnyOf(condition)) {
    if (!Array.isArray(condition.any_of)) return false;
    return condition.any_of.some((c) => evaluateRequiredWhen(c, values));
  }
  if (isAtomic(condition)) {
    const lhs = values[condition.field] ?? "";
    if ("equals" in condition) return looseEqual(lhs, condition.equals);
    if ("not_equals" in condition) return !looseEqual(lhs, condition.not_equals);
    if ("in" in condition && Array.isArray(condition.in)) {
      return condition.in.some((v) => looseEqual(lhs, v));
    }
    if ("not_in" in condition && Array.isArray(condition.not_in)) {
      return !condition.not_in.some((v) => looseEqual(lhs, v));
    }
    return false; // atomic without an operand — defensive
  }
  return false;
}

function isAllOf(c: RequiredWhen): c is RequiredWhenAllOf {
  return Object.prototype.hasOwnProperty.call(c, "all_of");
}
function isAnyOf(c: RequiredWhen): c is RequiredWhenAnyOf {
  return Object.prototype.hasOwnProperty.call(c, "any_of");
}
function isAtomic(c: RequiredWhen): c is RequiredWhenAtomic {
  return typeof (c as RequiredWhenAtomic).field === "string";
}

// Loose equality — form values come back as strings from text/number
// inputs, but newtron emits enum/literal comparands in their native
// shape. Normalize both sides to string for the comparison so
// `{field: 'service_type', in: ['evpn-irb']}` matches the select
// value "evpn-irb" without typeof gymnastics on each operator.
function looseEqual(a: unknown, b: unknown): boolean {
  // Treat null/undefined symmetrically with "".
  const an = a === null || a === undefined ? "" : a;
  const bn = b === null || b === undefined ? "" : b;
  return String(an) === String(bn);
}

// ─── Pretty-printer ────────────────────────────────────────────────

/**
 * formatRequiredWhen — operator-facing string describing when the
 * field is required. Uses sibling field labels (not wire names) so
 * the message reads in the same vocabulary as the form labels.
 *
 * Examples (resolved against ServiceSpec):
 *   {field:'service_type', in:['evpn-irb','evpn-routed']}
 *     → "Required when Service Type is evpn-irb or evpn-routed"
 *   {all_of:[...]} → "Required when X is Y and Z is W"
 *   {any_of:[...]} → "Required when X is Y or Z is W"
 *
 * Returns "" when the condition is null/undefined or malformed — the
 * caller suppresses the tooltip rather than showing an empty one.
 */
export function formatRequiredWhen(
  condition: RequiredWhen | null | undefined,
  siblingFields: readonly SchemaField[],
): string {
  if (!condition) return "";
  const inner = formatNode(condition, siblingFields);
  return inner === "" ? "" : `Required when ${inner}.`;
}

function formatNode(c: RequiredWhen, siblings: readonly SchemaField[]): string {
  if (isAllOf(c)) {
    if (!Array.isArray(c.all_of) || c.all_of.length === 0) return "";
    return c.all_of.map((sub) => formatNode(sub, siblings)).filter((s) => s !== "").join(" and ");
  }
  if (isAnyOf(c)) {
    if (!Array.isArray(c.any_of) || c.any_of.length === 0) return "";
    return c.any_of.map((sub) => formatNode(sub, siblings)).filter((s) => s !== "").join(" or ");
  }
  if (isAtomic(c)) {
    const label = labelFor(c.field, siblings);
    if ("equals" in c) return `${label} is ${formatValue(c.equals)}`;
    if ("not_equals" in c) return `${label} is not ${formatValue(c.not_equals)}`;
    if ("in" in c && Array.isArray(c.in)) {
      return `${label} is ${joinHuman(c.in.map(formatValue))}`;
    }
    if ("not_in" in c && Array.isArray(c.not_in)) {
      return `${label} is none of ${joinHuman(c.not_in.map(formatValue))}`;
    }
  }
  return "";
}

function labelFor(wireName: string, siblings: readonly SchemaField[]): string {
  const hit = siblings.find((f) => f.name === wireName);
  return hit ? hit.label : wireName;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "''";
  if (typeof v === "string") return v;
  return String(v);
}

// Join 1 → "a", 2 → "a or b", 3+ → "a, b, or c".
function joinHuman(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}
