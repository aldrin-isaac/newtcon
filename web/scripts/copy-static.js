// copy-static.js — copies *.html, *.css, *.woff2 (+ font licenses) from web/src/ into web/dist/,
// preserving subdirectory structure.
//
// This script is the post-tsc step in the build pipeline defined by
// docs/adr/0002-frontend-framework.md §Implementation notes. It runs after
// `tsc --project tsconfig.json` has produced ES modules under web/dist/ and
// copies the static assets that tsc does not emit.
//
// Usage (via npm run build):
//   node scripts/copy-static.js
//
// Requires Node.js 16+ (uses fs.cpSync introduced in v16.7.0; project targets
// Node v22 per the checked-in .nvmrc).

import { readdirSync, statSync, mkdirSync, copyFileSync } from "fs";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "src");
const distDir = join(__dirname, "..", "dist");

const STATIC_EXTENSIONS = new Set([".html", ".css", ".woff2", ".txt"]);

/**
 * Walks srcDir recursively and copies any file whose extension is in
 * STATIC_EXTENSIONS into the mirrored path under distDir, creating
 * intermediate directories as needed.
 *
 * @param {string} dir - Absolute path to the directory being walked.
 */
function copyStaticFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const srcPath = join(dir, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyStaticFiles(srcPath);
    } else {
      const ext = entry.slice(entry.lastIndexOf("."));
      if (STATIC_EXTENSIONS.has(ext)) {
        const rel = relative(srcDir, srcPath);
        const destPath = join(distDir, rel);
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(srcPath, destPath);
        console.log(`copied  ${rel}`);
      }
    }
  }
}

copyStaticFiles(srcDir);
console.log("copy-static: done");
