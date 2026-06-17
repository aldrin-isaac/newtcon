// empty-states.ts — pedagogical copy for empty spec facets
// (slice #169.A). Each spec kind gets a one-line concept explanation
// + an optional prerequisite/workflow hint, surfaced when the panel
// list is empty so a new operator can tell what the facet is for and
// what to do next.
//
// Vocabulary discipline: phrasing tracks newtron's published terms
// (services, IP VPN, MAC VPN, VRF, L3 VNI, prefix list, route policy,
// profile, zone, platform). No project-internal jargon leaks here —
// the empty state is the most exposed surface for a new operator and
// the operator-language lens binds it.
//
// Anonymous-mode pedagogy + Topology/Permissions empty states +
// sample-seed flow are separate follow-up slices on #169.

import type { SpecKind } from "./api/newtcon/network.js";

export interface EmptyStateCopy {
  /** Headline — what the operator is looking at. */
  title: string;
  /** One-sentence operator-language explanation of the concept. */
  body: string;
  /**
   * Optional prerequisite or workflow hint. Used when there's
   * something the operator probably needs to do first OR a follow-on
   * that uses this kind.
   */
  hint?: string;
}

const COPY: Partial<Record<SpecKind, EmptyStateCopy>> = {
  services: {
    title: "No services defined yet",
    body: "A service bundles an IP VPN, MAC VPN, QoS policy, and filter set together so the bundle can be applied to interfaces.",
    hint: "You'll usually create an IP VPN or MAC VPN first.",
  },
  ipvpns: {
    title: "No IP VPNs defined yet",
    body: "An IP VPN is a Layer 3 routing domain — a VRF plus an L3 VNI for the VXLAN overlay.",
    hint: "Referenced by service specs with VRF type L3.",
  },
  macvpns: {
    title: "No MAC VPNs defined yet",
    body: "A MAC VPN is a Layer 2 broadcast domain — a VLAN plus a VNI for the VXLAN overlay.",
    hint: "Referenced by service specs with bridged or EVPN-IRB types.",
  },
  "qos-policies": {
    title: "No QoS policies defined yet",
    body: "A QoS policy declares scheduling queues (strict, WRR, WFQ, DWRR) that service specs can reference for per-interface shaping.",
  },
  filters: {
    title: "No filters defined yet",
    body: "A filter is an ordered list of permit / deny rules applied to traffic ingress or egress on a service binding.",
  },
  "prefix-lists": {
    title: "No prefix lists defined yet",
    body: "A prefix list is a named set of IP prefixes that route policies use for matching.",
  },
  "route-policies": {
    title: "No route policies defined yet",
    body: "A route policy is an ordered list of permit / deny statements that filter BGP routes by prefix list or community.",
    hint: "You'll usually create a prefix list first if you want to match on prefixes.",
  },
  profiles: {
    title: "No device profiles defined yet",
    body: "A profile carries a device's identity — management IP, loopback IP, zone, underlay ASN, platform — and applies when newtron registers the device.",
    hint: "Required before a device appears in Topology.",
  },
  zones: {
    title: "No zones defined yet",
    body: "A zone is an operator-defined region (e.g. amer, emea, dc1) that device profiles reference for grouping and filtering.",
  },
  platforms: {
    title: "No platforms defined yet",
    body: "A platform tells newtron how to drive a hardware model — driver name, port-naming convention.",
    hint: "Platforms are declared in newtron's network.json; not editable from newtcon yet.",
  },
};

/**
 * emptyStateFor returns the curated empty-state copy for a kind, or a
 * graceful fallback that still reads as a sentence (so newtcon doesn't
 * crash readability when newtron grows a new spec kind before this map
 * is updated).
 */
export function emptyStateFor(kind: SpecKind): EmptyStateCopy {
  return COPY[kind] ?? {
    title: `No ${kind} defined yet`,
    body: "",
  };
}

/** hasEmptyState returns true when the kind has curated copy. */
export function hasEmptyState(kind: SpecKind): boolean {
  return kind in COPY;
}
