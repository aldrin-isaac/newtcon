// Headless smoke for the Specs-view detail drawer's tailored rendering of
// services + zones. Verifies:
//
//   service:
//     - drawer renders the tailored layout (.spec-detail-label present)
//     - prominent rows include "Type" with the service_type value rendered
//       under the operator label (not in the "All fields" disclosure)
//     - "service_type" wire name is NOT visible as a prominent row label
//
//   zone:
//     - drawer renders the empty-state ("This spec has no additional fields.")
//       because the schema is just `name` (excluded) and newtron's zone
//       detail returns only `name`
//
// Requires newtcon-server at $NEWTCON_URL with L2c-enabled newtron and the
// 1node-vs-auth network registered.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const USER = process.env.NEWTCON_TEST_USER || "ron";
const PASSWORD = process.env.NEWTCON_TEST_PASS || "ronthenewt";
const NETWORK = process.env.NEWTCON_TEST_NETWORK || "1node-vs-auth";

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
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

// ---- helpers --------------------------------------------------------------

async function signIn() {
  if (!(await page.$("#auth-overlay:not([hidden])"))) return; // cookie-authenticated; no overlay
  await page.type("#auth-username", USER);
  await page.type("#auth-password", PASSWORD);
  await page.click("#auth-submit");
  await page.waitForFunction(() => {
    const el = document.getElementById("auth-overlay");
    return el && el.hidden;
  }, { timeout: 5000 });
}

async function openSpecRow(facetLabel, rowName) {
  // Switch to the facet (e.g. "Services" / "Zones") via the subnav. Match
  // against the rendered label text since the smoke is keyed on the
  // operator-visible title rather than the internal kind id.
  await page.evaluate((label) => {
    const btn = Array.from(document.querySelectorAll(".specs-subnav-item"))
      .find((b) => (b.textContent || "").trim().startsWith(label));
    btn?.click();
  }, facetLabel);
  // Wait for the panel to repopulate with rows matching that facet.
  await page.waitForFunction(
    (name) => {
      const items = Array.from(document.querySelectorAll(".panel-list-item"));
      return items.some((el) => (el.textContent || "").trim() === name);
    },
    { timeout: 5000 },
    rowName,
  );
  // Click the row to open the drawer.
  await page.evaluate((name) => {
    const items = Array.from(document.querySelectorAll(".panel-list-item"));
    const row = items.find((el) => (el.textContent || "").trim() === name);
    row?.click();
  }, rowName);
  // Wait for drawer content to populate (either tailored layout, empty
  // state, or generic tree).
  await page.waitForFunction(() => {
    const c = document.getElementById("drawer-content");
    if (!c || c.children.length < 3) return false; // kind + name + something
    return !!c.querySelector(".spec-detail, .spec-detail-empty-state, .drawer-detail");
  }, { timeout: 5000 });
}

// ---- run ------------------------------------------------------------------

try {
  console.log(`→ open ${BASE}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate((n) => localStorage.setItem("newtcon.activeNetwork", n), NETWORK);
  await page.reload({ waitUntil: "domcontentloaded" });

  await signIn();
  expect(true, "signed in");

  // Specs view is the default; wait for at least one panel row.
  await page.waitForSelector(".panel-list-item", { timeout: 8000 });
  expect(true, "specs view rendered with at least one row");

  // ---- service detail ----
  await openSpecRow("Services", "TRANSIT_1");

  const serviceLayout = await page.evaluate(() => {
    const c = document.getElementById("drawer-content");
    if (!c) return null;
    const labels = Array.from(c.querySelectorAll(".spec-detail-label:not(.spec-detail-label--extra)"))
      .map((el) => (el.textContent || "").trim());
    const extraLabels = Array.from(c.querySelectorAll(".spec-detail-label--extra"))
      .map((el) => (el.textContent || "").trim());
    // Find the prominent "Type" row's value
    const typeDt = Array.from(c.querySelectorAll(".spec-detail-label:not(.spec-detail-label--extra)"))
      .find((el) => (el.textContent || "").trim() === "Service Type");
    const typeValueEl = typeDt?.nextElementSibling;
    const typeValue = typeValueEl ? (typeValueEl.textContent || "").trim() : null;
    return { prominent: labels, extras: extraLabels, typeValue };
  });
  expect(serviceLayout !== null, "service drawer DOM is present");
  expect(serviceLayout.prominent.includes("Service Type"),
    `service prominent rows include "Type": ${JSON.stringify(serviceLayout.prominent)}`);
  expect(!serviceLayout.prominent.includes("service_type"),
    "wire name 'service_type' is NOT a prominent row label");
  expect(serviceLayout.typeValue === "routed",
    `prominent "Type" row value is "routed" (was "${serviceLayout.typeValue}")`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-spec-drawer-01-service.png" });

  // ---- zone detail (empty-state) ----
  await openSpecRow("Zone", "amer");

  const zoneState = await page.evaluate(() => {
    const c = document.getElementById("drawer-content");
    if (!c) return null;
    const empty = c.querySelector(".spec-detail-empty-state");
    return {
      hasEmptyState: !!empty,
      emptyText: empty ? (empty.textContent || "").trim() : null,
      hasProminent: !!c.querySelector(".spec-detail-label:not(.spec-detail-label--extra)"),
    };
  });
  expect(zoneState !== null, "zone drawer DOM is present");
  expect(zoneState.hasEmptyState,
    `zone drawer shows the empty-state placeholder (got: "${zoneState.emptyText}")`);
  expect(!zoneState.hasProminent,
    "zone drawer has no prominent rows (schema is just `name`, which is excluded)");
  await page.screenshot({ path: "/tmp/newtcon-smoke-spec-drawer-02-zone.png" });
} finally {
  await browser.close();
  console.log(`\n=== ${ok.length} ok, ${failed.length} failed ===`);
  if (failed.length > 0) {
    failed.forEach((m) => console.log("  FAIL: " + m));
    process.exit(1);
  }
}
