// views/specs/ssh-login.ts — the scoped "SSH Login" control, rendered as the
// General → SSH Login facet of the Specs view.
//
// It's the scalar mirror of the ip-vpn override affordance: ssh_user +
// masked ssh_pass authored at network / zone / node scope, reusing the
// schema-form scope machinery and the ${secret:} store flow.

import { fetchSpecDetail } from "../../api/newtcon/network.js";
import { fetchSchema } from "../../api/newtcon/schema.js";
import { setSecret } from "../../api/newtcon/secrets.js";
import { showSSHCredentials } from "../../api/newtcon/ssh-credentials.js";
import { confirmInline } from "../../confirm-inline.js";
import { el } from "../../dom.js";
import { activeNetwork } from "../../network-switcher.js";
import { engineOpErrorBody, formatErrorBrief } from "../../render-error.js";
import { renderSchemaForm } from "../../schema-form.js";
import { isSecretReference, secretReference } from "../../secret-field.js";
import { enqueueSSHLoginClear, enqueueSSHLoginSet } from "../../staging.js";
import { showToast } from "../../toast.js";

// renderSSHLoginInto — the scoped "SSH Login" control (the scalar mirror of the
// ip-vpn override affordance). Sets ssh_user + masked ssh_pass at network / zone /
// node scope via newtron's set/clear-ssh-credentials, reusing the schema-form scope
// machinery and the ${secret:} store flow. The network-floor invariant is enforced
// upstream (400 override-without-base / 409 clear-base-with-overrides), surfaced
// verbatim. Rendered inline as the "SSH Login" facet under the Specs → General group
// (it's a spec, not a topology action). Re-renders itself after set/clear to refresh
// context.
export async function renderSSHLoginInto(content: HTMLElement): Promise<void> {
  const network = activeNetwork();
  // Build into a DETACHED panel and swap it in atomically at the end. This facet
  // re-renders on every pending-queue change (subscribePending), and the build
  // awaits (fetchSchema / renderSchemaForm) — so two overlapping renders (open +
  // a staging notify) would each clear-then-append and stack DUPLICATE forms.
  // Replacing content in one shot at the end makes concurrent renders last-wins.
  const panel = document.createElement("div");
  panel.appendChild(el("h2", { className: "spec-panel-title" }, "SSH Login"));
  panel.appendChild(el("p", { className: "node-spec-intro" },
    "The login newtron uses to reach devices — resolved node > zone > network > platform > \"admin\". Set it once at network scope; override at zone/node for exceptions."));

  let schema;
  try {
    schema = await fetchSchema("SSHCredentials");
  } catch (err) {
    content.replaceChildren(el("p", { className: "panel-error" }, `SSH-login schema unavailable: ${formatErrorBrief(err)}`));
    return;
  }

  const { form, getValues, validate } = await renderSchemaForm({ schema });
  panel.appendChild(form);

  // Scope-aware context: pre-fill the login AUTHORED at the selected scope, and for
  // a chosen node also show the EFFECTIVE (resolved) login it dials with. Reaches
  // into the rendered inputs by name and re-reads whenever scope/instance changes.
  const scopeSel = form.querySelector<HTMLSelectElement>('[name="scope"]');
  const instSel = form.querySelector<HTMLSelectElement>('[name="scope_instance"]');
  const userInput = form.querySelector<HTMLInputElement>('[name="ssh_user"]');
  const passInput = form.querySelector<HTMLInputElement>('[name="ssh_pass"]');
  const ctxBox = el("div", { className: "ssh-login-context" });
  panel.appendChild(ctxBox);
  const refreshContext = async (): Promise<void> => {
    const scope = scopeSel?.value || "network";
    const instance = instSel?.value || "";
    if (scope !== "network" && !instance) { ctxBox.textContent = ""; return; }
    try {
      const authored = await showSSHCredentials(network, scope, instance || undefined);
      // Pre-fill ssh_user from what's authored at this scope (blank when it inherits);
      // never prefill the masked password — reflect its set/inherit state in the hint.
      if (userInput) userInput.value = authored.ssh_user || "";
      if (passInput) passInput.placeholder = authored.ssh_pass
        ? (isSecretReference(authored.ssh_pass) ? "•••••• set — type to replace" : "•••••• set")
        : "leave blank to inherit";
      ctxBox.textContent = "";
      const has = authored.ssh_user || authored.ssh_pass;
      ctxBox.appendChild(el("p", { className: "lifecycle-hint" },
        `Authored at ${scope}${instance ? " " + instance : ""}: ` +
        (has ? `user ${authored.ssh_user || "(none)"}, password ${authored.ssh_pass ? "set" : "(none)"}`
             : "nothing — inherits from the next scope up")));
      if (scope === "node" && instance) {
        void fetchSpecDetail("nodes", instance).then((node) => {
          // Show only the resolved USER (fine to display). NOT the password —
          // GET /nodes/{name} returns ssh_pass in the clear (newtlab dials with
          // it); the password state is shown above from the masked authored read.
          const n = node as { ssh_user?: string };
          ctxBox.appendChild(el("p", { className: "lifecycle-hint lifecycle-hint--detail" },
            `Effective login ${instance} connects as: ${n.ssh_user || "admin"} (resolved through the scope chain).`));
        }).catch(() => { /* effective read is best-effort context */ });
      }
    } catch {
      ctxBox.textContent = "";
    }
  };
  scopeSel?.addEventListener("change", () => void refreshContext());
  instSel?.addEventListener("change", () => void refreshContext());
  void refreshContext();

  const errOut = el("div", { className: "form-error-out" });
  panel.appendChild(errOut);

  // Buttons match the spec-authoring pattern: Save stages an upsert, Clear stages
  // a delete-style removal. Both go into the pending queue → committed by the
  // header Save (Apply All), with preview + undo — like ip-vpn / filters / nodes.
  const buttons = el("div", { className: "form-button-row" });
  const saveBtn = el("button", { type: "button", className: "form-submit-btn" }, "Save");
  const clearBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Clear override");
  buttons.appendChild(saveBtn);
  buttons.appendChild(clearBtn);
  panel.appendChild(buttons);

  const scopeLabel = (s: string, i: string): string => (s === "network" ? "network" : `${s} ${i}`);
  const stagedToast = (): void =>
    showToast({ kind: "success", title: "Added to pending changes", body: "Click Save in the header to apply." });

  saveBtn.addEventListener("click", async () => {
    if (!validate()) return;
    errOut.textContent = "";
    const values = getValues();
    const scope = String(values["scope"] ?? "network");
    const instance = String(values["scope_instance"] ?? "");
    saveBtn.disabled = true;
    saveBtn.textContent = "Staging…";
    try {
      // The plaintext password goes to the secret store NOW (a write-only side
      // effect) — this keeps plaintext OUT of the staged body, which carries only
      // the ${secret:KEY} reference (key: <instance>_ssh_pass, or "ssh_pass" at
      // network). Empty password ⇒ inherit.
      const body: Record<string, unknown> = {};
      if (values["ssh_user"]) body["ssh_user"] = values["ssh_user"];
      const pass = String(values["ssh_pass"] ?? "");
      if (pass && !isSecretReference(pass)) {
        const key = scope === "network" ? "ssh_pass" : `${instance}_ssh_pass`;
        await setSecret(network, key, pass);
        body["ssh_pass"] = secretReference(key);
      } else if (isSecretReference(pass)) {
        body["ssh_pass"] = pass;
      }
      // Prior authored value at this scope → the undo inverse.
      const prior = await showSSHCredentials(network, scope, instance || undefined).catch(() => null);
      enqueueSSHLoginSet(scope, instance, body, `SSH login — set at ${scopeLabel(scope, instance)}`, prior);
      stagedToast();
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      errOut.textContent = engineOpErrorBody(err);
    }
  });

  clearBtn.addEventListener("click", async () => {
    const values = getValues();
    const scope = String(values["scope"] ?? "network");
    const instance = String(values["scope_instance"] ?? "");
    const ok = await confirmInline({
      title: `Clear the SSH login at ${scopeLabel(scope, instance)} scope?`,
      body: "Stages removal of the override at this scope; it will inherit from the next scope up.",
      confirmLabel: "Clear",
    });
    if (!ok) return;
    try {
      const prior = await showSSHCredentials(network, scope, instance || undefined).catch(() => null);
      enqueueSSHLoginClear(scope, instance, `SSH login — clear at ${scopeLabel(scope, instance)}`, prior);
      stagedToast();
    } catch (err) {
      errOut.textContent = engineOpErrorBody(err);
    }
  });

  // Atomic swap — the ONLY mutation of `content`. Concurrent renders → last wins,
  // never a stacked duplicate form.
  content.replaceChildren(panel);
}
