// Headless smoke for phase 4 of the unified-substrate direction:
//   - Lab tab retired (no #tab-lab / #panel-lab in DOM)
//   - Provision button now lives in the Topology toolbar (alongside
//     Deploy as lab + Destroy lab)
//   - Sidebar nav shrinks to Specs + Topology

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
await authenticatePage(page, BASE);
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate(() => localStorage.setItem("newtcon.activeNetwork", "2node-vs"));
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });

  // ── 1. Sidebar nav is Specs + Topology only ─────────────────────────────
  const navLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".nav-item .nav-label")).map((el) => el.textContent?.trim()));
  expect(!navLabels.includes("Lab"),
    `Lab tab retired — not in sidebar nav: ${JSON.stringify(navLabels)}`);

  // ── 2. #tab-lab and #panel-lab are gone ─────────────────────────────────
  const stragglers = await page.evaluate(() => ({
    tabLab:   !!document.getElementById("tab-lab"),
    panelLab: !!document.getElementById("panel-lab"),
  }));
  expect(!stragglers.tabLab && !stragglers.panelLab,
    `no Lab tab/panel in DOM: ${JSON.stringify(stragglers)}`);

  // ── 3. Topology toolbar (Lab view) has all 3 lab-lifecycle buttons ──────
  await page.click("#tab-topology");
  await new Promise((r) => setTimeout(r, 1500));
  // View-mode gating (post-#210): lab lifecycle lives in the Lab view.
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll(".topology-view-chip"))
      .find((el) => el.textContent.trim() === "Lab");
    if (chip instanceof HTMLElement) chip.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  const toolbarBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".topology-toolbar-btn"))
      .map((b) => b.textContent?.trim()));
  expect(toolbarBtns.includes("Deploy"),  `toolbar has Deploy: ${JSON.stringify(toolbarBtns)}`);
  expect(toolbarBtns.includes("Provision"), `toolbar has Provision: ${JSON.stringify(toolbarBtns)}`);
  expect(toolbarBtns.includes("Destroy"), `toolbar has Destroy: ${JSON.stringify(toolbarBtns)}`);

  // ── 4. Provision click mounts inline confirm + POST on accept ───────────
  let provisionPostSeen = false;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/labs/") && req.url().endsWith("/provision")) {
      provisionPostSeen = true;
    }
  });

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll(".topology-toolbar-btn"))
      .find((el) => el.textContent.trim() === "Provision");
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 250));
  const provisionConfirmModal = await page.$(".confirm-overlay");
  expect(!!provisionConfirmModal, "Provision click mounts inline confirm modal");

  // Cancel first → no POST on the wire.
  await page.evaluate(() => {
    const cancel = document.querySelector(".confirm-modal-btn--cancel");
    if (cancel instanceof HTMLElement) cancel.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(!provisionPostSeen, "cancelled confirm → no POST (operator stayed safe)");

  // Re-click and accept → POST goes through.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll(".topology-toolbar-btn"))
      .find((el) => el.textContent.trim() === "Provision");
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(() => {
    const confirm = document.querySelector(".confirm-modal-btn--confirm");
    if (confirm instanceof HTMLElement) confirm.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  expect(provisionPostSeen, "accepted confirm → POST /api/labs/{net}/provision observed");

  await page.screenshot({ path: "/tmp/newtcon-smoke-phase4.png" });

  console.log("");
  if (failed.length === 0) console.log("✅ all checks passed");
  else { console.log(`❌ ${failed.length} failed`); process.exitCode = 1; }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
