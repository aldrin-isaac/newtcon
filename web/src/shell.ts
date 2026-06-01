// shell.ts — application chrome: icon hydration, status pill,
// nav-driven breadcrumbs, command palette (Cmd-K).
// Runs once on module load; reuses elements from index.html.

import { iconSVG } from "./icons.js";

// ---- Icon hydration -------------------------------------------------------

// Replace every <span data-icon="name"> with an inline SVG.
function hydrateIcons(root: ParentNode = document): void {
  const targets = root.querySelectorAll<HTMLElement>("[data-icon]");
  targets.forEach((el) => {
    const name = el.dataset.icon;
    if (!name) return;
    el.innerHTML = iconSVG(name);
    el.removeAttribute("data-icon");
  });
}

// Re-hydrate when app.ts injects new content. MutationObserver watches the
// content area + drawer for newly-added [data-icon] elements.
function watchForNewIcons(): void {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.hasAttribute && node.hasAttribute("data-icon")) {
          hydrateIcons(node.parentElement ?? document);
        } else {
          hydrateIcons(node);
        }
      }
    }
  });
  const main = document.getElementById("app-content");
  const drawer = document.getElementById("detail-drawer");
  const palette = document.getElementById("palette-results");
  if (main) observer.observe(main, { childList: true, subtree: true });
  if (drawer) observer.observe(drawer, { childList: true, subtree: true });
  if (palette) observer.observe(palette, { childList: true, subtree: true });
}

// ---- Status pill ----------------------------------------------------------

interface HealthShape {
  status?: string;
  newtron?: { url?: string; reachable?: boolean };
  newtron_url?: string;
}

async function refreshConnectionStatus(): Promise<void> {
  const dot = document.getElementById("newtron-dot");
  const label = document.getElementById("newtron-target");
  if (!dot || !label) return;
  try {
    const resp = await fetch("/api/health", { cache: "no-store" });
    if (!resp.ok) throw new Error(String(resp.status));
    const data = (await resp.json()) as HealthShape;
    const url = data?.newtron?.url ?? data?.newtron_url ?? "newtron";
    const reachable = data?.newtron?.reachable !== false;
    dot.className = "status-dot " + (reachable ? "status-dot--ok" : "status-dot--warning");
    label.textContent = url;
  } catch {
    dot.className = "status-dot status-dot--error";
    label.textContent = "newtcon unreachable";
  }
}

function startStatusPolling(): void {
  refreshConnectionStatus();
  setInterval(refreshConnectionStatus, 15000);
}

// ---- Breadcrumb ----------------------------------------------------------

function setupBreadcrumb(): void {
  const labelByTab: Record<string, string> = {
    "tab-specs": "Specs",
    "tab-topology": "Topology",
    "tab-lab": "Lab",
  };
  const crumb = document.getElementById("crumb-view");
  for (const id of Object.keys(labelByTab)) {
    const btn = document.getElementById(id);
    btn?.addEventListener(
      "click",
      () => {
        if (crumb) crumb.textContent = labelByTab[id];
      },
      true,
    );
  }
}

// ---- Sidebar nav active-state ---------------------------------------------

function setupSidebarActiveStates(): void {
  const ids = ["tab-specs", "tab-topology", "tab-lab"];
  ids.forEach((id) => {
    const btn = document.getElementById(id);
    btn?.addEventListener(
      "click",
      () => {
        ids.forEach((other) => {
          const o = document.getElementById(other);
          o?.classList.toggle("nav-item--active", other === id);
          o?.setAttribute("aria-selected", other === id ? "true" : "false");
        });
      },
      true,
    );
  });
}

// ---- Command palette ------------------------------------------------------

interface PaletteItem {
  label: string;
  kind: string;
  action: () => void;
}

let paletteItems: PaletteItem[] = [];
let paletteOpen = false;
let paletteSelected = 0;

function setupPalette(): void {
  const overlay = document.getElementById("palette-overlay");
  const input = document.getElementById("palette-input") as HTMLInputElement | null;
  const trigger = document.getElementById("palette-trigger");
  const resultsEl = document.getElementById("palette-results");
  if (!overlay || !input || !resultsEl) return;

  const open = (): void => {
    if (paletteOpen) return;
    paletteOpen = true;
    overlay.hidden = false;
    input.value = "";
    paletteSelected = 0;
    rebuildPaletteItems();
    renderPaletteResults("");
    setTimeout(() => input.focus(), 10);
  };
  const close = (): void => {
    if (!paletteOpen) return;
    paletteOpen = false;
    overlay.hidden = true;
  };

  trigger?.addEventListener("click", open);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (paletteOpen) close();
      else open();
    } else if (paletteOpen && e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (paletteOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const visible = resultsEl.querySelectorAll<HTMLElement>(".palette-item");
      if (visible.length === 0) return;
      paletteSelected = (paletteSelected + (e.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
      visible.forEach((el, i) => el.classList.toggle("palette-item--selected", i === paletteSelected));
      visible[paletteSelected].scrollIntoView({ block: "nearest" });
    } else if (paletteOpen && e.key === "Enter") {
      const visible = resultsEl.querySelectorAll<HTMLElement>(".palette-item");
      visible[paletteSelected]?.click();
    }
  });
  input.addEventListener("input", () => {
    paletteSelected = 0;
    renderPaletteResults(input.value);
  });

  function rebuildPaletteItems(): void {
    paletteItems = [];
    paletteItems.push(
      { label: "Go to Specs", kind: "View", action: () => document.getElementById("tab-specs")?.click() },
      { label: "Go to Topology", kind: "View", action: () => document.getElementById("tab-topology")?.click() },
      { label: "Go to Lab", kind: "View", action: () => document.getElementById("tab-lab")?.click() },
    );
    document.querySelectorAll<HTMLElement>(".spec-row-name").forEach((row) => {
      const text = row.textContent?.trim() ?? "";
      const parentRow = row.closest<HTMLElement>(".spec-row");
      if (text && parentRow) {
        const kind = parentRow.closest<HTMLElement>(".spec-panel")?.dataset.kindTitle ?? "Spec";
        paletteItems.push({
          label: text,
          kind,
          action: () => {
            close();
            parentRow.click();
          },
        });
      }
    });
    document.querySelectorAll<SVGGElement>(".topo-node").forEach((node) => {
      const name = node.getAttribute("aria-label")?.replace(/^Device /, "") ?? "";
      if (name) {
        paletteItems.push({
          label: name,
          kind: "Device",
          action: () => {
            close();
            document.getElementById("tab-topology")?.click();
            setTimeout(() => (node as unknown as HTMLElement).dispatchEvent(new MouseEvent("click")), 80);
          },
        });
      }
    });
  }

  function renderPaletteResults(query: string): void {
    resultsEl!.textContent = "";
    const q = query.toLowerCase().trim();
    const filtered = q === "" ? paletteItems : paletteItems.filter((it) => it.label.toLowerCase().includes(q));
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "No matches.";
      resultsEl!.appendChild(empty);
      return;
    }
    const byKind = new Map<string, PaletteItem[]>();
    for (const it of filtered) {
      const arr = byKind.get(it.kind) ?? [];
      arr.push(it);
      byKind.set(it.kind, arr);
    }
    let idx = 0;
    for (const [kind, items] of byKind) {
      const label = document.createElement("div");
      label.className = "palette-section-label";
      label.textContent = kind;
      resultsEl!.appendChild(label);
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "palette-item" + (idx === paletteSelected ? " palette-item--selected" : "");
        row.innerHTML = `<span>${escapeHtml(it.label)}</span><span class="palette-item-kind">${escapeHtml(kind)}</span>`;
        row.addEventListener("click", it.action);
        resultsEl!.appendChild(row);
        idx++;
      }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

// ---- Boot ----------------------------------------------------------------

function boot(): void {
  hydrateIcons();
  watchForNewIcons();
  setupBreadcrumb();
  setupSidebarActiveStates();
  setupPalette();
  startStatusPolling();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
