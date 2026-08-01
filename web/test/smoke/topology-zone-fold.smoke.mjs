// Smoke: collapsible zone grouping on the topology canvas — the density
// affordance for large fabrics. Folding a zone replaces its member devices with
// ONE card, re-terminates crossing links on it, and persists per network.
// Needs a network with at least one zoned device (default: 2node-vs / "amer").

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";
const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.ZONE_NET || "2node-vs";
const ok=[],bad=[]; const t=(c,m)=>{(c?ok:bad).push(m);console.log((c?"  ok: ":"  FAIL: ")+m);};
const b=await puppeteer.launch({executablePath: CHROME,headless:"new",args:["--no-sandbox","--disable-dev-shm-usage","--ignore-certificate-errors"],ignoreHTTPSErrors:true,defaultViewport:{width:1500,height:950}});
const page=await b.newPage(); await authenticatePage(page,BASE);
await page.evaluateOnNewDocument((n)=>{try{localStorage.setItem("newtcon.activeNetwork",n);localStorage.removeItem("newtcon.topology.collapsedZones."+n);}catch{}},NET);
await gotoApp(page,`${BASE}/#/${NET}/topology`,{waitUntil:"networkidle0",timeout:30000});
await page.waitForSelector(".topo-node",{timeout:60000});
await new Promise(r=>setTimeout(r,900));

const before = await page.evaluate(()=>({
  nodes: document.querySelectorAll(".topo-node").length,
  zoneCards: document.querySelectorAll(".topo-node--zone").length,
  regions: document.querySelectorAll(".topo-zone-region").length,
  label: document.querySelector(".topo-zone-label")?.textContent,
  labelClickable: !!document.querySelector(".topo-zone-label--clickable"),
  links: document.querySelectorAll(".topo-link:not(.topo-link-hit)").length,
}));
console.log("EXPANDED:", JSON.stringify(before));
t(before.zoneCards===0 && before.regions>0, "starts expanded: region drawn, no zone card");
t(before.labelClickable, `zone label is the fold handle (${JSON.stringify(before.label)})`);


// collapse
await page.evaluate(()=>document.querySelector(".topo-zone-label--clickable")?.dispatchEvent(new MouseEvent("click",{bubbles:true})));
await new Promise(r=>setTimeout(r,900));
const after = await page.evaluate((NET)=>({
  nodes: document.querySelectorAll(".topo-node").length,
  zoneCards: document.querySelectorAll(".topo-node--zone").length,
  regions: document.querySelectorAll(".topo-zone-region").length,
  zoneText: [...document.querySelectorAll(".topo-node--zone text")].map(t=>t.textContent),
  links: document.querySelectorAll(".topo-link:not(.topo-link-hit)").length,
  switchesGone: !document.querySelector('.topo-node[data-device="switch1"]'),
  stored: JSON.parse(localStorage.getItem("newtcon.topology.collapsedZones."+NET)||"[]"),
}), NET);
console.log("COLLAPSED:", JSON.stringify(after));
t(after.zoneCards===1, "one zone card replaces the members");
t(after.switchesGone, "member devices removed from the canvas");
t(after.regions===0, "no tinted region behind a folded zone (the card IS the zone)");
t(after.nodes < before.nodes, `fewer cards drawn (${before.nodes} -> ${after.nodes})`);
t(after.links <= before.links, `links merged or equal (${before.links} -> ${after.links})`);
t(JSON.stringify(after.stored)==='["amer"]', "choice persisted per network");
t(after.zoneText.join(" ").includes("amer") && after.zoneText.join(" ").includes("device"), `card reads zone + count (${JSON.stringify(after.zoneText)})`);


// expand again by clicking the card
await page.evaluate(()=>document.querySelector(".topo-node--zone")?.dispatchEvent(new MouseEvent("click",{bubbles:true})));
await new Promise(r=>setTimeout(r,900));
const back = await page.evaluate((NET)=>({
  zoneCards: document.querySelectorAll(".topo-node--zone").length,
  switch1: !!document.querySelector('.topo-node[data-device="switch1"]'),
  stored: JSON.parse(localStorage.getItem("newtcon.topology.collapsedZones."+NET)||"[]"),
}), NET);
t(back.zoneCards===0 && back.switch1, "clicking the card unfolds it again");
t(back.stored.length===0, "unfolding clears the stored preference");
// ── Bulk fold controls in the command bar ────────────────────────────────
// Deliberately NOT in the view-mode toolbar: folding must work in Lab and
// Physical too, and that toolbar's contents are gated by view mode.
const foldRow = () => page.evaluate(() => {
  const row = document.querySelector(".topology-zone-fold-row");
  return {
    present: !!row && !row.hidden,
    btns: [...(row?.querySelectorAll("button") ?? [])].map((b) => ({ label: b.textContent, disabled: b.disabled })),
    count: row?.querySelector(".topology-zone-fold-count")?.textContent ?? null,
    zoneCards: document.querySelectorAll(".topo-node--zone").length,
  };
});
const clickFold = (label) => page.evaluate((l) =>
  [...document.querySelectorAll(".topology-zone-fold-row button")].find((b) => b.textContent.includes(l))?.click(), label);

const f0 = await foldRow();
t(f0.present, "bulk fold controls mounted");
t(f0.btns.some((b) => /Collapse all/.test(b.label) && !b.disabled), "Collapse all enabled when nothing folded");
t(f0.btns.some((b) => /Expand all/.test(b.label) && b.disabled), "Expand all disabled when nothing folded");

await clickFold("Collapse all");
await new Promise((r) => setTimeout(r, 900));
const f1 = await foldRow();
t(f1.zoneCards >= 1, `Collapse all folds every zone (${f1.zoneCards} card(s))`);
t(f1.btns.some((b) => /Collapse all/.test(b.label) && b.disabled), "Collapse all disables once all folded");
t(/folded/.test(f1.count ?? ""), `running count shown (${JSON.stringify(f1.count)})`);

await clickFold("Expand all");
await new Promise((r) => setTimeout(r, 900));
const f2 = await foldRow();
t(f2.zoneCards === 0, "Expand all unfolds every zone");
t(await page.evaluate((NET) => localStorage.getItem("newtcon.topology.collapsedZones." + NET) === null, NET),
  "Expand all clears persistence");

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if(bad.length) process.exitCode=1;
await b.close();
