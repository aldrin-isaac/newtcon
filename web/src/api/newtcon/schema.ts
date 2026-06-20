// schema.ts — typed client for newtron's spec-authoring schema
// metadata, fronted by an in-session cache.
//
// Wire shape mirrors newtron PR #240 (docs/newtron/api.md §schema):
//
//   GET /api/schema           → { kinds: [{ kind, label, description }, …] }
//   GET /api/schema/{kind}    → { kind, label, description, fields: [SchemaField] }
//
// One module-level cache per browser session: schemas don't change at
// runtime (they're derived from struct tags at newtron boot), so
// fetching the same kind twice serves the second call from memory.

import { apiFetch } from "./_transport.js";

// ─── Wire-shape types ──────────────────────────────────────────────

export interface SchemaKindSummary {
  kind: string;        // Go type name, e.g. "IPVPNSpec"
  label: string;
  description: string;
}

export interface SchemaField {
  name: string;        // wire field name
  label: string;       // operator-facing form label
  description?: string;
  type:
    | "string"
    | "int"
    | "float"
    | "bool"
    | "enum"
    | "array"
    | "map"
    | "object"
    | "ref";
  required: boolean;
  enum?: string[];     // type === "enum"
  ref_kind?: string;   // type === "ref"
  item_type?: string;  // type === "array" | "map" of primitives
  item_kind?: string;  // type === "array" | "map" | "object" of structs
  // Validation hints (newtron #240 — universal-engine extension).
  // UIs flow these to HTML attributes for client-side checks; the
  // server still validates server-side.
  pattern?: string;    // regex value must match
  min?: number;        // inclusive lower bound (type === "int")
  max?: number;        // inclusive upper bound (type === "int")
  format?: string;     // semantic hint: "cidr" | "ipv4" | "ipv6" | "mac" | "asn"
  immutable?: boolean; // true → suppress edit input in update-mode forms
  // Conditional required (newtron #243). When the static `required` is
  // false AND the condition below evaluates true against the current
  // form values, the field becomes required. Structured tree, not a
  // DSL — see web/src/required-when.ts for the evaluator + tree
  // shapes. Unknown / malformed values evaluate to "not required."
  required_when?: import("../../required-when.js").RequiredWhen;
}

// SchemaPaths are URL templates with {netID} (always) and {name}
// (on `show` for top-level kinds) placeholders the caller substitutes.
// Empty / absent fields mean the verb does not exist for this kind.
export interface SchemaPaths {
  list?: string;
  show?: string;
  create?: string;
  update?: string;
  delete?: string;
}

export interface SchemaMeta {
  kind: string;
  label: string;
  description: string;
  fields: SchemaField[];
  /** Wire name of the field that addresses one row (e.g. "name",
   *  "seq", "queue_id"). Top-level kinds default to "name". */
  identifier?: string;
  /** Sub-rule kinds only: wire field name carrying the parent's name
   *  in request bodies (e.g. "filter" for FilterRule). */
  parent_ref?: string;
  /** HTTP path templates. Embedded-only kinds (RoutingSpec, etc.)
   *  omit `paths` entirely. */
  paths?: SchemaPaths;
}

// ─── Cache ─────────────────────────────────────────────────────────

// One pending promise per kind so concurrent callers share the
// in-flight fetch. Resolved entries stay forever for the session
// (the schema is boot-time data on newtron's side; invalidation comes
// from `visibilitychange` HEAD checks, not from age).
const schemaCache = new Map<string, Promise<SchemaMeta>>();
let kindsCache: Promise<SchemaKindSummary[]> | null = null;
let allSchemasCache: Promise<SchemaMeta[]> | null = null;

/**
 * fetchSchemaKinds returns the full list of registered authoring kinds,
 * alphabetical by kind name. Cached for the session.
 *
 * Prefer fetchAllSchemas when the caller needs the per-kind fields too —
 * one HTTP round-trip vs N+1 (summary + per-kind).
 */
export async function fetchSchemaKinds(): Promise<SchemaKindSummary[]> {
  if (kindsCache) return kindsCache;
  kindsCache = (async () => {
    const body = (await apiFetch("/api/schema", { cache: "no-store" })) as
      | { kinds?: SchemaKindSummary[] }
      | null;
    return Array.isArray(body?.kinds) ? body!.kinds! : [];
  })();
  try {
    return await kindsCache;
  } catch (e) {
    kindsCache = null; // allow retry on next call
    throw e;
  }
}

/**
 * fetchAllSchemas returns every registered kind's full SchemaMeta in
 * one HTTP round-trip (newtron PR #242). Side-effect: warms the
 * per-kind schemaCache so subsequent fetchSchema(kind) calls hit
 * memory.
 *
 * Use this for cold-start flows (panel discovery, kind resolver) that
 * need full metadata for every kind. The narrower fetchSchemaKinds
 * stays for callers that need only the summary.
 */
export async function fetchAllSchemas(): Promise<SchemaMeta[]> {
  if (allSchemasCache) return allSchemasCache;
  allSchemasCache = (async () => {
    const body = (await apiFetch("/api/schema/all", { cache: "no-store" })) as
      | { schemas?: SchemaMeta[] }
      | null;
    const schemas = Array.isArray(body?.schemas) ? body!.schemas! : [];
    // Warm the per-kind cache so fetchSchema(kind) hits memory after
    // this call. Wrap each in a resolved promise to match the
    // schemaCache value shape.
    for (const meta of schemas) {
      if (meta.kind) {
        schemaCache.set(meta.kind, Promise.resolve(meta));
      }
    }
    return schemas;
  })();
  try {
    return await allSchemasCache;
  } catch (e) {
    allSchemasCache = null;
    throw e;
  }
}

/**
 * fetchSchema returns the full field metadata for one kind. Cached
 * per-kind for the session. Throws on 404 (unknown kind) — caller
 * decides whether to fall back to a hand-typed form.
 */
export async function fetchSchema(kind: string): Promise<SchemaMeta> {
  const hit = schemaCache.get(kind);
  if (hit) return hit;
  const p = (async () => {
    return (await apiFetch(
      `/api/schema/${encodeURIComponent(kind)}`,
      { cache: "no-store" },
    )) as SchemaMeta;
  })();
  schemaCache.set(kind, p);
  try {
    return await p;
  } catch (e) {
    schemaCache.delete(kind);
    throw e;
  }
}

/**
 * resetSchemaCache — testing hook only. Production code should never
 * need to clear the cache.
 */
export function resetSchemaCache(): void {
  schemaCache.clear();
  kindsCache = null;
  allSchemasCache = null;
  slugToKindCache = null;
}

// Slug → newtron-kind-name map built dynamically by fetching every
// kind's schema and extracting the URL slug from `paths.list`. Built
// once per session; later panel / form / list calls hit the cache.
// Newtcon does not need to know which kinds exist — newtron tells it.
let slugToKindCache: Promise<Map<string, string>> | null = null;

/**
 * resolveSlugToKind — for a given URL slug (e.g. "ipvpns",
 * "qos-policies"), return the newtron kind name (e.g. "IPVPNSpec",
 * "QoSPolicy"). Returns null when the slug doesn't correspond to a
 * top-level kind newtron exposes — caller falls back to legacy paths
 * for kinds that aren't yet schema-described (e.g. prefix-lists).
 *
 * Derives the map by walking every registered kind, fetching its
 * schema, and reading the slug from `paths.list`. Top-level kinds
 * have `paths.list`; embedded / sub-rule kinds don't.
 */
/**
 * resolveSubRuleKind — for a parent URL slug (e.g. "filters",
 * "route-policies"), return the newtron kind name of the sub-rule
 * kind nested inside it (e.g. "FilterRule", "RoutePolicyRule").
 * Returns null when no sub-rule is discoverable from the schema.
 *
 * Strategy: resolve the parent slug to a kind, fetch its schema, find
 * the first `array` or `map` field with `item_kind` set — that names
 * the sub-rule. For parent slugs whose parent kind has no schema
 * (e.g. "prefix-lists" today — newtron doesn't ship a PrefixListSpec),
 * the helper falls back to walking every kind and picking the one
 * whose parent_ref / list-path pattern matches the slug.
 */
export async function resolveSubRuleKind(parentSlug: string): Promise<string | null> {
  // Path 1 — parent has a schema; read item_kind off its array/map field.
  const parentKind = await resolveSlugToKind(parentSlug).catch(() => null);
  if (parentKind !== null) {
    const meta = await fetchSchema(parentKind).catch(() => null);
    if (meta) {
      for (const f of meta.fields) {
        if ((f.type === "array" || f.type === "map") && f.item_kind) {
          return f.item_kind;
        }
      }
    }
  }
  // Path 2 — fallback: walk every registered kind, find the sub-rule
  // (kinds with parent_ref) whose parent_ref hyphenated-plural matches
  // the slug. This catches the prefix-lists case where newtron has no
  // parent schema but does have the PrefixListEntry sub-rule.
  const summaries = await fetchSchemaKinds().catch(() => []);
  for (const s of summaries) {
    const m = await fetchSchema(s.kind).catch(() => null);
    if (!m || !m.parent_ref) continue;
    // parent_ref "prefix_list" → slug "prefix-lists"
    // parent_ref "filter"       → slug "filters"
    // parent_ref "policy"       → ambiguous (filters AND route-policies
    //                              both have policy-style parent_refs)
    const conventionalSlug = m.parent_ref.replace(/_/g, "-") + "s";
    if (conventionalSlug === parentSlug) return m.kind;
  }
  return null;
}

export async function resolveSlugToKind(slug: string): Promise<string | null> {
  if (!slugToKindCache) {
    slugToKindCache = (async () => {
      const summaries = await fetchSchemaKinds();
      const out = new Map<string, string>();
      const results = await Promise.allSettled(
        summaries.map(async (s) => {
          const meta = await fetchSchema(s.kind);
          const listPath = meta.paths?.list;
          if (!listPath) return; // embedded or sub-rule — not addressable by slug
          // paths.list is "/newtron/v1/networks/{netID}/<slug>"; the
          // last path segment is the slug.
          const m = listPath.match(/\/([^/]+)$/);
          if (m) out.set(m[1]!, s.kind);
        }),
      );
      void results;
      return out;
    })();
    try {
      await slugToKindCache;
    } catch (e) {
      slugToKindCache = null;
      throw e;
    }
  }
  return (await slugToKindCache).get(slug) ?? null;
}
