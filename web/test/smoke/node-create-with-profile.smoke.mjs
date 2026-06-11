// Headless smoke for the Create-node flow on the Topology tab.
//
// Verifies:
//   1. Toolbar button is labelled "+ Create node" (renamed from "+ Add device")
//   2. Right-clicking the empty topology canvas pops a context menu with
//      "Create node"
//   3. Clicking either affordance opens a drawer with the full profile-fields
//      form: name, mgmt_ip, loopback_ip, zone (dropdown), platform (dropdown),
//      ssh_user
//   4. The drawer's submit doesn't fire if required fields are missing
//
// The smoke does NOT exercise actual Save (would mutate operator state); it
// asserts the wire-level structure of the form.

import puppeteer from "puppeteer-core";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate(() => localStorage.setItem("newtcon.activeNetwork", "2node-vs"));
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.click("#tab-topology");
  await new Promise((r) => setTimeout(r, 1500));

  // ── 1. Toolbar button label ────────────────────────────────────────────
  const btnLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".topology-toolbar-btn")).map((b) => b.textContent.trim()));
  expect(btnLabels.includes("+ Create node"),
    `toolbar has "+ Create node" button: ${JSON.stringify(btnLabels)}`);
  expect(!btnLabels.includes("+ Add device"),
    `legacy "+ Add device" label is gone: ${JSON.stringify(btnLabels)}`);

  // ── 2. Right-click on canvas background → context menu ────────────────
  await page.evaluate(() => {
    const slot = document.querySelector(".topology-graph-slot");
    if (!slot) return;
    const rect = slot.getBoundingClientRect();
    // Click in the bottom-right corner where there's likely empty space.
    slot.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: rect.right - 30,
      clientY: rect.bottom - 30,
    }));
  });
  await new Promise((r) => setTimeout(r, 300));

  const canvasMenu = await page.evaluate(() => {
    const m = document.querySelector(".topo-menu--canvas");
    if (!m) return null;
    const items = Array.from(m.querySelectorAll(".topo-menu-item-label")).map((el) => el.textContent.trim());
    return { items };
  });
  expect(canvasMenu !== null, "right-click on canvas background pops .topo-menu--canvas");
  expect(canvasMenu?.items?.includes("Create node"),
    `canvas menu has "Create node" item: ${JSON.stringify(canvasMenu?.items)}`);

  await page.screenshot({ path: "/tmp/newtcon-smoke-create-node-01-canvas-menu.png" });

  // ── 3. Click "Create node" → drawer opens with full profile fields ─────
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".topo-menu--canvas .topo-menu-item"));
    const create = items.find((b) => b.textContent.includes("Create node"));
    if (create instanceof HTMLElement) create.click();
  });
  await new Promise((r) => setTimeout(r, 400));

  const drawerFields = await page.evaluate(() => {
    const drawer = document.getElementById("detail-drawer");
    if (!drawer || drawer.getAttribute("aria-hidden") !== "false") return null;
    const inputs = Array.from(drawer.querySelectorAll("input[name], select[name]"));
    return inputs.map((i) => ({ name: i.getAttribute("name"), tag: i.tagName.toLowerCase(), required: i.hasAttribute("required") }));
  });
  expect(drawerFields !== null, "Create-node drawer opens");

  // Required-field presence. buildFormFields sets the HTML5 `required`
  // attribute on inputs but not on selects (validation is enforced in the
  // submit handler for selects — covered by step 4 below).
  const required = ["name", "mgmt_ip", "loopback_ip", "zone"];
  for (const r of required) {
    const f = drawerFields?.find((d) => d.name === r);
    expect(!!f, `required field "${r}" present: ${JSON.stringify(f)}`);
    if (f && f.tag === "input") {
      expect(f.required, `input "${r}" marked required: ${JSON.stringify(f)}`);
    }
  }
  const optionals = ["platform", "ssh_user"];
  for (const o of optionals) {
    const f = drawerFields?.find((d) => d.name === o);
    expect(!!f, `optional field "${o}" present: ${JSON.stringify(f)}`);
  }
  const zoneField = drawerFields?.find((d) => d.name === "zone");
  expect(zoneField?.tag === "select", `zone is a dropdown: ${JSON.stringify(zoneField)}`);
  const platformField = drawerFields?.find((d) => d.name === "platform");
  expect(platformField?.tag === "select", `platform is a dropdown: ${JSON.stringify(platformField)}`);

  await page.screenshot({ path: "/tmp/newtcon-smoke-create-node-02-drawer.png" });

  // ── 4. Submit with empty form surfaces a validation error ──────────────
  await page.evaluate(() => {
    const btn = document.querySelector(".form-submit-btn");
    if (btn instanceof HTMLButtonElement) btn.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const errorVisible = await page.evaluate(() => {
    const e = document.querySelector(".form-error-out .panel-error");
    return e?.textContent?.trim() ?? null;
  });
  expect(errorVisible && /required/i.test(errorVisible),
    `empty-submit shows validation error: "${errorVisible}"`);

  console.log("");
  if (failed.length === 0) console.log("✅ all checks passed");
  else { console.log(`❌ ${failed.length} failed`); process.exitCode = 1; }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
