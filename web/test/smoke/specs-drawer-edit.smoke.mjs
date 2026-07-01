// Headless smoke for the in-place edit flow on the Specs-view drawer.
// Verifies the slice that wired Edit → form prefilled from current detail →
// PUT /api/networks/.../services/{name} → drawer re-renders with the new
// values (newtron PR #172 update-X verbs).
//
// Uses services because it exercises the wire/form name asymmetry
// (detail returns `service_type`, the form has `type`); other kinds take
// the same code path with simpler prefill semantics.
//
// Setup + teardown happen via /api so the smoke is self-contained.
// Requires newtron-server reachable at NEWTRON_URL through newtcon-server.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const USER = process.env.NEWTCON_TEST_USER || "ron";
const PASSWORD = process.env.NEWTCON_TEST_PASS || "ronthenewt";
const NETWORK = process.env.NEWTCON_TEST_NETWORK || "1node-vs-auth";
const SVC = `smoke-edit-${Math.floor(Math.random() * 10000)}`;
const NEW_DESC = "edited by smoke";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

// ---- /api helpers --------------------------------------------------------

let sessionCookie = null;
async function api(method, path, body) {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (sessionCookie) init.headers["Cookie"] = sessionCookie;
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, init);
  const sc = r.headers.get("set-cookie");
  if (sc) sessionCookie = sc.split(";")[0];
  return { status: r.status, body: await r.text() };
}

async function maybeLogin() {
  // Only attempts a login if newtcon-server's posture requires auth.
  const cfg = await api("GET", "/api/config");
  const cfgBody = JSON.parse(cfg.body);
  if (cfgBody.auth_required) {
    const r = await api("POST", "/api/auth/login", { username: USER, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.body}`);
  }
}

async function createService(network, name) {
  const r = await api("POST", `/api/networks/${network}/services`, {
    name, service_type: "routed", description: "smoke initial description",
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`create service: ${r.status} ${r.body}`);
}

async function deleteService(network, name) {
  await api("DELETE", `/api/networks/${network}/services/${name}`);
}

// ---- run -----------------------------------------------------------------

await maybeLogin();
await createService(NETWORK, SVC);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
await authenticatePage(page, BASE);
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

try {
  console.log(`→ open ${BASE} (service=${SVC})`);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate((n) => localStorage.setItem("newtcon.activeNetwork", n), NETWORK);
  await page.reload({ waitUntil: "domcontentloaded" });

  // If auth is on, sign in. Anonymous mode skips this.
  const overlayPresent = await page.evaluate(() => {
    const el = document.getElementById("auth-overlay");
    return el && !el.hidden;
  });
  if (overlayPresent) {
    await page.type("#auth-username", USER);
    await page.type("#auth-password", PASSWORD);
    await page.click("#auth-submit");
    await page.waitForFunction(() => document.getElementById("auth-overlay")?.hidden, { timeout: 5000 });
  }
  expect(true, overlayPresent ? "signed in" : "anonymous mode (gate skipped)");

  // Services facet is the default; wait for our row + click it.
  await page.waitForFunction((name) =>
    Array.from(document.querySelectorAll(".panel-list-item")).some((el) => (el.textContent || "").trim() === name),
    { timeout: 8000 }, SVC);
  await page.evaluate((name) => {
    const row = Array.from(document.querySelectorAll(".panel-list-item"))
      .find((el) => (el.textContent || "").trim() === name);
    row?.click();
  }, SVC);
  await page.waitForSelector(".spec-detail", { timeout: 5000 });

  // Edit button visible (services is editable).
  const editBtnText = await page.$eval(".drawer-edit-btn", (el) => (el.textContent || "").trim());
  expect(editBtnText === "Edit", `Edit button rendered with label "${editBtnText}"`);

  // Click Edit → form replaces body.
  await page.click(".drawer-edit-btn");
  await page.waitForSelector(".spec-form", { timeout: 3000 });

  // Verify "name" is excluded from the edit form (identifier).
  const hasNameField = await page.$("#field-name");
  expect(hasNameField === null, "'name' field is NOT rendered in the edit form (identifier can't change)");

  // Verify prefill: `type` populated from wire `service_type` (the
  // asymmetry slice 1.8 introduced).
  const typeValue = await page.$eval("#field-type", (el) => el.value);
  expect(typeValue === "routed", `type field prefilled from service_type: "${typeValue}"`);

  // Verify description prefilled.
  const descBefore = await page.$eval("#field-description", (el) => el.value);
  expect(descBefore === "smoke initial description", `description prefilled: "${descBefore}"`);

  // Edit the description + Save.
  await page.evaluate(() => { document.querySelector("#field-description").value = ""; });
  await page.type("#field-description", NEW_DESC);
  await page.click(".form-submit-btn");

  // Wait for the drawer to re-render in read-only mode (Edit button reappears)
  // and the new description appears in the tailored layout.
  await page.waitForFunction((expected) => {
    if (!document.querySelector(".drawer-edit-btn")) return false; // still in edit mode
    const dl = document.querySelector(".spec-detail");
    return dl && (dl.textContent || "").includes(expected);
  }, { timeout: 5000 }, NEW_DESC);
  expect(true, `drawer re-rendered with the new description "${NEW_DESC}"`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-spec-edit.png" });
} finally {
  await browser.close();
  await deleteService(NETWORK, SVC);
  console.log(`\n=== ${ok.length} ok, ${failed.length} failed ===`);
  if (failed.length > 0) {
    failed.forEach((m) => console.log("  FAIL: " + m));
    process.exit(1);
  }
}
