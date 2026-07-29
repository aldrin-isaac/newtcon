// views/specs/panels.ts — the Specs view's panel catalog: which spec facets
// exist, what they're called, and how they group in the subnav.
//
// PANELS is discovered dynamically from newtron's /api/schema/all. One HTTP
// round-trip returns every registered SchemaMeta; the list is loaded on first
// specs-view mount and cached for the session. Synchronous lookups
// (kindTitleFor) fall back to humanizing the slug when called before the cache
// populates.
//
// The cache is module state, so every read goes through an accessor here
// rather than exporting the mutable array — one owner for "what facets exist".

import { type SpecKind } from "../../api/newtcon/network.js";
import { fetchAllSchemas } from "../../api/newtcon/schema.js";

export interface Panel {
  kind: SpecKind;
  title: string;
  /** True when newtron's schema advertises a create path for this kind
   *  (drives the "+ Add" affordance). PlatformSpec — a read-only global
   *  registry — has no create path, so it gets no Add button. */
  canCreate: boolean;
  /** True when newtron's schema advertises a delete path (drives the
   *  per-row × affordance). */
  canDelete: boolean;
}

let PANELS: Panel[] = [];
let panelsLoaded: Promise<Panel[]> | null = null;

/** panels — the discovered facet catalog. Empty until loadPanels resolves. */
export function panels(): readonly Panel[] {
  return PANELS;
}

export async function loadPanels(): Promise<Panel[]> {
  if (panelsLoaded) return panelsLoaded;
  panelsLoaded = (async () => {
    const out: Panel[] = [];
    try {
      const schemas = await fetchAllSchemas();
      for (const meta of schemas) {
        const listPath = meta.paths?.list;
        if (!listPath) continue; // embedded / sub-rule — not a top-level panel
        const m = listPath.match(/\/([^/]+)$/);
        if (!m) continue;
        out.push({
          kind: m[1]! as SpecKind,
          title: meta.label,
          canCreate: !!meta.paths?.create,
          canDelete: !!meta.paths?.delete,
        });
      }
    } catch {
      // Schema endpoint unavailable — no panels THIS attempt. Reset the
      // cache so the next call retries instead of replaying the failure
      // forever (#390: a transient schema fetch used to dead-mount the
      // Specs view until a full page reload).
      panelsLoaded = null;
    }
    PANELS = out;
    return out;
  })();
  try {
    return await panelsLoaded;
  } catch (e) {
    panelsLoaded = null;
    throw e;
  }
}

// kindTitleFor maps a SpecKind back to a human title. Reads the
// schema-loaded PANELS cache; falls back to a humanized slug when the
// cache hasn't loaded yet (e.g. a deep link to a detail drawer that
// fires before the Specs tab mounts).
export function kindTitleFor(kind: SpecKind): string {
  const panel = PANELS.find((p) => p.kind === kind);
  if (panel) return panel.title;
  // Humanize the slug: "qos-policies" → "Qos policies", "ipvpns" → "Ipvpns".
  // Operator sees the canonical label as soon as the schema cache loads.
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, " ");
}

/** specsViewDegraded — true when the schema never loaded (empty PANELS): the
 *  view mounted dead (#390). The tab dispatcher re-mounts on activation while
 *  this holds, and the error state offers an explicit Retry. */
export function specsViewDegraded(): boolean {
  return PANELS.length === 0;
}

// Spec facets grouped into operator-domain categories. Newtcon owns
// the grouping (UX policy — what's a Service vs. a Policy is editorial),
// but the panels within each group come from the schema-derived PANELS
// list. Any panel kind not named here lands in the "Other" fallback
// group so a new kind newtron registers still appears in the UI.
const SPEC_GROUPS: { id: string; label: string; kinds: SpecKind[] }[] = [
  { id: "services",  label: "Services",         kinds: ["services"] },
  // IP-VPN (L3VPN / VRF) + MAC-VPN (L2VPN) are the overlay virtual
  // networks a service rides on — their own group, not lumped under
  // Services.
  { id: "vpns",      label: "Virtual Networks", kinds: ["ipvpns", "macvpns"] },
  { id: "policies",  label: "Policies",         kinds: ["qos-policies", "filters", "route-policies", "prefix-lists"] },
  { id: "inventory", label: "Inventory",        kinds: ["nodes", "platforms", "zones"] },
];

// resolveGroupings returns the SPEC_GROUPS list extended with an
// "Other" group containing any kind present in PANELS but not named in
// SPEC_GROUPS. Catches new kinds newtron registers between releases.
export function resolveGroupings(): { id: string; label: string; kinds: SpecKind[] }[] {
  const grouped = new Set<string>(SPEC_GROUPS.flatMap((g) => g.kinds));
  const others = PANELS
    .map((p) => p.kind)
    .filter((k) => !grouped.has(k));
  if (others.length === 0) return SPEC_GROUPS;
  return [...SPEC_GROUPS, { id: "other", label: "Other", kinds: others }];
}
