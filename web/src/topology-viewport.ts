// topology-viewport.ts — pure pan / zoom math for the Topology view.
//
// SVG viewBox-driven: the viewport (x, y, w, h) defines the rectangle of
// the SVG coordinate space that maps to the rendered <svg> element. Zoom
// shrinks/grows (w, h); pan translates (x, y). Aspect ratio of the
// viewBox matches the rendered element's aspect ratio so circles stay
// circular.
//
// Why a separate module: the math is small but fiddly (zoom-around-
// cursor in particular), and renderTopologySVG in app.ts is already
// long. This stays pure — no DOM, no event handling — so tests don't
// need a browser.

/** Viewport — the SVG viewBox rect. */
export interface ViewState {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 2D box, used for fit-to-view bounds. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Minimum / maximum zoom factor relative to the natural (1.0) view. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4.0;

/** Default zoom multiplier per wheel "notch" (browsers vary; this is per-step). */
export const ZOOM_STEP = 1.15;

/**
 * fitToBounds returns the viewport that frames the given bounds inside
 * an element of the supplied pixel dimensions, with a margin.
 *
 * Aspect-ratio-aware: the returned viewport's w/h matches the element
 * shape so the rendered topology isn't squashed.
 */
export function fitToBounds(
  bounds: Bounds,
  elementWidth: number,
  elementHeight: number,
  margin = 40,
): ViewState {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const elAspect = elementWidth / Math.max(1, elementHeight);
  const boundsAspect = bw / bh;

  let vw: number;
  let vh: number;
  if (boundsAspect > elAspect) {
    // Bounds are wider relative to element — fit width.
    vw = bw + margin * 2;
    vh = vw / elAspect;
  } else {
    // Bounds taller — fit height.
    vh = bh + margin * 2;
    vw = vh * elAspect;
  }
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    x: cx - vw / 2,
    y: cy - vh / 2,
    w: vw,
    h: vh,
  };
}

/**
 * zoomAt returns a new viewport zoomed by `factor` around the given
 * pixel-space (clientX, clientY) within an element of size
 * (elementWidth, elementHeight) displaying `current` as its viewBox.
 *
 * Factor > 1 zooms in (smaller viewBox); factor < 1 zooms out.
 *
 * Clamped against the natural-zoom range, which is set by `naturalW`
 * (the viewBox width at zoom=1.0). Without that reference we'd allow
 * arbitrary zoom and the operator would lose the graph.
 */
export function zoomAt(
  current: ViewState,
  factor: number,
  cursorX: number,
  cursorY: number,
  elementWidth: number,
  elementHeight: number,
  naturalW: number,
): ViewState {
  // Cursor position in SVG (viewBox) coordinates.
  const sx = current.x + (cursorX / elementWidth) * current.w;
  const sy = current.y + (cursorY / elementHeight) * current.h;

  // Proposed new size (zoom in → smaller viewBox → factor > 1).
  let newW = current.w / factor;
  let newH = current.h / factor;

  // Clamp against the natural-zoom range. naturalW/ZOOM_MAX is the
  // smallest viewBox we allow (deepest zoom); naturalW/ZOOM_MIN is the
  // largest (most zoomed out).
  const minW = naturalW / ZOOM_MAX;
  const maxW = naturalW / ZOOM_MIN;
  if (newW < minW) {
    const k = minW / newW;
    newW *= k; newH *= k;
  } else if (newW > maxW) {
    const k = maxW / newW;
    newW *= k; newH *= k;
  }

  // Translate so the cursor's SVG-coord position stays fixed at the
  // same element-space (cursorX, cursorY).
  return {
    x: sx - (cursorX / elementWidth) * newW,
    y: sy - (cursorY / elementHeight) * newH,
    w: newW,
    h: newH,
  };
}

/**
 * panBy returns a new viewport translated by (dx, dy) measured in
 * pixel space relative to an element of size (elementWidth,
 * elementHeight). The translation converts to viewBox space using the
 * current zoom level so panning feels 1:1 with the cursor.
 */
export function panBy(
  current: ViewState,
  dx: number,
  dy: number,
  elementWidth: number,
  elementHeight: number,
): ViewState {
  const factorX = current.w / elementWidth;
  const factorY = current.h / elementHeight;
  return {
    x: current.x - dx * factorX,
    y: current.y - dy * factorY,
    w: current.w,
    h: current.h,
  };
}

/** Format a ViewState as the SVG viewBox attribute string. */
export function viewBoxStr(v: ViewState): string {
  return `${v.x} ${v.y} ${v.w} ${v.h}`;
}
