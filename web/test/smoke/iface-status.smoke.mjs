// Browser smoke: the device drawer's Interfaces tab, when a port is expanded,
// renders the per-interface LIVE STATUS panel (newtron #431) — LLDP far-end
// (the wiring truth), resolved ARP, SONiC-computed rates, and the Rx/Tx counter
// table. Read live; skips when the device isn't deployed.
//
//   NET=3node-vs-newtcon DEVICE=switch1 IFACE=Ethernet0 \
//   NEWTCON_URL=https://127.0.0.1:8095 NEWTCON_TEST_USER=ron NEWTCON_TEST_PASS=… \
//   node test/smoke/iface-status.smoke.mjs

import puppeteer from "puppeteer-core";
import { authenticatePage, skipIfNotDeployed } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEVICE = process.env.DEVICE || "switch1";
const IFACE = process.env.IFACE || "Ethernet0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

await skipIfNotDeployed(NET, DEVICE);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
  ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 },
});
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate((n) => localStorage.setItem("newtcon.activeNetwork", n), NET);
  await page.goto(BASE, { waitUntil: "networkidle0" });

  // Open the device drawer via the topology node, then the Interfaces tab.
  await page.click("#tab-topology");
  await page.waitForSelector("svg.topology-graph", { timeout: 10000 }).catch(() => {});
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
  await sleep(900);

  // Expand the target port row.
  const expanded = await page.evaluate((iface) => {
    const re = new RegExp(`${iface}(\\D|$)`);
    const row = [...document.querySelectorAll(".iface-row")].find((x) => re.test(x.textContent));
    if (row) { row.click(); return true; }
    return false;
  }, IFACE);
  expect(expanded, `expanded interface row ${IFACE}`);

  await page.waitForSelector(".iface-live", { timeout: 8000 }).catch(() => {});
  // Wait for the async fetch to resolve (loading → content).
  await page.waitForFunction(() => {
    const l = document.querySelector(".iface-live");
    return l && !/Loading/.test(l.textContent || "");
  }, { timeout: 8000 }).catch(() => {});
  await sleep(200);

  const view = await page.evaluate(() => {
    const l = document.querySelector(".iface-live");
    if (!l) return null;
    return {
      lldp: l.querySelector(".iface-live-lldp-peer")?.textContent || "",
      hasArp: !!l.querySelector(".iface-live-arp"),
      hasRates: !!l.querySelector(".iface-live-rates"),
      counterRows: l.querySelectorAll(".iface-live-counters tr").length,
      text: l.innerText,
    };
  });

  expect(!!view, "LIVE STATUS panel rendered");
  if (view) {
    expect(!/unavailable/i.test(view.text), "live status is available (device reachable)");
    expect(view.lldp && view.lldp !== "no LLDP neighbor heard", `LLDP far-end shown: "${view.lldp}"`);
    expect(view.hasArp, "ARP row present");
    expect(view.hasRates, "rates row present (COUNTERS_DB populated)");
    expect(view.counterRows >= 6, `counter table present (${view.counterRows} rows incl. header)`);
  }
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
