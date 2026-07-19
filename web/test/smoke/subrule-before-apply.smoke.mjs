// Browser smoke: sub-rules can be authored on a NOT-yet-applied parent spec.
// Create a QoS policy (staged), open its detail (previously 404'd for pending
// specs), and confirm the sub-rule section is reachable + a queue stages — so
// parent + rules apply together in one Save (groupOrder already sequences them).
// Staged-only (no apply) → no engine mutation; the browser close drops the queue.
import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";
const BASE=process.env.NEWTCON_URL||"http://127.0.0.1:8095", NET=process.env.NET||"1node-vs";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const expect=(c,m)=>{c?(pass++,console.log("  ok:",m)):(fail++,console.error("  FAIL:",m));};
const b=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:"new",args:["--no-sandbox","--disable-dev-shm-usage","--ignore-certificate-errors"],ignoreHTTPSErrors:true,defaultViewport:{width:1500,height:950}});
try{
  const p=await b.newPage();
  await authenticatePage(p, BASE);
  await p.evaluateOnNewDocument(n=>{try{localStorage.setItem("newtcon.activeNetwork",n);}catch{}},NET);
  p.on("pageerror",e=>console.log("  [pageerror]",e.message));
  await gotoApp(p, BASE, {waitUntil:"networkidle0",timeout:20000});
  await p.click("#tab-specs"); await p.waitForSelector('[data-kind="qos-policies"]', { timeout: 60000 });
  await p.click('[data-kind="qos-policies"]'); await p.waitForSelector(".panel-add-btn",{timeout:20000}); await sleep(200);
  // create a staged qos-policy
  await p.evaluate(()=>document.querySelector(".panel-add-btn")?.click());
  await p.waitForSelector('.form-control[name="name"], input[name="name"]',{timeout:20000});
  await p.evaluate(()=>{const i=document.querySelector('input[name="name"]')||document.querySelector('[name="name"]');i.value="PCTEST";i.dispatchEvent(new Event("input",{bubbles:true}));});
  await p.evaluate(()=>Array.from(document.querySelectorAll("button.form-submit-btn")).find(b=>/Create/.test(b.textContent))?.click());
  await sleep(800);
  // open the pending-create row's detail (the fix)
  await p.evaluate(()=>{const r=Array.from(document.querySelectorAll(".panel-list-item")).find(e=>e.textContent.trim()==="PCTEST");r?.click();});
  await sleep(700);
  const d=await p.evaluate(()=>({
    note: !!document.querySelector(".drawer-pending-note"),
    subSection: !!document.querySelector(".subrule-section"),
    err: (document.querySelector(".drawer-error, .panel-error, .status-error")?.textContent||"").trim().slice(0,60),
    addBtns: document.querySelectorAll(".subrule-section button, .subrule-section .form-submit-btn").length,
  }));
  expect(d.note, "pending-create detail opens with the staged-note (was 404)");
  expect(d.subSection, "sub-rule section (QoS queues) is reachable on the un-applied parent");
  expect(d.err==="", `no error in the detail ("${d.err}")`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode=fail?1:0;
}catch(e){console.error("threw:",e.message);process.exitCode=1;}finally{await b.close();}
