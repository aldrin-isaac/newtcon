// Browser smoke: an audit event's detail can be expanded, collapsed, and
// expanded AGAIN — regression for the "stuck on Loading… after re-open" bug
// (the detail row is destroyed on collapse, so re-open must render from cache,
// not just guard the fetch).

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
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-audit");
  await page.waitForSelector(".audit-row--expandable", { timeout: 20000 });
  const toggle = () => page.evaluate(() => document.querySelector(".audit-row--expandable")?.click());

  await toggle();
  await page.waitForSelector(".audit-detail-row .audit-detail", { timeout: 20000 });
  expect(true, "first open renders the detail");

  await toggle(); await sleep(150);
  expect(await page.evaluate(() => !document.querySelector(".audit-detail-row")), "collapse removes the detail row");

  await toggle();
  let ok = false;
  try {
    await page.waitForFunction(() => {
      const d = document.querySelector(".audit-detail-row");
      return d && d.querySelector(".audit-detail") && !d.querySelector(".audit-detail-loading");
    }, { timeout: 20000 });
    ok = true;
  } catch { ok = false; }
  expect(ok, "re-open renders the detail (not stuck on Loading…)");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
