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
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const USER = process.env.NEWTCON_TEST_USER || "ron";
const PASSWORD = process.env.NEWTCON_TEST_PASS || "ronthenewt";
const NETWORK = process.env.NEWTCON_TEST_NETWORK || "1node-vs-auth";
// newtron canonicalizes spec names to upper-case + underscores
// (smoke-edit-1 → SMOKE_EDIT_1), so use the normalized form up front — otherwise
// the created row never matches the name the smoke searches for.
const SVC = `SMOKE_EDIT_${Math.floor(Math.random() * 10000)}`;
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
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true,
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
await authenticatePage(page, BASE);
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

try {
  console.log(`→ open ${BASE} (service=${SVC})`);
  await gotoApp(page, BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
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
    await page.waitForFunction(() => document.getElementById("auth-overlay")?.hidden, { timeout: 20000 });
  }
  expect(true, overlayPresent ? "signed in" : "anonymous mode (gate skipped)");

  // Services facet is the default; wait for our row + click it.
  await page.waitForFunction((name) =>
    Array.from(document.querySelectorAll(".panel-list-item")).some((el) => (el.textContent || "").trim() === name),
    { timeout: 20000 }, SVC);
  await page.evaluate((name) => {
    const row = Array.from(document.querySelectorAll(".panel-list-item"))
      .find((el) => (el.textContent || "").trim() === name);
    row?.click();
  }, SVC);
  await page.waitForSelector(".spec-detail", { timeout: 20000 });

  // Edit button visible (services is editable).
  const editBtnText = await page.$eval(".drawer-edit-btn", (el) => (el.textContent || "").trim());
  expect(editBtnText === "Edit", `Edit button rendered with label "${editBtnText}"`);

  // Click Edit → form replaces body. Use a JS click (the button can be below the
  // fold in the drawer; page.click requires it to be in the viewport).
  await page.evaluate(() => document.querySelector(".drawer-edit-btn")?.click());
  await page.waitForSelector(".schema-form", { timeout: 10000 });

  // The identifier renders READ-ONLY in edit mode (immutable) — the operator sees
  // it but newtron rejects identifier changes, so the input is disabled/readOnly.
  const nameField = await page.$("[name=name]");
  const nameLocked = nameField ? await page.$eval("[name=name]", (el) => el.disabled || el.readOnly) : true;
  expect(nameLocked, "'name' field is read-only in the edit form (identifier can't change)");

  // Verify prefill: `type` populated from wire `service_type` (the
  // asymmetry slice 1.8 introduced).
  const typeValue = await page.$eval("[name=service_type]", (el) => el.value);
  expect(typeValue === "routed", `type field prefilled from service_type: "${typeValue}"`);

  // Verify description prefilled.
  const descBefore = await page.$eval("[name=description]", (el) => el.value);
  expect(descBefore === "smoke initial description", `description prefilled: "${descBefore}"`);

  // Edit the description + Save. Save STAGES the update (staging model, via
  // enqueueSpecUpdate) rather than PUTting immediately, so apply it through the
  // pending bar + apply-preview, then verify it persisted.
  await page.evaluate(() => { const d = document.querySelector("[name=description]"); d.value = ""; d.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.type("[name=description]", NEW_DESC);
  await page.evaluate(() => document.querySelector(".form-submit-btn")?.click());
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => document.getElementById("pending-bar-save")?.click());
  await page.waitForSelector(".apply-preview-card .btn-primary", { timeout: 20000 });
  await page.evaluate(() => Array.from(document.querySelectorAll(".apply-preview-card .btn-primary")).find((b) => /Apply/.test(b.textContent))?.click());
  await new Promise((r) => setTimeout(r, 2500));

  // Verify the edit persisted (authenticated /api read).
  const after = await api("GET", `/api/networks/${NETWORK}/services/${SVC}`);
  expect(JSON.parse(after.body).description === NEW_DESC, `description persisted after apply: "${JSON.parse(after.body).description}"`);
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
