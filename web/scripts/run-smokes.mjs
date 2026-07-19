#!/usr/bin/env node
// run-smokes.mjs — one-command smoke suite (console-uplift 0.1, issue #382).
//
//   npm run smoke                    # all smokes, alphabetical
//   npm run smoke -- --filter iface  # only smokes whose filename matches
//
// Runs every web/test/smoke/*.smoke.mjs sequentially in a child process
// (smokes call process.exit, so they must not share this process), classifies
// each as PASS / FAIL / SKIP, prints a summary, and exits non-zero if any
// failed. SKIP is a smoke that exited 0 after printing a "SKIP:" line
// (skipIfNotDeployed) — expected when the target network isn't deployed.
//
// Environment is passed through untouched (NEWTCON_URL, NEWTCON_TEST_USER/
// PASS, CHROME_BIN, NET/DEVICE/... — see docs/smoke-suite.md). One
// convenience: when NEWTCON_URL is https:// and NODE_TLS_REJECT_UNAUTHORIZED
// is unset, it is set to "0" for the children — the smokes' Node-side fetch()
// calls must tolerate the dev server's self-signed cert, exactly like the
// in-browser --ignore-certificate-errors flag every smoke already carries.
// Per-smoke wall-clock cap: SMOKE_TIMEOUT_MS (default 180000).

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const smokeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/smoke");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS) || 180_000;

const filterIdx = process.argv.indexOf("--filter");
const filter = filterIdx >= 0 ? process.argv[filterIdx + 1] ?? "" : "";

const files = readdirSync(smokeDir)
  .filter((f) => f.endsWith(".smoke.mjs"))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(filter ? `no smokes match --filter ${filter}` : "no smokes found");
  process.exit(2);
}

const env = { ...process.env };
const base = env.NEWTCON_URL || "http://127.0.0.1:8095";
if (base.startsWith("https://") && env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
  env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

console.log(`running ${files.length} smoke${files.length === 1 ? "" : "s"} against ${base}\n`);

// Warm-up: the suite's FIRST Chrome launch pays a cold-start cost (profile
// creation, cold page cache) that on a loaded lab host can eat the first
// smoke's whole wait budget. Launch a throwaway browser and load the app once
// so smoke #1 starts warm. Best-effort — a warm-up failure is not a verdict.
try {
  const { default: puppeteer } = await import("puppeteer-core");
  const b = await puppeteer.launch({
    executablePath: env.CHROME_BIN || "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
    ignoreHTTPSErrors: true,
  });
  const p = await b.newPage();
  await p.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  await b.close();
  console.log("  (warm-up done)\n");
} catch { /* warm-up is optional */ }

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(smokeDir, file)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const killer = setTimeout(() => {
      out += `\n[runner] timed out after ${timeoutMs}ms — killed\n`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(killer);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const skipped = code === 0 && /^SKIP:/m.test(out);
      resolve({ file, code, secs, out, verdict: code === 0 ? (skipped ? "skip" : "pass") : "fail" });
    });
  });
}

const results = [];
for (const file of files) {
  const r = await runOne(file);
  results.push(r);
  const name = file.replace(/\.smoke\.mjs$/, "");
  if (r.verdict === "pass") console.log(`  ✓ ${name} (${r.secs}s)`);
  else if (r.verdict === "skip") console.log(`  - ${name} SKIPPED (${r.secs}s)`);
  else {
    console.log(`  ✗ ${name} FAILED exit=${r.code} (${r.secs}s)`);
    const tail = r.out.trimEnd().split("\n").slice(-15);
    for (const line of tail) console.log(`      ${line}`);
  }
}

const pass = results.filter((r) => r.verdict === "pass").length;
const fail = results.filter((r) => r.verdict === "fail").length;
const skip = results.filter((r) => r.verdict === "skip").length;
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
