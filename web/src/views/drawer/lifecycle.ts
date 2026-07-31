// views/drawer/lifecycle.ts — the drawer's substrate section: state pill,
// lab-VM Start/Stop, and SSH/console snippets.
//
// Substrate-agnostic state + substrate-aware actions:
//   - Lab VM running   → Stop button + SSH/console snippets
//   - Lab VM stopped   → Start button
//   - Lab VM booting   → state pill only (transition in progress)
//   - Not realized     → guidance text pointing at "Deploy as lab"
//   - Reachable via probe (not lab) → state pill only (start/stop n/a)
//
// The section is view-mode-aware so it matches the operator's intent: Physical
// view inspects the physical substrate only (a coincidentally-running lab VM of
// the same name must not bleed in), Spec view shows intent only, Lab view gets
// the full VM surface.

import { type LabState, fetchLabStatus, postLabStartNode, postLabStopNode } from "../../api/newtcon/lab.js";
import { fetchNodeInfo } from "../../api/newtcon/nodes.js";
import { ApiError } from "../../api/newtcon/services.js";
import { confirmInline } from "../../confirm-inline.js";
import { resolveDeviceStatus } from "../../device-status.js";
import { el } from "../../dom.js";
import { activeNetwork } from "../../network-switcher.js";
import { engineOpErrorBody, extractUnderlyingMessage } from "../../render-error.js";
import { showToast } from "../../toast.js";
import { type TopologyViewMode } from "../../topology-view-mode.js";
import { isProvisioning } from "../topology/index.js";

// engineOpErrorBody: for newtlab lifecycle ops (deploy / provision / destroy),
// prefer newtron's real underlying error — e.g. a reconcile failure
// "…DEVICE_METADATA|localhost not found in CONFIG_DB" (device booted but SONiC
// config uninitialised, so Provision can't bootstrap it) — over newtcon's generic
// "upstream unreachable" wrapper, which points the operator at the wrong thing.
export async function renderLifecycleSection(host: HTMLElement, device: string, viewMode?: TopologyViewMode): Promise<void> {
  host.textContent = "";
  // Section label reflects the substrate the drawer is showing — same
  // operator-intent framing as the topology view chips. Default
  // ("Lifecycle") covers the cases where the drawer is opened outside
  // a view-mode context.
  const sectionLabel = viewMode === "spec-physical" ? "Physical state"
    : viewMode === "spec-lab" ? "Lab VM"
    : viewMode === "spec" ? "Spec"
    : "Lifecycle";
  host.appendChild(el("p", { className: "lifecycle-header" }, sectionLabel));
  const body = el("div", { className: "lifecycle-body" });
  body.appendChild(el("p", { className: "lifecycle-loading" }, "Checking substrate…"));
  host.appendChild(body);

  const network = activeNetwork();
  let labState: LabState | null = null;
  // Physical view inspects the physical substrate only — don't even
  // fetch lab state, so a coincidentally-running lab VM with the same
  // name can't bleed VM details into the drawer. Same principle for
  // Spec view (intent only, no actuation).
  if (viewMode !== "spec-physical" && viewMode !== "spec") {
    try { labState = await fetchLabStatus(network); } catch { /* lab unknown */ }
  }
  let online: boolean | undefined;
  let probeErr: unknown;
  try { await fetchNodeInfo(device); online = true; } catch (e) { online = false; probeErr = e; }

  const status = resolveDeviceStatus(device, labState, online, isProvisioning(network));
  const labNode = labState?.nodes?.[device];

  body.textContent = "";

  // Spec view: intent only. Show a single hint that the device is
  // declared but no actuation overlay is being requested here.
  if (viewMode === "spec") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `${device} is declared in this network's topology spec. Switch to Lab or Physical to inspect actuation state.`));
    return;
  }

  // Physical view: physical-substrate state only. Skip the lab pill
  // and any VM affordances even when a lab happens to be running.
  if (viewMode === "spec-physical") {
    const pill = el("div", { className: `lifecycle-pill lifecycle-pill--${online ? "running" : "down"}` });
    pill.appendChild(el("span", { className: "lifecycle-pill-state" }, online ? "online" : "offline"));
    pill.appendChild(el("span", { className: "lifecycle-pill-detail" },
      online ? "physical device reachable" : "no response from device"));
    body.appendChild(pill);
    if (!online) {
      body.appendChild(el("p", { className: "lifecycle-hint" },
        `Newtron's /info probe got no response from ${device}. The device may be unreachable, not yet provisioned, or running but firewalled.`));
    }
    return;
  }

  // Lab view (and the default "Lifecycle" fallback path for legacy
  // openNodeDrawer callers) — show the substrate pill, lab VM
  // controls, and SSH/console snippets.
  const pill = el("div", { className: `lifecycle-pill lifecycle-pill--${status.state}` });
  pill.appendChild(el("span", { className: "lifecycle-pill-state" }, status.state));
  pill.appendChild(el("span", { className: "lifecycle-pill-detail" }, status.detail));
  body.appendChild(pill);

  if (status.state === "unrealized") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `No substrate is realizing ${device} yet. Switch to the Lab view and click "Deploy" to deploy this network as VMs.`));
    return;
  }

  if (status.state === "unreachable") {
    // Surface the REAL cause. newtcon classifies newtron's http_5xx as
    // "newtron_unavailable", but newtron is up — the device is. The genuinely
    // useful detail (e.g. "DEVICE_METADATA|localhost not found in CONFIG_DB" →
    // the device is booted but SONiC config isn't initialized) lives in the
    // probe error's underlying_error_message, not the generic "upstream
    // unreachable" wrapper.
    const reason = probeErr instanceof ApiError ? extractUnderlyingMessage(probeErr.details) : null;
    const hint = el("p", { className: "lifecycle-hint" },
      `${device}'s VM is running, but newtron can't read its live state. You can still stop the VM or SSH in to investigate.`);
    body.appendChild(hint);
    if (reason) {
      body.appendChild(el("p", { className: "lifecycle-hint lifecycle-hint--detail" },
        `newtron reports: ${reason}`));
    }
  }

  if (status.state === "provisioning") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `${device} is being provisioned — newtron is pushing config + restarting containers. Live reads pause until it completes; the status returns to running automatically.`));
  }

  // Start/Stop — only meaningful for lab-managed VMs.
  if (labNode) {
    const actions = el("div", { className: "lifecycle-actions" });
    if (status.state === "running" || status.state === "booting" || status.state === "unreachable" || status.state === "provisioning") {
      const stop = el("button", { type: "button", className: "btn btn-danger btn-sm" }, "Stop VM");
      stop.addEventListener("click", async () => {
        const ok = await confirmInline({
          title: `Stop VM "${device}"?`,
          body: `In lab "${network}". The device will go offline.`,
          danger: true,
          confirmLabel: "Stop",
        });
        if (!ok) return;
        stop.setAttribute("disabled", "");
        stop.textContent = "Stopping…";
        postLabStopNode(network, device)
          .then(() => renderLifecycleSection(host, device, viewMode))
          .catch((err) => {
            stop.removeAttribute("disabled");
            stop.textContent = "Stop VM";
            showToast({ kind: "error", title: "Stop failed", body: engineOpErrorBody(err) });
          });
      });
      actions.appendChild(stop);
    }
    if (status.state === "down") {
      const start = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Start VM");
      start.addEventListener("click", () => {
        start.setAttribute("disabled", "");
        start.textContent = "Starting…";
        postLabStartNode(network, device)
          .then(() => renderLifecycleSection(host, device, viewMode))
          .catch((err) => {
            start.removeAttribute("disabled");
            start.textContent = "Start VM";
            showToast({ kind: "error", title: "Start failed", body: engineOpErrorBody(err) });
          });
      });
      actions.appendChild(start);
    }
    body.appendChild(actions);

    // SSH/console snippets — only when the VM is up and ports are known
    // (incl. unreachable: the VM is up, so SSH is exactly how you'd investigate).
    if ((status.state === "running" || status.state === "unreachable") && labNode.ssh_port) {
      const sshUser = labNode.ssh_user || "admin";
      const sshCmd = `ssh -p ${labNode.ssh_port} ${sshUser}@localhost`;
      body.appendChild(buildCopyRow("SSH", sshCmd));
    }
    if (labNode.console_port) {
      const consoleCmd = `telnet localhost ${labNode.console_port}`;
      body.appendChild(buildCopyRow("Console", consoleCmd));
    }
  }
}

function buildCopyRow(label: string, value: string): HTMLElement {
  const row = el("div", { className: "lifecycle-snippet" });
  row.appendChild(el("span", { className: "lifecycle-snippet-label" }, label));
  const code = el("code", { className: "lifecycle-snippet-value" }, value);
  row.appendChild(code);
  const copyBtn = el("button", {
    type: "button",
    className: "btn btn-ghost btn-sm lifecycle-snippet-copy",
    title: `Copy ${label.toLowerCase()} command`,
  }, "Copy");
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(value).then(() => {
      const orig = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      window.setTimeout(() => { copyBtn.textContent = orig; }, 1200);
    });
  });
  row.appendChild(copyBtn);
  return row;
}
