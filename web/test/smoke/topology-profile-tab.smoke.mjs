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
import { authenticatePage } from "./_auth.mjs";

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
await authenticatePage(page, BASE);
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

  // Drawer opens. The Profile tab was renamed to "Spec" in the
  // device-drawer redesign (6-tab consolidation); the spec content
  // (DeviceProfile schema-driven labeled rows) lives there now.
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll(".node-tab"));
    return btns.some((b) => (b.textContent || "").trim() === "Spec");
  }, { timeout: 5000 });
  expect(true, "node drawer renders a Spec tab");

  // Capture the device name (drawer header h2).
  const deviceName = await page.$eval(".node-drawer-name", (el) => el.textContent?.trim());
  expect(deviceName && deviceName.length > 0, `drawer shows device name: "${deviceName}"`);

  // Click the Spec tab (formerly Profile).
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll(".node-tab"))
      .find((b) => (b.textContent || "").trim() === "Spec");
    btn?.click();
  });

  // Wait for the panel to either render the spec body or the
  // not-found message. Either outcome is acceptable.
  const outcome = await page.waitForFunction(() => {
    const panel = document.getElementById("node-panel-spec");
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

  // If profile rendered, sanity-check the tailored layout took effect:
  //   - the schema-aware labels appear ("Management IP", not "mgmt_ip")
  //   - the panel uses the .spec-detail-label class (the labeled-row layout)
  //   - ssh_pass — present in the raw newtron response but NOT in the schema —
  //     lives inside the "All fields" disclosure, not in the prominent rows.
  if (value === "rendered") {
    const layoutSignal = await page.evaluate(() => {
      const panel = document.getElementById("node-panel-profile");
      if (!panel) return null;
      const rowLabels = Array.from(panel.querySelectorAll(".spec-detail-label:not(.spec-detail-label--extra)"))
        .map((el) => (el.textContent || "").trim());
      const extraLabels = Array.from(panel.querySelectorAll(".spec-detail-label--extra"))
        .map((el) => (el.textContent || "").trim());
      return {
        prominent: rowLabels,
        extras: extraLabels,
        hasDisclosure: !!panel.querySelector(".spec-detail-extras"),
      };
    });
    expect(layoutSignal !== null, "tailored layout DOM is present (.spec-detail-label present)");
    expect(
      layoutSignal.prominent.includes("Management IP"),
      `prominent rows use operator labels: ${JSON.stringify(layoutSignal.prominent)}`
    );
    expect(
      !layoutSignal.prominent.includes("ssh_pass"),
      "ssh_pass (not in schema) is NOT a prominent row"
    );
    // ssh_pass might or might not exist depending on the test newtron's config.
    // If it's present, it MUST be in the extras disclosure, not in prominent.
    const newtronReturnsSshPass = await page.evaluate(() => {
      const panel = document.getElementById("node-panel-profile");
      return panel ? (panel.textContent || "").includes("ssh_pass") : false;
    });
    if (newtronReturnsSshPass) {
      expect(
        layoutSignal.hasDisclosure && layoutSignal.extras.includes("ssh_pass"),
        "ssh_pass surfaces only in the 'All fields' disclosure"
      );
    }
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
