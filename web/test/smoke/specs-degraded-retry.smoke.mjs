// Browser smoke: a transient schema-catalog failure must NOT dead-mount the
// Specs view (#390). With /api/schema/all blocked, the view renders a
// retryable "Couldn't load the spec catalog" state; once the endpoint is
// reachable again, the Retry button mounts the real facet subnav — no page
// reload required. Lab-independent: only the schema endpoint is exercised.

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  // Phase 1: schema catalog unreachable → degraded state with a Retry button.
  // Simulated with a page-context fetch monkeypatch, NOT setRequestInterception:
  // interception drops the puppeteer-installed session cookie (whoami 401s and
  // the auth gate blocks the mount before any schema fetch fires).
  await page.evaluateOnNewDocument(() => {
    const orig = window.fetch;
    window.__schemaBlocked = true;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (window.__schemaBlocked && url.includes("/api/schema/all")) {
        return Promise.reject(new TypeError("simulated schema outage (smoke)"));
      }
      return orig.call(window, input, init);
    };
  });
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".specs-degraded", { timeout: 20000 });
  expect(true, "blocked schema fetch renders the degraded state, not a dead mount");
  const heading = await page.evaluate(() => document.querySelector(".specs-degraded h3")?.textContent || "");
  expect(heading.includes("Couldn't load the spec catalog"), "degraded state explains what failed");
  expect(await page.evaluate(() => !!document.querySelector(".specs-degraded button")), "degraded state offers a Retry button");

  // Phase 2: endpoint healthy again → Retry mounts the real view in place.
  await page.evaluate(() => { window.__schemaBlocked = false; });
  await page.evaluate(() => document.querySelector(".specs-degraded button")?.click());
  await page.waitForSelector(".specs-subnav", { timeout: 60000 });
  expect(true, "Retry mounts the facet subnav without a page reload");
  expect(await page.evaluate(() => !document.querySelector(".specs-degraded")), "degraded state is gone after recovery");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
