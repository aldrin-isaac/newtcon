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
export function clampDrawerWidth(px: number, viewportWidth: number): number {
  const max = Math.floor(viewportWidth * DRAWER_MAX_VIEWPORT_FRACTION);
  // Floor beats cap on tiny viewports: a too-narrow drawer is unusable,
  // and CSS max-width already keeps it inside the screen.
  return Math.max(Math.min(Math.round(px), max), DRAWER_MIN_PX);
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
  if (stored !== null) applyWidth(drawer, clampDrawerWidth(stored, window.innerWidth));

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
    const width = clampDrawerWidth(window.innerWidth - ev.clientX, window.innerWidth);
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
