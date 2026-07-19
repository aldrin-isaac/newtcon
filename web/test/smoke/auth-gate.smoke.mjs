// Headless smoke for the login overlay (slice 1.D).
// Verifies the end-to-end sign-in arc against a real newtron-server with L2c
// enabled.
//
// Requires:
//   newtcon-server running at $NEWTCON_URL (default http://127.0.0.1:8082)
//   newtron-server reachable from newtcon-server, with --auth-pam-service set
//   A PAM-recognised user. Configure via env:
//     NEWTCON_TEST_USER     (default "alice")
//     NEWTCON_TEST_PASSWORD (default "YourPaSsWoRd")

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const USER = process.env.NEWTCON_TEST_USER || "ron";
const PASSWORD = process.env.NEWTCON_TEST_PASS || "ronthenewt";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true,
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
// NOTE: this smoke tests the login OVERLAY itself, so it must NOT pre-authenticate
// (authenticatePage is intentionally omitted). It requires the server to run with
// --auth-required for the overlay to appear.
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

try {
  console.log(`→ open ${BASE}`);
  await gotoApp(page, BASE, { waitUntil: "domcontentloaded", timeout: 15000 });

  // 1. Overlay appears at boot when no session cookie is set.
  await page.waitForFunction(() => {
    const el = document.getElementById("auth-overlay");
    return el && !el.hidden;
  }, { timeout: 15000 });
  await page.screenshot({ path: "/tmp/newtcon-smoke-auth-01-overlay.png" });

  const title = await page.$eval("#auth-overlay .auth-card-title", (el) => el.textContent?.trim());
  expect(title === "Sign in to Newtron Console", `overlay title: "${title}"`);

  // 2. Workspace gated — panel-specs is empty until sign-in mounts it.
  const specsPanelEmpty = await page.$eval("#panel-specs", (el) => el.children.length === 0);
  expect(specsPanelEmpty, "workspace panel-specs is empty (app mount gated on auth)");

  // 3. User pill hidden when not signed-in. (The user-pill-wrap is the
  //    visibility-toggled element; the trigger + dropdown live inside it.)
  const userPillHidden = await page.$eval("#user-pill-wrap", (el) => el.hasAttribute("hidden"));
  expect(userPillHidden, "user pill hidden while not signed in");

  // 3a. Focus retention (regression): a background 401 — what raises the
  // "session expired / timeout" banner — must NOT steal focus back to the
  // username field while the operator is typing their password.
  await page.focus("#auth-username"); await page.type("#auth-username", "probe");
  await page.focus("#auth-password"); await page.type("#auth-password", "half");
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("auth:401")));
  await new Promise((r) => setTimeout(r, 120));
  const focusAfter401 = await page.evaluate(() => document.activeElement?.id);
  expect(focusAfter401 === "auth-password", `focus stays on password after a background 401 (got "${focusAfter401}")`);
  // Clear the probe values so the real sign-in below starts clean.
  await page.evaluate(() => { const u = document.getElementById("auth-username"); const pw = document.getElementById("auth-password"); if (u) u.value = ""; if (pw) pw.value = ""; });

  // 4. Successful sign-in: type creds, submit, overlay hides, app mounts.
  await page.type("#auth-username", USER);
  await page.type("#auth-password", PASSWORD);
  await page.click("#auth-submit");
  await page.waitForFunction(() => {
    const el = document.getElementById("auth-overlay");
    return el && el.hidden;
  }, { timeout: 15000 });
  expect(true, "overlay hides after successful sign-in");

  // 5. User pill shows the username.
  await page.waitForFunction((u) => {
    const el = document.getElementById("user-pill-name");
    return el && el.textContent === u;
  }, { timeout: 10000 }, USER);
  const pillName = await page.$eval("#user-pill-name", (el) => el.textContent);
  expect(pillName === USER, `user pill shows username: "${pillName}"`);

  // 6. Workspace mounts after sign-in — panel-specs gains content.
  await page.waitForFunction(() => {
    const el = document.getElementById("panel-specs");
    return el && el.children.length > 0;
  }, { timeout: 15000 });
  expect(true, "workspace panel-specs mounts after sign-in");
  await page.screenshot({ path: "/tmp/newtcon-smoke-auth-02-signed-in.png" });

  // 6a. Pill dropdown opens on trigger click, shows username + expiry.
  const dropdownHiddenBefore = await page.$eval("#user-pill-dropdown", (el) => el.hidden);
  expect(dropdownHiddenBefore, "pill dropdown hidden before click");
  await page.click("#user-pill-trigger");
  await page.waitForFunction(() => !document.getElementById("user-pill-dropdown")?.hidden, { timeout: 10000 });
  const dropdownUser = await page.$eval("#user-pill-dropdown-username", (el) => el.textContent);
  const expiresValue = await page.$eval("#user-pill-dropdown-expires", (el) => el.textContent);
  expect(dropdownUser === USER, `dropdown shows username: "${dropdownUser}"`);
  expect(/in /.test(expiresValue || ""), `dropdown shows expiry relative: "${expiresValue}"`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-auth-02b-dropdown.png" });

  // 6b. Dropdown closes on outside click.
  await page.evaluate(() => document.body.click());
  await page.waitForFunction(() => document.getElementById("user-pill-dropdown")?.hidden, { timeout: 10000 });
  expect(true, "pill dropdown closes on outside click");

  // 7. Sign-out: open the pill dropdown, click the signout button, page
  // reloads, overlay returns. The button calls logout() then
  // window.location.reload(); we navigate alongside to handle the reload.
  await page.click("#user-pill-trigger");
  await page.waitForFunction(() => !document.getElementById("user-pill-dropdown")?.hidden, { timeout: 10000 });
  const [_, navOut] = await Promise.all([
    page.click("#user-signout"),
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null),
  ]);
  void _;
  void navOut;
  await page.waitForFunction(() => {
    const el = document.getElementById("auth-overlay");
    return el && !el.hidden;
  }, { timeout: 15000 });
  expect(true, "overlay reappears after sign-out + reload");
  await page.screenshot({ path: "/tmp/newtcon-smoke-auth-03-signed-out.png" });
} finally {
  await browser.close();
  console.log(`\n=== ${ok.length} ok, ${failed.length} failed ===`);
  if (failed.length > 0) {
    failed.forEach((m) => console.log("  FAIL: " + m));
    process.exit(1);
  }
}
