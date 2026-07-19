#!/usr/bin/env node
// ratchet.mjs — consolidation ratchets (console-uplift 0.3, issue #384).
//
// Runs first in `npm test`. Computes the program's accountability metrics
// (docs/console-uplift-plan.md §Metrics) and fails if any EXCEEDS its
// ceiling in ratchet-ceilings.json. Ceilings are edited DOWNWARD ONLY, by
// the slice that earns the reduction — that codifies "always leave it
// better than you found it": the numbers can't quietly grow back.
//
//   app_ts_lines          web/src/app.ts line count        (target ≤ 800)
//   chip_families         distinct `.*-chip` class families across all
//                         web/src CSS                      (target 1)
//   raw_colors_workspace  raw hex / rgb() occurrences in workspace.css —
//                         includes var() fallbacks, which duplicate token
//                         values and go away in Phase 3.1  (target 0)
//
// Being UNDER a ceiling prints a tighten-me nudge but passes — lowering is
// the responsibility (and the credit) of the slice that did the work.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ceilings = JSON.parse(readFileSync(path.join(webRoot, "ratchet-ceilings.json"), "utf8"));

function cssFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (e.endsWith(".css")) out.push(p);
  }
  return out;
}

const metrics = {
  // Newline count = `wc -l` semantics (no trailing-newline off-by-one).
  app_ts_lines: (readFileSync(path.join(webRoot, "src/app.ts"), "utf8").match(/\n/g) ?? []).length,
  chip_families: new Set(
    cssFiles(path.join(webRoot, "src"))
      .flatMap((f) => readFileSync(f, "utf8").match(/\.[a-z][a-z0-9-]*-chip(?![a-z0-9-])/g) ?? [])
      .map((m) => m.slice(1)),
  ).size,
  raw_colors_workspace:
    (readFileSync(path.join(webRoot, "src/workspace.css"), "utf8")
      .match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).length,
};

let failed = false;
for (const [name, value] of Object.entries(metrics)) {
  const ceiling = ceilings[name];
  if (ceiling === undefined) { console.error(`ratchet: no ceiling for ${name}`); failed = true; continue; }
  if (value > ceiling) {
    console.error(`ratchet FAIL: ${name} = ${value} > ceiling ${ceiling} — this metric only goes down (docs/console-uplift-plan.md)`);
    failed = true;
  } else if (value < ceiling) {
    console.log(`ratchet: ${name} = ${value} (ceiling ${ceiling} — tighten it in ratchet-ceilings.json to bank the win)`);
  } else {
    console.log(`ratchet: ${name} = ${value} (at ceiling)`);
  }
}
process.exit(failed ? 1 : 0);
