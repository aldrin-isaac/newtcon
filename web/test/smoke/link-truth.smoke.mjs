// Browser smoke: link truth (uplift 4.2, #422).
//   1. Every rendered topology link carries exactly one LLDP-verdict class
//      (verified / intent-only / mismatch) — the class-mapping DoD.
//   2. A spec-only fabric (no live devices) renders all links intent-only
//      (dashed — the not-actuated law).
//   3. The link-truth legend is present on the canvas.
// Runs against NET (default smoke-fixture: stable spec-only fabric).

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await gotoApp(page, `${BASE}/#/${NET}/topology`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".topo-link", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1000));

  const links = await page.evaluate(() =>
    [...document.querySelectorAll(".topo-link")].filter((l) => !l.classList.contains("topo-link-hit") && !l.closest(".topo-legend")).map((l) => ({
      verdicts: ["topo-link--verified", "topo-link--intent-only", "topo-link--mismatch"].filter((c) => l.classList.contains(c)),
      dashed: getComputedStyle(l).strokeDasharray !== "none",
    })));
  expect(links.length > 0, `links rendered (${links.length})`);
  expect(links.every((l) => l.verdicts.length === 1),
    "every link carries exactly one verdict class");

  const intentLinks = links.filter((l) => l.verdicts[0] === "topo-link--intent-only");
  expect(intentLinks.every((l) => l.dashed), `intent-only links are dashed (${intentLinks.length} of ${links.length})`);
  const verifiedLinks = links.filter((l) => l.verdicts[0] === "topo-link--verified");
  expect(verifiedLinks.every((l) => !l.dashed), `verified links are solid (${verifiedLinks.length})`);

  expect(await page.evaluate(() => !!document.querySelector(".topo-legend")), "link-truth legend present");
  const legendText = await page.evaluate(() => document.querySelector(".topo-legend")?.textContent || "");
  expect(legendText.includes("verified") && legendText.includes("intent-only"),
    "legend teaches the line grammar");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
