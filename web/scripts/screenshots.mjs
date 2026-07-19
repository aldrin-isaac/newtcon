#!/usr/bin/env node
// screenshots.mjs — visual baseline capture + compare (console-uplift 0.2,
// issue #383).
//
//   node scripts/screenshots.mjs                 # capture the baseline set
//   node scripts/screenshots.mjs --compare       # capture "current" + build
//                                                #   a side-by-side review page
//   node scripts/screenshots.mjs --filter drawer # subset by capture id
//
// Captures the canonical view set to web/test/visual-baseline/ (gitignored —
// baselines are per-host review artifacts, not repo content):
//
//   baseline/<id>.png            the reference set (plain run)
//   current/<id>.png             the comparison set (--compare)
//   compare.html                 side-by-side review page (--compare)
//
// The visual phases of docs/console-uplift-plan.md use this to prove
// "zero behavior change" (Phase 1 extractions compare ≈ baseline) and to
// review deliberate visual change (Phases 3-4) as images, not prose.
//
// Environment: NEWTCON_URL / NEWTCON_TEST_USER / NEWTCON_TEST_PASS /
// CHROME_BIN / NET — same as the smoke suite (docs/smoke-suite.md). Default
// NET is smoke-fixture: stable, un-deployed, so captures don't churn with
// live counters. Captures are best-effort: one failed view is reported and
// skipped, the rest still land.

import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "../test/smoke/_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEVICE = process.env.DEVICE || "switch1";
// THEME=light|dark|both (default both since Phase 3.2: the console has two
// first-class themes; dark captures get a "--dark" id suffix).
const THEME = process.env.THEME || "both";
const THEMES = THEME === "both" ? ["light", "dark"] : [THEME];

const outRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/visual-baseline");
const compareMode = process.argv.includes("--compare");
const filterIdx = process.argv.indexOf("--filter");
const filter = filterIdx >= 0 ? process.argv[filterIdx + 1] ?? "" : "";
const outDir = path.join(outRoot, compareMode ? "current" : "baseline");
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared navigation helpers used by several captures.
async function openTopology(page) {
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node, .topology-empty-state", { timeout: 60000 }).catch(() => {});
  await sleep(800);
}
async function openDrawerTab(page, tab) {
  await openTopology(page);
  await page.evaluate((d) => {
    const t = [...document.querySelectorAll("svg text")].find((e) => e.textContent.trim() === d);
    if (t) (t.closest("g") || t).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, DEVICE);
  await sleep(900);
  await page.evaluate((name) => {
    const b = [...document.querySelectorAll("button.node-tab, .drawer-tab, [role=tab]")].find((e) => e.textContent.trim() === name);
    if (b) b.click();
  }, tab);
  await sleep(1200);
}

// The canonical set. Each capture navigates from a fresh app load.
const CAPTURES = [
  { id: "specs", run: async (page) => {
    await page.click("#tab-specs");
    await page.waitForSelector('[data-kind="services"]', { timeout: 60000 });
    await sleep(500);
  } },
  { id: "specs-permissions", run: async (page) => {
    await page.click("#tab-specs");
    await page.waitForSelector(".specs-subnav-item", { timeout: 60000 });
    await page.evaluate(() => [...document.querySelectorAll(".specs-subnav-item")]
      .find((b) => b.textContent.trim().startsWith("Permissions"))?.click());
    await sleep(1000);
  } },
  { id: "topology-spec", run: async (page) => {
    await openTopology(page);
    await page.evaluate(() => [...document.querySelectorAll(".topology-view-chip")]
      .find((c) => c.textContent.trim() === "Spec")?.click());
    await sleep(800);
  } },
  { id: "topology-lab", run: async (page) => {
    await openTopology(page);
    await page.evaluate(() => [...document.querySelectorAll(".topology-view-chip")]
      .find((c) => c.textContent.trim() === "Lab")?.click());
    await sleep(800);
  } },
  { id: "drawer-interfaces", run: (page) => openDrawerTab(page, "Interfaces") },
  { id: "drawer-state", run: (page) => openDrawerTab(page, "State") },
  { id: "drawer-spec", run: (page) => openDrawerTab(page, "Spec") },
  { id: "apply-modal", run: async (page) => {
    // Stage one harmless spec create, open the confirm modal, shoot, then
    // cancel + discard so nothing persists past the capture.
    await page.click("#tab-specs");
    await page.waitForSelector('[data-kind="qos-policies"]', { timeout: 60000 });
    await page.click('[data-kind="qos-policies"]');
    await page.waitForSelector(".panel-add-btn", { timeout: 20000 });
    await page.evaluate(() => document.querySelector(".panel-add-btn")?.click());
    await page.waitForSelector('input[name="name"]', { timeout: 20000 });
    await page.evaluate(() => {
      const i = document.querySelector('input[name="name"]');
      i.value = "VISBASELINE"; i.dispatchEvent(new Event("input", { bubbles: true }));
      [...document.querySelectorAll("button.form-submit-btn")].find((b) => /Create/.test(b.textContent))?.click();
    });
    await sleep(500);
    await page.evaluate(() => document.getElementById("pending-bar-save")?.click());
    await page.waitForSelector(".apply-preview-card", { timeout: 20000 });
    await sleep(500);
  }, cleanup: async (page) => {
    await page.evaluate(() => [...document.querySelectorAll(".apply-preview-foot button")]
      .find((b) => /Cancel/.test(b.textContent))?.click());
    await sleep(300);
    await page.evaluate(() => {
      const d = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Discard");
      if (d) d.click();
    });
    await sleep(400);
    await page.evaluate(() => document.querySelector(".confirm-modal-btn--confirm")?.click());
    await sleep(300);
  } },
  { id: "audit", run: async (page) => {
    await page.click("#tab-audit");
    await sleep(1500);
  } },
];

const targets = CAPTURES.filter((c) => !filter || c.id.includes(filter))
  .flatMap((c) => THEMES.map((theme) => ({ ...c, theme, id: theme === "dark" ? `${c.id}--dark` : c.id })));
console.log(`${compareMode ? "compare" : "baseline"} capture: ${targets.length} view${targets.length === 1 ? "" : "s"} (themes: ${THEMES.join("+")}) → ${outDir}\n`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors", "--force-device-scale-factor=1"],
  ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 1000 },
});
const results = [];
try {
  for (const cap of targets) {
    const page = await browser.newPage();
    try {
      await authenticatePage(page, BASE);
      await page.evaluateOnNewDocument((n, t) => { try { localStorage.setItem("newtcon.activeNetwork", n); localStorage.setItem("newtcon.theme", t); } catch { /* */ } }, NET, cap.theme);
      await gotoApp(page, BASE);
      await cap.run(page);
      const file = path.join(outDir, `${cap.id}.png`);
      await page.screenshot({ path: file });
      if (cap.cleanup) await cap.cleanup(page).catch(() => {});
      results.push({ id: cap.id, ok: true });
      console.log(`  ✓ ${cap.id}`);
    } catch (e) {
      results.push({ id: cap.id, ok: false, err: e.message });
      console.log(`  ✗ ${cap.id} — ${e.message.split("\n")[0]}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}

if (compareMode) {
  const rows = targets.map((cap) => {
    const b = path.join(outRoot, "baseline", `${cap.id}.png`);
    const c = path.join(outRoot, "current", `${cap.id}.png`);
    const bOk = existsSync(b), cOk = existsSync(c);
    const delta = bOk && cOk ? Math.abs(statSync(b).size - statSync(c).size) : null;
    const note = !bOk ? "no baseline" : !cOk ? "no current capture" :
      delta === 0 ? "byte-identical" : `size Δ ${delta} bytes — eyeball below`;
    return `
    <section>
      <h2>${cap.id} <small>${note}</small></h2>
      <div class="pair">
        <figure><figcaption>baseline</figcaption>${bOk ? `<img src="baseline/${cap.id}.png">` : "<p>—</p>"}</figure>
        <figure><figcaption>current</figcaption>${cOk ? `<img src="current/${cap.id}.png">` : "<p>—</p>"}</figure>
      </div>
    </section>`;
  }).join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>newtcon visual compare</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #f5f5f0; }
  h2 { border-top: 2px solid #d6d3cc; padding-top: 1rem; } h2 small { color: #8a857f; font-weight: normal; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  figure { margin: 0; } figcaption { font-size: .8rem; color: #57534e; margin-bottom: .25rem; }
  img { width: 100%; border: 1px solid #d6d3cc; }
</style>
<h1>newtcon visual compare</h1>
<p>Baseline vs current. Byte-size deltas are a hint, not a verdict — review by eye.</p>
${rows}`;
  writeFileSync(path.join(outRoot, "compare.html"), html);
  console.log(`\ncompare page: ${path.join(outRoot, "compare.html")}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} captured, ${failed} failed`);
process.exit(failed ? 1 : 0);
