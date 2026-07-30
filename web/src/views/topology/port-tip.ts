// views/topology/port-tip.ts — the fast hover tip for canvas dots.
//
// Native SVG <title> has a ~1s browser-controlled delay, which reads as the
// canvas being unresponsive. This is a custom overlay that shows instantly and
// follows the cursor; the element's aria-label preserves the screen-reader path.
//
// One singleton div is reused for every dot — attaching a tip per element would
// leak a node per link end on every re-render.

import { el } from "../../dom.js";
import { type PortState } from "../../topology-links.js";

let topoTipEl: HTMLDivElement | null = null;

function topoTip(): HTMLDivElement {
  if (topoTipEl) return topoTipEl;
  topoTipEl = document.createElement("div");
  topoTipEl.className = "topo-tip";
  topoTipEl.hidden = true;
  document.body.appendChild(topoTipEl);
  return topoTipEl;
}

export function attachFastTip(node: Element, build: () => HTMLElement): void {
  node.addEventListener("mouseenter", () => { const t = topoTip(); t.replaceChildren(build()); t.hidden = false; });
  node.addEventListener("mousemove", (e) => {
    const t = topoTip(); const ev = e as MouseEvent;
    t.style.left = `${ev.clientX + 14}px`;
    t.style.top = `${ev.clientY + 16}px`;
  });
  node.addEventListener("mouseleave", () => { if (topoTipEl) topoTipEl.hidden = true; });
}

function fmtSpeed(mbps?: number): string | undefined {
  if (mbps === undefined) return undefined;
  return mbps >= 1000 && mbps % 1000 === 0 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`;
}

// buildPortTip — the elegant interface tooltip: a status-dotted header with
// the port name, then quiet label/value rows. State drives the header dot +
// the admin/oper value color.
export function buildPortTip(iface: string, st: PortState | undefined, state: string, members?: string[]): HTMLElement {
  const wrap = el("div", { className: "topo-tip-card" });
  const head = el("div", { className: "topo-tip-head" });
  head.append(el("span", { className: `topo-tip-dot topo-tip-dot--${state}` }), el("span", { className: "topo-tip-name" }, iface));
  wrap.appendChild(head);
  const kv = el("dl", { className: "topo-tip-kv" });
  const row = (k: string, v: string | undefined, cls?: string): void => {
    if (v === undefined) return;
    kv.append(el("dt", {}, k), el("dd", { className: cls ?? "" }, v));
  };
  const upCls = (v?: string): string => (v ? (/^(up|1|true)$/i.test(v) ? "topo-tip-up" : "topo-tip-down") : "");
  row("admin", st?.admin, upCls(st?.admin));
  row("oper", st?.oper, upCls(st?.oper));
  row("speed", fmtSpeed(st?.speedMbps));
  row("mtu", st?.mtu);
  // A PortChannel bundles physical ports — name them so the operator sees what
  // the aggregate actually carries. Physical ports never have members.
  if (members && members.length > 0) {
    row(members.length === 1 ? "member" : `members (${members.length})`, members.join(", "), "topo-tip-members");
  }
  wrap.appendChild(kv);
  return wrap;
}
