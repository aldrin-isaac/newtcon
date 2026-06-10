// device-status.ts — unified per-device status resolver across substrates.
//
// Phase 2 of the unified-substrate direction: the operator should see one
// per-device state ("running" / "booting" / "down" / "unrealized") without
// caring whether the device is a newtlab VM or physical hardware. The badge
// state is substrate-agnostic; the substrate-specific detail (vm pid +
// ssh_port, or "reachable via newtron probe") lives in the tooltip only.
//
// Source-of-truth order per device:
//   1. newtlab /labs/{network}/status — authoritative for VMs the lab knows
//      about (running, stopped, error; phase indicates mid-boot).
//   2. newtron /info — runtime probe, used only when newtlab has no record of
//      this device. Success means "something is reachable at this name"
//      (typically physical hardware or a lab outside the current view).
//   3. Neither — the device exists in newtron's topology but no substrate
//      is realizing it yet.

import type { LabState } from "./api/newtcon/lab.js";

export type DeviceState = "running" | "booting" | "down" | "unrealized";

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
