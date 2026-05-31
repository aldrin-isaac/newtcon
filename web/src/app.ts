// app.ts — newtcon workspace entry. Fetches every spec type in parallel and
// renders a panel per kind.

import { fetchSpecList, type SpecKind } from "./api/newtcon/network.js";
import { ApiError } from "./api/newtcon/services.js";

interface Panel {
  kind: SpecKind;
  title: string;
}

const PANELS: Panel[] = [
  { kind: "services", title: "Services" },
  { kind: "ipvpns", title: "IP VPNs" },
  { kind: "macvpns", title: "MAC VPNs" },
  { kind: "qos-policies", title: "QoS policies" },
  { kind: "filters", title: "Filters" },
  { kind: "route-policies", title: "Route policies" },
  { kind: "prefix-lists", title: "Prefix lists" },
  { kind: "profiles", title: "Device profiles" },
  { kind: "zones", title: "Zones" },
  { kind: "platforms", title: "Platforms" },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function renderPanel(panel: Panel, result: PromiseSettledResult<string[]>): HTMLElement {
  const container = el("section", { className: "panel" });
  const header = el("div", { className: "panel-header" });
  header.appendChild(el("h2", { className: "panel-title" }, panel.title));

  if (result.status === "fulfilled") {
    const items = result.value;
    header.appendChild(el("span", { className: "panel-count" }, String(items.length)));
    container.appendChild(header);

    if (items.length === 0) {
      container.appendChild(el("p", { className: "panel-empty" }, "none defined"));
    } else {
      const list = el("ul", { className: "panel-list" });
      for (const name of items) list.appendChild(el("li", {}, name));
      container.appendChild(list);
    }
    return container;
  }

  // rejected
  container.appendChild(header);
  const err = result.reason;
  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    container.appendChild(el("p", { className: "panel-error" }, "newtron is unreachable"));
    const detailObj = err.details as { underlying_error_message?: string } | undefined;
    const detail = detailObj?.underlying_error_message ?? err.message;
    container.appendChild(el("p", { className: "panel-error-detail" }, detail));
  } else if (err instanceof ApiError) {
    container.appendChild(el("p", { className: "panel-error" }, err.message));
  } else {
    container.appendChild(el("p", { className: "panel-error" }, "request failed"));
    container.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
  }
  return container;
}

async function mount(): Promise<void> {
  const root = document.getElementById("workspace-root");
  if (!root) return;

  // Surface the configured newtron URL in the footer.
  fetch("/api/health", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const target = document.getElementById("newtron-target");
      const url = data?.newtron_url ?? data?.dependencies?.newtron?.url;
      if (target && typeof url === "string" && url.length > 0) {
        target.textContent = url;
      }
    })
    .catch(() => {
      /* footer just shows "—" */
    });

  const results = await Promise.allSettled(PANELS.map((p) => fetchSpecList(p.kind)));

  root.textContent = "";
  PANELS.forEach((panel, i) => {
    root.appendChild(renderPanel(panel, results[i]));
  });
}

mount();
