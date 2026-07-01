// Browser smoke: deleting a service that's still applied warns with the binding
// count before staging (defense-in-depth for newtron's delete-guard gap).
// Cancel must leave the service untouched. Read-only: never confirms the delete.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const SVC = "TRANSIT"; // applied on 6 underlay endpoints in the fixture
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-specs");
  await page.waitForSelector('[data-kind="services"]', { timeout: 8000 });
  await page.click('[data-kind="services"]');
  await page.waitForSelector(`[aria-label="Delete ${SVC}"]`, { timeout: 8000 });

  await page.evaluate((s) => document.querySelector(`[aria-label="Delete ${s}"]`)?.click(), SVC);
  await page.waitForSelector(".confirm-modal", { timeout: 5000 });
  const body = await page.evaluate(() => document.querySelector(".confirm-modal-body")?.textContent || "");
  const confirmLabel = await page.evaluate(() => document.querySelector(".confirm-modal-btn--confirm")?.textContent || "");
  expect(/applied on 6 interfaces/.test(body), `warns with binding count (“${body.slice(0, 70)}…”)`);
  expect(/also removes those \d+ binding/.test(body), "explains force delete cascades the bindings");
  expect(/switch\d:Ethernet\d/.test(body), "lists the bound endpoints");
  expect(confirmLabel === "Force delete", `confirm offers Force delete (got "${confirmLabel}")`);

  // Cancel → service must remain.
  await page.evaluate(() => document.querySelector(".confirm-modal-btn--cancel")?.click());
  await sleep(400);
  const present = await page.evaluate((s) => !!document.querySelector(`[aria-label="Delete ${s}"]`), SVC);
  expect(present, "Cancel leaves the service in place (not staged for delete)");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
