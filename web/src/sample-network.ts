// sample-network.ts — quickstart seed for the empty Services facet
// (slice #169.E). Surfaces a "Load sample" affordance in the
// teaching empty-state so a new operator can populate a small,
// representative pair of specs and see what's possible without
// authoring from scratch.
//
// Design choices:
//
//   - Two specs only: one IP VPN + one Service that references it.
//     Shows the most common newtcon binding (service → IP VPN);
//     resists overwhelming a first-time operator.
//   - Seeds STAGE through the existing pending-changes queue —
//     they appear in green, the operator confirms via the apply-
//     preview modal, and Discard backs out. No surprise mutations.
//   - On reload, skip seeds whose names already exist so a re-load
//     after partial-apply doesn't conflict; report what was skipped.
//   - Pure data + pure planning function — the enqueue call sits in
//     the UI layer so the renderer can react to the result.

import type { SpecKind } from "./api/newtcon/network.js";

export interface SampleSeed {
  kind: SpecKind;
  name: string;
  body: Record<string, unknown>;
  /** Operator-facing one-liner for the post-load confirmation. */
  description: string;
}

/**
 * SAMPLE_SEEDS is the curated quickstart bundle. Values track the
 * field shapes in app.ts specForms for ipvpns + services so they pass
 * newtron's create-validators cleanly. Names are prefixed `sample-`
 * so they're easy to identify and delete.
 */
export const SAMPLE_SEEDS: readonly SampleSeed[] = [
  {
    kind: "ipvpns",
    name: "sample-l3vpn",
    body: {
      name: "sample-l3vpn",
      l3vni: 10000,
      vrf: "sample-vrf",
      description: "Quickstart IP VPN created from the empty-state link.",
    },
    description: "1 IP VPN (sample-l3vpn) — Layer 3 routing domain at L3 VNI 10000",
  },
  {
    kind: "services",
    name: "sample-service",
    body: {
      name: "sample-service",
      type: "irb",
      ipvpn: "sample-l3vpn",
      description: "Quickstart service binding sample-l3vpn — apply to an interface to see traffic.",
    },
    description: "1 service (sample-service) referencing the IP VPN above",
  },
];

/** Per-seed outcome after planLoad runs against existing names. */
export interface SeedPlan {
  seed: SampleSeed;
  /** "queue" → enqueue this seed; "skip" → already exists by name. */
  action: "queue" | "skip";
}

/**
 * planLoad partitions SAMPLE_SEEDS against the operator's current
 * spec names per kind. Pure: no I/O, no staging mutation. The caller
 * passes the existing-names map; planLoad returns one entry per seed
 * with action="queue" (no conflict) or action="skip" (name already
 * exists, don't overwrite).
 *
 * existingByKind keys must include every kind referenced in
 * SAMPLE_SEEDS; missing kinds are treated as empty (no existing
 * names) so the seed queues normally.
 */
export function planLoad(
  existingByKind: ReadonlyMap<SpecKind, ReadonlySet<string>>,
): SeedPlan[] {
  return SAMPLE_SEEDS.map((seed) => {
    const existing = existingByKind.get(seed.kind);
    if (existing && existing.has(seed.name)) {
      return { seed, action: "skip" as const };
    }
    return { seed, action: "queue" as const };
  });
}

/**
 * summarisePlan returns the per-action counts + an operator-readable
 * lines array for the post-load message. Pure — built so the renderer
 * has everything it needs to compose the confirmation without
 * re-walking the plan.
 */
export function summarisePlan(plan: readonly SeedPlan[]): {
  queued: number;
  skipped: number;
  lines: string[];
} {
  const queued = plan.filter((p) => p.action === "queue").length;
  const skipped = plan.filter((p) => p.action === "skip").length;
  const lines: string[] = [];
  for (const p of plan) {
    if (p.action === "queue") lines.push("+ " + p.seed.description);
    else lines.push("− " + p.seed.name + " already exists; skipped");
  }
  return { queued, skipped, lines };
}
