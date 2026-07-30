// views/topology/add-link.ts — the Add-link drawer (Spec view's one authoring
// affordance on the canvas).
//
// Each endpoint picker offers the device's FREE (unwired) interfaces from its
// PLATFORM inventory — not just the already-configured topology ports — so any
// platform interface is linkable. A needs-config interface (present in the
// platform, not yet in the node's ports) can be configured with the platform
// defaults inline: submit stages the port config (update-device, which applies
// before the link) alongside the link itself. Host-like devices (no platform
// inventory — newtron#403) fall back to a free-text field.

import { fetchPlatformPorts, fetchSpecDetail } from "../../api/newtcon/network.js";
import { el } from "../../dom.js";
import { comparePorts } from "../../port-config.js";
import { enqueuePortConfig, enqueueTopologyAddLink } from "../../staging.js";

// AddLinkCtx — inputs for the Add-link drawer.
export interface AddLinkCtx {
  deviceNames: string[];
  topology: unknown;        // raw topology: nodes[dev].ports (configured) + links (wired)
  pendingWired: string[];   // pending-link endpoints "device:iface"
  hostLike: Set<string>;
  onSuccess: () => void;
}

export function openAddLinkDrawer(ctx: AddLinkCtx): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, "Topology"));
  content.appendChild(el("h2", { className: "drawer-name" }, "Add link"));

  const raw = (ctx.topology && typeof ctx.topology === "object")
    ? ctx.topology as { nodes?: Record<string, { ports?: Record<string, unknown> }>; links?: { a?: string; z?: string }[] }
    : {};
  const wired = new Set<string>(ctx.pendingWired);
  for (const l of raw.links ?? []) { if (l?.a) wired.add(l.a); if (l?.z) wired.add(l.z); }
  const configuredOf = (dev: string): Set<string> => new Set(Object.keys(raw.nodes?.[dev]?.ports ?? {}));
  const platformCache = new Map<string, { inventory: string[]; template: Record<string, Record<string, unknown>> }>();
  const deviceToPlatform = new Map<string, string>();

  // One endpoint picker: device dropdown + an interface control that adapts to the
  // device (switch → dropdown of free platform interfaces; host-like → free text),
  // plus an inline "configure with defaults" affordance for a needs-config port.
  // Returns resolve() for the submit.
  interface Endpoint { device: string; iface: string; configure?: { iface: string; body: Record<string, unknown> }; }
  const buildEndpointPicker = (label: string): { group: HTMLElement; resolve: () => Endpoint | null } => {
    const group = el("div", { className: "form-group" });
    group.appendChild(el("label", { className: "form-label" }, label));
    const devSelect = el("select", { className: "form-control" }) as HTMLSelectElement;
    devSelect.appendChild(el("option", { value: "" }, "— select device —") as HTMLOptionElement);
    for (const d of ctx.deviceNames) devSelect.appendChild(el("option", { value: d }, d) as HTMLOptionElement);
    group.appendChild(devSelect);

    const ifaceWrap = el("div", { className: "link-iface-wrap" });
    const cfgWrap = el("div", { className: "link-configure-wrap" });
    group.appendChild(ifaceWrap);
    group.appendChild(cfgWrap);

    let ifaceCtrl: HTMLSelectElement | HTMLInputElement | null = null;
    let hostFree = false;
    let curTemplate: Record<string, Record<string, unknown>> = {};
    let curConfigured = new Set<string>();
    let cfgCheckbox: HTMLInputElement | null = null;

    const renderConfigureOpt = (): void => {
      cfgWrap.textContent = "";
      cfgCheckbox = null;
      if (hostFree || !ifaceCtrl || ifaceCtrl.tagName !== "SELECT") return;
      const iface = ifaceCtrl.value;
      if (!iface || curConfigured.has(iface)) return; // already configured — nothing to do
      const lbl = el("label", { className: "link-configure-opt" });
      const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
      cb.checked = true;
      cfgCheckbox = cb;
      lbl.appendChild(cb);
      lbl.appendChild(el("span", {}, `Configure ${iface} with platform defaults — it isn't configured yet`));
      cfgWrap.appendChild(lbl);
    };

    const renderIface = async (): Promise<void> => {
      ifaceWrap.textContent = "";
      cfgWrap.textContent = "";
      ifaceCtrl = null; hostFree = false; cfgCheckbox = null;
      const dev = devSelect.value;
      const mkInput = (ph: string, disabled = false): HTMLInputElement => {
        const inp = el("input", { className: "form-control", type: "text", autocomplete: "off", placeholder: ph }) as HTMLInputElement;
        inp.disabled = disabled;
        return inp;
      };
      if (!dev) { ifaceWrap.appendChild(mkInput("select a device first", true)); return; }
      if (ctx.hostLike.has(dev)) {
        hostFree = true;
        ifaceCtrl = mkInput("interface, e.g. eth0");
        ifaceWrap.appendChild(ifaceCtrl);
        return;
      }
      ifaceWrap.appendChild(el("p", { className: "iface-view-loading" }, "Loading interfaces…"));
      try {
        let platform = deviceToPlatform.get(dev);
        if (platform === undefined) {
          platform = ((await fetchSpecDetail("nodes", dev)) as { platform?: string }).platform ?? "";
          deviceToPlatform.set(dev, platform);
        }
        let pc = platformCache.get(platform);
        if (!pc) {
          const [pd, tmpl] = await Promise.all([
            fetchSpecDetail("platforms", platform).catch(() => null),
            fetchPlatformPorts(platform).catch(() => ({})),
          ]);
          const inventory = ((pd as { ports?: { name?: string }[] } | null)?.ports ?? [])
            .map((p) => p.name ?? "").filter(Boolean).sort(comparePorts);
          pc = { inventory, template: tmpl as Record<string, Record<string, unknown>> };
          platformCache.set(platform, pc);
        }
        if (devSelect.value !== dev) return; // selection changed while awaiting
        curTemplate = pc.template;
        curConfigured = configuredOf(dev);
        const available = pc.inventory.filter((i) => !wired.has(`${dev}:${i}`));
        ifaceWrap.textContent = "";
        if (available.length === 0) {
          ifaceWrap.appendChild(mkInput(pc.inventory.length ? "every interface is already wired" : "platform declares no interfaces (newtron#403)", true));
          return;
        }
        const sel = el("select", { className: "form-control" }) as HTMLSelectElement;
        sel.appendChild(el("option", { value: "" }, "— select interface —") as HTMLOptionElement);
        for (const i of available) {
          sel.appendChild(el("option", { value: i }, curConfigured.has(i) ? i : `${i} · needs config`) as HTMLOptionElement);
        }
        sel.addEventListener("change", renderConfigureOpt);
        ifaceCtrl = sel;
        ifaceWrap.appendChild(sel);
      } catch {
        ifaceWrap.textContent = "";
        hostFree = true; // fall back to free-text on fetch failure
        ifaceCtrl = mkInput("interface name");
        ifaceWrap.appendChild(ifaceCtrl);
      }
    };
    devSelect.addEventListener("change", () => void renderIface());
    void renderIface();

    const resolve = (): Endpoint | null => {
      const device = devSelect.value;
      const iface = (ifaceCtrl?.value ?? "").trim();
      if (!device || !iface) return null;
      const ep: Endpoint = { device, iface };
      if (!hostFree && !curConfigured.has(iface) && cfgCheckbox?.checked) {
        ep.configure = { iface, body: { ...(curTemplate[iface] ?? {}) } };
      }
      return ep;
    };
    return { group, resolve };
  };

  const aPick = buildEndpointPicker("Endpoint A (device + interface)");
  const zPick = buildEndpointPicker("Endpoint Z (device + interface)");
  content.appendChild(aPick.group);
  content.appendChild(zPick.group);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);
  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Add link");
  content.appendChild(submitBtn);

  submitBtn.addEventListener("click", () => {
    errorOut.textContent = "";
    const a = aPick.resolve();
    const z = zPick.resolve();
    if (!a || !z) {
      errorOut.appendChild(el("p", { className: "panel-error" }, "Both endpoints (device and interface) are required."));
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Queued";
    try {
      // Stage the port config for any needs-config endpoint first (update-device
      // applies before the link), then the link itself.
      const configured: string[] = [];
      for (const e of [a, z]) {
        if (e.configure) {
          enqueuePortConfig(e.device, e.configure.iface, e.configure.body, (raw.nodes?.[e.device] as Record<string, unknown>) ?? {});
          configured.push(`${e.device}:${e.configure.iface}`);
        }
      }
      enqueueTopologyAddLink(`${a.device}:${a.iface}`, `${z.device}:${z.iface}`);
      const note = configured.length ? ` — configured ${configured.join(", ")}` : "";
      content.insertBefore(el("p", { className: "form-success" }, `Link queued${note}. Click Save in the header to apply.`), submitBtn);
      ctx.onSuccess();
      setTimeout(() => {
        drawer.setAttribute("aria-hidden", "true");
        drawer.classList.remove("open");
      }, 900);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add link";
      errorOut.appendChild(el("p", { className: "panel-error" }, String(err)));
    }
  });
}
