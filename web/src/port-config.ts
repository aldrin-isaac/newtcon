// port-config.ts — pure helpers for the schema-driven port-config flow.
//
// Two distinct "ports" concepts (newtron platform-port model):
//   - platform inventory ports — the MENU: every front-panel port a platform
//     has (name + nic_index + optional speed/lanes), generated at onboarding.
//   - topology device ports — the CHOSEN SUBSET: per-port config (admin_status,
//     mtu, speed, …) the operator authored on a concrete device.
//
// The inventory is the source of truth for what ports exist; newtcon persists
// only configured ports to the topology device (`topology.Ports ⊆ platform.Ports`
// by construction). The config FORM is schema-driven (kind PortConfig, rendered by
// the device drawer's per-port "Properties" action) — these helpers only order
// port names numerically and merge a chosen port's config into a device body for
// the whole-device write-back. No I/O, no DOM.

export interface PlatformPort {
  name: string;
  nic_index?: number;
  speed?: string;
  lanes?: number[];
}

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
