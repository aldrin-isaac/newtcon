// Smoke: the workspace's responsive contract.
//   - the sidebar collapses to an icon rail at <=1100px, WITHOUT dropping the
//     labels from the accessibility tree
//   - the topology canvas fits the window at every size (no page scrolling)
//   - the fabric-health strip sits below the canvas and stays on screen
//   - a genuinely too-short window keeps a canvas floor and scrolls instead

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";
const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const ok=[],bad=[]; const t=(c,m)=>{(c?ok:bad).push(m);console.log((c?"  ok: ":"  FAIL: ")+m);};
const b=await puppeteer.launch({executablePath: CHROME,headless:"new",args:["--no-sandbox","--disable-dev-shm-usage","--ignore-certificate-errors"],ignoreHTTPSErrors:true,defaultViewport:{width:1500,height:950}});
const page=await b.newPage(); await authenticatePage(page,BASE);
await page.evaluateOnNewDocument((n)=>{try{localStorage.setItem("newtcon.activeNetwork",n);}catch{}},NET);
await gotoApp(page,`${BASE}/#/${NET}/topology`,{waitUntil:"networkidle0",timeout:30000});
await page.waitForSelector(".topo-node",{timeout:60000});

const probe = async (w,h) => {
  await page.setViewport({width:w,height:h});
  await new Promise(r=>setTimeout(r,600));
  return page.evaluate(() => {
    const sb=document.querySelector(".app-sidebar").getBoundingClientRect();
    const label=document.querySelector(".nav-label");
    const lb=label.getBoundingClientRect();
    const slot=document.querySelector(".topology-graph-slot").getBoundingClientRect();
    const foot=document.querySelector(".topology-footer")?.getBoundingClientRect();
    const content=document.querySelector(".app-content");
    return {
      sidebarW: Math.round(sb.width),
      labelVisible: lb.width>4,
      labelInA11yTree: !!label.textContent.trim(),
      slotH: Math.round(slot.height), slotBottom: Math.round(slot.bottom),
      footTop: foot?Math.round(foot.top):null, footBottom: foot?Math.round(foot.bottom):null,
      footVisible: !!foot && foot.top < window.innerHeight && foot.bottom > 0,
      pagesScrolls: content.scrollHeight > content.clientHeight + 2,
      vh: window.innerHeight,
    };
  });
};

for (const [w,h] of [[1600,1000],[1280,900],[1100,800],[1000,760],[860,700]]) {
  const r = await probe(w,h);
  console.log(`${w}x${h}:`, JSON.stringify(r));
  const collapsed = w <= 1100;
  t(collapsed ? r.sidebarW < 70 : r.sidebarW > 200, `${w}px: sidebar ${collapsed?"collapsed to rail":"full"} (${r.sidebarW}px)`);
  t(collapsed ? !r.labelVisible : r.labelVisible, `${w}px: nav labels ${collapsed?"hidden":"shown"}`);
  t(r.labelInA11yTree, `${w}px: label text still in the DOM for screen readers`);
  t(r.footVisible, `${w}px: status strip on screen`);
  t(!r.pagesScrolls, `${w}px: content area does not scroll (canvas fits)`);
  t(r.footBottom <= r.vh + 2, `${w}px: footer within the viewport (${r.footBottom} <= ${r.vh})`);
}
// very short window: the floor should kick in and scrolling is then acceptable
const tiny = await probe(1200, 420);
console.log("1200x420:", JSON.stringify(tiny));
t(tiny.slotH >= 300, `tiny window: canvas holds its ${tiny.slotH}px floor rather than vanishing`);
console.log(`\n${ok.length} ok, ${bad.length} failed`); if(bad.length) process.exitCode=1;
await b.close();
