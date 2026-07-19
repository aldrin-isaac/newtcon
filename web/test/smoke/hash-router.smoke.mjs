// Browser smoke: hash router (uplift 2.4, #404).
//   1. Boot with no hash stamps the default route #/{net}/specs.
//   2. Tab navigation writes the hash; back/forward restore the view.
//   3. A specs facet deep link (#/{net}/specs/ipvpns) lands on that facet.
//   4. Deep-link to a device drawer (#/{net}/topology/device/{d}) opens the
//      inspector — and SURVIVES REFRESH (the acceptance).
// Device discovered from the network's topology; works on any network with
// at least one device. No lab/live state needed (the drawer shell renders
// regardless of substrate reachability).

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp, apiGET } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const topo = await apiGET(NET, "topology", BASE).catch(() => null);
// topology.nodes is a name-keyed object; prefer a switch-ish name for a
// meatier drawer, else take the first node.
const names = Object.keys(topo?.nodes || {});
const device = names.find((n) => n.startsWith("switch")) || names[0];
if (!device) {
  console.log(`SKIP: network ${NET} has no topology devices to deep-link`);
  process.exit(0);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  // 1. Bare boot stamps the default route.
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForFunction(() => location.hash.length > 0, { timeout: 10000 });
  expect(await page.evaluate(() => location.hash) === `#/${NET}/specs`, `bare boot stamps #/${NET}/specs`);

  // 2. Tab navigation writes the hash; back restores the previous view.
  await page.click("#tab-topology");
  await sleep(300);
  expect(await page.evaluate(() => location.hash) === `#/${NET}/topology`, "Topology click writes the hash");
  await page.goBack();
  await sleep(400);
  expect(await page.evaluate(() => location.hash) === `#/${NET}/specs`, "back returns the hash to specs");
  expect(await page.evaluate(() => !document.getElementById("panel-specs").hidden), "back re-activates the Specs panel");
  await page.goForward();
  await sleep(400);
  expect(await page.evaluate(() => !document.getElementById("panel-topology").hidden), "forward re-activates Topology");

  // 3. Specs facet deep link.
  await gotoApp(page, `${BASE}/#/${NET}/specs/ipvpns`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".specs-subnav-item--active", { timeout: 20000 });
  const facetLabel = await page.evaluate(() => document.querySelector(".specs-subnav-item--active")?.textContent || "");
  expect(facetLabel.includes("IP-VPN"), `facet deep link lands on IP VPNs (active: ${JSON.stringify(facetLabel)})`);

  // 4. Device-drawer deep link + REFRESH SURVIVAL.
  await gotoApp(page, `${BASE}/#/${NET}/topology/device/${device}`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector("#detail-drawer.open", { timeout: 20000 });
  let header = await page.evaluate(() => document.getElementById("drawer-content")?.textContent || "");
  expect(header.includes(device), `deep link opens the ${device} drawer`);
  await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector("#detail-drawer.open", { timeout: 20000 });
  header = await page.evaluate(() => document.getElementById("drawer-content")?.textContent || "");
  expect(header.includes(device), "device drawer survives refresh");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
