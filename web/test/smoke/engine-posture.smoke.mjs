// Browser smoke: engine posture surface (uplift 6.4, #447).
//   1. /api/health carries engine_posture with honest tri-states.
//   2. The newtron pill grows a chip per ABSENT/DISABLED layer (and stays
//      quiet when the stack is whole); the tooltip carries the sentence.
// Posture-agnostic: asserts UI consistency WITH whatever health reports.

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const health = await (await fetch(`${BASE}/api/health`)).json();
const posture = health.engine_posture;
expect(!!posture && ["enabled", "absent", "unknown"].includes(posture.auth_surface),
  `health carries auth_surface (${posture?.auth_surface})`);
expect(["enabled", "disabled", "unknown"].includes(posture?.audit_log ?? ""),
  `health carries audit_log (${posture?.audit_log})`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("newtron-target")?.textContent !== "checking…", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 500));

  const ui = await page.evaluate(() => ({
    chips: [...document.querySelectorAll("#newtron-pill .posture-flag")].map((c) => c.textContent),
    title: document.getElementById("newtron-pill")?.title ?? "",
  }));
  const expectedChips = (posture.auth_surface === "absent" ? 1 : 0) + (posture.audit_log === "disabled" ? 1 : 0);
  expect(ui.chips.length === expectedChips,
    `pill chips match posture (${JSON.stringify(ui.chips)} for auth=${posture.auth_surface}, audit=${posture.audit_log})`);
  if (posture.auth_surface === "absent") expect(ui.chips.includes("no auth"), "auth chip labeled");
  if (posture.audit_log === "disabled") expect(ui.chips.includes("no audit"), "audit chip labeled");
  expect(ui.title.includes("newtron connection"), "tooltip carries the posture sentence");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
