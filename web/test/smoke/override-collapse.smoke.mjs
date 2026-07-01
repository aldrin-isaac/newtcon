// Browser smoke: a scoped-spec base with overrides shows a disclosure caret;
// the overrides are collapsed by default and toggle open/closed. Self-contained:
// creates a zone override of IPVPN via newtcon /api, verifies, then removes it
// via newtron's scoped delete (newtcon has no scoped-delete affordance yet).

import puppeteer from "puppeteer-core";
import { authenticatePage, loginCookie } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const NEWTRON = process.env.NEWTRON_URL || "http://127.0.0.1:18080";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };
// Node-side calls go through newtcon /api with the session cookie (newtron :18080
// needs a bearer under --auth-required). Scoped delete uses newtcon's DELETE.
const _ck = await loginCookie(BASE);
const AUTH = _ck ? { Cookie: `${_ck.name}=${_ck.value}` } : {};
const JSON_H = { "Content-Type": "application/json", ...AUTH };
// Discover an existing ipvpn + zone so the smoke adapts to the network's specs.
const IPVPN = ((await (await fetch(`${BASE}/api/networks/${NET}/ipvpns`, { headers: AUTH })).json()).names || [])[0];
const ZONE = ((await (await fetch(`${BASE}/api/networks/${NET}/zones`, { headers: AUTH })).json()).names || [])[0];
if (!IPVPN || !ZONE) { console.log(`SKIP: ${NET} needs an ipvpn + a zone for the override smoke`); process.exit(0); }
const removeOverride = () => fetch(`${BASE}/api/networks/${NET}/ipvpns/${IPVPN}?scope=zone&scope_instance=${ZONE}`, {
  method: "DELETE", headers: AUTH,
}).catch(() => {});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 950 } });
try {
  await removeOverride(); // clear any leftover from a prior run
  const base = await (await fetch(`${BASE}/api/networks/${NET}/ipvpns/${IPVPN}`, { headers: AUTH })).json();
  const r = await fetch(`${BASE}/api/networks/${NET}/ipvpns`, {
    method: "POST", headers: JSON_H,
    body: JSON.stringify({ name: IPVPN, scope: "zone", scope_instance: ZONE, l3vni: base.l3vni, route_targets: base.route_targets }),
  });
  expect(r.status === 201, `zone override of ${IPVPN} created (${r.status})`);

  const page = await browser.newPage();

  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-specs");
  await page.waitForSelector('[data-kind="ipvpns"]', { timeout: 8000 });
  await page.click('[data-kind="ipvpns"]');
  await page.waitForSelector(".panel-list-row", { timeout: 8000 });
  await sleep(400);

  const before = await page.evaluate(() => ({
    caret: !!document.querySelector(".panel-override-toggle"),
    caretText: document.querySelector(".panel-override-toggle")?.textContent || "",
    ovRows: document.querySelectorAll(".panel-list-row--override").length,
    ovVisible: Array.from(document.querySelectorAll(".panel-list-row--override")).filter((x) => !x.hidden).length,
  }));
  expect(before.caret, "base row has a disclosure caret");
  expect(before.ovRows >= 1, `override row(s) present in DOM (${before.ovRows})`);
  expect(before.caretText === "▸" && before.ovVisible === 0, "overrides collapsed by default (hidden)");

  await page.evaluate(() => document.querySelector(".panel-override-toggle")?.click());
  await sleep(300);
  const after = await page.evaluate(() => ({
    caretText: document.querySelector(".panel-override-toggle")?.textContent || "",
    ovVisible: Array.from(document.querySelectorAll(".panel-list-row--override")).filter((x) => !x.hidden).length,
  }));
  expect(after.caretText === "▾" && after.ovVisible >= 1, "clicking the caret expands the overrides");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally {
  await removeOverride();
  await browser.close();
}
