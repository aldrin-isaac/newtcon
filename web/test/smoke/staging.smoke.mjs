// Smoke: stage edits in Specs, see them queued green/red, click Save in the
// header, confirm the apply-preview modal, verify they land in newtron.

import puppeteer from "puppeteer-core";
import { authenticatePage, loginCookie, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const NEWTRON = process.env.NEWTRON_URL || "http://127.0.0.1:18080";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
// The network to act in. newtcon needs an explicit active network (the
// switcher persists it in localStorage); we set it below rather than relying
// on a boot default.
const NET = process.env.NEWTCON_NET || "default";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok: " : "  FAIL: ") + m); }

// Facet subnav labels are the singular kind name with the count appended
// ("Zone0", "Platform5"). Strip the trailing count to compare the label.
const facetLabel = (t) => (t ?? "").trim().replace(/\d+$/, "");

// Save opens the apply-preview confirm modal (slice #171.A); applying requires
// confirming it. Click Save, confirm the preview, settle.
async function saveAndConfirm(page) {
  await page.evaluate(() => document.getElementById("pending-bar-save")?.click());
  try {
    await page.waitForSelector(".apply-preview-overlay .btn-primary", { timeout: 20000 });
    await page.evaluate(() =>
      document.querySelector(".apply-preview-overlay .btn-primary")?.click());
  } catch { /* no modal — nothing to apply */ }
  await new Promise((r) => setTimeout(r, 1800));
}

// newtron returns 500 (not 404) with {"error":"zone '..' not found"} for a
// missing zone, so "absent" means not-ok rather than a specific status.
// Verify through newtcon (authenticated via the session cookie) rather than
// hitting newtron :18080 directly, which needs a bearer under --auth-required.
const _ck = await loginCookie(BASE);
const AUTH = _ck ? { Cookie: `${_ck.name}=${_ck.value}` } : {};
const zoneUrl = (name) => `${BASE}/api/networks/${NET}/zones/${name}`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true,
  defaultViewport: { width: 1500, height: 950 },
});

const zoneName = "zone_t" + Math.floor(Math.random() * 9000 + 1000);

try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  console.log(`→ open ${BASE} (network ${NET})`);
  await gotoApp(page, BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate((n) => localStorage.setItem("newtcon.activeNetwork", n), NET);
  await page.reload({ waitUntil: "networkidle0", timeout: 15000 });
  await page.screenshot({ path: "/tmp/newtcon-smoke-s01-loaded.png" });

  // Bar should be hidden at boot.
  const barHiddenAtBoot = await page.$eval("#pending-bar", (el) => el.hidden);
  expect(barHiddenAtBoot === true, "pending bar hidden when queue is empty");

  // ─── Stage a zone spec via the Specs view ────────────────────────
  console.log(`→ queue create zone "${zoneName}"`);
  // Specs is the default view. Click the "Zone" facet in the subnav.
  await page.evaluate((label) => {
    const items = Array.from(document.querySelectorAll(".specs-subnav-item"));
    const strip = (t) => (t ?? "").trim().replace(/\d+$/, "");
    items.find((b) => strip(b.textContent) === label)?.click();
  }, "Zone");
  await new Promise((r) => setTimeout(r, 400));

  // Click the "+ Add" button in the Zone panel.
  await page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll(".panel"));
    const zp = panels.find((p) => /^zone\b/i.test((p.querySelector(".panel-title")?.textContent ?? "").trim()));
    zp?.querySelector(".panel-add-btn")?.click();
  });
  await new Promise((r) => setTimeout(r, 500));

  const drawerOpen = await page.evaluate(() =>
    document.getElementById("detail-drawer")?.classList.contains("open"));
  expect(drawerOpen === true, "create drawer opened on + Add");

  // Fill the name field (schema-driven form: [name="name"]).
  await page.evaluate((n) => {
    const input = document.querySelector('#drawer-content [name="name"]')
      || document.querySelector("#drawer-content input");
    if (input) { input.value = n; input.dispatchEvent(new Event("input", { bubbles: true })); }
  }, zoneName);

  // Submit the create form.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("#drawer-content button"))
      .find((b) => /create/i.test(b.textContent ?? ""));
    btn?.click();
  });
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: "/tmp/newtcon-smoke-s02-queued.png" });

  const barShown = await page.$eval("#pending-bar", (el) => !el.hidden);
  expect(barShown, "pending bar appears after one queue");
  const countText = await page.$eval(".pending-bar-count", (el) => el.textContent);
  expect(countText === "1", `pending count = 1 (got "${countText}")`);

  // The zone row should now appear in the panel with green pending styling.
  const greenRowSeen = await page.evaluate(() =>
    document.querySelectorAll(".panel-list-row--pending-add").length);
  expect(greenRowSeen >= 1, `≥1 green pending-add row in the panel (got ${greenRowSeen})`);

  // Confirm newtron does NOT yet have it (still queued, not saved).
  const beforeSave = await fetch(zoneUrl(zoneName), { headers: AUTH });
  expect(!beforeSave.ok, `newtron does NOT have ${zoneName} pre-save (got ${beforeSave.status})`);

  // ─── Save (+ confirm the apply-preview modal) ─────────────────────
  console.log("→ click Save, confirm the apply-preview");
  await saveAndConfirm(page);
  await page.screenshot({ path: "/tmp/newtcon-smoke-s03-after-save.png" });

  const barHiddenAfter = await page.$eval("#pending-bar", (el) => el.hidden);
  expect(barHiddenAfter, "pending bar hidden after Save");

  const afterSave = await fetch(zoneUrl(zoneName), { headers: AUTH });
  expect(afterSave.ok, `newtron now serves zone ${zoneName} (got ${afterSave.status})`);

  // ─── Cleanup: queue a delete then Save ──────────────────────────
  console.log(`→ queue delete zone "${zoneName}"`);
  // NOTE: this step is intermittently ineffective, and the cause is a PRODUCT
  // bug, not test timing — mountSpecsView can double-mount, leaving two full
  // .specs-layout trees in the DOM (measured: layouts:2, mains:2, subnavs:2).
  // The row this clicks may then belong to the abandoned mount, so the click
  // no-ops (it optional-chains away) and the delete never queues. The teardown
  // in `finally` makes that harmless — the zone is removed either way — but the
  // assertions below can still fail until the double-mount is fixed.
  await page.evaluate((n) => {
    const rows = Array.from(document.querySelectorAll(".panel-list-row"));
    const row = rows.find((r) => r.querySelector(".panel-list-item")?.textContent.trim() === n);
    row?.querySelector(".panel-delete-btn")?.click();
  }, zoneName);
  await new Promise((r) => setTimeout(r, 600));
  const redRowSeen = await page.evaluate(() =>
    document.querySelectorAll(".panel-list-row--pending-del").length);
  expect(redRowSeen >= 1, `≥1 red pending-del row visible (got ${redRowSeen})`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-s04-pending-delete.png" });

  console.log("→ click Save to apply the delete");
  await saveAndConfirm(page);

  const afterDelete = await fetch(zoneUrl(zoneName), { headers: AUTH });
  expect(!afterDelete.ok, `zone ${zoneName} gone from newtron after delete (status ${afterDelete.status})`);

  console.log("");
  console.log(`✅ ${ok.length} passed, ❌ ${failed.length} failed`);
  if (failed.length > 0) {
    for (const f of failed) console.log("  -", f);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  // Teardown must NOT depend on the UI delete above having run. The zone is
  // written to newtron's spec dir the moment the create Save lands, so any
  // failure after that point — a throw, a selector timeout, or the UI delete
  // simply not finding its row — used to strand a zone_tNNNN file in the
  // newtron working tree. Delete it through the API unconditionally and
  // best-effort, matching the teardown-in-finally pattern node-scaffold /
  // override-delete / specs-drawer-edit already use.
  try {
    await fetch(zoneUrl(zoneName), { method: "DELETE", headers: AUTH });
  } catch { /* newtcon unreachable or already gone — nothing more to do */ }
  await browser.close();
}
