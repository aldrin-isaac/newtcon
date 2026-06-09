// Headless smoke for the topology switcher.
// Verifies:
//   1. Header trigger renders with the active network label
//   2. Dropdown lists registered networks
//   3. Fetches to /api/* automatically include ?net=<active>
//   4. The "+ New topology" modal can be opened (we don't actually
//      scaffold — that would write to disk on the operator's box)

import puppeteer from "puppeteer-core";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const apiCalls = [];
page.on("request", (req) => { if (req.url().includes("/api/")) apiCalls.push(req.url()); });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

try {
  console.log(`→ open ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.screenshot({ path: "/tmp/newtcon-smoke-n01-loaded.png" });

  // Trigger present + labeled with active network.
  const triggerLabel = await page.$eval("#network-switcher-trigger .network-switcher-label", (el) => el.textContent);
  expect(triggerLabel?.length > 0, `header trigger labeled: "${triggerLabel}"`);

  // Click trigger → dropdown appears.
  await page.click("#network-switcher-trigger");
  await new Promise((r) => setTimeout(r, 300));
  const dropdownItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".network-switcher-dropdown .network-switcher-item-id"))
      .map((el) => el.textContent?.trim()));
  expect(dropdownItems.length >= 1, `dropdown shows network(s): ${JSON.stringify(dropdownItems)}`);
  expect(dropdownItems.includes("New topology…"), `dropdown has "New topology…" action`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-n02-dropdown.png" });

  // Click outside → dropdown closes.
  await page.evaluate(() => document.body.click());
  await new Promise((r) => setTimeout(r, 150));
  const dropdownGone = await page.$(".network-switcher-dropdown");
  expect(!dropdownGone, "dropdown closes on outside click");

  // Verify the fetch interceptor: did at least one /api/* request carry ?net=?
  const netParamed = apiCalls.filter((u) => /\?(?:[^#]*&)?net=/.test(u));
  const notNetParamed = apiCalls.filter((u) =>
    u.includes("/api/") && !/\?(?:[^#]*&)?net=/.test(u));
  expect(netParamed.length > 0,
    `≥1 /api/* call had ?net= (got ${netParamed.length}/${apiCalls.length})`);
  // Spot-check the network-agnostic exclusions.
  const healthHits = notNetParamed.filter((u) => u.includes("/api/health"));
  expect(healthHits.length > 0, `/api/health was NOT given ?net= (good — it's network-agnostic)`);

  // Open the "New topology" modal — verify form fields present, then close.
  await page.click("#network-switcher-trigger");
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".network-switcher-item-id"));
    items.find((el) => el.textContent.trim() === "New topology…")?.closest("button")?.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const modalFields = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".network-modal-form .form-control"))
      .map((el) => el.name));
  expect(modalFields.length === 3, `modal has 3 inputs (got ${JSON.stringify(modalFields)})`);
  expect(modalFields.includes("id") && modalFields.includes("spec_dir") && modalFields.includes("description"),
    `modal fields are id + spec_dir + description`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-n03-modal.png" });

  console.log("");
  if (failed.length === 0) console.log("✅ all checks passed");
  else { console.log(`❌ ${failed.length} failed`); process.exitCode = 1; }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
