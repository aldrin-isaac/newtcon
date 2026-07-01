import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";
const BASE="http://127.0.0.1:8095", NET="1node-vs";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const expect=(c,m)=>{c?(pass++,console.log("  ok:",m)):(fail++,console.error("  FAIL:",m));};
const b=await puppeteer.launch({executablePath:"/usr/bin/google-chrome",headless:"new",args:["--no-sandbox","--disable-dev-shm-usage"],defaultViewport:{width:1500,height:950}});
try{
  const p=await b.newPage();
  await authenticatePage(p);
  await p.evaluateOnNewDocument(n=>{try{localStorage.setItem("newtcon.activeNetwork",n);}catch{}},NET);
  await p.goto(BASE,{waitUntil:"networkidle0",timeout:20000});
  await p.click("#tab-specs"); await p.waitForSelector('[data-kind="qos-policies"]',{timeout:8000});
  await p.click('[data-kind="qos-policies"]'); await p.waitForSelector(".panel-add-btn",{timeout:6000});
  const stageCreate=async(name)=>{
    await p.evaluate(()=>document.querySelector(".panel-add-btn")?.click());
    await p.waitForSelector('input[name="name"]',{timeout:6000});
    await p.evaluate(nm=>{const i=document.querySelector('input[name="name"]');i.value=nm;i.dispatchEvent(new Event("input",{bubbles:true}));},name);
    await p.evaluate(()=>Array.from(document.querySelectorAll("button.form-submit-btn")).find(b=>/Create/.test(b.textContent))?.click());
    await sleep(500);
  };
  await stageCreate("OKQOS");   // new → will succeed
  await stageCreate("DUPQOS");  // exists on server → 409 at apply
  // Save → apply-preview
  await p.evaluate(()=>document.getElementById("pending-bar-save")?.click());
  await p.waitForSelector(".apply-preview-card",{timeout:8000}); await sleep(300);
  expect(await p.evaluate(()=>!!document.querySelector(".apply-preview-url")), "Q2: preview shows the API URL line");
  const urlTxt=await p.evaluate(()=>document.querySelector(".apply-preview-url")?.textContent||"");
  console.log("  sample url:", urlTxt);
  // confirm Apply
  await p.evaluate(()=>Array.from(document.querySelectorAll(".apply-preview-card .btn-primary")).find(x=>/Apply/.test(x.textContent))?.click());
  // results modal
  await p.waitForFunction(()=>{const t=document.querySelector(".apply-preview-title")?.textContent||"";return /Applied 1 · Failed 1/.test(t);},{timeout:8000});
  expect(true,"Q1: results modal shows 'Applied 1 · Failed 1'");
  const r=await p.evaluate(()=>({ok:!!document.querySelector(".apply-result-section--ok"),failSec:!!document.querySelector(".apply-result-section--fail"),err:(document.querySelector(".apply-result-error")?.textContent||"").slice(0,60)}));
  expect(r.ok,"has Applied section"); expect(r.failSec,"has Failed section"); expect(r.err!=="",`failed item shows error ("${r.err}")`);
  console.log(`\n${pass} passed, ${fail} failed`); process.exitCode=fail?1:0;
}catch(e){console.error("threw:",e.message);process.exitCode=1;}finally{await b.close();}
