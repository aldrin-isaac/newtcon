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
// picker, order port names numerically, and merge a chosen port's config into a
// device body for the whole-device write-back. No I/O, no DOM.

export interface PlatformPort {
  name: string;
  nic_index?: number;
  speed?: string;
  lanes?: number[];
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
 * comparePorts orders interface names numerically by their embedded numbers
 * (Ethernet0 < Ethernet4 < … < Ethernet124; ge-0/0/0 < ge-0/0/10), so port
 * lists sort low→high instead of lexicographically (which puts Ethernet100
 * before Ethernet12). Splits each name into alternating text / number chunks
 * and compares chunk-wise; numeric chunks compare as numbers.
 */
export function comparePorts(a: string, b: string): number {
  const chunks = (s: string): Array<string | number> =>
    (s.match(/\d+|\D+/g) ?? []).map((c) => (/^\d+$/.test(c) ? parseInt(c, 10) : c));
  const ax = chunks(a);
  const bx = chunks(b);
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i]!;
    const y = bx[i]!;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs !== ys) return xs < ys ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/**
 * buildPicker lists every inventory port as a configurable row, marking the
 * ones already configured in the committed topology and the ones with a staged
 * (pending) config. Pending wins over committed (it's the newer intent). Rows
 * are returned numerically ordered (comparePorts), independent of the
 * inventory's array order. Only inventory ports appear, so the operator can
 * never author a port the platform doesn't have.
 */
export function buildPicker(
  inventory: readonly PlatformPort[],
  committed: Record<string, Record<string, unknown>> | undefined,
  pending: Record<string, Record<string, unknown>> | undefined,
): PickerPort[] {
  const com = committed ?? {};
  const pen = pending ?? {};
  return inventory
    .map((p) => {
      const inPending = has(pen, p.name);
      const inCommitted = has(com, p.name);
      const status: PortStatus = inPending ? "pending" : inCommitted ? "configured" : "unconfigured";
      const config = inPending ? pen[p.name] : inCommitted ? com[p.name] : undefined;
      const out: PickerPort = { name: p.name, status };
      if (p.speed !== undefined) out.speed = p.speed;
      if (config !== undefined) out.config = config;
      return out;
    })
    .sort((a, b) => comparePorts(a.name, b.name));
}

/**
 * mergePort returns a new device body with `config` set at `port` in its ports
 * map — immutable; steps and sibling ports preserved. The whole-device PUT is a
 * full replace, so callers stage the *merged* device, never a lone port. This
 * is the single merge primitive the staging queue uses.
 */
export function mergePort(
  device: Record<string, unknown> | undefined,
  port: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const base = device ?? {};
  const ports = { ...((base.ports as Record<string, unknown>) ?? {}) };
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
