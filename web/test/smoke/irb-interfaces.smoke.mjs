// Browser smoke: the device drawer's Interfaces tab renders the "IRB
// interfaces (VLAN)" section — SVI rows joined from the live /vlans read +
// topology intent, expandable to the kind-aware LIVE STATUS panel (members),
// with Apply-service / Delete-VLAN actions and the "+ Add VLAN interface"
// affordance (macvpn VLAN-pin hint). Needs a deployed device with a VLAN
// interface; skips otherwise.
//
//   NET=3node-vs-newtcon DEVICE=switch1 VLAN=Vlan100 \
//   NEWTCON_URL=https://127.0.0.1:8095 NEWTCON_TEST_USER=ron NEWTCON_TEST_PASS=… \
//   node test/smoke/irb-interfaces.smoke.mjs

import puppeteer from "puppeteer-core";
import { authenticatePage, skipIfNotDeployed, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEVICE = process.env.DEVICE || "switch1";
const VLAN = process.env.VLAN || "Vlan100";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

await skipIfNotDeployed(NET, DEVICE);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
  ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 1050 },
});
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await gotoApp(page, BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate((n) => localStorage.setItem("newtcon.activeNetwork", n), NET);
  await gotoApp(page, BASE, { waitUntil: "networkidle0" });
  await page.click("#tab-topology");
  await page.waitForSelector("svg.topology-graph", { timeout: 20000 }).catch(() => {});
  await sleep(1000);
  await page.evaluate((d) => {
    const t = [...document.querySelectorAll("svg text")].find((e) => e.textContent.trim() === d);
    if (t) (t.closest("g") || t).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, DEVICE);
  await sleep(900);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button,.drawer-tab,[role=tab]")].find((e) => /^Interfaces$/.test(e.textContent.trim()));
    if (b) b.click();
  });
  await page.waitForSelector(".irb-section", { timeout: 20000 }).catch(() => {});
  await sleep(800);

  const section = await page.evaluate(() => !!document.querySelector(".irb-section"));
  expect(section, "IRB interfaces (VLAN) section rendered");

  const row = await page.evaluate((vlan) => {
    const r = [...document.querySelectorAll(".irb-row")].find((x) => x.textContent.includes(vlan));
    if (!r) return null;
    return { meta: r.querySelector(".irb-row-meta")?.textContent || "", svc: r.querySelector(".iface-svc-chip")?.textContent || null };
  }, VLAN);
  expect(!!row, `${VLAN} row present`);
  if (row) {
    expect(/L2VNI/.test(row.meta), `row meta carries L2VNI (${row.meta})`);
    expect(!!row.svc, `service chip shown (${row.svc})`);
  }

  // Expand → kind-aware LIVE STATUS with a members row + actions.
  await page.evaluate((vlan) => {
    [...document.querySelectorAll(".irb-row")].find((x) => x.textContent.includes(vlan))?.click();
  }, VLAN);
  await page.waitForFunction(() => {
    const l = document.querySelector(".irb-row-detail .iface-live");
    return l && !/Loading/.test(l.textContent || "");
  }, { timeout: 20000 }).catch(() => {});
  await sleep(200);
  const detail = await page.evaluate(() => {
    const d = document.querySelector(".irb-row-detail");
    return {
      members: !!d?.querySelector(".iface-live-members"),
      actions: [...(d?.querySelectorAll(".iface-action-btn") || [])].map((b) => b.textContent),
    };
  });
  expect(detail.members, "LIVE STATUS members row present (kind-aware /status)");
  expect(detail.actions.some((a) => /Apply service|Re-apply service/.test(a)), "Apply-service action offered on the SVI");
  expect(detail.actions.some((a) => /Delete VLAN/.test(a)), "Delete-VLAN action offered");

  // Add form opens with the hint.
  await page.evaluate(() => {
    [...document.querySelectorAll(".irb-section .iface-action-btn")].find((b) => /Add VLAN interface/.test(b.textContent))?.click();
  });
  await sleep(1200);
  const hint = await page.evaluate(() => document.querySelector(".irb-add-form-host .form-help-text")?.textContent || "");
  expect(/VlanN/.test(hint), "add-VLAN form opens with the SVI hint");
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
