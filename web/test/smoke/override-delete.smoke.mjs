// Browser smoke: a zone/node override can be deleted from the Specs UI (scoped
// delete, newtron #319). Self-contained: creates a zone override of IPVPN via
// /api, deletes it through the override row's × (staged) + Apply, asserts it's
// gone, and the network base survives. Cleans up via newtron if anything leaks.

import puppeteer from "puppeteer-core";
import { authenticatePage, loginCookie } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const NEWTRON = process.env.NEWTRON_URL || "http://127.0.0.1:18080";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };
const api = (p) => `${BASE}/api/networks/${NET}/${p}`;
// Node-side calls go through newtcon /api with the session cookie (newtron :18080
// needs a bearer under --auth-required).
const _ck = await loginCookie(BASE);
const AUTH = _ck ? { Cookie: `${_ck.name}=${_ck.value}` } : {};
const af = (p, opts = {}) => fetch(api(p), { ...opts, headers: { ...(opts.headers || {}), ...AUTH } });
// Discover an existing ipvpn + zone to scope the override onto, so the smoke
// adapts to whatever specs the network has rather than assuming IPVPN/myzone.
const IPVPN = ((await (await af("ipvpns")).json()).names || [])[0];
const ZONE = ((await (await af("zones")).json()).names || [])[0];
if (!IPVPN || !ZONE) { console.log(`SKIP: ${NET} needs an ipvpn + a zone for the override smoke`); process.exit(0); }
const removeOverride = () => af(`ipvpns/${IPVPN}?scope=zone&scope_instance=${ZONE}`, { method: "DELETE" }).catch(() => {});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 950 } });
try {
  await removeOverride();
  const b = await (await af(`ipvpns/${IPVPN}`)).json();
  const cr = await af("ipvpns", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: IPVPN, scope: "zone", scope_instance: ZONE, l3vni: b.l3vni, route_targets: b.route_targets }) });
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

  const baseAlive = (await (await af("ipvpns")).json()).names?.includes(IPVPN);
  expect(baseAlive, `network base ${IPVPN} survives the scoped delete`);
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
