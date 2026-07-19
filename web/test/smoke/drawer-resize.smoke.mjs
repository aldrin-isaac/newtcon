// Browser smoke: resizable drawer (drawer-resize.ts).
//   1. Dragging the left-edge handle widens the drawer.
//   2. CONTENTS reflow with it (the drawer table grows too).
//   3. The width persists across reload; double-click resets to default.
// Runs in docked mode (1500px viewport); overlay uses the same handle+var.

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  const device = await (async () => {
    const { apiGET } = await import("./_auth.mjs");
    const topo = await apiGET(NET, "topology", BASE).catch(() => null);
    const names = Object.keys(topo?.nodes || {});
    return names.find((n) => n.startsWith("switch")) || names[0];
  })();
  if (!device) { console.log(`SKIP: no devices on ${NET}`); process.exit(0); }

  await gotoApp(page, `${BASE}/#/${NET}/topology/device/${device}`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector("#detail-drawer.open .drawer-resize-handle", { timeout: 30000 });
  const widths = () => page.evaluate(() => {
    const d = document.getElementById("detail-drawer");
    const t = d.querySelector(".drawer-content table");
    return { drawer: Math.round(d.getBoundingClientRect().width), table: t ? Math.round(t.getBoundingClientRect().width) : 0 };
  });

  const before = await widths();
  const handle = await page.$(".drawer-resize-handle");
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 3, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + 300, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const after = await widths();
  expect(after.drawer > before.drawer + 150, `drag widens the drawer (${before.drawer} → ${after.drawer})`);
  expect(after.table > before.table + 100, `contents reflow proportionally (table ${before.table} → ${after.table})`);

  await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector("#detail-drawer.open", { timeout: 30000 });
  await sleep(300);
  const persisted = await widths();
  expect(Math.abs(persisted.drawer - after.drawer) <= 2, `width persists across reload (${persisted.drawer})`);

  await page.evaluate(() => document.querySelector(".drawer-resize-handle")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await sleep(300);
  const reset = await widths();
  expect(Math.abs(reset.drawer - before.drawer) <= 2, `double-click resets to default (${reset.drawer})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
