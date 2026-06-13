// Headless smoke for the Profile sub-tab in the device drawer (Topology view).
// Verifies:
//   1. Sign in (re-uses the auth-gate flow).
//   2. Switch to Topology tab; click the first device on the canvas.
//   3. The node drawer opens with a "Profile" tab in the tab strip.
//   4. Clicking the Profile tab either:
//        (a) renders the profile spec (mgmt_ip / loopback_ip / zone / …), or
//        (b) renders the "No profile found" empty-state for legacy devices.
//      Both outcomes are acceptable — the test asserts the tab activates
//      and one of the two recognisable shapes appears.
//
// Requires newtcon-server at $NEWTCON_URL talking to a newtron with L2c
// enabled. Auth creds via NEWTCON_TEST_USER / NEWTCON_TEST_PASSWORD.

import puppeteer from "puppeteer-core";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const USER = process.env.NEWTCON_TEST_USER || "alice";
const PASSWORD = process.env.NEWTCON_TEST_PASSWORD || "YourPaSsWoRd";
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
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

try {
  console.log(`→ open ${BASE}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });

  // Preset the active network so the topology view targets one that actually
  // exists in this dev environment.
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

  // Switch to Topology tab.
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 8000 });
  expect(true, "topology view loaded with at least one device");
  await page.screenshot({ path: "/tmp/newtcon-smoke-profile-tab-01-topo.png" });

  // Open the inspector drawer for the first device. The convention today is
  // right-click → floating menu → "Open inspector →" header button (left-
  // click only toggles selection in the canvas; it doesn't open the drawer).
  await page.evaluate(() => {
    const node = document.querySelectorAll(".topo-node")[0];
    node?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 }));
  });
  await page.waitForSelector(".topo-menu-header--button", { timeout: 3000 });
  await page.click(".topo-menu-header--button");

  // Drawer opens. Verify the Profile tab is present.
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll(".node-tab"));
    return btns.some((b) => (b.textContent || "").trim() === "Profile");
  }, { timeout: 5000 });
  expect(true, "node drawer renders a Profile tab");

  // Capture the device name (drawer-name header).
  const deviceName = await page.$eval(".drawer-name", (el) => el.textContent?.trim());
  expect(deviceName && deviceName.length > 0, `drawer shows device name: "${deviceName}"`);

  // Click the Profile tab.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll(".node-tab"))
      .find((b) => (b.textContent || "").trim() === "Profile");
    btn?.click();
  });

  // Wait for the panel to either render the spec body (.drawer-detail) or
  // the not-found message. Either outcome is acceptable.
  const outcome = await page.waitForFunction(() => {
    const panel = document.getElementById("node-panel-profile");
    if (!panel || panel.hidden) return null;
    if (panel.querySelector(".drawer-detail")) return "rendered";
    if (panel.querySelector(".panel-error")) {
      const txt = panel.querySelector(".panel-error")?.textContent;
      return txt === "No profile found" ? "not-found" : "error";
    }
    return null;
  }, { timeout: 5000 });

  const value = await outcome.jsonValue();
  expect(
    value === "rendered" || value === "not-found",
    `Profile tab activated and showed a recognisable state: "${value}"`
  );

  // If profile rendered, sanity-check a typical field appears somewhere in the
  // panel — mgmt_ip is the strongest signal it's actually the device profile.
  if (value === "rendered") {
    const hasMgmtField = await page.evaluate(() => {
      const panel = document.getElementById("node-panel-profile");
      if (!panel) return false;
      return /mgmt_ip|loopback_ip|zone|platform/.test(panel.textContent || "");
    });
    expect(hasMgmtField, "rendered profile contains a device-profile field (mgmt_ip / loopback_ip / zone / platform)");
  }

  await page.screenshot({ path: "/tmp/newtcon-smoke-profile-tab-02-tab.png" });
} finally {
  await browser.close();
  console.log(`\n=== ${ok.length} ok, ${failed.length} failed ===`);
  if (failed.length > 0) {
    failed.forEach((m) => console.log("  FAIL: " + m));
    process.exit(1);
  }
}
