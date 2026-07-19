// Browser smoke: toast discipline (uplift 2.3, #403). Three properties,
// asserted geometrically in a real viewport (the screenshot-proof acceptance):
//   1. The toast region sits BELOW the header bar — toasts never overlap
//      header controls (network switcher, pending bar, pills).
//   2. The visible stack is capped at 4.
//   3. An identical repeat collapses into a ×N counter instead of stacking.
// Lab-independent: toasts are fired directly via the page's own toast module.

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
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 30000 });

  const result = await page.evaluate(async () => {
    const { showToast } = await import("/toast.js");
    // Overflow the cap with distinct toasts, then repeat one three times.
    for (const t of ["one", "two", "three", "four", "five"]) showToast({ kind: "info", title: "Toast " + t });
    showToast({ kind: "error", title: "Apply failed", body: "same reason" });
    showToast({ kind: "error", title: "Apply failed", body: "same reason" });
    showToast({ kind: "error", title: "Apply failed", body: "same reason" });
    const header = document.querySelector(".app-header").getBoundingClientRect();
    const region = document.querySelector(".toast-region").getBoundingClientRect();
    return {
      headerBottom: header.bottom,
      regionTop: region.top,
      visible: document.querySelectorAll(".toast").length,
      countBadge: document.querySelector(".toast-count")?.textContent || null,
    };
  });

  expect(result.regionTop >= result.headerBottom,
    `toast region starts below the header (region top ${result.regionTop} ≥ header bottom ${result.headerBottom})`);
  expect(result.visible <= 4, `visible stack capped (${result.visible} ≤ 4)`);
  expect(result.countBadge === "×3", `triple repeat collapsed into a ×3 counter (got ${JSON.stringify(result.countBadge)})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
