// Browser smoke: docked inspector (uplift 2.5, #405).
//   ≥1400px: the drawer docks — position:static grid pane beside the
//     workspace; the topology canvas and the inspector DO NOT overlap.
//   <1400px: the overlay is retained — position:fixed, slides over content.
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
  expect(wide.position === "static", `≥1400px: drawer is a docked grid pane (position ${wide.position})`);
  expect(wide.drawerWidth > 300, `docked pane has real width (${Math.round(wide.drawerWidth)}px)`);
  expect(wide.overlapPx === 0, `canvas and inspector do not overlap (overlap ${Math.round(wide.overlapPx)}px)`);
  expect(!wide.bodyHack, "body.drawer-open hack is gone");

  // ---- Overlay mode (narrow) ----
  await page.setViewport({ width: 1200, height: 900 });
  const narrow = await openDrawerAndMeasure();
  expect(narrow.position === "fixed", `<1400px: drawer overlays (position ${narrow.position})`);
  expect(narrow.drawerWidth > 300, `overlay has real width (${Math.round(narrow.drawerWidth)}px)`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
