// network-switcher.ts — workspace header dropdown for picking the active
// newtron network. The active-network ID is read by api-path.ts's apiPath()
// helper, which writes it positionally into /api/networks/{netID}/... URLs.
//
// Storage: localStorage key "newtcon.activeNetwork" (default "default").
// Reload-on-switch is intentional — every mounted view re-fetches under the
// new netID rather than reasoning about cross-network state coherence.
//
// Backend: GET /api/networks (list) + POST /api/networks (register).

import { iconSVG } from "./icons.js";
import { confirmInline } from "./confirm-inline.js";

const STORAGE_KEY = "newtcon.activeNetwork";
const DEFAULT_NET = "default";

interface NetworkInfo {
  id: string;
  dir: string;
  has_topology: boolean;
  topology: string;
  nodes: string[];
}

// ---- Active-network storage ---------------------------------------------

export function activeNetwork(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_NET;
  } catch {
    return DEFAULT_NET;
  }
}

function setActiveNetwork(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage blocked — fall back to URL-driven mode would need page-state plumbing.
    // For now the in-memory selection persists for this session only.
  }
}

// ---- Dropdown UI --------------------------------------------------------

let cachedNetworks: NetworkInfo[] = [];

async function fetchNetworks(): Promise<NetworkInfo[]> {
  try {
    const r = await fetch("/api/networks", { cache: "no-store" });
    if (!r.ok) return [];
    const body = (await r.json()) as { networks?: NetworkInfo[] };
    return body.networks ?? [];
  } catch {
    return [];
  }
}

function activeLabel(active: string, infos: NetworkInfo[]): string {
  const match = infos.find((n) => n.id === active);
  if (!match) return active;
  return match.topology ? `${match.id} · ${match.topology}` : match.id;
}

function renderDropdown(host: HTMLElement, infos: NetworkInfo[]): void {
  const active = activeNetwork();
  host.textContent = "";

  for (const info of infos) {
    const isActive = info.id === active;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "network-switcher-item" + (isActive ? " network-switcher-item--active" : "");
    item.innerHTML = `
      <span class="network-switcher-item-icon">${iconSVG(isActive ? "check" : "network")}</span>
      <span class="network-switcher-item-id">${escapeHtml(info.id)}</span>
      <span class="network-switcher-item-topology">${escapeHtml(info.topology || "—")}</span>`;
    item.addEventListener("click", async () => {
      if (isActive) { closeDropdown(); return; }
      const ok = await confirmInline({
        title: `Switch to "${info.id}"?`,
        body: `Topology: ${info.topology || info.dir}\n\nThe page will reload.`,
        confirmLabel: "Switch",
      });
      if (!ok) return;
      setActiveNetwork(info.id);
      window.location.reload();
    });
    host.appendChild(item);
  }

  // Divider + "+ New network" action.
  const sep = document.createElement("div");
  sep.className = "network-switcher-sep";
  host.appendChild(sep);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "network-switcher-item network-switcher-item--action";
  addBtn.innerHTML = `<span class="network-switcher-item-icon">${iconSVG("plus")}</span><span class="network-switcher-item-id">New network…</span>`;
  addBtn.addEventListener("click", () => {
    closeDropdown();
    openRegisterModal();
  });
  host.appendChild(addBtn);
}

let dropdownEl: HTMLElement | null = null;

function closeDropdown(): void {
  if (dropdownEl) { dropdownEl.remove(); dropdownEl = null; }
}

// Guard for non-browser test contexts (node:test imports api-path.ts which
// pulls activeNetwork() through this module).
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (!dropdownEl) return;
    if (e.target instanceof Node && (dropdownEl.contains(e.target) || document.getElementById("network-switcher-trigger")?.contains(e.target))) return;
    closeDropdown();
  });
}

async function toggleDropdown(trigger: HTMLElement): Promise<void> {
  if (dropdownEl) { closeDropdown(); return; }
  cachedNetworks = await fetchNetworks();
  dropdownEl = document.createElement("div");
  dropdownEl.id = "network-switcher-dropdown";
  dropdownEl.className = "network-switcher-dropdown";
  renderDropdown(dropdownEl, cachedNetworks);
  document.body.appendChild(dropdownEl);
  const rect = trigger.getBoundingClientRect();
  dropdownEl.style.left = `${rect.left}px`;
  dropdownEl.style.top = `${rect.bottom + 4}px`;
}

// ---- Register-new modal --------------------------------------------------

function openRegisterModal(): void {
  // Two fields — id + optional description. Newtron resolves the path
  // itself from its --networks-base config (newtron PRs #245 + #251);
  // newtcon never carries paths on the wire.
  //
  // The endpoint is idempotent: 201 means newtron materialised the
  // slot, 200 means an id with that name was already registered. The
  // modal branches on the status code so the operator gets a clear
  // "name taken" message instead of an opaque success when they typed
  // an existing id.
  const overlay = document.createElement("div");
  overlay.className = "network-modal-overlay";
  overlay.innerHTML = `
    <div class="network-modal">
      <h2 class="network-modal-title">New network</h2>
      <p class="network-modal-hint">Creates an empty network under newtron's configured networks base. Topology and specs are populated through the UI or the newtron CLI.</p>
      <form class="network-modal-form">
        <label class="form-label">Network ID *</label>
        <input class="form-control" name="id" placeholder="e.g. demo-1"
               required pattern="[A-Za-z0-9_-]{1,64}"
               title="Letters, digits, underscore, hyphen — 1 to 64 chars" />
        <label class="form-label">Description</label>
        <input class="form-control" name="description" placeholder="What this network is for (optional)" />
        <div class="network-modal-error" hidden></div>
        <div class="network-modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Create</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  const close = (): void => overlay.remove();
  overlay.querySelector('[data-action="cancel"]')?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const form = overlay.querySelector("form") as HTMLFormElement;
  const errorOut = overlay.querySelector(".network-modal-error") as HTMLElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorOut.hidden = true;
    const data = new FormData(form);
    const id = String(data.get("id") ?? "").trim();
    const description = String(data.get("description") ?? "").trim();
    if (!id) {
      errorOut.textContent = "Network ID is required.";
      errorOut.hidden = false;
      return;
    }
    {
      const ok = await confirmInline({
        title: `Create new network "${id}"?`,
        body: "Newtron will materialise an empty network under its --networks-base.",
        confirmLabel: "Create",
      });
      if (!ok) return;
    }
    try {
      const r = await fetch("/api/networks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, description }),
      });
      if (r.status === 200) {
        // Idempotent re-call — name already taken by an existing
        // registration. Surface explicitly so the operator can pick a
        // different id rather than silently switching into the
        // existing network.
        errorOut.textContent = `A network with id "${id}" already exists. Pick a different name.`;
        errorOut.hidden = false;
        return;
      }
      if (!r.ok) {
        const body = await r.text();
        errorOut.textContent = `${r.status}: ${body}`;
        errorOut.hidden = false;
        return;
      }
      // 201 Created — switch to the new network and reload.
      setActiveNetwork(id);
      window.location.reload();
    } catch (err) {
      errorOut.textContent = String(err);
      errorOut.hidden = false;
    }
  });
}

// ---- Boot ---------------------------------------------------------------

export function setupNetworkSwitcher(): void {
  // Header trigger element rendered by index.html; if missing the switcher
  // is a no-op (e.g. in tests that mount only fragments).
  const trigger = document.getElementById("network-switcher-trigger");
  if (!trigger) return;
  refreshTriggerLabel(trigger);
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleDropdown(trigger);
  });
}

async function refreshTriggerLabel(trigger: HTMLElement): Promise<void> {
  const label = trigger.querySelector(".network-switcher-label");
  if (!label) return;
  label.textContent = activeNetwork();
  // Best-effort: replace with "{id} · {topology}" once /api/networks responds.
  cachedNetworks = await fetchNetworks();
  label.textContent = activeLabel(activeNetwork(), cachedNetworks);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
}
