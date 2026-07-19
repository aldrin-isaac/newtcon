// Browser smoke: Cmd-K verbs (uplift 5.1, #432).
//   1. "apply <svc> on <device>:<iface>" stages into the pending queue —
//      NO direct apply (queue count rises, nothing hits the wire).
//   2. "create vlan <n> on <device>" stages likewise.
//   3. "deploy <network>" navigates to Topology (lifecycle, not intent).
// Everything staged is DISCARDED before exit — the smoke must not mutate.
// Needs a network with ≥1 service + ≥1 device: default 3node-vs-newtcon.

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "3node-vs-newtcon";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await gotoApp(page, `${BASE}/#/${NET}/specs`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".specs-subnav", { timeout: 30000 });

  const pendingCount = () => page.evaluate(() => {
    const el = document.querySelector(".pending-bar-count");
    return el && !document.getElementById("pending-bar").hidden ? Number(el.textContent) : 0;
  });
  const openPalette = async () => {
    await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
    await page.waitForSelector("#palette-overlay:not([hidden])", { timeout: 10000 });
  };
  const typeAndWaitFor = async (text, needle) => {
    await page.type("#palette-input", text, { delay: 15 });
    await page.waitForFunction((n) =>
      [...document.querySelectorAll(".palette-item")].some((i) => i.textContent.includes(n)),
      { timeout: 20000 }, needle);
  };
  const clickItem = (needle) => page.evaluate((n) => {
    [...document.querySelectorAll(".palette-item")].find((i) => i.textContent.includes(n))?.click();
  }, needle);

  // 1. apply verb stages.
  const before = await pendingCount();
  await openPalette();
  await typeAndWaitFor("apply TRANSIT on switch1:Ethernet5", "apply TRANSIT on switch1:Ethernet5");
  await clickItem("apply TRANSIT on switch1:Ethernet5");
  await sleep(400);
  expect(await pendingCount() === before + 1, "apply verb staged into the pending queue");

  // 2. create vlan verb stages.
  await openPalette();
  await typeAndWaitFor("create vlan 300 on switch1", "create vlan 300 on switch1");
  await clickItem("create vlan 300 on switch1");
  await sleep(400);
  expect(await pendingCount() === before + 2, "create-vlan verb staged into the pending queue");

  // 3. deploy verb navigates (never stages).
  await openPalette();
  await typeAndWaitFor(`deploy ${NET}`, "open Topology");
  await clickItem("open Topology");
  await sleep(600);
  expect(await page.evaluate(() => location.hash.endsWith("/topology")), "deploy verb navigates to Topology");
  expect(await pendingCount() === before + 2, "deploy verb did NOT stage anything");

  // Cleanup: discard everything this smoke staged.
  await page.evaluate(() => document.getElementById("pending-bar-discard")?.click());
  await sleep(400);
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => /discard/i.test(b.textContent) && b.closest(".confirm-modal"))?.click();
  });
  await sleep(400);
  const final = await pendingCount();
  expect(final === before, `queue restored (${final})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
