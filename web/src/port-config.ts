// port-config.ts — pure helpers for the schema-driven port-config flow.
//
// Two distinct "ports" concepts (newtron platform-port model):
//   - platform inventory ports — the MENU: every front-panel port a platform
//     has (name + nic_index + optional speed/lanes), generated at onboarding.
//   - topology device ports — the CHOSEN SUBSET: per-port config (admin_status,
//     mtu, speed, …) the operator authored on a concrete device.
//
// The inventory is the source of truth for what ports exist, so newtcon offers
// the inventory as the picker and persists only configured ports to the
// topology device (`topology.Ports ⊆ platform.Ports` by construction). The
// config FORM is schema-driven (kind PortConfig) — these helpers only shape the
// picker and merge a chosen port's config into a device body for the
// whole-device write-back. No I/O, no DOM.

export interface PlatformPort {
  name: string;
  nic_index?: number;
  speed?: string;
  lanes?: number[];
}

// A device's topology entry — provisioning steps + per-port config map.
// Ports are kept opaque (Record<string, unknown>) here: the field set is the
// PortConfig schema's concern, not this module's.
export interface TopoDevice {
  steps?: unknown[];
  ports?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

export type PortStatus = "unconfigured" | "configured" | "pending";

export interface PickerPort {
  name: string;
  /** Inventory speed — used to pre-fill the form's speed field. */
  speed?: string;
  /** committed in topology / staged-pending / not yet configured. */
  status: PortStatus;
  /** Current config for a configured or pending port (for edit prefill). */
  config?: Record<string, unknown>;
}

const has = (o: Record<string, unknown>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/**
 * buildPicker lists every inventory port as a configurable row, marking the
 * ones already configured in the committed topology and the ones with a staged
 * (pending) config. Pending wins over committed (it's the newer intent). Only
 * inventory ports appear, so the operator can never author a port the platform
 * doesn't have.
 */
export function buildPicker(
  inventory: readonly PlatformPort[],
  committed: Record<string, Record<string, unknown>> | undefined,
  pending: Record<string, Record<string, unknown>> | undefined,
): PickerPort[] {
  const com = committed ?? {};
  const pen = pending ?? {};
  return inventory.map((p) => {
    const inPending = has(pen, p.name);
    const inCommitted = has(com, p.name);
    const status: PortStatus = inPending ? "pending" : inCommitted ? "configured" : "unconfigured";
    const config = inPending ? pen[p.name] : inCommitted ? com[p.name] : undefined;
    const out: PickerPort = { name: p.name, status };
    if (p.speed !== undefined) out.speed = p.speed;
    if (config !== undefined) out.config = config;
    return out;
  });
}

/**
 * mergePort returns a new device body with `config` set at `port` in its ports
 * map — immutable; steps and sibling ports preserved. The whole-device PUT is a
 * full replace, so callers stage the *merged* device, never a lone port.
 */
export function mergePort(
  device: TopoDevice | undefined,
  port: string,
  config: Record<string, unknown>,
): TopoDevice {
  const base = device ?? {};
  const ports = { ...(base.ports ?? {}) };
  ports[port] = config;
  return { ...base, ports };
}

/**
 * prefillForPort returns the PortConfig form prefill for a picked port: its
 * existing config when editing a configured/pending port, otherwise the
 * inventory speed as a sensible starting value. The `port` identifier is NOT
 * included — it's the ports-map key (chosen via the picker), not a body field.
 */
export function prefillForPort(picked: PickerPort): Record<string, unknown> {
  if (picked.config && Object.keys(picked.config).length > 0) {
    return { ...picked.config };
  }
  return picked.speed ? { speed: picked.speed } : {};
}
