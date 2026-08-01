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
console.log(`\n${ok.length} ok, ${bad.length} failed`);
if(bad.length) process.exitCode=1;
await b.close();
