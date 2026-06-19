// End-to-end smoke: drive a real action through the panel and verify it
// landed in newtron.

import puppeteer from "puppeteer-core";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const NEWTRON = process.env.NEWTRON_URL || "http://127.0.0.1:18080";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const failed = [];
const expect = (cond, msg) => {
  if (!cond) { failed.push(msg); console.error("FAIL:", msg); }
  else { console.log("  ok:", msg); }
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});

try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    // Inline confirm modal auto-accept; replaces native-dialog handler.
    const install = () => new MutationObserver(() => {
      const btn = document.querySelector(".confirm-modal-btn--confirm");
      if (btn instanceof HTMLElement) btn.click();
    }).observe(document.body, { childList: true, subtree: true });
    if (document.readyState === "loading") {
      addEventListener("DOMContentLoaded", install);
    } else {
      install();
    }
  });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  console.log(`→ open ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 8000 });

  // Pick a free VLAN ID (avoid collisions across re-runs).
  const vlanID = 3000 + Math.floor(Math.random() * 800);
  console.log(`→ will create VLAN ${vlanID} via the panel`);

  // Select switch1 (first device).
  await page.evaluate(() => {
    document.querySelector(".topo-node").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));

  // Open VLANs group.
  await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll(".topo-action-group"));
    groups.find((g) => /VLAN/.test(g.querySelector(".topo-action-group-summary")?.textContent ?? ""))?.setAttribute("open", "");
  });
  await new Promise((r) => setTimeout(r, 50));

  // Click Create VLAN.
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".topo-action-item-label"));
    items.find((it) => it.textContent.trim() === "Create VLAN")?.closest("button")?.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: "/tmp/newtcon-smoke-e01-form.png" });

  // Fill in VLAN ID + Apply.
  await page.evaluate((id) => {
    const numInput = document.querySelector(".topo-inline-form input[type=number]");
    if (numInput) { numInput.value = String(id); numInput.dispatchEvent(new Event("input", { bubbles: true })); }
  }, vlanID);
  await page.evaluate(() => {
    document.querySelector(".topo-inline-form button[type=submit]")?.click();
  });

  // Wait for the panel to re-render (mountTopologyTab) after success.
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: "/tmp/newtcon-smoke-e02-after.png" });

  // Verify via newtron API that the VLAN was actually created.
  const resp = await fetch(`${NEWTRON}/newtron/v1/network/default/node/switch1/vlan/${vlanID}`);
  expect(resp.ok || resp.status === 404, `vlan endpoint reachable (${resp.status})`);
  if (resp.ok) {
    const body = await resp.json();
    expect(!!body, `newtron reports VLAN ${vlanID} exists (body=${JSON.stringify(body).slice(0, 80)})`);
    console.log(`  ✓ VLAN ${vlanID} created end-to-end`);
  } else {
    failed.push(`newtron returned ${resp.status} when checking VLAN ${vlanID}`);
  }

  // Now delete it via the panel — verify delete-vlan autofills the dropdown.
  console.log(`→ delete VLAN ${vlanID} via the panel`);
  await page.evaluate(() => {
    document.querySelector(".topo-node").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll(".topo-action-group"));
    groups.find((g) => /VLAN/.test(g.querySelector(".topo-action-group-summary")?.textContent ?? ""))?.setAttribute("open", "");
  });
  await new Promise((r) => setTimeout(r, 50));
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".topo-action-item-label"));
    items.find((it) => it.textContent.trim() === "Delete VLAN")?.closest("button")?.click();
  });
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: "/tmp/newtcon-smoke-e03-delete-form.png" });

  // Delete-VLAN's VLAN ID field should be a dropdown of existing VLANs.
  const deleteFieldKind = await page.evaluate(() => {
    const sel = document.querySelector(".topo-inline-form select");
    if (sel) return { kind: "select", options: Array.from(sel.options).map((o) => o.value) };
    const inp = document.querySelector(".topo-inline-form input");
    if (inp) return { kind: "input" };
    return { kind: "none" };
  });
  expect(deleteFieldKind.kind === "select",
    `Delete VLAN's VLAN ID is an autofilled dropdown (got ${deleteFieldKind.kind})`);
  if (deleteFieldKind.kind === "select") {
    expect(deleteFieldKind.options.includes(String(vlanID)),
      `dropdown includes the VLAN we just created (${vlanID})`);
  }

  console.log("");
  if (failed.length === 0) console.log("✅ end-to-end smoke passed");
  else {
    console.log(`❌ ${failed.length} check(s) failed:`);
    for (const f of failed) console.log("  -", f);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
