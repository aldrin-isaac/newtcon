// Headless smoke for the Topology-tab "Deploy as lab" button.
// Verifies:
//   1. Button renders in the topology toolbar with the right label
//   2. Click fires the confirm dialog
//   3. After confirm, modal opens with the log panel + Close (disabled initially)
//   4. POST /api/labs/{active}/deploy is observed on the wire
//   5. Close button enables (either after error or after stream completes)

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

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
await authenticatePage(page, BASE);
const deployPosts = [];
page.on("request", (req) => {
  if (req.method() === "POST" && /\/api\/labs\/[^/]+\/deploy/.test(req.url())) {
    deployPosts.push(req.url());
  }
});

// (Inline confirm modal replaces window.confirm — accepted below by
//  clicking the modal's Confirm button.)

try {
  // Pre-seed localStorage so the active network points at a registered one.
  // Run a no-op navigation first so the origin exists for localStorage.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate(() => localStorage.setItem("newtcon.activeNetwork", "2node-vs"));

  console.log(`→ reload ${BASE} with active network "2node-vs"`);
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });

  // Switch to Topology tab → Lab view (post-#210 the lifecycle buttons
  // are gated to the Lab view).
  await page.click("#tab-topology");
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll(".topology-view-chip"))
      .find((el) => el.textContent.trim() === "Lab");
    if (chip instanceof HTMLElement) chip.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  await page.screenshot({ path: "/tmp/newtcon-smoke-deploy-01-topology.png" });

  // 1. Button is present.
  const btnText = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".topology-toolbar-btn"));
    const b = btns.find((el) => el.textContent.trim() === "Deploy");
    return b ? b.textContent.trim() : null;
  });
  expect(btnText === "Deploy", `toolbar button labeled "${btnText}"`);

  // 2-3. Click the button → inline confirm modal mounts → click Confirm
  // → deploy modal opens.
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".topology-toolbar-btn"));
    btns.find((el) => el.textContent.trim() === "Deploy")?.click();
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(() => {
    const confirm = document.querySelector(".confirm-modal-btn--confirm");
    if (confirm instanceof HTMLElement) confirm.click();
  });
  await new Promise((r) => setTimeout(r, 800));

  const modal = await page.$(".deploy-modal");
  expect(!!modal, "deploy modal opened after confirm");

  const logPresent = await page.$(".deploy-modal-log");
  expect(!!logPresent, "log panel present in modal");

  await page.screenshot({ path: "/tmp/newtcon-smoke-deploy-02-modal.png" });

  // 4. The deploy POST was sent. We don't care about the response status —
  // newtlab may 404 or accept; phase 1 only requires the wire-level click→POST.
  expect(deployPosts.length === 1,
    `exactly 1 POST /api/labs/{active}/deploy observed: ${JSON.stringify(deployPosts)}`);
  expect(/\/api\/labs\/[^/]+\/deploy$/.test(deployPosts[0] ?? ""),
    `deploy URL has the correct shape: ${deployPosts[0]}`);

  // 5. The Close button is always enabled — operator stays in control even if
  // newtlab's SSE stream is slow or never emits a terminal event.
  const closeState = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll(".network-modal-actions .btn"))
      .find((b) => b.textContent?.trim() === "Close");
    return c ? { present: true, disabled: c.hasAttribute("disabled") } : { present: false };
  });
  expect(closeState.present && !closeState.disabled,
    `Close button present and enabled: ${JSON.stringify(closeState)}`);

  // 6. Clicking Close dismisses the modal.
  await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll(".network-modal-actions .btn"))
      .find((b) => b.textContent?.trim() === "Close");
    c?.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const stillThere = await page.$(".deploy-modal");
  expect(!stillThere, "modal dismissed after Close clicked");

  await page.screenshot({ path: "/tmp/newtcon-smoke-deploy-03-final.png" });

  console.log("");
  if (failed.length === 0) console.log("✅ all checks passed");
  else { console.log(`❌ ${failed.length} failed`); process.exitCode = 1; }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
