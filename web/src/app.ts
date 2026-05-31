// app.ts — newtcon workspace entry. Fetches every spec type in parallel and
// renders a panel per kind.

import { fetchSpecList, fetchSpecDetail, type SpecKind } from "./api/newtcon/network.js";
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
      for (const name of items) {
        const item = el("li", { className: "panel-list-item", tabIndex: 0 }, name);
        item.dataset.kind = panel.kind;
        item.dataset.name = name;
        item.addEventListener("click", () => openDetail(panel.kind, panel.title, name));
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(panel.kind, panel.title, name);
          }
        });
        list.appendChild(item);
      }
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

// ---- Detail drawer -------------------------------------------------------

function renderValue(value: unknown): HTMLElement | Text {
  if (value === null || value === undefined) {
    return el("span", { className: "detail-null" }, "—");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return el("span", { className: "detail-null" }, "(empty)");
    const list = el("ol", { className: "detail-array" });
    for (const item of value) {
      const li = el("li");
      li.appendChild(renderValue(item));
      list.appendChild(li);
    }
    return list;
  }
  if (typeof value === "object") {
    const dl = el("dl", { className: "detail-object" });
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      dl.appendChild(el("dt", {}, k));
      const dd = el("dd");
      dd.appendChild(renderValue(v));
      dl.appendChild(dd);
    }
    return dl;
  }
  if (typeof value === "boolean") {
    return el("span", { className: "detail-bool" }, value ? "true" : "false");
  }
  return document.createTextNode(String(value));
}

async function openDetail(kind: SpecKind, kindTitle: string, name: string): Promise<void> {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle));
  content.appendChild(el("h2", { className: "drawer-name" }, name));
  const loading = el("p", { className: "status-loading" }, "Loading…");
  content.appendChild(loading);

  try {
    const detail = await fetchSpecDetail(kind, name);
    content.removeChild(loading);
    const body = renderValue(detail);
    if (body instanceof HTMLElement) {
      body.classList.add("drawer-detail");
    }
    content.appendChild(body);
  } catch (err) {
    content.removeChild(loading);
    if (err instanceof ApiError && err.status === 404) {
      content.appendChild(el("p", { className: "panel-error" }, `${kindTitle} not found`));
    } else if (err instanceof ApiError) {
      content.appendChild(el("p", { className: "panel-error" }, err.message));
    } else {
      content.appendChild(el("p", { className: "panel-error" }, "request failed"));
      content.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
    }
  }
}

function closeDetail(): void {
  const drawer = document.getElementById("detail-drawer");
  if (!drawer) return;
  drawer.setAttribute("aria-hidden", "true");
  drawer.classList.remove("open");
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

  document.getElementById("drawer-close")?.addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });
}

mount();
