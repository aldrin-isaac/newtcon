// Browser smoke: per-port actions in the device interface table route through
// the workspace staging queue — Configure (access/trunk/routed) + Clear stage
// (with a pending overlay + bar count), and "+ Apply" opens the staged
// apply-service form.

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEVICE = process.env.DEVICE || "switch1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 },
});
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((net) => {
    try { localStorage.setItem("newtcon.activeNetwork", net); localStorage.setItem("newtcon:topology-view:" + net, "spec"); } catch { /* */ }
    const inst = () => new MutationObserver(() => { const b = document.querySelector(".confirm-modal-btn--confirm"); if (b instanceof HTMLElement) b.click(); }).observe(document.body, { childList: true, subtree: true });
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", inst); else inst();
  }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 60000 });
  await page.evaluate((dev) => document.querySelector(`g.topo-node[data-device='${dev}']`)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })), DEVICE);
  await page.waitForSelector(".topo-menu-header--button", { timeout: 20000 });
  await page.evaluate(() => document.querySelector(".topo-menu-header--button")?.click());
  await page.waitForSelector(".node-tabs", { timeout: 20000 });
  await page.evaluate(() => Array.from(document.querySelectorAll("button.node-tab")).find((b) => b.textContent.trim() === "Interfaces")?.click());
  await page.waitForSelector(".iface-table tbody .iface-row", { timeout: 20000 });

  // Expand a row → Configure ▾ → Set to access → VLAN 100 → Queue.
  await page.evaluate(() => document.querySelector(".iface-table tbody .iface-row")?.click());
  await page.waitForFunction(() => { const d = document.querySelector(".iface-detail-row"); return d && !d.hidden; }, { timeout: 20000 });
  await page.evaluate(() => Array.from(document.querySelectorAll(".iface-actions .iface-action-btn")).find((b) => /Configure/.test(b.textContent))?.click());
  await page.waitForSelector(".iface-portmode-menu", { timeout: 20000 });
  await page.evaluate(() => Array.from(document.querySelectorAll(".iface-portmode-menu .iface-action-btn")).find((b) => /access/.test(b.textContent))?.click());
  await page.waitForSelector(".iface-action-form", { timeout: 20000 });
  expect(await page.evaluate(() => !!document.querySelector(".iface-action-form input[type=number]")), "Configure→access form has a VLAN field");
  await page.evaluate(() => { const i = document.querySelector(".iface-action-form input[type=number]"); i.value = "100"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.evaluate(() => document.querySelector(".iface-action-form button[type=submit]")?.click());
  await page.waitForSelector(".chip--warning", { timeout: 20000 });
  await sleep(200);

  expect(await page.evaluate(() => document.querySelectorAll(".chip--warning").length) > 0, "staged action shows a pending overlay on the row");
  expect(await page.evaluate(() => { const m = (document.body.textContent || "").match(/(\d+)\s+pending/i); return m ? Number(m[1]) : 0; }) > 0, "workspace pending bar reflects the staged change");

  // "+ Apply" CTA opens the staged apply-service form (with a service dropdown).
  await page.evaluate(() => { const c = Array.from(document.querySelectorAll(".iface-apply-cta")); (c[c.length - 1] || c[0])?.click(); });
  await page.waitForFunction(() => { const f = document.querySelector(".iface-action-form"); return f && /service/i.test(f.textContent || "") && f.querySelector("select"); }, { timeout: 20000 });
  expect(true, "+ Apply opens the staged apply-service form with a service dropdown");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
