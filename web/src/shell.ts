// shell.ts — application chrome: icon hydration, status pill,
// nav-driven breadcrumbs, command palette (Cmd-K).
// Runs once on module load; reuses elements from index.html.

import { iconSVG } from "./icons.js";
import {
  subscribe as subscribePending,
  getQueue,
  pendingCount,
  describePending,
  removeFromQueue,
  discardAll,
  applyAll,
  probeOnline,
} from "./staging.js";
import { previewQueue, driftVerdict, shouldDriftCheck, deliveryDevices, deliveryLabel, type ApplyPreview, type PendingPreview, type DriftVerdict } from "./apply-preview.js";
import { apiPath } from "./api-path.js";
import { appendEntry, buildEntry } from "./action-history.js";
import { activeNetwork } from "./network-switcher.js";
import type { Pending, ApplyResult } from "./staging.js";
import { fetchSpecDetail } from "./api/newtcon/network.js";
import { fetchTopology } from "./api/newtcon/nodes.js";
import { captureTopologyBodies, type RawTopology } from "./topology-undo-capture.js";
import {
  type DeviceBatch,
  type DeviceProjection,
  type ProjectionDiffResult,
  groupByDevice,
  summarizeDiff,
} from "./projection-aggregator.js";
import { postProjectionDiff } from "./api/newtcon/nodes.js";
import { setupNetworkSwitcher } from "./network-switcher.js";
import { ensureSignedIn, setupAuthGate, userFromGate } from "./auth-gate.js";
import { confirmInline } from "./confirm-inline.js";
import { showToast } from "./toast.js";
import { initTheme, toggleTheme, currentTheme } from "./theme.js";
import { setupFabricHealthStrip } from "./fabric-health-strip.js";

// ---- Theme toggle ---------------------------------------------------------
// The button lives in the sidebar footer (index.html); theme.ts owns the
// data-theme stamp + persistence. The icon/label always advertise the theme
// you would SWITCH TO (moon = "go dark", sun = "go light").

function syncThemeToggle(): void {
  const icon = document.getElementById("theme-toggle-icon");
  const label = document.getElementById("theme-toggle-label");
  const dark = currentTheme() === "dark";
  if (icon) icon.innerHTML = iconSVG(dark ? "sun" : "moon");
  if (label) label.textContent = dark ? "Light theme" : "Dark theme";
}

function setupThemeToggle(): void {
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    toggleTheme();
    syncThemeToggle();
  });
  syncThemeToggle();
}

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
    label.textContent = "Newtron Console unreachable";
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
    "tab-history": "Changes",
    "tab-audit": "Audit",
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
  const ids = ["tab-specs", "tab-topology", "tab-history", "tab-audit"];
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
  const headerHint = document.getElementById("palette-hint");
  const resultsEl = document.getElementById("palette-results");
  if (!overlay || !input || !resultsEl) return;

  // Platform-aware modifier label for the header hint (slice #169.F).
  // The Cmd-K handler below accepts both metaKey and ctrlKey, so we
  // pick the label that matches the operator's primary modifier.
  const modLabel = document.getElementById("palette-hint-mod");
  if (modLabel) {
    const platform = (navigator.platform || "").toLowerCase();
    const isMac = platform.includes("mac");
    modLabel.textContent = isMac ? "⌘" : "Ctrl";
  }

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
  headerHint?.addEventListener("click", open);
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

  const firstText = (el: Element): string =>
    (Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE)?.textContent ?? el.textContent ?? "").trim();

  function rebuildPaletteItems(): void {
    paletteItems = [];
    // Tabs — always available, every view (was only Specs + Topology).
    for (const [id, label] of [
      ["tab-specs", "Specs"], ["tab-topology", "Topology"],
      ["tab-history", "Changes"], ["tab-audit", "Audit"],
    ] as Array<[string, string]>) {
      paletteItems.push({ label: `Go to ${label}`, kind: "View", action: () => document.getElementById(id)?.click() });
    }
    // Spec facets (rendered while the Specs view is open) — jump straight to one.
    document.querySelectorAll<HTMLElement>(".specs-subnav-item").forEach((btn) => {
      const label = firstText(btn);
      if (label) paletteItems.push({
        label, kind: "Facet",
        action: () => { close(); document.getElementById("tab-specs")?.click(); setTimeout(() => btn.click(), 60); },
      });
    });
    // Spec rows in the active facet — open the detail. (Base rows only; an
    // override row's label is its scope instance, not the spec name.)
    const activeFacet = document.querySelector<HTMLElement>(".specs-subnav-item--active");
    const facetKind = activeFacet ? firstText(activeFacet) : "Spec";
    document.querySelectorAll<HTMLElement>(".panel-list-item:not(.panel-list-item--override)").forEach((row) => {
      const text = row.textContent?.trim() ?? "";
      if (text) paletteItems.push({ label: text, kind: facetKind, action: () => { close(); row.click(); } });
    });
    // Topology nodes (rendered while the Topology view is open).
    document.querySelectorAll<SVGGElement>(".topo-node").forEach((node) => {
      const name = node.getAttribute("aria-label")?.replace(/^Device /, "") ?? "";
      if (name) paletteItems.push({
        label: name, kind: "Node",
        action: () => { close(); document.getElementById("tab-topology")?.click(); setTimeout(() => (node as unknown as HTMLElement).dispatchEvent(new MouseEvent("click")), 80); },
      });
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

// ---- Pending-bar (workspace-level staging) -------------------------------

// pendingItemClass colors a queue row: flat mutations by their effect
// (create/update/delete); topology/device entries by their op as before.
function pendingItemClass(p: Pending): string {
  if (p.group === "mutation") {
    return p.effect === "create" ? "pending-bar-item--add"
      : p.effect === "delete" ? "pending-bar-item--del"
        : "pending-bar-item--mod";
  }
  if (p.group === "ssh-login") return p.op === "clear" ? "pending-bar-item--del" : "pending-bar-item--mod";
  return p.op.startsWith("add") ? "pending-bar-item--add" : "pending-bar-item--del";
}

function setupPendingBar(): void {
  const bar = document.getElementById("pending-bar");
  const list = document.getElementById("pending-bar-list");
  const countEl = bar?.querySelector(".pending-bar-count");
  const toggle = document.getElementById("pending-bar-toggle");
  const discardBtn = document.getElementById("pending-bar-discard");
  const saveBtn = document.getElementById("pending-bar-save");
  if (!bar || !list || !countEl || !toggle || !discardBtn || !saveBtn) return;

  // Keyboard apply (operators are keyboard-first): ⌘↵ / Ctrl+↵ runs Save when
  // there are staged changes. Skipped while the palette or a form field is
  // focused, or the apply-preview is already open, to avoid surprise.
  const modLabel = (navigator.platform || "").toLowerCase().includes("mac") ? "⌘↵" : "Ctrl+↵";
  saveBtn.setAttribute("title", `Apply staged changes (${modLabel})`);
  document.addEventListener("keydown", (e) => {
    if (!((e.metaKey || e.ctrlKey) && e.key === "Enter")) return;
    if (paletteOpen) return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (pendingCount() === 0 || saveBtn.hasAttribute("disabled")) return;
    if (document.querySelector(".apply-preview-overlay")) return;
    e.preventDefault();
    saveBtn.click();
  });

  const render = (): void => {
    const n = pendingCount();
    bar.hidden = n === 0;
    countEl.textContent = String(n);
    if (n === 0) list.hidden = true;
    if (!list.hidden) renderList();
  };
  const renderList = (): void => {
    list.textContent = "";
    for (const p of getQueue()) {
      const row = document.createElement("div");
      row.className = "pending-bar-item " + pendingItemClass(p);
      const label = document.createElement("span");
      label.className = "pending-bar-item-label";
      label.textContent = describePending(p);
      row.appendChild(label);
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "pending-bar-item-drop";
      drop.title = "Drop this pending change";
      drop.textContent = "×";
      drop.addEventListener("click", (e) => { e.stopPropagation(); removeFromQueue(p.id); });
      row.appendChild(drop);
      list.appendChild(row);
    }
  };

  toggle.addEventListener("click", () => {
    list.hidden = !list.hidden;
    if (!list.hidden) renderList();
  });

  discardBtn.addEventListener("click", async () => {
    const n = pendingCount();
    if (n === 0) return;
    const ok = await confirmInline({
      title: `Discard ${n} pending change${n === 1 ? "" : "s"}?`,
      body: "Nothing will be applied.",
      danger: true,
      confirmLabel: "Discard",
    });
    if (!ok) return;
    discardAll();
  });

  saveBtn.addEventListener("click", async () => {
    if (pendingCount() === 0) return;
    // Compute the preview ONCE — used both for the confirm modal and the
    // history capture below. applyAll() drains the queue, so we can't
    // recompute after the fact.
    const preview = previewQueue(getQueue());
    const ok = await confirmApplyAll(preview);
    if (!ok) return;
    saveBtn.setAttribute("disabled", "");
    saveBtn.textContent = "Saving…";
    const network = activeNetwork();
    const timestamp = new Date().toISOString();

    // Capture pre-apply bodies for delete-style spec items (slice #175.C.1)
    // BEFORE applyAll runs — once a spec is deleted, the body is gone and
    // undo can't recreate it. Fetched in parallel; failures degrade
    // silently (the item just won't be undoable).
    const preBodies = await capturePreApplyBodies(getQueue());

    const r = await applyAll();
    saveBtn.removeAttribute("disabled");
    saveBtn.textContent = "Save";

    // History capture (slice #175.A): persist the {preview, result} pair
    // to localStorage so the operator can browse "what did I just do"
    // from the History tab. Best-effort; storage failures are swallowed
    // by saveHistory.
    const entryId = `apply-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = buildEntry({
      id: entryId,
      preBodies,
      timestamp,
      user: userFromGate(),
      network,
      preview,
      result: r,
    });
    appendEntry(network, entry);

    if (r.failed.length > 0) {
      // Mixed/failed apply: a queue-shaped results modal — what went through vs.
      // what failed (and stays on the queue to fix + retry). Clearer than a
      // text toast when several items applied and one didn't.
      mountApplyResultModal(r);
    } else if (r.applied.length > 0) {
      showToast({
        kind: "success",
        title: `Applied ${r.applied.length} change${r.applied.length === 1 ? "" : "s"}`,
      });
    }
    // Re-mount whichever view is visible so the (now-applied) changes refresh.
    document.querySelector(".nav-item--active")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  subscribePending(render);
  render();
}

// ---- Pre-apply body capture (slice #175.C.1) -----------------------------
//
// Undo for delete-style operations needs the body of the thing being
// deleted — otherwise nothing can recreate it. Fired in parallel just
// before applyAll runs; per-fetch failures degrade silently (the item
// just renders as not-undoable in the History tab).
//
// Covered:
//   spec.delete             fetchSpecDetail per item
//   topology.remove-link    {a, z} endpoints extracted from fetchTopology()
//
// The topology fetch fires only when the queue actually has a remove-link
// — no point pulling the whole topology for a spec-only batch.

async function capturePreApplyBodies(queue: readonly Pending[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  // Spec-delete bodies.
  const specTargets = queue.filter((p) => p.group === "mutation" && !p.sub && p.effect === "delete");
  const topologyTargets = queue.filter((p) =>
    p.group === "topology" && p.op === "remove-link");
  await Promise.all([
    ...specTargets.map(async (p) => {
      if (p.group !== "mutation" || p.sub || p.effect !== "delete") return;
      try {
        const detail = await fetchSpecDetail(p.kind, p.name);
        if (detail && typeof detail === "object" && !Array.isArray(detail)) {
          out.set(p.id, detail as Record<string, unknown>);
        }
      } catch { /* item just won't be undoable */ }
    }),
    (async () => {
      if (topologyTargets.length === 0) return;
      try {
        const topology = (await fetchTopology()) as RawTopology;
        for (const [id, body] of captureTopologyBodies(topology, queue)) {
          out.set(id, body);
        }
      } catch { /* topology fetch failed → those items just won't be undoable */ }
    })(),
  ]);
  return out;
}

// ---- Apply preview modal (slice #171.A) ----------------------------------
//
// Replaces the previous window.confirm() with a structured preview of
// every pending change in the order it will execute. Operator can expand
// each row to inspect the spec/action body, then commit or cancel.
// Click-outside / Escape / Cancel = false; Apply = true.

function confirmApplyAll(preview: ApplyPreview): Promise<boolean> {
  if (preview.total === 0) return Promise.resolve(false);
  // Compute the per-device batches synchronously before opening the
  // modal so the projection section renders immediately with one row
  // per affected device (in "fetching…" state). The actual POSTs fire
  // from inside the modal mount.
  const batches = groupByDevice(getQueue());
  return new Promise<boolean>((resolve) => mountApplyPreviewModal(preview, batches, resolve));
}

function mountApplyPreviewModal(
  preview: ApplyPreview,
  batches: DeviceBatch[],
  resolve: (ok: boolean) => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "apply-preview-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Confirm apply of pending changes");

  const card = document.createElement("div");
  card.className = "apply-preview-card";

  const head = document.createElement("header");
  head.className = "apply-preview-head";
  const title = document.createElement("h2");
  title.className = "apply-preview-title";
  title.textContent = `Apply ${preview.total} pending change${preview.total === 1 ? "" : "s"}?`;
  head.appendChild(title);
  const subtitle = document.createElement("p");
  subtitle.className = "apply-preview-subtitle";
  subtitle.textContent = "These will be applied in this order:";
  head.appendChild(subtitle);
  card.appendChild(head);

  const list = document.createElement("ol");
  list.className = "apply-preview-list";
  for (const item of preview.items) {
    list.appendChild(renderApplyPreviewItem(item));
  }
  card.appendChild(list);

  // Delivery mode (per device). Device-targeted actions apply actuated
  // (delivered to the running switch) when the device is online, or as
  // authored intent (actuates at next provision) when it's offline — and a
  // topology-mode apply still reports success, so the difference must not be
  // silent. One chip per affected device, probed async with the same probe
  // applyDevice uses.
  const delivery = deliveryDevices(getQueue());
  if (delivery.length > 0) {
    card.appendChild(renderDeliverySection(delivery));
  }

  // Device-level projection (slice #171.B). For every affected device,
  // newtron computes the projected per-device diff via in-memory replay
  // + restore. Rendered as a per-device row that starts in "fetching…"
  // state and updates when the parallel POST resolves.
  if (batches.length > 0) {
    card.appendChild(renderProjectionSection(batches, activeNetwork()));
  }

  // Drift check: does the server still match what each staged spec op assumes?
  // Async — probes existence per spec mutation and warns before Apply.
  card.appendChild(renderDriftSection(getQueue(), activeNetwork()));

  if (preview.hasDangerous) {
    const warn = document.createElement("p");
    warn.className = "apply-preview-warn";
    const n = preview.counts.danger;
    warn.textContent = `${n} destructive change${n === 1 ? "" : "s"} flagged. Review before applying.`;
    card.appendChild(warn);
  }

  const foot = document.createElement("footer");
  foot.className = "apply-preview-foot";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-ghost";
  cancel.textContent = "Cancel";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "btn btn-primary";
  apply.textContent = `Apply ${preview.total} change${preview.total === 1 ? "" : "s"}`;
  foot.appendChild(cancel);
  foot.appendChild(apply);
  card.appendChild(foot);

  overlay.appendChild(card);

  let done = false;
  const close = (ok: boolean): void => {
    if (done) return;
    done = true;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    resolve(ok);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); close(false); }
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close(false);
  });
  cancel.addEventListener("click", () => close(false));
  apply.addEventListener("click", () => close(true));
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
  apply.focus();
}

function renderApplyPreviewItem(item: PendingPreview): HTMLElement {
  const row = document.createElement("li");
  row.className = "apply-preview-item apply-preview-item--" + item.effect;
  if (item.danger) row.classList.add("apply-preview-item--danger");

  const main = document.createElement("div");
  main.className = "apply-preview-item-main";

  const marker = document.createElement("span");
  marker.className = "apply-preview-marker";
  marker.textContent = item.effect === "create" ? "+"
    : item.effect === "delete" ? "−" : item.effect === "update" ? "~" : "•";
  marker.setAttribute("aria-hidden", "true");
  main.appendChild(marker);

  const kind = document.createElement("span");
  kind.className = "apply-preview-kind";
  kind.textContent = item.kind;
  main.appendChild(kind);

  const title = document.createElement("span");
  title.className = "apply-preview-item-title";
  title.textContent = item.title;
  main.appendChild(title);

  if (item.scope) {
    const scope = document.createElement("span");
    scope.className = "apply-preview-scope";
    scope.textContent = item.scope;
    main.appendChild(scope);
  }

  if (item.danger) {
    const tag = document.createElement("span");
    tag.className = "apply-preview-danger-tag";
    tag.textContent = "destructive";
    main.appendChild(tag);
  }

  row.appendChild(main);

  // The endpoint + scope this change targets — the operator's "where does this
  // actually go" context, alongside the body.
  if (item.path) {
    const url = document.createElement("div");
    url.className = "apply-preview-url";
    const m = document.createElement("span");
    m.className = "apply-preview-method apply-preview-method--" + item.method.toLowerCase();
    m.textContent = item.method;
    url.appendChild(m);
    url.appendChild(document.createTextNode(" " + item.path));
    row.appendChild(url);
  }

  if (item.body && Object.keys(item.body).length > 0) {
    const details = document.createElement("details");
    details.className = "apply-preview-details";
    const summary = document.createElement("summary");
    summary.className = "apply-preview-details-summary";
    summary.textContent = "body";
    details.appendChild(summary);
    const pre = document.createElement("pre");
    pre.className = "apply-preview-body";
    pre.textContent = JSON.stringify(item.body, null, 2);
    details.appendChild(pre);
    row.appendChild(details);
  }
  return row;
}

// mountApplyResultModal — a queue-shaped results popup shown after an Apply that
// had at least one failure: what went through (drained) vs. what failed (and
// stays on the queue to fix + retry). Reuses the apply-preview item shape.
function mountApplyResultModal(result: ApplyResult): void {
  const overlay = document.createElement("div");
  overlay.className = "apply-preview-overlay";
  const card = document.createElement("div");
  card.className = "apply-preview-card";
  overlay.appendChild(card);

  const head = document.createElement("div");
  head.className = "apply-preview-head";
  const title = document.createElement("h2");
  title.className = "apply-preview-title";
  title.textContent = `Applied ${result.applied.length} · Failed ${result.failed.length}`;
  head.appendChild(title);
  const subtitle = document.createElement("p");
  subtitle.className = "apply-preview-subtitle";
  subtitle.textContent = "Successful changes are applied and cleared. Failed changes stayed on the queue — fix and Save again.";
  head.appendChild(subtitle);
  card.appendChild(head);

  const section = (label: string, cls: string, items: HTMLElement[]): void => {
    if (items.length === 0) return;
    const h = document.createElement("h3");
    h.className = "apply-result-section " + cls;
    h.textContent = label;
    card.appendChild(h);
    const list = document.createElement("ul");
    list.className = "apply-preview-list";
    for (const it of items) list.appendChild(it);
    card.appendChild(list);
  };

  if (result.applied.length > 0) {
    section(`Applied (${result.applied.length})`, "apply-result-section--ok",
      previewQueue(result.applied).items.map(renderApplyPreviewItem));
  }
  if (result.failed.length > 0) {
    const errById = new Map(result.failed.map((f) => [f.pending.id, f.error]));
    const failItems = previewQueue(result.failed.map((f) => f.pending)).items.map((item) => {
      const row = renderApplyPreviewItem(item);
      row.classList.add("apply-result-item--failed");
      const err = document.createElement("p");
      err.className = "apply-result-error";
      err.textContent = errById.get(item.id) ?? "failed";
      row.appendChild(err);
      return row;
    });
    section(`Failed — still on the queue (${result.failed.length})`, "apply-result-section--fail", failItems);
  }

  const buttons = document.createElement("div");
  buttons.className = "apply-preview-actions";
  const close = document.createElement("button");
  close.className = "btn btn-primary";
  close.textContent = "Close";
  const dismiss = (): void => overlay.remove();
  close.addEventListener("click", dismiss);
  buttons.appendChild(close);
  card.appendChild(buttons);

  overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { dismiss(); document.removeEventListener("keydown", esc); }
  });

  document.body.appendChild(overlay);
}

// renderDriftSection probes, per staged spec mutation, whether the server
// still matches what the op assumes (existence), and warns before Apply so the
// operator isn't surprised by a post-apply failure or an undo-resurrect. Async,
// like the projection section. Sub-rule / topology drift is a follow-up.
function renderDriftSection(queue: readonly Pending[], network: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "apply-preview-drift";
  const specOps = queue.filter((p): p is Extract<Pending, { group: "mutation" }> =>
    shouldDriftCheck(p));
  if (specOps.length === 0) { section.hidden = true; return section; }

  const status = document.createElement("p");
  status.className = "apply-preview-drift-status";
  status.textContent = "Checking for drift…";
  section.appendChild(status);

  void (async () => {
    const hits = (await Promise.all(specOps.map(async (p) => {
      let exists: boolean;
      try {
        const r = await fetch(apiPath.network(network, `${p.kind}/${encodeURIComponent(p.name)}`), { cache: "no-store" });
        exists = r.ok;
      } catch { return null; } // probe failed — don't cry drift on a transient error
      const v = driftVerdict(p.effect, exists);
      return v.level === "none" ? null : { p, v };
    }))).filter((x): x is { p: Extract<Pending, { group: "mutation" }>; v: DriftVerdict } => x !== null);

    section.textContent = "";
    if (hits.length === 0) { section.hidden = true; return; }
    const head = document.createElement("p");
    head.className = "apply-preview-drift-head";
    head.textContent = `${hits.length} possible drift${hits.length === 1 ? "" : "s"} — the server moved since you staged:`;
    section.appendChild(head);
    const ul = document.createElement("ul");
    ul.className = "apply-preview-drift-list";
    for (const { p, v } of hits) {
      const li = document.createElement("li");
      li.className = "apply-preview-drift-item apply-preview-drift-item--" + v.level;
      li.textContent = `${p.kind} ${p.name}: ${v.reason}`;
      ul.appendChild(li);
    }
    section.appendChild(ul);
  })();

  return section;
}

// renderProjectionSection renders the per-device projection block inside
// the apply-preview modal (slice #171.B). For each batched device:
//
//   - Mounts a row in "fetching…" state immediately so the operator
//     sees what's being computed.
//   - Fires POST /projection-diff in parallel; updates the row in place
//     with summary counts + a collapsed details panel for the full diff
//     when the response arrives, or with the error message on failure.
//
// Fanout-and-aggregate per the newtron#193 analysis: ~50 LoC, no batch
// endpoint required. Latency is N parallel calls; the operator can
// click Apply before all projections resolve if they want.
// renderDeliverySection — the per-device delivery-mode chips in the confirm
// modal. One row per device with staged device/interface actions; each row
// probes the device (same probe applyDevice uses) and resolves to either
// "delivers to device" (online → actuated apply) or "authors intent" (offline
// → topology mode, actuates at next provision). The distinction must be
// visible because both paths report success.
function renderDeliverySection(devices: string[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "apply-preview-delivery";
  const heading = document.createElement("h3");
  heading.className = "apply-preview-delivery-heading";
  heading.textContent = "Delivery";
  section.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "apply-preview-delivery-list";
  section.appendChild(list);

  for (const device of devices) {
    const row = document.createElement("li");
    row.className = "apply-preview-delivery-row";
    const name = document.createElement("span");
    name.className = "apply-preview-delivery-device";
    name.textContent = device;
    row.appendChild(name);
    const chip = document.createElement("span");
    chip.className = "chip chip--caps chip--muted";
    chip.textContent = "checking device…";
    row.appendChild(chip);
    list.appendChild(row);

    void probeOnline(device).then((online) => {
      const d = deliveryLabel(online);
      chip.className = "chip chip--caps " + (d.mode === "intent" ? "chip--warning" : "chip--success");
      chip.textContent = d.label;
      chip.title = d.hint;
      if (d.mode === "intent") {
        const note = document.createElement("span");
        note.className = "apply-preview-delivery-note";
        note.textContent = "offline — actuates at next provision";
        row.appendChild(note);
      }
    });
  }
  return section;
}

function renderProjectionSection(batches: DeviceBatch[], network: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "apply-preview-projection";
  const heading = document.createElement("h3");
  heading.className = "apply-preview-projection-heading";
  heading.textContent = `Device-level projection (${batches.length} device${batches.length === 1 ? "" : "s"})`;
  section.appendChild(heading);
  const blurb = document.createElement("p");
  blurb.className = "apply-preview-projection-blurb";
  blurb.textContent = "newtron's projected per-device config diff if these ops apply. In-memory replay; no device writes.";
  section.appendChild(blurb);

  const list = document.createElement("ul");
  list.className = "apply-preview-projection-list";
  section.appendChild(list);

  for (const batch of batches) {
    const row = renderProjectionRow({ device: batch.device, opCount: batch.ops.length });
    list.appendChild(row.element);
    void postProjectionDiff(batch.device, batch.ops, network)
      .then((raw) => {
        const result = (raw && typeof raw === "object") ? raw as ProjectionDiffResult : {};
        row.update({ device: batch.device, opCount: batch.ops.length, result });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        row.update({ device: batch.device, opCount: batch.ops.length, error: msg });
      });
  }
  return section;
}

// renderProjectionRow returns the row element + an `update` closure
// that re-renders its contents when the fetch resolves. Keeping the
// element identity stable lets us paint the row immediately and
// replace its body when the result arrives.
function renderProjectionRow(initial: DeviceProjection): {
  element: HTMLElement;
  update: (next: DeviceProjection) => void;
} {
  const li = document.createElement("li");
  li.className = "apply-preview-projection-row";
  const paint = (state: DeviceProjection): void => {
    li.textContent = "";
    const head = document.createElement("div");
    head.className = "apply-preview-projection-head";
    const name = document.createElement("span");
    name.className = "apply-preview-projection-device";
    name.textContent = state.device;
    head.appendChild(name);
    const ops = document.createElement("span");
    ops.className = "apply-preview-projection-ops";
    ops.textContent = `${state.opCount} op${state.opCount === 1 ? "" : "s"}`;
    head.appendChild(ops);
    if (state.result) {
      const s = summarizeDiff(state.result.diff);
      const summary = document.createElement("span");
      summary.className = "apply-preview-projection-summary";
      if (s.total === 0) {
        summary.textContent = "no config-db change";
        summary.classList.add("apply-preview-projection-summary--noop");
      } else {
        const parts = [];
        if (s.create > 0) parts.push(`+${s.create}`);
        if (s.modify > 0) parts.push(`~${s.modify}`);
        if (s.delete > 0) parts.push(`−${s.delete}`);
        summary.textContent = `${parts.join(" / ")} entries`;
      }
      head.appendChild(summary);
    } else if (state.error) {
      const err = document.createElement("span");
      err.className = "apply-preview-projection-error";
      err.textContent = "projection failed";
      head.appendChild(err);
    } else {
      const spin = document.createElement("span");
      spin.className = "apply-preview-projection-fetching";
      spin.textContent = "fetching…";
      head.appendChild(spin);
    }
    li.appendChild(head);

    if (state.error) {
      const errLine = document.createElement("p");
      errLine.className = "apply-preview-projection-error-detail";
      errLine.textContent = state.error;
      li.appendChild(errLine);
    } else if (state.result && state.result.diff && state.result.diff.length > 0) {
      const details = document.createElement("details");
      details.className = "apply-preview-details";
      const summary = document.createElement("summary");
      summary.className = "apply-preview-details-summary";
      summary.textContent = "diff";
      details.appendChild(summary);
      const pre = document.createElement("pre");
      pre.className = "apply-preview-body";
      pre.textContent = JSON.stringify(state.result.diff, null, 2);
      details.appendChild(pre);
      li.appendChild(details);
    }
  };
  paint(initial);
  return {
    element: li,
    update: paint,
  };
}

async function boot(): Promise<void> {
  hydrateIcons();
  initTheme();
  setupThemeToggle();
  watchForNewIcons();
  // Auth gate runs first: the workspace only renders once whoami succeeds or
  // the operator signs in. The overlay markup lives in index.html; auth-gate.ts
  // hydrates it and resolves when signed-in. Anonymous /api/health probing
  // (via startStatusPolling) is fine — newtcon-server's /api/health is public.
  await ensureSignedIn();
  setupAuthGate();
  setupBreadcrumb();
  setupSidebarActiveStates();
  setupPalette();
  setupPendingBar();
  setupNetworkSwitcher();
  setupFabricHealthStrip();
  startStatusPolling();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
