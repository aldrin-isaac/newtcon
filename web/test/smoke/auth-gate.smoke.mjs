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

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const USER = process.env.NEWTCON_TEST_USER || "alice";
const PASSWORD = process.env.NEWTCON_TEST_PASSWORD || "YourPaSsWoRd";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

try {
  console.log(`→ open ${BASE}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });

  // 1. Overlay appears at boot when no session cookie is set.
  await page.waitForFunction(() => {
    const el = document.getElementById("auth-overlay");
    return el && !el.hidden;
  }, { timeout: 5000 });
  await page.screenshot({ path: "/tmp/newtcon-smoke-auth-01-overlay.png" });

  const title = await page.$eval("#auth-overlay .auth-card-title", (el) => el.textContent?.trim());
  expect(title === "Sign in to newtcon", `overlay title: "${title}"`);

  // 2. Workspace gated — panel-specs is empty until sign-in mounts it.
  const specsPanelEmpty = await page.$eval("#panel-specs", (el) => el.children.length === 0);
  expect(specsPanelEmpty, "workspace panel-specs is empty (app mount gated on auth)");

  // 3. User pill hidden when not signed-in.
  const userPillHidden = await page.$eval("#user-pill", (el) => el.hasAttribute("hidden"));
  expect(userPillHidden, "user pill hidden while not signed in");

  // 4. Successful sign-in: type creds, submit, overlay hides, app mounts.
  await page.type("#auth-username", USER);
  await page.type("#auth-password", PASSWORD);
  await page.click("#auth-submit");
  await page.waitForFunction(() => {
    const el = document.getElementById("auth-overlay");
    return el && el.hidden;
  }, { timeout: 5000 });
  expect(true, "overlay hides after successful sign-in");

  // 5. User pill shows the username.
  await page.waitForFunction((u) => {
    const el = document.getElementById("user-pill-name");
    return el && el.textContent === u;
  }, { timeout: 2000 }, USER);
  const pillName = await page.$eval("#user-pill-name", (el) => el.textContent);
  expect(pillName === USER, `user pill shows username: "${pillName}"`);

  // 6. Workspace mounts after sign-in — panel-specs gains content.
  await page.waitForFunction(() => {
    const el = document.getElementById("panel-specs");
    return el && el.children.length > 0;
  }, { timeout: 5000 });
  expect(true, "workspace panel-specs mounts after sign-in");
  await page.screenshot({ path: "/tmp/newtcon-smoke-auth-02-signed-in.png" });

  // 7. Sign-out: click the pill's button, page reloads, overlay returns.
  // The button calls logout() then window.location.reload(); we navigate
  // alongside to handle the reload.
  const [_, navOut] = await Promise.all([
    page.click("#user-signout"),
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null),
  ]);
  void _;
  void navOut;
  await page.waitForFunction(() => {
    const el = document.getElementById("auth-overlay");
    return el && !el.hidden;
  }, { timeout: 5000 });
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
