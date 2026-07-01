// Browser smoke: a zone/node override can be deleted from the Specs UI (scoped
// delete, newtron #319). Self-contained: creates a zone override of IPVPN via
// /api, deletes it through the override row's × (staged) + Apply, asserts it's
// gone, and the network base survives. Cleans up via newtron if anything leaks.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const NEWTRON = process.env.NEWTRON_URL || "http://127.0.0.1:18080";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "3node-vs-newtcon";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };
const api = (p) => `${BASE}/api/networks/${NET}/${p}`;
const removeOverride = () => fetch(`${NEWTRON}/newtron/v1/networks/${NET}/delete-ipvpn`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "IPVPN", scope: "zone", scope_instance: "myzone" }),
}).catch(() => {});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 950 } });
try {
  await removeOverride();
  const b = await (await fetch(api("ipvpns/IPVPN"))).json();
  const cr = await fetch(api("ipvpns"), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "IPVPN", scope: "zone", scope_instance: "myzone", l3vni: b.l3vni, route_targets: b.route_targets }) });
  expect(cr.status === 201, `override created (${cr.status})`);

  const page = await browser.newPage();

  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-specs");
  await page.waitForSelector('[data-kind="ipvpns"]', { timeout: 8000 });
  await page.click('[data-kind="ipvpns"]');
  await page.waitForSelector(".panel-list-row", { timeout: 8000 });
  await sleep(300);
  await page.evaluate(() => document.querySelector(".panel-override-toggle")?.click()); // expand
  await page.waitForSelector(".panel-list-row--override .panel-delete-btn", { timeout: 5000 });

  await page.evaluate(() => document.querySelector(".panel-list-row--override .panel-delete-btn")?.click());
  await sleep(400);
  const pending = await page.evaluate(() => (document.body.textContent.match(/(\d+)\s+pending/i) || [])[1] || "0");
  expect(pending === "1", `override delete staged (pending=${pending})`);

  await page.evaluate(() => document.getElementById("pending-bar-save")?.click());
  await page.waitForSelector(".apply-preview-card .btn-primary", { timeout: 8000 });
  await page.evaluate(() => Array.from(document.querySelectorAll(".apply-preview-card .btn-primary")).find((x) => /Apply/.test(x.textContent))?.click());
  await sleep(2500);

  const baseAlive = (await (await fetch(api("ipvpns"))).json()).names?.includes("IPVPN");
  expect(baseAlive, "network base IPVPN survives the scoped delete");
  // Re-open the facet and confirm no override rows remain.
  await page.click('[data-kind="services"]'); await sleep(150);
  await page.click('[data-kind="ipvpns"]'); await sleep(400);
  await page.evaluate(() => document.querySelector(".panel-override-toggle")?.click());
  await sleep(200);
  const ovLeft = await page.evaluate(() => document.querySelectorAll(".panel-list-row--override").length);
  expect(ovLeft === 0, `override removed from the facet (${ovLeft} left)`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally {
  await removeOverride();
  await browser.close();
}
