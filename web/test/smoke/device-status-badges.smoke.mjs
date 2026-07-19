// Headless smoke for phase 2 of the unified-substrate direction:
// per-device status badges on the Topology SVG.
//
// Verifies that mounting the Topology tab against the live newtron + newtlab
// stack produces device <g> elements with substrate-agnostic state classes
// (topo-node--running / --booting / --down / --unrealized) and matching
// status dot color classes (topo-status-dot--…).

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

const VALID_STATES = ["running", "booting", "provisioning", "unreachable", "down", "unrealized"];   // status dot (lifecycle)
const PALETTE_STATES = ["spec-only", "actuated-ok", "actuated-down", "drift", "unknown"]; // <g> topo-elem (palette, #210)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true,
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
await authenticatePage(page, BASE);
try {
  // Seed active network = a real registered one.
  await gotoApp(page, BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate(() => localStorage.setItem("newtcon.activeNetwork", "2node-vs"));

  // Track newtlab status polls so we can verify the 5s poll fires.
  const labStatusCalls = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/labs/") && req.url().endsWith("/status")) {
      labStatusCalls.push(Date.now());
    }
  });

  console.log(`→ reload ${BASE} with active network "2node-vs"`);
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.click("#tab-topology");
  await new Promise((r) => setTimeout(r, 1500));

  await page.screenshot({ path: "/tmp/newtcon-smoke-status-01-topology.png" });

  // 1. SVG renders + has at least one device node.
  const deviceCount = await page.evaluate(() =>
    document.querySelectorAll("svg.topology-graph g.topo-node[data-device]").length);
  expect(deviceCount > 0, `topology SVG has ≥1 device node (got ${deviceCount})`);

  // 2. Every device <g> has a state class from the unified set.
  const states = await page.evaluate(
    (validStates) => {
      const out = [];
      for (const g of document.querySelectorAll("svg.topology-graph g.topo-node[data-device]")) {
        const found = validStates.find((s) => g.classList.contains(`topo-elem--${s}`));
        out.push({ device: g.getAttribute("data-device"), state: found ?? null });
      }
      return out;
    },
    PALETTE_STATES,
  );
  const allClassed = states.every((s) => s.state !== null);
  expect(allClassed, `every device <g> has a unified state class: ${JSON.stringify(states)}`);

  // 3. Every device has a status badge dot with a matching state-color class.
  const dots = await page.evaluate(
    (validStates) => {
      const out = [];
      for (const g of document.querySelectorAll("svg.topology-graph g.topo-node[data-device]")) {
        const dot = g.querySelector("circle.topo-status-dot");
        const dotState = dot
          ? validStates.find((s) => dot.classList.contains(`topo-status-dot--${s}`)) ?? null
          : null;
        out.push({ device: g.getAttribute("data-device"), dotState });
      }
      return out;
    },
    VALID_STATES,
  );
  const allDots = dots.every((d) => d.dotState !== null);
  expect(allDots, `every device has a status-dot with a state-color class: ${JSON.stringify(dots)}`);

  // 4. The badge tooltip surfaces substrate detail (lab vm / probe / etc.).
  const tooltips = await page.evaluate(() => {
    const out = [];
    for (const g of document.querySelectorAll("svg.topology-graph g.topo-node[data-device]")) {
      const title = g.querySelector("g.topo-status-badge > title");
      out.push({
        device: g.getAttribute("data-device"),
        tooltip: title?.textContent ?? null,
      });
    }
    return out;
  });
  const allTooltips = tooltips.every((t) => typeof t.tooltip === "string" && t.tooltip.includes(t.device));
  expect(allTooltips,
    `every status badge has a tooltip containing the device name: ${JSON.stringify(tooltips)}`);

  // (Post-#210 the <g> palette state (spec-only / actuated-*) and the dot
  // lifecycle state (running / booting / …) are intentionally separate systems,
  // so they are no longer expected to be equal — #2 and #3 assert each is
  // well-formed on its own.)

  // 6. The 5s status poll fires. Wait a bit past the first interval and check
  // we observed ≥1 lab-status request after the initial mount call. The
  // initial mountTopologyTab also calls fetchLabStatus, so the floor is 2.
  const initialCount = labStatusCalls.length;
  await new Promise((r) => setTimeout(r, 6000));
  const afterCount = labStatusCalls.length;
  expect(afterCount > initialCount,
    `5s poll fired (status calls: ${initialCount} → ${afterCount})`);

  // 7. Switching away from Topology stops the poll.
  await page.click("#tab-specs");
  await new Promise((r) => setTimeout(r, 200));
  const beforePauseCount = labStatusCalls.length;
  await new Promise((r) => setTimeout(r, 6000));
  const afterPauseCount = labStatusCalls.length;
  expect(afterPauseCount === beforePauseCount,
    `poll halted when leaving Topology tab (status calls before/after 6s pause: ${beforePauseCount}/${afterPauseCount})`);

  console.log("");
  if (failed.length === 0) console.log("✅ all checks passed");
  else { console.log(`❌ ${failed.length} failed`); process.exitCode = 1; }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
