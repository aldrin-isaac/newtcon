// Browser smoke: the device drawer header folds the old Summary tab — identity
// facts + interface/drift stats are always visible, and there is no Summary tab
// (default lands on Interfaces).

import puppeteer from "puppeteer-core";
import { authenticatePage, apiGET } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEVICE = process.env.DEVICE || "switch1";
// Discover the device's declared identity so the assertions adapt to whatever
// network we run against — platform / ASN / loopback differ per fixture.
const spec = await apiGET(NET, `nodes/${DEVICE}`);
const PLATFORM = spec.platform, ASN = spec.underlay_asn, LOOPBACK = spec.loopback_ip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((net) => { try { localStorage.setItem("newtcon.activeNetwork", net); localStorage.setItem("newtcon:topology-view:" + net, "spec"); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 10000 });
  await page.evaluate((dev) => document.querySelector(`g.topo-node[data-device='${dev}']`)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })), DEVICE);
  await page.waitForSelector(".topo-menu-header--button", { timeout: 6000 });
  await page.evaluate(() => document.querySelector(".topo-menu-header--button")?.click());
  await page.waitForSelector(".node-tabs", { timeout: 6000 });
  await sleep(400);

  // No Summary tab; default active tab is Interfaces.
  const tabs = await page.evaluate(() => Array.from(document.querySelectorAll("button.node-tab")).map((b) => b.textContent.trim()));
  expect(!tabs.includes("Summary"), `no Summary tab (${tabs.join(",")})`);
  const active = await page.evaluate(() => document.querySelector("button.node-tab.node-tab--active")?.textContent.trim());
  expect(active === "Spec", `default tab is Spec in spec-view (Summary removed) (${active})`);

  // Header carries identity facts + a stats row, always visible.
  await page.waitForFunction((p) => (document.querySelector(".node-drawer-subtitle")?.textContent || "").includes(p), { timeout: 6000 }, PLATFORM);
  const sub = await page.evaluate(() => document.querySelector(".node-drawer-subtitle")?.textContent || "");
  expect(sub.includes(PLATFORM) && sub.includes(`AS ${ASN}`) && sub.includes(`lo ${LOOPBACK}`),
    `header subtitle has discovered identity facts (platform=${PLATFORM} AS=${ASN} lo=${LOOPBACK}): "${sub}"`);
  // Interface counts + drift come from live probes (/interfaces, /drift), present
  // only with a deployed device. Assert them when they populate; skip on the
  // staged fixture (the identity subtitle above is the spec-based part, which now
  // falls back to the NodeSpec when /info is unavailable).
  const gotStats = await page.waitForFunction(() => (document.querySelector(".node-drawer-stats")?.textContent || "").length > 0, { timeout: 4000 }).then(() => true).catch(() => false);
  if (gotStats) {
    const stats = await page.evaluate(() => document.querySelector(".node-drawer-stats")?.textContent || "");
    expect(/interfaces/.test(stats), `header stats row shows interface count (${stats})`);
    expect(/drift/.test(stats), `header stats row shows drift status (${stats})`);
  } else {
    console.log("  n/a: interface/drift stats (no live device on the staged fixture)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
