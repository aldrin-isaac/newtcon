// network-switcher.ts — workspace header dropdown for picking the active
// newtron network. Plus the small `fetch` interceptor that appends
// `?net=<activeID>` to every API call that needs a network.
//
// Storage: localStorage key "newtcon.activeNetwork" (default "default").
// Reload-on-switch is intentional — every mounted view re-fetches under the
// new netID rather than reasoning about cross-network state coherence.
//
// Backend: /api/networks (GET list, POST register) + server.NetworkSelector
// middleware reading ?net=<id>.

import { iconSVG } from "./icons.js";

const STORAGE_KEY = "newtcon.activeNetwork";
const DEFAULT_NET = "default";

// API paths that are NOT scoped to a network — the fetch interceptor must
// not append ?net= to these or newtron will reject the request.
const NETWORK_AGNOSTIC = [
  "/api/health",
  "/api/networks",          // GET list / POST register operate on the registry
  "/api/labs",              // newtlab — separate engine, lab names are global
];

interface NetworkInfo {
  id: string;
  spec_dir: string;
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

// ---- Fetch interceptor --------------------------------------------------

function needsNetworkParam(url: string): boolean {
  if (!url.startsWith("/api/")) return false;
  for (const prefix of NETWORK_AGNOSTIC) {
    if (url === prefix || url.startsWith(prefix)) return false;
  }
  return true;
}

function appendNet(url: string, net: string): string {
  // Preserve existing query string if any.
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}net=${encodeURIComponent(net)}`;
}

// installFetchInterceptor replaces window.fetch with a wrapper that appends
// ?net=<active> to every /api/* URL that isn't on the network-agnostic list.
// Called once, at module load.
export function installFetchInterceptor(): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;

    if (needsNetworkParam(url)) {
      const patched = appendNet(url, activeNetwork());
      if (typeof input === "string") return origFetch(patched, init);
      if (input instanceof URL) return origFetch(new URL(patched, window.location.href), init);
      // Request object — clone with the new URL.
      return origFetch(new Request(patched, input), init);
    }
    return origFetch(input, init);
  };
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
    item.addEventListener("click", () => {
      if (isActive) { closeDropdown(); return; }
      if (!window.confirm(`Switch active network to "${info.id}" (${info.topology || info.spec_dir})? The page will reload.`)) return;
      setActiveNetwork(info.id);
      window.location.reload();
    });
    host.appendChild(item);
  }

  // Divider + "+ New topology" action.
  const sep = document.createElement("div");
  sep.className = "network-switcher-sep";
  host.appendChild(sep);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "network-switcher-item network-switcher-item--action";
  addBtn.innerHTML = `<span class="network-switcher-item-icon">${iconSVG("plus")}</span><span class="network-switcher-item-id">New topology…</span>`;
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

document.addEventListener("click", (e) => {
  if (!dropdownEl) return;
  if (e.target instanceof Node && (dropdownEl.contains(e.target) || document.getElementById("network-switcher-trigger")?.contains(e.target))) return;
  closeDropdown();
});

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
  // Trivial in-place modal (no framework). Three fields: id, spec_dir,
  // description. scaffold:true is always sent — the operator is creating
  // a *new* topology here; for "register an existing spec dir" use the
  // newtron CLI (out of scope for v1 of the switcher).
  const overlay = document.createElement("div");
  overlay.className = "network-modal-overlay";
  overlay.innerHTML = `
    <div class="network-modal">
      <h2 class="network-modal-title">New topology</h2>
      <p class="network-modal-hint">Creates an empty spec layout at the given path and registers it as a network. Spec files (topology.json, platforms.json, profiles/) are scaffolded; populate them through the UI or the newtron CLI.</p>
      <form class="network-modal-form">
        <label class="form-label">Network ID *</label>
        <input class="form-control" name="id" placeholder="e.g. demo-1" required />
        <label class="form-label">Spec directory (absolute path) *</label>
        <input class="form-control" name="spec_dir" placeholder="e.g. /var/topologies/demo-1/specs" required />
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
    const specDir = String(data.get("spec_dir") ?? "").trim();
    const description = String(data.get("description") ?? "").trim();
    if (!id || !specDir) {
      errorOut.textContent = "Network ID and spec directory are required.";
      errorOut.hidden = false;
      return;
    }
    if (!window.confirm(`Create new topology "${id}" at ${specDir}? Empty spec files will be written.`)) return;
    try {
      const r = await fetch("/api/networks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, spec_dir: specDir, description, scaffold: true }),
      });
      if (!r.ok) {
        const body = await r.text();
        errorOut.textContent = `${r.status}: ${body}`;
        errorOut.hidden = false;
        return;
      }
      // Switch to the new network and reload.
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
