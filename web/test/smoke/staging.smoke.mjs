// Smoke: stage edits in Specs + Topology, see them queued green/red,
// click Save in the header, verify they land in newtron.

import puppeteer from "puppeteer-core";

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

const zoneName = "zone_t" + Math.floor(Math.random() * 9000 + 1000);

try {
  const page = await browser.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  console.log(`→ open ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.screenshot({ path: "/tmp/newtcon-smoke-s01-loaded.png" });

  // Bar should be hidden at boot.
  const barHiddenAtBoot = await page.$eval("#pending-bar", (el) => el.hidden);
  expect(barHiddenAtBoot === true, "pending bar hidden when queue is empty");

  // ─── Stage an zone spec via the Specs view ───────────────────────
  console.log(`→ queue create zone "${zoneName}"`);
  // Specs is the default view. Click the "zones" subnav.
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".specs-subnav-item, .nav-item, .spec-row, button"));
    const zones = items.find((b) => /Zones/i.test(b.textContent ?? ""));
    if (zones) zones.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  // Click the "+ Add" button for zones (panel-add-btn).
  await page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll(".panel"));
    const ipPanel = panels.find((p) => /Zones/i.test(p.querySelector(".panel-title")?.textContent ?? ""));
    ipPanel?.querySelector(".panel-add-btn")?.click();
  });
  await new Promise((r) => setTimeout(r, 400));

  // Fill in name field.
  await page.evaluate((n) => {
    const labels = Array.from(document.querySelectorAll("#drawer-content .spec-form-label, #drawer-content label"));
    const nameLabel = labels.find((l) => /name/i.test(l.textContent ?? ""));
    const input = nameLabel?.parentElement?.querySelector("input") || document.querySelector("#drawer-content input");
    if (input) { input.value = n; input.dispatchEvent(new Event("input", { bubbles: true })); }
  }, zoneName);

  // Submit the create form.
  await page.evaluate(() => {
    const submit = document.querySelector(".form-submit-btn") || document.querySelector("#drawer-content button[type=button]");
    if (submit && /create/i.test(submit.textContent ?? "")) submit.click();
    else document.querySelectorAll("#drawer-content button").forEach((b) => {
      if (/create/i.test(b.textContent ?? "")) b.click();
    });
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: "/tmp/newtcon-smoke-s02-queued.png" });

  const barShown = await page.$eval("#pending-bar", (el) => !el.hidden);
  expect(barShown, "pending bar appears after one queue");
  const countText = await page.$eval(".pending-bar-count", (el) => el.textContent);
  expect(countText === "1", `pending count = 1 (got "${countText}")`);

  // The zone row should now appear in the panel with green pending styling.
  const greenRowSeen = await page.evaluate(() => {
    return document.querySelectorAll(".panel-list-row--pending-add").length;
  });
  expect(greenRowSeen >= 1, `≥1 green pending-add row in the panel (got ${greenRowSeen})`);

  // Confirm newtron does NOT yet have it (still queued, not saved).
  const beforeSave = await fetch(`${NEWTRON}/newtron/v1/network/default/zone/${zoneName}`);
  expect(beforeSave.status === 404 || beforeSave.status === 500,
    `newtron does NOT have ${zoneName} pre-save (got ${beforeSave.status})`);

  // ─── Click Save in the header ─────────────────────────────────────
  console.log("→ click Save in the header pending bar");
  await page.evaluate(() => document.getElementById("pending-bar-save")?.click());
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: "/tmp/newtcon-smoke-s03-after-save.png" });

  // Bar should be hidden again.
  const barHiddenAfter = await page.$eval("#pending-bar", (el) => el.hidden);
  expect(barHiddenAfter, "pending bar hidden after Save");

  // newtron should now have the spec.
  const afterSave = await fetch(`${NEWTRON}/newtron/v1/network/default/zone/${zoneName}`);
  expect(afterSave.ok, `newtron now serves /zone/${zoneName} (got ${afterSave.status})`);

  // ─── Cleanup: queue a delete then Save ──────────────────────────
  console.log(`→ queue delete zone "${zoneName}"`);
  await page.evaluate((n) => {
    const rows = Array.from(document.querySelectorAll(".panel-list-row"));
    const row = rows.find((r) => r.querySelector(".panel-list-item")?.textContent.trim() === n);
    row?.querySelector(".panel-delete-btn")?.click();
  }, zoneName);
  await new Promise((r) => setTimeout(r, 600));
  const redRowSeen = await page.evaluate(() => {
    return document.querySelectorAll(".panel-list-row--pending-del").length;
  });
  expect(redRowSeen >= 1, `≥1 red pending-del row visible (got ${redRowSeen})`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-s04-pending-delete.png" });

  console.log("→ click Save to apply the delete");
  await page.evaluate(() => document.getElementById("pending-bar-save")?.click());
  await new Promise((r) => setTimeout(r, 1500));

  const afterDelete = await fetch(`${NEWTRON}/newtron/v1/network/default/zone/${zoneName}`);
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
  await browser.close();
}
