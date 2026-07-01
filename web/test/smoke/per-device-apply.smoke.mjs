// Smoke: click a device → queue a Create VLAN via the action form →
// see it in the panel's "Queued for switch1" list → click Apply changes →
// confirm newtron now has the VLAN. Then queue a Delete VLAN, click
// Discard changes (client-only), confirm newtron still has the VLAN.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const NEWTRON = process.env.NEWTRON_URL || "http://127.0.0.1:18080";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok: " : "  FAIL: ") + m); }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});

const vlanID = 3700 + Math.floor(Math.random() * 200);

try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument(() => {
    // Inline confirm modal auto-accept; replaces native-dialog handler.
    const install = () => new MutationObserver(() => {
      const btn = document.querySelector(".confirm-modal-btn--confirm");
      if (btn instanceof HTMLElement) btn.click();
    }).observe(document.body, { childList: true, subtree: true });
    if (document.readyState === "loading") {
      addEventListener("DOMContentLoaded", install);
    } else {
      install();
    }
  });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  console.log(`→ open ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 8000 });

  // Select switch1.
  console.log("→ click switch1");
  await page.evaluate(() => document.querySelector(".topo-node")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await new Promise((r) => setTimeout(r, 300));

  // Apply changes should be disabled initially (no queue).
  const applyDisabledAtBoot = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll(".topo-action-panel-savebar .btn-primary"))[0];
    return btn?.hasAttribute("disabled");
  });
  expect(applyDisabledAtBoot, "Apply changes is disabled when nothing is queued");

  // Open VLANs group and click Create VLAN.
  await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll(".topo-action-group"));
    groups.find((g) => /VLAN/.test(g.querySelector(".topo-action-group-summary")?.textContent ?? ""))?.setAttribute("open", "");
  });
  await new Promise((r) => setTimeout(r, 50));
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".topo-action-item-label"));
    items.find((it) => it.textContent.trim() === "Create VLAN")?.closest("button")?.click();
  });
  await new Promise((r) => setTimeout(r, 200));

  // Fill VLAN ID + click Queue. The "Apply" button is now labeled "Queue".
  console.log(`→ fill VLAN ID ${vlanID} and Queue`);
  await page.evaluate((id) => {
    const input = document.querySelector(".topo-inline-form input[type=number]");
    if (input) { input.value = String(id); input.dispatchEvent(new Event("input", { bubbles: true })); }
  }, vlanID);
  await page.evaluate(() => document.querySelector(".topo-inline-form button[type=submit]")?.click());
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: "/tmp/newtcon-smoke-q01-queued.png" });

  // The queued-for-device list should now show a green entry.
  const queuedListCount = await page.evaluate(() =>
    document.querySelectorAll(".topo-action-panel-section--queued .topo-queued-item").length);
  expect(queuedListCount >= 1, `Queued list shows the item (got ${queuedListCount})`);

  // Pending bar at workspace top should show count 1.
  const headerCount = await page.$eval(".pending-bar-count", (el) => el.textContent).catch(() => "0");
  expect(headerCount === "1", `Header pending count = 1 (got "${headerCount}")`);

  // Apply changes button should now be enabled.
  const applyEnabledAfterQueue = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll(".topo-action-panel-savebar .btn-primary"))[0];
    return btn && !btn.hasAttribute("disabled") ? btn.textContent.trim() : null;
  });
  expect(applyEnabledAfterQueue !== null && /Apply changes/.test(applyEnabledAfterQueue ?? ""),
    `Apply changes is enabled and labeled correctly (got "${applyEnabledAfterQueue}")`);

  // Newtron should NOT yet have the VLAN.
  const preApply = await fetch(`${NEWTRON}/newtron/v1/network/default/node/switch1/vlan/${vlanID}`);
  expect(preApply.status >= 400, `newtron does NOT have VLAN ${vlanID} pre-Apply (got ${preApply.status})`);

  // Click Apply changes.
  console.log("→ click Apply changes");
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll(".topo-action-panel-savebar .btn-primary"))[0];
    btn?.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // Newtron should now have the VLAN.
  const postApply = await fetch(`${NEWTRON}/newtron/v1/network/default/node/switch1/vlan/${vlanID}`);
  expect(postApply.ok, `newtron now has VLAN ${vlanID} after Apply (got ${postApply.status})`);

  // ─── Queue a Delete VLAN, then click Discard changes ──────────────
  console.log("→ queue Delete VLAN + Discard changes (client-only)");
  // Re-select switch1 (queue may have refreshed the panel)
  await page.evaluate(() => document.querySelector(".topo-node")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll(".topo-action-group"));
    groups.find((g) => /VLAN/.test(g.querySelector(".topo-action-group-summary")?.textContent ?? ""))?.setAttribute("open", "");
  });
  await new Promise((r) => setTimeout(r, 50));
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".topo-action-item-label"));
    items.find((it) => it.textContent.trim() === "Delete VLAN")?.closest("button")?.click();
  });
  await new Promise((r) => setTimeout(r, 600));

  // Fill VLAN ID (Delete VLAN's id field is now an autofilled dropdown).
  await page.evaluate((id) => {
    const sel = document.querySelector(".topo-inline-form select");
    if (sel) { sel.value = String(id); sel.dispatchEvent(new Event("change", { bubbles: true })); }
    const inp = document.querySelector(".topo-inline-form input[type=number]");
    if (inp && !sel) { inp.value = String(id); inp.dispatchEvent(new Event("input", { bubbles: true })); }
  }, vlanID);
  await page.evaluate(() => document.querySelector(".topo-inline-form button[type=submit]")?.click());
  await new Promise((r) => setTimeout(r, 600));

  // Verify a danger (red) queued entry shows.
  const dangerEntries = await page.evaluate(() =>
    document.querySelectorAll(".topo-action-panel-section--queued .topo-queued-item--danger").length);
  expect(dangerEntries >= 1, `Queued list shows red (destructive) entry (got ${dangerEntries})`);

  // Click Discard changes — should NOT call newtron.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll(".topo-action-panel-savebar .btn-danger"))[0];
    btn?.click();
  });
  await new Promise((r) => setTimeout(r, 700));

  // Newtron should STILL have the VLAN (delete was discarded client-side).
  const afterDiscard = await fetch(`${NEWTRON}/newtron/v1/network/default/node/switch1/vlan/${vlanID}`);
  expect(afterDiscard.ok, `newtron still has VLAN ${vlanID} after Discard (got ${afterDiscard.status})`);

  // Queue should be empty.
  const headerCountAfter = await page.evaluate(() => {
    const el = document.querySelector(".pending-bar-count");
    const bar = document.getElementById("pending-bar");
    return { hidden: bar?.hidden, count: el?.textContent };
  });
  expect(headerCountAfter.hidden === true || headerCountAfter.count === "0",
    `Pending bar empty after Discard (got ${JSON.stringify(headerCountAfter)})`);

  // ─── Cleanup ────────────────────────────────────────────────────
  console.log("→ cleanup via direct API");
  await fetch(`${BASE}/api/networks/default/nodes/switch1/rpc/delete-vlan`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: vlanID }),
  });

  console.log("");
  console.log(`✅ ${ok.length} passed, ❌ ${failed.length} failed`);
  if (failed.length > 0) for (const f of failed) console.log("  -", f);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
