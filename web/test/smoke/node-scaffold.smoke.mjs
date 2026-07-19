// Browser smoke: "Add node" scaffolds a service-ready node (#283) — it stages a
// profile WITH underlay_asn and a topology entry WITH a setup-device step, so
// the node can host services without manual fixups. Self-contained: creates a
// node via the form, applies, asserts the persisted scaffold, then deletes it.

import puppeteer from "puppeteer-core";
import { authenticatePage, loginCookie, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEV = "switch4";
const api = (p) => `${BASE}/api/networks/${NET}/${p}`;
const _ck = await loginCookie(BASE);
const AUTH = _ck ? { Cookie: `${_ck.name}=${_ck.value}` } : {};
const af = (p, opts = {}) => fetch(api(p), { ...opts, headers: { ...(opts.headers || {}), ...AUTH } });
// Discover the network's zone + a platform (reuse an existing device's) + that
// platform's hwsku, so the scaffolded node adapts to the network rather than
// assuming myzone / Force10-S6000.
const ZONE = ((await (await af("zones")).json()).names || [])[0];
const REF = await (await af(`nodes/${process.env.DEVICE || "switch1"}`)).json();
const PLATFORM = REF.platform;
const HWSKU = PLATFORM ? (await (await af(`platforms/${PLATFORM}`)).json()).hwsku : null;
if (!ZONE || !PLATFORM) { console.log(`SKIP: ${NET} needs a zone + a platform for the node-scaffold smoke`); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => {
    try { localStorage.setItem("newtcon.activeNetwork", n); localStorage.setItem("newtcon:topology-view:" + n, "spec"); } catch { /* */ }
    const inst = () => new MutationObserver(() => { const b = document.querySelector(".confirm-modal-btn--confirm"); if (b instanceof HTMLElement) b.click(); }).observe(document.body, { childList: true, subtree: true });
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", inst); else inst();
  }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 20000 });
  // Node creation is Specs-only (#353): Specs -> Node facet -> "+ New".
  await page.click("#tab-specs");
  await page.waitForSelector('[data-kind="nodes"]', { timeout: 60000 });
  await page.click('[data-kind="nodes"]');
  await page.waitForSelector(".panel-add-btn", { timeout: 20000 });
  await page.evaluate(() => document.querySelector(".panel-add-btn")?.click());
  await page.waitForSelector('input[name="name"]', { timeout: 20000 });
  // Wait for the SPECIFIC options we fill to populate. A count > 1 is wrong for a
  // 1-zone fixture (smoke-fixture has only "myzone"), which left the zone select
  // on its placeholder and silently blocked the required-field submit.
  await page.waitForFunction((zone, platform) =>
    Array.from(document.querySelector('select[name="zone"]')?.options ?? []).some((o) => o.value === zone) &&
    Array.from(document.querySelector('select[name="platform"]')?.options ?? []).some((o) => o.value === platform),
    { timeout: 20000 }, ZONE, PLATFORM);

  await page.evaluate((dev, zone, platform) => {
    const set = (sel, val, evt) => { const e = document.querySelector(sel); e.value = val; e.dispatchEvent(new Event(evt, { bubbles: true })); };
    set('input[name="name"]', dev, "input");
    set('input[name="mgmt_ip"]', "127.0.0.1", "input");
    set('input[name="loopback_ip"]', "10.9.9.9", "input");
    set('select[name="zone"]', zone, "change");
    set('select[name="platform"]', platform, "change");
    set('input[name="underlay_asn"]', "65004", "input");
  }, DEV, ZONE, PLATFORM);
  await page.evaluate(() => Array.from(document.querySelectorAll("button.form-submit-btn")).find((b) => /Create/.test(b.textContent))?.click());
  await sleep(500);
  // Save → confirm in the apply-preview modal (its own Apply button).
  await page.evaluate(() => document.getElementById("pending-bar-save")?.click());
  await page.waitForSelector(".apply-preview-card .btn-primary", { timeout: 20000 });
  await page.evaluate(() => Array.from(document.querySelectorAll(".apply-preview-card .btn-primary")).find((b) => /Apply/.test(b.textContent))?.click());
  await sleep(3000);

  // Verify persisted scaffold via the API.
  const topo = await (await af("topology")).json();
  const entry = (topo.nodes ?? {})[DEV] ?? {};
  const setup = (entry.steps ?? []).find((s) => (s.url || "") === "/setup-device");
  expect(!!setup, "topology device has a setup-device step");
  expect(setup && setup.params?.fields?.hwsku === HWSKU, `setup-device carries discovered hwsku ${HWSKU} (${setup?.params?.fields?.hwsku})`);
  expect(setup && setup.params?.fields?.bgp_asn === "65004", `setup-device carries bgp_asn (${setup?.params?.fields?.bgp_asn})`);
  const prof = await (await af(`nodes/${DEV}`)).json();
  expect(prof && prof.underlay_asn === 65004, `profile has underlay_asn (${prof?.underlay_asn})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally {
  try { await af(`topology/nodes/${DEV}?force=true`, { method: "DELETE" }); await af(`nodes/${DEV}`, { method: "DELETE" }); } catch { /* */ }
  await browser.close();
}
