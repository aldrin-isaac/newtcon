// Headless smoke for phase 3 of the unified-substrate direction:
//   - Lifecycle section in the device-inspector drawer
//   - "Tear down" toolbar button in Lab view (mirror of "Bring up")
//
// Asserts structural presence + correct state-based content.  The full
// transition (Stop / Start / Tear-down → device boots back up) depends on
// newtlab actually completing a deploy and isn't reliably timed in a smoke;
// the wire-level interactions are what we pin here.

import puppeteer from "puppeteer-core";

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
let dialogSawConfirm = false;
page.on("dialog", (d) => {
  dialogSawConfirm = true;
  void d.dismiss();  // don't actually destroy the lab
});

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate(() => localStorage.setItem("newtcon.activeNetwork", "2node-vs"));
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.click("#tab-topology");
  await new Promise((r) => setTimeout(r, 1500));

  // Switch to Lab view so the lifecycle buttons are present in the
  // toolbar (post-#210 view-mode gating: Spec view doesn't carry lab
  // lifecycle).
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll(".topology-view-chip"))
      .find((el) => el.textContent.trim() === "Lab");
    if (chip instanceof HTMLElement) chip.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  // ── 1. Tear-down toolbar button is present in Lab view ───────────────────
  const tearDownText = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll(".topology-toolbar-btn"))
      .find((el) => el.textContent.trim() === "Tear down");
    return b ? { text: b.textContent.trim(), classes: b.className } : null;
  });
  expect(tearDownText !== null, `Lab view toolbar has "Tear down" button`);

  // ── 2. Tear-down click fires a confirm dialog (dismissed automatically) ──
  dialogSawConfirm = false;
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll(".topology-toolbar-btn"))
      .find((el) => el.textContent.trim() === "Tear down");
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  expect(dialogSawConfirm, "tear-down click triggers confirm dialog");

  await page.screenshot({ path: "/tmp/newtcon-smoke-lifecycle-01-topology.png" });

  // Switch back to Spec view so the right-click → Inspect context menu
  // is available (gated to Spec post-#210).
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll(".topology-view-chip"))
      .find((el) => el.textContent.trim() === "Spec");
    if (chip instanceof HTMLElement) chip.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  // ── 3. Open the device inspector for switch1 via right-click → Inspect ───
  // SVG node has class topo-node + data-device. The contextmenu handler in
  // app.ts opens a floating menu whose header (.topo-menu-header--button)
  // calls openNodeDrawer when clicked.
  await page.evaluate(() => {
    const g = document.querySelector("svg.topology-graph g.topo-node[data-device='switch1']");
    if (g) g.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 }));
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    const header = document.querySelector(".topo-menu-header--button");
    if (header instanceof HTMLElement) header.click();
  });
  await new Promise((r) => setTimeout(r, 800));

  await page.screenshot({ path: "/tmp/newtcon-smoke-lifecycle-02-drawer.png" });

  // ── 4. Drawer has the Lifecycle section with header + state pill ─────────
  const lifecyclePresent = await page.$(".lifecycle-section");
  expect(!!lifecyclePresent, "device drawer renders .lifecycle-section");

  // Wait for the async state probe to populate the section.
  await page.waitForFunction(
    () => !!document.querySelector(".lifecycle-pill"),
    { timeout: 5000 },
  ).catch(() => { /* falls through; expect below will catch */ });

  const lifecycleState = await page.evaluate(() => {
    const pill = document.querySelector(".lifecycle-pill");
    if (!pill) return null;
    const stateClass = Array.from(pill.classList).find((c) => c.startsWith("lifecycle-pill--"));
    return {
      stateClass,
      stateText: pill.querySelector(".lifecycle-pill-state")?.textContent?.trim(),
      detailText: pill.querySelector(".lifecycle-pill-detail")?.textContent?.trim(),
    };
  });
  expect(lifecycleState !== null && ["lifecycle-pill--running", "lifecycle-pill--booting", "lifecycle-pill--down", "lifecycle-pill--unrealized"].includes(lifecycleState?.stateClass),
    `lifecycle pill has a unified-state class: ${JSON.stringify(lifecycleState)}`);
  expect(typeof lifecycleState?.detailText === "string" && lifecycleState.detailText.length > 0,
    `lifecycle pill has detail text: "${lifecycleState?.detailText}"`);

  // ── 5. State-appropriate action surface ──────────────────────────────────
  // For 2node-vs in current operator state (no lab deployed), the state
  // should be "unrealized" → no Start/Stop button, but a hint should appear.
  // If a lab is running, Stop would show. The smoke handles both cleanly.
  const actionPlan = await page.evaluate(() => ({
    hasStart: !!Array.from(document.querySelectorAll(".lifecycle-actions .btn"))
      .find((b) => b.textContent?.trim() === "Start VM"),
    hasStop:  !!Array.from(document.querySelectorAll(".lifecycle-actions .btn"))
      .find((b) => b.textContent?.trim() === "Stop VM"),
    hasHint:  !!document.querySelector(".lifecycle-hint"),
    hasSshSnippet:     !!Array.from(document.querySelectorAll(".lifecycle-snippet-label"))
      .find((l) => l.textContent?.trim() === "SSH"),
    hasConsoleSnippet: !!Array.from(document.querySelectorAll(".lifecycle-snippet-label"))
      .find((l) => l.textContent?.trim() === "Console"),
  }));
  // Sanity: the action set is internally consistent with the resolved state.
  const stateClass = lifecycleState?.stateClass;
  if (stateClass === "lifecycle-pill--unrealized") {
    expect(actionPlan.hasHint && !actionPlan.hasStart && !actionPlan.hasStop,
      `unrealized state: hint shown, no start/stop. plan=${JSON.stringify(actionPlan)}`);
  } else if (stateClass === "lifecycle-pill--down") {
    expect(actionPlan.hasStart && !actionPlan.hasStop,
      `down state: Start button shown, Stop hidden. plan=${JSON.stringify(actionPlan)}`);
  } else if (stateClass === "lifecycle-pill--running" || stateClass === "lifecycle-pill--booting") {
    expect(actionPlan.hasStop && !actionPlan.hasStart,
      `${stateClass.replace("lifecycle-pill--", "")} state: Stop button shown, Start hidden. plan=${JSON.stringify(actionPlan)}`);
    if (stateClass === "lifecycle-pill--running") {
      expect(actionPlan.hasSshSnippet,
        `running state: SSH snippet present. plan=${JSON.stringify(actionPlan)}`);
    }
  }

  console.log("");
  if (failed.length === 0) console.log("✅ all checks passed");
  else { console.log(`❌ ${failed.length} failed`); process.exitCode = 1; }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
