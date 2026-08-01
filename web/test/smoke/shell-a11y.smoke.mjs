// Smoke: the shell's accessibility contract — workspace nav is real links (not
// a fake tablist), the skip link works, decorative icons are hidden, the polite
// live region exists, and the command palette hands focus back on close.

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";
const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const ok=[],bad=[]; const t=(c,m)=>{(c?ok:bad).push(m);console.log((c?"  ok: ":"  FAIL: ")+m);};
const browser = await puppeteer.launch({ executablePath: CHROME, headless:"new", args:["--no-sandbox","--disable-dev-shm-usage","--ignore-certificate-errors"], ignoreHTTPSErrors:true, defaultViewport:{width:1500,height:950} });
const page = await browser.newPage();
await authenticatePage(page, BASE);
await page.evaluateOnNewDocument((n)=>{try{localStorage.setItem("newtcon.activeNetwork",n);}catch{}}, NET);
await gotoApp(page, BASE, { waitUntil:"networkidle0", timeout:30000 });
await new Promise(r=>setTimeout(r,800));

// 1. nav semantics
const nav = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll(".nav .nav-item"));
  return {
    tags: items.map(i=>i.tagName),
    roleTab: items.filter(i=>i.getAttribute("role")==="tab").length,
    hrefs: items.map(i=>i.getAttribute("href")),
    ariaCurrent: items.map(i=>i.getAttribute("aria-current")),
    navRole: document.querySelector(".nav")?.getAttribute("role"),
  };
});
t(nav.tags.every(x=>x==="A"), `workspace nav items are <a> (${[...new Set(nav.tags)].join(",")})`);
t(nav.roleTab===0, `no bogus role="tab" remains (${nav.roleTab})`);
t(nav.hrefs.every(h=>h && h.startsWith("#/")), `every item has a real URL (${nav.hrefs[1]})`);
t(nav.ariaCurrent.filter(a=>a==="page").length===1, `exactly one aria-current="page"`);

// 2. skip link
const skip = await page.evaluate(() => {
  const a = document.querySelector(".skip-link");
  if (!a) return null;
  a.focus();
  const r = a.getBoundingClientRect();
  return { href: a.getAttribute("href"), firstInTab: document.body.firstElementChild === a, visibleOnFocus: r.top >= 0, target: !!document.querySelector(a.getAttribute("href")) };
});
t(!!skip, "skip link exists");
t(skip?.firstInTab === true, "skip link is first in the tab order");
t(skip?.visibleOnFocus === true, "skip link becomes visible on focus");
t(skip?.target === true, `skip link target #app-content exists`);

// 3. icons hidden
const icons = await page.evaluate(() => {
  const wraps = Array.from(document.querySelectorAll(".nav-icon, .network-switcher-chevron, .user-pill-chevron, .anon-pill-chevron"));
  return { total: wraps.length, hidden: wraps.filter(w=>w.getAttribute("aria-hidden")==="true").length };
});
t(icons.total>0 && icons.hidden===icons.total, `decorative icons aria-hidden (${icons.hidden}/${icons.total})`);

// 4. live region
const live = await page.evaluate(() => {
  const el = document.getElementById("a11y-announcer");
  return el ? { live: el.getAttribute("aria-live"), role: el.getAttribute("role") } : null;
});
t(live?.live === "polite" && live?.role === "status", "polite live region present");

// 5. palette focus trap + return
const pal = await page.evaluate(async () => {
  const before = document.activeElement?.id || document.activeElement?.className || "body";
  document.getElementById("tab-topology")?.focus();
  const opener = document.activeElement?.id;
  document.dispatchEvent(new KeyboardEvent("keydown", { key:"k", metaKey:true, bubbles:true }));
  await new Promise(r=>setTimeout(r,120));
  const openFocus = document.activeElement?.id;
  document.dispatchEvent(new KeyboardEvent("keydown", { key:"Escape", bubbles:true }));
  await new Promise(r=>setTimeout(r,120));
  return { opener, openFocus, restored: document.activeElement?.id, before };
});
t(pal.openFocus === "palette-input", `palette focuses its input on open (${pal.openFocus})`);
t(pal.restored === pal.opener, `palette restores focus on close (${pal.opener} -> ${pal.restored})`);

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) process.exitCode = 1;
await browser.close();
