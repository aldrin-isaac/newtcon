// topology-filters.ts — layered filters for the Topology view
// (slice #174.E). Operator selects one or more zones; non-matching
// devices dim out so the rest of the graph still provides context.
//
// Zone is the v1 dimension because it's the operator-natural concept
// for "what part of the network do I care about right now" and the data
// is cheap (one read of the profiles list — same trip already needed for
// device metadata in other parts of the UI). VRF and service membership
// are deferred — both require traversal of richer data than profiles
// expose, and the filter shape here is designed to extend cleanly when
// those land.

export interface DeviceMetadata {
  /** Profile zone field. null when the device has no profile or the profile lacks a zone. */
  zone: string | null;
}

export interface TopologyFilter {
  /** Selected zones. Empty set = no zone constraint (everything matches). */
  zones: Set<string>;
}

export function emptyFilter(): TopologyFilter {
  return { zones: new Set() };
}

/** isActive returns true when the filter narrows anything. */
export function isActive(filter: TopologyFilter): boolean {
  return filter.zones.size > 0;
}

/**
 * matchesFilter decides whether a device passes the filter.
 *
 *   Inactive filter (no dimensions set) → every device matches.
 *   Active zone filter → device must have a zone in the selected set.
 *                        Devices missing zone metadata do NOT match an
 *                        active filter — invisible-because-unknown is
 *                        more honest than implicit-pass.
 */
export function matchesFilter(
  deviceName: string,
  filter: TopologyFilter,
  metadata: Map<string, DeviceMetadata>,
): boolean {
  if (!isActive(filter)) return true;
  const meta = metadata.get(deviceName);
  if (filter.zones.size > 0) {
    if (!meta || meta.zone === null) return false;
    if (!filter.zones.has(meta.zone)) return false;
  }
  return true;
}

export interface FilterResult {
  /** Device names that pass the filter (or all device names when filter inactive). */
  visible: Set<string>;
  /** Device names dimmed out by an active filter (empty when filter inactive). */
  hidden: Set<string>;
}

/**
 * applyFilter partitions a device-name list into visible vs hidden.
 * When the filter is inactive, every device is visible and `hidden` is
 * empty — the renderer can short-circuit dim styling on that signal.
 */
export function applyFilter(
  filter: TopologyFilter,
  deviceNames: readonly string[],
  metadata: Map<string, DeviceMetadata>,
): FilterResult {
  const visible = new Set<string>();
  const hidden = new Set<string>();
  if (!isActive(filter)) {
    for (const n of deviceNames) visible.add(n);
    return { visible, hidden };
  }
  for (const n of deviceNames) {
    if (matchesFilter(n, filter, metadata)) visible.add(n);
    else hidden.add(n);
  }
  return { visible, hidden };
}

/**
 * uniqueZones extracts the sorted unique zone values present in the
 * metadata map. Devices with null zone are skipped. Used to drive the
 * filter chip UI — only render chips for zones that actually appear.
 */
export function uniqueZones(metadata: Map<string, DeviceMetadata>): string[] {
  const zones = new Set<string>();
  for (const m of metadata.values()) {
    if (m.zone !== null) zones.add(m.zone);
  }
  return [...zones].sort();
}
