// Headless smoke for the Specs-view drawer's tailored rendering of a
// sub-rule spec kind (qos-policy with one queue). Verifies the new
// behaviour added when extending the tailored layout to the remaining
// six kinds:
//
//   - The sub-rule wire field ("queues" for qos-policies) does NOT appear
//     in the body's "All fields" disclosure — children render separately
//     via the existing renderSubRuleDeleteSection / Section pathway.
//   - The dedicated "Existing queues" section IS rendered with the queue
//     visible (regression check: prior pipeline unchanged).
//
// Other sub-rule kinds (filters → rules, prefix-lists → prefixes,
// route-policies → rules) take the same code path; one verified kind is
// enough to assert the threading.
//
// Setup + teardown happen via direct /api calls (curl-equivalent) to keep
// the smoke self-contained — the puppeteer side only drives the UI.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const USER = process.env.NEWTCON_TEST_USER || "ron";
const PASSWORD = process.env.NEWTCON_TEST_PASS || "ronthenewt";
const NETWORK = process.env.NEWTCON_TEST_NETWORK || "1node-vs-auth";
const POLICY = `smoke-qos-${Math.floor(Math.random() * 10000)}`;

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

// ---- API helpers (cookie-authed) -----------------------------------------

let sessionCookie = null;

async function api(method, path, body) {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (sessionCookie) init.headers["Cookie"] = sessionCookie;
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, init);
  const sc = r.headers.get("set-cookie");
  if (sc) sessionCookie = sc.split(";")[0];
  const text = await r.text();
  return { status: r.status, body: text };
}

async function login() {
  const r = await api("POST", "/api/auth/login", { username: USER, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.body}`);
}

async function createQoSPolicyWithQueue(network, name) {
  const p = await api("POST", `/api/networks/${network}/qos-policies`, {
    name,
    description: "smoke test policy — auto-deleted",
  });
  if (p.status !== 201 && p.status !== 200) throw new Error(`create policy: ${p.status} ${p.body}`);
  // Body carries the parent policy explicitly — the path-param is decorative
  // today (see injectParentName in app.ts for the UI's same workaround).
  const q = await api("POST", `/api/networks/${network}/qos-policies/${name}/queues`, {
    policy: name,
    queue_id: 1,
    name: "smoke-q",
    type: "dwrr",
    weight: 50,
  });
  if (q.status !== 201 && q.status !== 200) throw new Error(`add queue: ${q.status} ${q.body}`);
}

async function deleteQoSPolicy(network, name) {
  // Best-effort teardown — don't throw on failure.
  await api("DELETE", `/api/networks/${network}/qos-policies/${name}`);
}

// ---- run ------------------------------------------------------------------

await login();
await createQoSPolicyWithQueue(NETWORK, POLICY);

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
  console.log(`→ open ${BASE} (policy=${POLICY})`);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate((n) => localStorage.setItem("newtcon.activeNetwork", n), NETWORK);
  await page.reload({ waitUntil: "domcontentloaded" });

  // Sign in.
  await page.waitForSelector("#auth-username", { timeout: 5000 });
  await page.type("#auth-username", USER);
  await page.type("#auth-password", PASSWORD);
  await page.click("#auth-submit");
  await page.waitForFunction(() => {
    const el = document.getElementById("auth-overlay");
    return el && el.hidden;
  }, { timeout: 5000 });
  expect(true, "signed in");

  // Switch to QoS policies facet via the subnav.
  await page.evaluate(() => {
    const btn = document.querySelector('.specs-subnav-item[data-kind="qos-policies"]');
    btn?.click();
  });
  await page.waitForFunction(
    (name) => Array.from(document.querySelectorAll(".panel-list-item"))
      .some((el) => (el.textContent || "").trim() === name),
    { timeout: 5000 },
    POLICY,
  );

  // Open the drawer.
  await page.evaluate((name) => {
    const items = Array.from(document.querySelectorAll(".panel-list-item"));
    items.find((el) => (el.textContent || "").trim() === name)?.click();
  }, POLICY);
  await page.waitForFunction(() => {
    const c = document.getElementById("drawer-content");
    return c && (c.querySelector(".spec-detail") || c.querySelector(".spec-detail-empty-state"));
  }, { timeout: 5000 });

  const layout = await page.evaluate(() => {
    const c = document.getElementById("drawer-content");
    if (!c) return null;
    const prominent = Array.from(c.querySelectorAll(".spec-detail-label:not(.spec-detail-label--extra)"))
      .map((el) => (el.textContent || "").trim());
    const extras = Array.from(c.querySelectorAll(".spec-detail-label--extra"))
      .map((el) => (el.textContent || "").trim());
    const subRuleSectionExists = !!c.querySelector(".subrule-delete-section");
    const subRuleListItems = Array.from(c.querySelectorAll(".subrule-list .subrule-row")).length;
    return { prominent, extras, subRuleSectionExists, subRuleListItems };
  });

  expect(layout !== null, "qos-policy drawer DOM is present");
  expect(
    !layout.prominent.includes("queues") && !layout.extras.includes("queues"),
    `'queues' field is excluded from both prominent rows and the All-fields disclosure (prominent=${JSON.stringify(layout.prominent)}, extras=${JSON.stringify(layout.extras)})`
  );
  expect(layout.subRuleSectionExists,
    "the dedicated 'Existing queues' section IS rendered (sub-rule pipeline unchanged)");
  expect(layout.subRuleListItems === 1,
    `dedicated section shows the one queue (saw ${layout.subRuleListItems} item(s))`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-subrule-qos.png" });
} finally {
  await browser.close();
  // Teardown — best effort.
  await deleteQoSPolicy(NETWORK, POLICY);
  console.log(`\n=== ${ok.length} ok, ${failed.length} failed ===`);
  if (failed.length > 0) {
    failed.forEach((m) => console.log("  FAIL: " + m));
    process.exit(1);
  }
}
