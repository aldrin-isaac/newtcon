// Headless smoke for the topology switcher.
// Verifies:
//   1. Header trigger renders with the active network label
//   2. Dropdown lists registered networks
//   3. Network-scoped /api/* calls render as /api/networks/{netID}/...
//      (the path-substitution that replaced the ?net= fetch interceptor
//      in PR #135), and the network-agnostic exclusions (/api/health) are
//      not given the prefix
//   4. The "+ New network" modal can be opened (we don't actually
//      scaffold — that would write to disk on the operator's box)

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true,
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
await authenticatePage(page, BASE);
const apiCalls = [];
page.on("request", (req) => { if (req.url().includes("/api/")) apiCalls.push(req.url()); });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

try {
  console.log(`→ open ${BASE}`);
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 15000 });
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
  expect(dropdownItems.includes("New network…"), `dropdown has "New network…" action`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-n02-dropdown.png" });

  // Click outside → dropdown closes.
  await page.evaluate(() => document.body.click());
  await new Promise((r) => setTimeout(r, 150));
  const dropdownGone = await page.$(".network-switcher-dropdown");
  expect(!dropdownGone, "dropdown closes on outside click");

  // Verify path-substitution: ≥1 /api/* request carried /networks/{active}/...
  // and the network-agnostic paths (/api/health, /api/networks, /api/labs) were
  // not given the prefix.
  const networkScoped = apiCalls.filter((u) => /\/api\/networks\/[^/]+\//.test(u));
  const agnostic = apiCalls.filter((u) =>
    /\/api\/(health|labs)\b/.test(u) || /\/api\/networks$/.test(u) || /\/api\/networks\?/.test(u));
  expect(networkScoped.length > 0,
    `≥1 /api/networks/{netID}/... call observed (got ${networkScoped.length}/${apiCalls.length})`);
  expect(agnostic.some((u) => u.includes("/api/health")),
    `/api/health observed without /networks/ prefix (correctly network-agnostic)`);

  // Open the "New network" modal — verify form fields present, then close.
  await page.click("#network-switcher-trigger");
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".network-switcher-item-id"));
    items.find((el) => el.textContent.trim() === "New network…")?.closest("button")?.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const modalFields = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".network-modal-form .form-control"))
      .map((el) => el.name));
  // spec_dir was removed (newtron #245/#251) — networks are created under
  // newtron's --networks-base, so the operator only supplies id + description.
  expect(modalFields.length === 2, `modal has 2 inputs (got ${JSON.stringify(modalFields)})`);
  expect(modalFields.includes("id") && modalFields.includes("description"),
    `modal fields are id + description`);
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
