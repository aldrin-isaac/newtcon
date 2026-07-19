// Headless smoke for the node-create form — Specs → Inventory → Node → "+ New"
// (node creation is Specs-only since #353; the canvas creates nothing, #369 —
// this smoke previously asserted the removed toolbar/canvas Create-node flow).
//
// Verifies the schema-driven create form's wire-level structure:
//   1. The Node facet offers a "+ New" (panel-add-btn) affordance
//   2. The form has the NodeSpec fields: name, mgmt_ip, loopback_ip, zone,
//      platform — and NOT ssh_user (credentials moved wholly to the scoped
//      SSH Login store: Specs → General → SSH Login)
//   3. zone + platform render as dropdowns (ref-to-kind → <select>)
//   4. Empty-submit is blocked by required-field validation (form stays open)
//
// Does NOT exercise Save (would mutate operator state); form structure only.

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok: ", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 20000 });

  // Specs → Node facet.
  await page.click("#tab-specs");
  await page.waitForSelector('[data-kind="nodes"]', { timeout: 60000 });
  await page.click('[data-kind="nodes"]');
  await page.waitForSelector(".panel-add-btn", { timeout: 20000 });
  expect(true, 'Node facet offers "+ New" (panel-add-btn)');

  await page.evaluate(() => document.querySelector(".panel-add-btn")?.click());
  const formOpened = await page.waitForSelector('input[name="name"]', { timeout: 20000 }).then(() => true).catch(() => false);
  expect(formOpened, "create-node form opens from the Specs facet");

  const fields = await page.evaluate(() => {
    const el = (n) => document.querySelector(`input[name="${n}"], select[name="${n}"], textarea[name="${n}"]`);
    const probe = (n) => { const e = el(n); return e ? { tag: e.tagName.toLowerCase(), required: e.hasAttribute("required") } : null; };
    return {
      name: probe("name"), mgmt_ip: probe("mgmt_ip"), loopback_ip: probe("loopback_ip"),
      zone: probe("zone"), platform: probe("platform"), ssh_user: probe("ssh_user"),
      underlay_asn: probe("underlay_asn"),
    };
  });
  for (const req of ["name", "mgmt_ip", "loopback_ip", "zone"]) {
    expect(!!fields[req], `required field "${req}" present: ${JSON.stringify(fields[req])}`);
  }
  for (const opt of ["platform", "underlay_asn"]) {
    expect(!!fields[opt], `optional field "${opt}" present: ${JSON.stringify(fields[opt])}`);
  }
  expect(fields.ssh_user === null,
    "ssh_user is NOT in the create form — credentials live in Specs → General → SSH Login");
  expect(fields.zone?.tag === "select", `zone is a dropdown: ${JSON.stringify(fields.zone)}`);
  expect(fields.platform?.tag === "select", `platform is a dropdown: ${JSON.stringify(fields.platform)}`);

  await page.screenshot({ path: "/tmp/newtcon-smoke-create-node-specs-form.png" });

  // Empty-submit must not stage anything: blocked by native required-field
  // validation (the empty name input goes :invalid, form stays open).
  await page.evaluate(() => Array.from(document.querySelectorAll("button.form-submit-btn")).find((b) => /Create/.test(b.textContent))?.click());
  await sleep(300);
  const blocked = await page.evaluate(() => {
    const f = document.querySelector('input[name="name"]');
    return !!(f && f.matches(":invalid"));
  });
  expect(blocked, "empty-submit blocked by required-field validation (name is :invalid)");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
