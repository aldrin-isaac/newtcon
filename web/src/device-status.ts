// device-status.ts — unified per-device status resolver across substrates.
//
// Phase 2 of the unified-substrate direction: the operator should see one
// per-device state without caring whether the device is a newtlab VM or physical
// hardware. States:
//   running     — realized AND reachable (the operator can read live state)
//   booting     — realized, mid-boot
//   unreachable — realized (VM process up) but the live probe FAILED: newtron
//                 can't read the device (stale deploy, mgmt down, mid-provision).
//                 Distinct from "running" (the process is alive but useless for
//                 reads) and from "down" (the VM isn't stopped).
//   down        — the VM is stopped / errored
//   unrealized  — exists in newtron's topology but no substrate realizes it
//
// The badge state is substrate-agnostic; substrate detail lives in the tooltip.
//
// Source-of-truth per device:
//   1. newtlab /labs/{network}/status — authoritative that a VM EXISTS + its
//      process state (running/stopped/error; phase = mid-boot).
//   2. newtron /info probe (`online`) — REACHABILITY. Folded into a lab-running
//      device (running vs unreachable) AND the sole signal when newtlab has no
//      record (physical hardware / a lab outside the current view).
//   3. Neither — unrealized.

import type { LabState } from "./api/newtcon/lab.js";

export type DeviceState = "running" | "booting" | "unreachable" | "down" | "unrealized";

export interface DeviceStatus {
  state: DeviceState;
  /** Short tooltip text. Surfaces substrate hint + lifecycle detail. */
  detail: string;
}

export function resolveDeviceStatus(
  device: string,
  labState: LabState | null,
  online: boolean | undefined,
): DeviceStatus {
  const labNode = labState?.nodes?.[device];
  if (labNode) {
    if (labNode.status === "running") {
      if (labNode.phase) {
        return { state: "booting", detail: `lab VM — ${labNode.phase}` };
      }
      const ports: string[] = [];
      if (labNode.ssh_port) ports.push(`ssh :${labNode.ssh_port}`);
      if (labNode.console_port) ports.push(`console :${labNode.console_port}`);
      const portDetail = ports.length > 0 ? ` — ${ports.join(", ")}` : "";
      // The VM process is up — but "running" should mean the operator can actually
      // read the device. If the live /info probe DEFINITIVELY failed, the process
      // is alive yet newtron can't reach it (stale/mismatched deploy, mgmt down,
      // mid-provision): a distinct "unreachable", not a green "running". An
      // undefined probe (in flight / not run) stays optimistically "running".
      if (online === false) {
        return { state: "unreachable", detail: `lab VM up (pid ${labNode.pid})${portDetail} — but newtron can't read its live state` };
      }
      return { state: "running", detail: `lab VM (pid ${labNode.pid})${portDetail}` };
    }
    if (labNode.status === "stopped") {
      return { state: "down", detail: "lab VM stopped" };
    }
    // "error" or any other newtlab-reported status
    return { state: "down", detail: `lab VM ${labNode.status}` };
  }
  // No lab record for this device — fall back to runtime probe.
  if (online === true) {
    return { state: "running", detail: "reachable via newtron probe (not a lab VM)" };
  }
  if (online === false) {
    return { state: "unrealized", detail: "no lab VM; newtron probe failed" };
  }
  return { state: "unrealized", detail: "probe in flight…" };
}
