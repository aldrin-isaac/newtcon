// authorization.ts — Permissions tab (read-only view of newtron's
// authorization table). Lights up the slice that landed when newtron PR
// #160 closed the gap newtron#150 had blocked.
//
// Three sections, in this order:
//
//   Super users         flat list of identities with everything granted
//   User groups         reusable membership sets, group → members
//   Permissions         per-permission grant table, each grant rendered
//                       either as a shorthand list or as a typed
//                       {allow, where} object — both shapes are valid in
//                       newtron's wire (per the convergence note).
//
// Read-only today. Editing means modifying network.json and POST-ing
// /reload; newtcon does not expose either surface yet — when it does,
// this view becomes the inspector half of the editor.

import { fetchAuthorization, type AuthorizationDetail } from "./api/newtcon/authorization.js";
import { formatErrorBrief } from "./render-error.js";
import {
  type PermissionGroupId,
  describePermission,
  groupLabelFor,
  groupPermissions,
} from "./permission-catalog.js";

/** mountAuthorizationTab clears `root` and renders the Permissions view. */
export async function mountAuthorizationTab(root: HTMLElement): Promise<void> {
  root.textContent = "";
  const loading = el("p", { className: "status-loading" }, "Loading…");
  root.appendChild(loading);

  try {
    const data = await fetchAuthorization();
    root.textContent = "";
    renderAuthorization(root, data);
  } catch (err) {
    root.textContent = "";
    root.appendChild(el("p", { className: "panel-error" }, "Couldn't load authorization table"));
    root.appendChild(el("p", { className: "panel-error-detail" }, formatErrorBrief(err)));
  }
}

function renderAuthorization(root: HTMLElement, data: AuthorizationDetail): void {
  const heading = el("h2", { className: "view-heading" }, "Permissions");
  const intro = el("p", { className: "view-intro" },
    "Live authorization table read from newtron. Edit by changing network.json + POST /reload upstream.");
  root.appendChild(heading);
  root.appendChild(intro);

  root.appendChild(renderSuperUsers(data.super_users ?? []));
  root.appendChild(renderUserGroups(data.user_groups ?? {}));
  root.appendChild(renderPermissions(data.permissions ?? {}));
}

function renderSuperUsers(users: string[]): HTMLElement {
  const section = el("section", { className: "authz-section" });
  section.appendChild(el("h3", { className: "authz-section-heading" }, "Super users"));
  if (users.length === 0) {
    section.appendChild(el("p", { className: "authz-empty" }, "(none)"));
    return section;
  }
  const list = el("ul", { className: "authz-chip-list" });
  for (const u of users) {
    list.appendChild(el("li", { className: "authz-chip" }, u));
  }
  section.appendChild(list);
  return section;
}

function renderUserGroups(groups: Record<string, string[]>): HTMLElement {
  const section = el("section", { className: "authz-section" });
  section.appendChild(el("h3", { className: "authz-section-heading" }, "User groups"));
  const entries = Object.entries(groups);
  if (entries.length === 0) {
    section.appendChild(el("p", { className: "authz-empty" }, "(none)"));
    return section;
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  const dl = el("dl", { className: "authz-grants" });
  for (const [name, members] of entries) {
    dl.appendChild(el("dt", { className: "authz-grant-name" }, name));
    const dd = el("dd", { className: "authz-grant-value" });
    dd.appendChild(renderMemberList(members));
    dl.appendChild(dd);
  }
  section.appendChild(dl);
  return section;
}

function renderPermissions(permissions: Record<string, unknown>): HTMLElement {
  const section = el("section", { className: "authz-section" });
  section.appendChild(el("h3", { className: "authz-section-heading" }, "Permissions"));
  const names = Object.keys(permissions);
  if (names.length === 0) {
    section.appendChild(el("p", { className: "authz-empty" }, "(none)"));
    return section;
  }

  // Group by operator-domain category (Spec authoring / Services /
  // Routing / …). Each group is its own subsection with a heading so
  // the operator scans by concern, not alphabet.
  const grouped = groupPermissions(names);
  for (const [groupId, groupNames] of grouped) {
    section.appendChild(renderPermissionGroup(groupId, groupNames, permissions));
  }
  return section;
}

function renderPermissionGroup(
  groupId: PermissionGroupId,
  names: string[],
  permissions: Record<string, unknown>,
): HTMLElement {
  const sub = el("section", { className: "authz-subsection" });
  sub.appendChild(el("h4", { className: "authz-subsection-heading" }, groupLabelFor(groupId)));
  const dl = el("dl", { className: "authz-grants" });
  for (const name of names) {
    const desc = describePermission(name);
    // dt has the friendly title + the wire name as a small caption so
    // the operator who knows the API can still see exactly which
    // permission they're looking at.
    const dt = el("dt", { className: "authz-grant-name" });
    dt.appendChild(el("span", { className: "authz-grant-title" }, desc.title));
    if (desc.title !== name) {
      dt.appendChild(el("span", { className: "authz-grant-wire-name" }, name));
    }
    if (desc.body) {
      dt.appendChild(el("p", { className: "authz-grant-body" }, desc.body));
    }
    dl.appendChild(dt);
    const dd = el("dd", { className: "authz-grant-value" });
    dd.appendChild(renderPermissionGrant(permissions[name]));
    dl.appendChild(dd);
  }
  sub.appendChild(dl);
  return sub;
}

/**
 * renderPermissionGrant handles the polymorphism in newtron's wire schema.
 *
 *   Shorthand: a flat list of group / user names
 *     "create-vlan": ["ops"]
 *
 *   Typed (single object): an object with users/groups + optional where
 *     "acl.modify": {"groups": ["intf-ops"], "where": {"interface":"Ethernet0"}}
 *
 *   Typed (array of objects): a list of disjunctive grants — any one matches
 *     "service.apply": [
 *       {"groups": ["spec-team"], "where": {"resource": "transit-*"}},
 *       {"groups": ["ops"],       "where": {"resource": "vpn-*"}}
 *     ]
 *
 * The "allow" field name in earlier docs is also accepted as a fallback for
 * forward-compat.
 */
function renderPermissionGrant(grant: unknown): HTMLElement {
  if (Array.isArray(grant)) {
    // Disambiguate: array of strings = shorthand; array of objects = typed
    // list (each element a {groups/users/where} grant).
    if (grant.every((g) => typeof g === "string")) {
      return renderMemberList(grant as string[]);
    }
    const stack = el("div", { className: "authz-grant-stack" });
    for (const item of grant) {
      stack.appendChild(renderTypedGrant(item));
    }
    return stack;
  }
  if (grant && typeof grant === "object") {
    return renderTypedGrant(grant);
  }
  // Unknown shape — render raw text honestly rather than guessing.
  return el("code", { className: "authz-grant-raw" }, JSON.stringify(grant));
}

function renderTypedGrant(grant: unknown): HTMLElement {
  const obj = (grant ?? {}) as {
    groups?: string[];
    users?: string[];
    allow?: string[];
    where?: Record<string, unknown>;
  };
  const box = el("div", { className: "authz-grant-typed" });

  const members = [
    ...(Array.isArray(obj.groups) ? obj.groups : []),
    ...(Array.isArray(obj.users) ? obj.users : []),
    ...(Array.isArray(obj.allow) ? obj.allow : []),
  ];
  if (members.length > 0) {
    const row = el("div", { className: "authz-grant-row" });
    row.appendChild(el("span", { className: "authz-grant-row-label" }, "allow"));
    row.appendChild(renderMemberList(members));
    box.appendChild(row);
  }

  if (obj.where && typeof obj.where === "object" && Object.keys(obj.where).length > 0) {
    const row = el("div", { className: "authz-grant-row" });
    row.appendChild(el("span", { className: "authz-grant-row-label" }, "where"));
    row.appendChild(renderWhereScope(obj.where));
    box.appendChild(row);
  }

  // Defensive — if neither members nor where matched, show the raw shape
  // so the operator sees what newtron returned rather than an empty row.
  if (box.children.length === 0) {
    box.appendChild(el("code", { className: "authz-grant-raw" }, JSON.stringify(grant)));
  }
  return box;
}

function renderMemberList(members: string[]): HTMLElement {
  const list = el("ul", { className: "authz-chip-list" });
  for (const m of members) {
    list.appendChild(el("li", { className: "authz-chip" }, m));
  }
  return list;
}

function renderWhereScope(where: Record<string, unknown>): HTMLElement {
  const list = el("ul", { className: "authz-where-list" });
  const keys = Object.keys(where).sort();
  for (const k of keys) {
    const v = where[k];
    const item = el("li", { className: "authz-where-item" });
    item.appendChild(el("span", { className: "authz-where-key" }, k + ":"));
    item.appendChild(el("span", { className: "authz-where-value" }, String(v)));
    list.appendChild(item);
  }
  return list;
}

// ---- Local DOM helper (mirrors app.ts's `el` so this module stays
// self-contained — no cross-module HTMLElement-builder dependency).
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
