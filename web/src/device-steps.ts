// device-steps.ts — THE topology step-parser (console-uplift 1.5, #389).
//
// A topology device entry carries `steps`: the declared provisioning intent
// newtron replays (/setup-device, /create-vlan, /bind-macvpn,
// /interfaces/{iface}/apply-service|configure-interface|add-trunk-vlan, …).
// Three modules used to parse that array independently (device-interfaces,
// device-resources, irb-interfaces) — three copies of the same guards and
// URL decomposition. This module is now the single source: it normalizes
// each raw step (object/url/params guards, spec_name capture, interface-verb
// URL split) and the consumers keep only their domain logic.

export interface DeviceStep {
  /** The raw step URL ("/interfaces/Ethernet0/apply-service"). */
  url: string;
  /** The step's params object ({} when absent/malformed). */
  params: Record<string, unknown>;
  /** step.spec_name when present (the owning spec, e.g. the service name). */
  specName?: string;
  /** For /interfaces/{iface}/{verb} steps: the interface. */
  iface?: string;
  /** The step verb: trailing segment for interface steps
   *  ("apply-service"), the bare path otherwise ("create-vlan"). */
  verb: string;
}

/** parseDeviceSteps normalizes a device entry's raw steps array. Tolerant of
 *  malformed input — non-objects and step-less entries yield []. */
export function parseDeviceSteps(steps: unknown): DeviceStep[] {
  if (!Array.isArray(steps)) return [];
  const out: DeviceStep[] = [];
  for (const raw of steps) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    const url = typeof step.url === "string" ? step.url : "";
    if (!url) continue;
    const params = step.params && typeof step.params === "object"
      ? step.params as Record<string, unknown> : {};
    const parsed: DeviceStep = { url, params, verb: url.replace(/^\//, "") };
    if (typeof step.spec_name === "string" && step.spec_name !== "") parsed.specName = step.spec_name;
    const m = url.match(/^\/interfaces\/(.+?)\/([a-z-]+)$/);
    if (m) { parsed.iface = m[1]!; parsed.verb = m[2]!; }
    out.push(parsed);
  }
  return out;
}
