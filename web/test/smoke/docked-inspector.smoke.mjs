// Browser smoke: docked inspector (uplift 2.5, #405).
//   ≥1250px: the drawer docks — position:static grid pane beside the
//     workspace; the topology canvas and the inspector DO NOT overlap.
//   <1250px: the overlay is retained — position:fixed, slides over content.
//
// The threshold was 1400px, which left an ordinary laptop with a flat 640px
// overlay covering the canvas instead of a resizable column. It was then 1100,
// which docked so eagerly that a 1200px window kept only ~545px of canvas —
// technically usable, too cramped to work in. 1250 is the operator's call, and
// the exact boundary is asserted below so it cannot drift silently.
// Also proves the body.drawer-open hack is gone (no class, no canvas padding).
// Device discovered from the network's topology (spec-only is fine).

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp, apiGET } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const topo = await apiGET(NET, "topology", BASE).catch(() => null);
const names = Object.keys(topo?.nodes || {});
const device = names.find((n) => n.startsWith("switch")) || names[0];
if (!device) {
  console.log(`SKIP: network ${NET} has no topology devices`);
  process.exit(0);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  const openDrawerAndMeasure = async () => {
    await gotoApp(page, `${BASE}/#/${NET}/topology/device/${device}`, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForSelector("#detail-drawer.open", { timeout: 20000 });
    await page.waitForSelector(".topo-node", { timeout: 60000 });
    return page.evaluate(() => {
      const drawer = document.getElementById("detail-drawer");
      const canvas = document.querySelector("#panel-topology svg");
      const d = drawer.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return {
        position: getComputedStyle(drawer).position,
        drawerWidth: d.width,
        overlapPx: Math.max(0, Math.min(d.right, c.right) - Math.max(d.left, c.left)),
        bodyHack: document.body.classList.contains("drawer-open"),
      };
    });
  };

  // ---- Docked mode (wide) ----
  await page.setViewport({ width: 1500, height: 950 });
  const wide = await openDrawerAndMeasure();
  expect(wide.position === "static", `≥1250px: drawer is a docked grid pane (position ${wide.position})`);
  expect(wide.drawerWidth > 300, `docked pane has real width (${Math.round(wide.drawerWidth)}px)`);
  expect(wide.overlapPx === 0, `canvas and inspector do not overlap (overlap ${Math.round(wide.overlapPx)}px)`);
  expect(!wide.bodyHack, "body.drawer-open hack is gone");

  // ---- Overlay mode (narrow) ----
  await page.setViewport({ width: 1000, height: 900 });
  const narrow = await openDrawerAndMeasure();
  expect(narrow.position === "fixed", `<1250px: drawer overlays (position ${narrow.position})`);
  expect(narrow.drawerWidth > 300, `overlay has real width (${Math.round(narrow.drawerWidth)}px)`);


  // ---- The threshold itself ----
  // A media query is an off-by-one waiting to happen (min-width is inclusive),
  // and "roughly docks around 1250" is not a testable claim. Pin both sides.
  const modeAt = async (w) => {
    await page.setViewport({ width: w, height: 900 });
    await new Promise((r) => setTimeout(r, 400));
    return page.evaluate(() =>
      getComputedStyle(document.getElementById("detail-drawer")).position);
  };
  expect((await modeAt(1250)) === "static", "1250px (threshold): drawer docks");
  expect((await modeAt(1249)) === "fixed", "1249px (one under): drawer overlays");

  // The band the threshold change was made for: a laptop-width window must dock
  // (resizable column) rather than overlay, and dragging the drawer as wide as
  // it will go must not push the row past the window — the workspace track has
  // min-width:0 so it yields, and the clamp reserves MAIN_MIN_PX for it.
  await page.setViewport({ width: 1300, height: 900 });
  await new Promise((r) => setTimeout(r, 600));
  const laptop = await page.evaluate(() => ({
    position: getComputedStyle(document.getElementById("detail-drawer")).position,
  }));
  expect(laptop.position === "static", `1300px (laptop): drawer docks (position ${laptop.position})`);

  const handle = await page.evaluate(() => {
    const e = document.querySelector('[class*="drawer-resize"],.drawer-resize-handle');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (handle) {
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(60, handle.y, { steps: 12 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 1200));
    const dragged = await page.evaluate(() => {
      const w = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().width);
      const sum = w(".app-sidebar") + w(".app-main") + w("#detail-drawer");
      return { sum, vw: window.innerWidth, main: w(".app-main"),
               overflowsX: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    expect(!dragged.overflowsX, "an extreme drawer drag does not overflow the page sideways");
    expect(Math.abs(dragged.sum - dragged.vw) <= 2,
      `columns still tile the window exactly (${dragged.sum} vs ${dragged.vw})`);
    expect(dragged.main >= 400, `workspace keeps a usable floor (${dragged.main}px)`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
