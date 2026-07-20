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
// Needs a network with ≥1 service and ≥1 device. Discover one instead of
// hardcoding a lab that may no longer exist (the fixture lacks services'
// verb targets only when its seed changes — prefer NET when given).
async function discoverNet(base) {
  if (process.env.NET) return process.env.NET;
  try {
    const raw = await (await fetch(`${base}/api/networks`)).json();
    const list = Array.isArray(raw) ? raw : raw.networks ?? [];
    for (const n of list) {
      const id = n.id ?? n.name;
      if (!id) continue;
      try {
        const [svcs, topo] = await Promise.all([
          (await fetch(`${base}/api/networks/${id}/services`)).json(),
          (await fetch(`${base}/api/networks/${id}/topology`)).json(),
        ]);
        const svcCount = Array.isArray(svcs) ? svcs.length : (svcs.services ?? []).length;
        // Links are required: the port-picker stage harvests its catalog
        // from them — a linkless network can't complete a mouse-only apply.
        if (svcCount > 0 && Object.keys(topo.nodes ?? {}).length > 0 && (topo.links ?? []).length > 0) return id;
      } catch { /* next */ }
    }
  } catch { /* fall through */ }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const NET = await discoverNet(BASE);
if (!NET) { console.log("SKIP: no network with services + devices for verb targets"); process.exit(0); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  // The palette works from any tab; History mounts instantly (no facet
  // fetches), so the smoke doesn't inherit slow-network Specs stalls.
  await gotoApp(page, `${BASE}/#/${NET}/history`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".view-heading", { timeout: 30000 });

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

  // Discover a service + device on NET for the sentences.
  const svcRaw = await (await fetch(`${BASE}/api/networks/${NET}/services`)).json();
  const svcList = Array.isArray(svcRaw) ? svcRaw : svcRaw.services ?? [];
  const SVC = typeof svcList[0] === "string" ? svcList[0] : svcList[0]?.name;
  const topoRaw = await (await fetch(`${BASE}/api/networks/${NET}/topology`)).json();
  const DEV = Object.keys(topoRaw.nodes ?? {}).find((n) => n.startsWith("switch")) || Object.keys(topoRaw.nodes ?? {})[0];

  // 1. apply verb stages.
  const before = await pendingCount();
  await openPalette();
  await typeAndWaitFor(`apply ${SVC} on ${DEV}:Ethernet5`, `apply ${SVC} on ${DEV}:Ethernet5`);
  await clickItem(`apply ${SVC} on ${DEV}:Ethernet5`);
  await sleep(400);
  expect(await pendingCount() === before + 1, "apply verb staged into the pending queue");

  // 2. create vlan verb stages.
  await openPalette();
  await typeAndWaitFor(`create vlan 300 on ${DEV}`, `create vlan 300 on ${DEV}`);
  await clickItem(`create vlan 300 on ${DEV}`);
  await sleep(400);
  expect(await pendingCount() === before + 2, "create-vlan verb staged into the pending queue");

  // 3. deploy verb navigates (never stages).
  await openPalette();
  await typeAndWaitFor(`deploy ${NET}`, "open Topology");
  await clickItem("open Topology");
  await sleep(600);
  expect(await page.evaluate(() => location.hash.endsWith("/topology")), "deploy verb navigates to Topology");
  expect(await pendingCount() === before + 2, "deploy verb did NOT stage anything");

  // 4. MOUSE-ONLY staging (uplift 6.3): click through verb → service →
  //    device → port with zero typing beyond opening the palette.
  await openPalette();
  await page.type("#palette-input", "a", { delay: 15 });
  await page.waitForFunction(() => [...document.querySelectorAll(".palette-item")].some((i) => i.textContent.includes("apply ")), { timeout: 20000 });
  await clickItem(`apply ${SVC} on …`);
  await page.waitForFunction((d) => [...document.querySelectorAll(".palette-item")].some((i) => i.textContent.includes(`${d}:`)), { timeout: 20000 }, DEV);
  await clickItem(`apply ${SVC} on ${DEV}:…`);
  await page.waitForFunction((s2) => [...document.querySelectorAll(".palette-item")].some((i) => i.textContent.includes(s2) && !i.textContent.includes("…")), { timeout: 20000 }, `on ${DEV}:`);
  const stagedVia = await page.evaluate((needle) => {
    const all = [...document.querySelectorAll(".palette-item")].map((i) => i.textContent);
    const item = [...document.querySelectorAll(".palette-item")].find((i) => i.textContent.includes(needle) && !i.textContent.includes("…") && !i.textContent.includes("<port>"));
    const label = item?.textContent ?? null;
    item?.click();
    return label ?? "MISS among: " + all.slice(0, 6).join(" | ");
  }, `on ${DEV}:`);
  await sleep(400);
  expect(await pendingCount() === before + 3, `mouse-only click-through staged (via ${JSON.stringify(stagedVia)})`);

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
