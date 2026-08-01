// drawer-resize.ts — user-resizable detail drawer/inspector width.
//
// A grab handle on the drawer's LEFT edge drags the panel wider or
// narrower. Works in both drawer modes (the drawer is right-anchored in
// each): docked grid pane (≥1400px) and fixed overlay. The chosen width
// persists per browser (localStorage) and is applied as a CSS custom
// property — --drawer-user-width — that workspace.css consumes per mode,
// so the closed states (width 0 / translateX) stay untouched.
// Double-click the handle to reset to the mode default.

const STORAGE_KEY = "newtcon.drawerWidth";
export const DRAWER_MIN_PX = 360;
export const DRAWER_MAX_VIEWPORT_FRACTION = 0.85;

/** clampDrawerWidth — bound a requested width to sane limits for the
 *  viewport: never narrower than DRAWER_MIN_PX, never wider than 85% of
 *  the viewport (the canvas must stay usable beside/behind it). */
/** The workspace column must stay usable however wide the drawer is dragged.
 *  Only binds when the drawer is DOCKED — an overlay floats over the workspace
 *  and squeezes nothing. */
export const MAIN_MIN_PX = 420;

export interface ClampOpts {
  /** True when the drawer occupies its own grid column (>=1100px) rather than
   *  floating over the workspace. */
  docked?: boolean;
  /** Width of the sidebar column, which the drawer does not get to consume. */
  sidebarWidth?: number;
}

export function clampDrawerWidth(px: number, viewportWidth: number, opts: ClampOpts = {}): number {
  const byFraction = Math.floor(viewportWidth * DRAWER_MAX_VIEWPORT_FRACTION);
  // Docked, the drawer SHARES the row with the workspace, so the fraction alone
  // is not enough: at 1300px it would allow 1105px against 1068px of available
  // track, squeezing the canvas to nothing and overflowing the grid. Reserve the
  // middle panel explicitly. (Reachable since the dock threshold dropped from
  // 1400 to 1100 — at 1400+ the fraction happened to leave enough room.)
  const byLayout = opts.docked
    ? viewportWidth - (opts.sidebarWidth ?? 0) - MAIN_MIN_PX
    : Number.POSITIVE_INFINITY;
  const max = Math.min(byFraction, byLayout);
  // Floor beats cap on tiny viewports: a too-narrow drawer is unusable,
  // and CSS max-width already keeps it inside the screen.
  return Math.max(Math.min(Math.round(px), max), DRAWER_MIN_PX);
}

/** dockedNow — mirrors the CSS breakpoint in workspace.css (the drawer takes a
 *  grid column at >=1100px). Read from the element rather than duplicating the
 *  number: computed position is `static` when docked, `fixed` when overlaying. */
function dockedNow(drawer: HTMLElement): boolean {
  return getComputedStyle(drawer).position === "static";
}

/** sidebarWidth — the column the drawer cannot consume. */
function sidebarWidth(): number {
  const el = document.querySelector(".app-sidebar");
  return el ? Math.round(el.getBoundingClientRect().width) : 0;
}

function storedWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function applyWidth(drawer: HTMLElement, px: number | null): void {
  if (px === null) drawer.style.removeProperty("--drawer-user-width");
  else drawer.style.setProperty("--drawer-user-width", `${px}px`);
}

/** setupDrawerResize — install the grab handle on #detail-drawer. */
export function setupDrawerResize(): void {
  const drawer = document.getElementById("detail-drawer");
  if (!drawer) return;

  const stored = storedWidth();
  if (stored !== null) applyWidth(drawer, clampDrawerWidth(stored, window.innerWidth, { docked: dockedNow(drawer), sidebarWidth: sidebarWidth() }));

  const handle = document.createElement("div");
  handle.className = "drawer-resize-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize detail panel — drag left or right, double-click to reset");
  handle.title = "Drag to resize · double-click to reset";
  drawer.appendChild(handle);

  let dragging = false;
  handle.addEventListener("pointerdown", (ev) => {
    dragging = true;
    handle.setPointerCapture(ev.pointerId);
    drawer.classList.add("drawer--resizing");
    ev.preventDefault();
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    // The drawer is right-anchored in both modes: its width is the distance
    // from the pointer to the viewport's right edge.
    const width = clampDrawerWidth(window.innerWidth - ev.clientX, window.innerWidth,
      { docked: dockedNow(drawer), sidebarWidth: sidebarWidth() });
    applyWidth(drawer, width);
  });
  const finish = (): void => {
    if (!dragging) return;
    dragging = false;
    drawer.classList.remove("drawer--resizing");
    const current = drawer.style.getPropertyValue("--drawer-user-width");
    try {
      if (current !== "") localStorage.setItem(STORAGE_KEY, current.replace("px", ""));
    } catch { /* private mode — width lives for the session only */ }
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("dblclick", () => {
    applyWidth(drawer, null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  });
}
