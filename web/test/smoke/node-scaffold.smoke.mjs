// Browser smoke: "Add node" scaffolds a service-ready node (#283) — it stages a
// profile WITH underlay_asn and a topology entry WITH a setup-device step, so
// the node can host services without manual fixups. Self-contained: creates a
// node via the form, applies, asserts the persisted scaffold, then deletes it.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "3node-vs-newtcon";
const DEV = "switch4";
const api = (p) => `${BASE}/api/networks/${NET}/${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => {
    try { localStorage.setItem("newtcon.activeNetwork", n); localStorage.setItem("newtcon:topology-view:" + n, "spec"); } catch { /* */ }
    const inst = () => new MutationObserver(() => { const b = document.querySelector(".confirm-modal-btn--confirm"); if (b instanceof HTMLElement) b.click(); }).observe(document.body, { childList: true, subtree: true });
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", inst); else inst();
  }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-topology"); await page.waitForSelector(".topo-node", { timeout: 10000 });
  await page.evaluate(() => Array.from(document.querySelectorAll(".topology-toolbar-btn")).find((b) => /Create node/.test(b.textContent))?.click());
  await page.waitForSelector('input[name="name"]', { timeout: 6000 });
  // wait for zone + platform option lists to populate
  await page.waitForFunction(() => (document.querySelector('select[name="zone"]')?.options.length ?? 0) > 1 && (document.querySelector('select[name="platform"]')?.options.length ?? 1) > 1, { timeout: 8000 });

  await page.evaluate((dev) => {
    const set = (sel, val, evt) => { const e = document.querySelector(sel); e.value = val; e.dispatchEvent(new Event(evt, { bubbles: true })); };
    set('input[name="name"]', dev, "input");
    set('input[name="mgmt_ip"]', "127.0.0.1", "input");
    set('input[name="loopback_ip"]', "10.1.0.4", "input");
    set('select[name="zone"]', "myzone", "change");
    set('select[name="platform"]', "Force10-S6000_vs", "change");
    set('select[name="role"]', "LeafRouter", "change");
    set('input[name="underlay_asn"]', "65004", "input");
  }, DEV);
  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Stage node")?.click());
  await sleep(500);
  // Save → confirm in the apply-preview modal (its own Apply button).
  await page.evaluate(() => document.getElementById("pending-bar-save")?.click());
  await page.waitForSelector(".apply-preview-card .btn-primary", { timeout: 8000 });
  await page.evaluate(() => Array.from(document.querySelectorAll(".apply-preview-card .btn-primary")).find((b) => /Apply/.test(b.textContent))?.click());
  await sleep(3000);

  // Verify persisted scaffold via the API.
  const topo = await (await fetch(api("topology"))).json();
  const entry = (topo.nodes ?? {})[DEV] ?? {};
  const setup = (entry.steps ?? []).find((s) => (s.url || "") === "/setup-device");
  expect(!!setup, "topology device has a setup-device step");
  expect(setup && setup.params?.fields?.hwsku === "Force10-S6000", `setup-device carries hwsku (${setup?.params?.fields?.hwsku})`);
  expect(setup && setup.params?.fields?.bgp_asn === "65004", `setup-device carries bgp_asn (${setup?.params?.fields?.bgp_asn})`);
  const prof = await (await fetch(api(`nodes/${DEV}`))).json();
  expect(prof && prof.underlay_asn === 65004, `profile has underlay_asn (${prof?.underlay_asn})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally {
  try { await fetch(api(`topology/nodes/${DEV}?force=true`), { method: "DELETE" }); await fetch(api(`nodes/${DEV}`), { method: "DELETE" }); } catch { /* */ }
  await browser.close();
}
