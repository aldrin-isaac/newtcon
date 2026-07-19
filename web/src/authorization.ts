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
import { el } from "./dom.js";
import { ApiError } from "./api/newtcon/services.js";
import { formatErrorBrief } from "./render-error.js";
import {
  type PermissionGroupId,
  describePermission,
  groupLabelFor,
  groupPermissions,
} from "./permission-catalog.js";
import {
  type EffectivePermission,
  type ExpandedGrant,
  type PermissionSummary,
  type UserSummary,
  allUsers,
  summarizePermission,
  summarizeUser,
} from "./permission-derivations.js";
import { filterAuthorization } from "./permission-search.js";
import { PERMISSIONS_EMPTY } from "./empty-states.js";
import { isAnonymous } from "./auth-gate.js";

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
    // Pedagogical treatment of the auth.read 403 (newtron PR #188).
    // When an operator engages the engage-when-configured gate, the
    // detail line already carries the typed "alice lacks auth.read on
    // default" string; the headline should explain WHY this happens
    // rather than read as a generic load failure.
    if (err instanceof ApiError && err.kind === "authorization_failure") {
      root.appendChild(el("h2", { className: "view-heading" }, "Permissions"));
      root.appendChild(el("p", { className: "panel-error" },
        "auth.read permission required to view this network's grant table"));
      root.appendChild(el("p", { className: "panel-error-detail" }, formatErrorBrief(err)));
      root.appendChild(el("p", { className: "view-intro" },
        "This deployment engages newtron's auth.read gate. Ask an operator with super-user privileges or matching grant in network.json to add your group to the auth.read permission."));
      return;
    }
    root.appendChild(el("p", { className: "panel-error" }, "Couldn't load authorization table"));
    root.appendChild(el("p", { className: "panel-error-detail" }, formatErrorBrief(err)));
  }
}

function renderAuthorization(root: HTMLElement, data: AuthorizationDetail): void {
  const heading = el("h2", { className: "view-heading" }, "Permissions");
  root.appendChild(heading);

  // Teaching empty state (slice #169.C). When the whole authorization
  // payload is empty (no super-users, no groups, no permissions),
  // render one teaching block instead of the standard intro + three
  // "(none)" lines. The Lookup section and search bar would have
  // nothing to operate on either, so suppress them too.
  if (isAuthorizationEmpty(data)) {
    root.appendChild(renderPermissionsEmptyState());
    return;
  }

  const intro = el("p", { className: "view-intro" },
    "Live authorization table read from newtron. Edit by changing network.json + POST /reload upstream.");
  root.appendChild(intro);

  // Anonymous-mode pedagogy (slice #169.D). The grant table below
  // describes who can do what for IDENTIFIED operators; in anonymous
  // mode no identity reaches newtron, so the operator is effectively
  // outside this table. Surface that honestly.
  if (isAnonymous()) {
    root.appendChild(el("p", { className: "view-note view-note--info" },
      "Newtron Console is running in anonymous mode — requests reach newtron without an operator identity, so the grants below apply only to signed-in operators in other sessions."));
  }

  root.appendChild(renderLookup(data));

  // Search filters every visible section (super-users / user-groups /
  // permission table) by substring; the Lookup section above stays
  // unfiltered — it's a different affordance for direct identity /
  // permission lookup, and shrinking those selectors would defeat their
  // purpose. (Slice #170.C.)
  const filtered = el("div", { className: "authz-filtered" });
  const rerender = (q: string): void => {
    const f = filterAuthorization(q, data);
    filtered.textContent = "";
    filtered.appendChild(renderSuperUsers(f.superUsers, f.totals.superUsers));
    filtered.appendChild(renderUserGroups(f.userGroups, f.totals.userGroups));
    // renderPermissions takes the unfiltered permissions map + a name
    // allow-list so each row still has access to its original grant
    // value for rendering.
    filtered.appendChild(renderPermissions(data.permissions ?? {}, f.permissions, f.totals.permissions));
  };
  root.appendChild(renderSearchBar(rerender));
  root.appendChild(filtered);
  rerender("");
}

function renderSearchBar(onInput: (query: string) => void): HTMLElement {
  const box = el("section", { className: "authz-section authz-search" });
  const input = el("input", {
    type: "search",
    className: "authz-search-input",
    placeholder: "Search permissions, groups, users…",
    autocomplete: "off",
    spellcheck: false,
  });
  input.setAttribute("aria-label", "Filter permissions table");
  input.addEventListener("input", () => onInput(input.value));
  box.appendChild(input);
  return box;
}

// ---- Lookup: forward + inverse member-of views (slice #170.B) -------------
//
// Two affordances at the top of the Permissions tab:
//
//   "What can <user> do?"   — pick a user → list of effective permissions
//                             grouped by operator-domain, each row showing
//                             how the user holds it (super-user / direct /
//                             via group: ops) and any where-clause scope.
//
//   "Who has <permission>?" — pick a permission → super-users + per-grant
//                             rows showing direct users + groups expanded
//                             to their members + where-clause scope.
//
// Pure derivation from the same AuthorizationDetail payload; no extra
// HTTP work.

function renderLookup(data: AuthorizationDetail): HTMLElement {
  const section = el("section", { className: "authz-section authz-lookup" });
  section.appendChild(el("h3", { className: "authz-section-heading" }, "Lookup"));

  const users = allUsers(data);
  const perms = Object.keys(data.permissions ?? {}).sort();

  section.appendChild(renderUserLookup(users, data));
  section.appendChild(renderPermissionLookup(perms, data));
  return section;
}

function renderUserLookup(users: string[], data: AuthorizationDetail): HTMLElement {
  const box = el("div", { className: "authz-lookup-block" });
  const prompt = el("label", { className: "authz-lookup-prompt" });
  prompt.appendChild(document.createTextNode("What can "));
  const sel = el("select", { className: "authz-lookup-select" });
  sel.appendChild(el("option", { value: "" }, "—"));
  for (const u of users) {
    sel.appendChild(el("option", { value: u }, u));
  }
  prompt.appendChild(sel);
  prompt.appendChild(document.createTextNode(" do?"));
  box.appendChild(prompt);

  const result = el("div", { className: "authz-lookup-result" });
  box.appendChild(result);

  sel.addEventListener("change", () => {
    result.textContent = "";
    if (!sel.value) return;
    result.appendChild(renderUserSummary(summarizeUser(sel.value, data)));
  });

  if (users.length === 0) {
    const empty = el("p", { className: "authz-empty" }, "(no users in this network)");
    box.appendChild(empty);
  }
  return box;
}

function renderPermissionLookup(perms: string[], data: AuthorizationDetail): HTMLElement {
  const box = el("div", { className: "authz-lookup-block" });
  const prompt = el("label", { className: "authz-lookup-prompt" });
  prompt.appendChild(document.createTextNode("Who has "));
  const sel = el("select", { className: "authz-lookup-select" });
  sel.appendChild(el("option", { value: "" }, "—"));
  for (const p of perms) {
    const d = describePermission(p);
    const label = d.title === p ? p : `${d.title}  (${p})`;
    sel.appendChild(el("option", { value: p }, label));
  }
  prompt.appendChild(sel);
  prompt.appendChild(document.createTextNode("?"));
  box.appendChild(prompt);

  const result = el("div", { className: "authz-lookup-result" });
  box.appendChild(result);

  sel.addEventListener("change", () => {
    result.textContent = "";
    if (!sel.value) return;
    result.appendChild(renderPermissionSummary(summarizePermission(sel.value, data)));
  });
  return box;
}

function renderUserSummary(s: UserSummary): HTMLElement {
  const box = el("div", { className: "authz-summary" });
  const head = el("div", { className: "authz-summary-head" });
  head.appendChild(el("strong", { className: "authz-summary-name" }, s.user));
  if (s.isSuperUser) {
    head.appendChild(el("span", { className: "authz-summary-badge" }, "super-user"));
  }
  box.appendChild(head);

  if (s.groups.length > 0) {
    const groupsRow = el("div", { className: "authz-summary-row" });
    groupsRow.appendChild(el("span", { className: "authz-summary-row-label" }, "member of"));
    groupsRow.appendChild(renderMemberList(s.groups));
    box.appendChild(groupsRow);
  }

  if (s.permissions.length === 0) {
    box.appendChild(el("p", { className: "authz-empty" }, "(holds no permissions)"));
    return box;
  }

  // Group effective permissions by operator-domain for the same scanning
  // affordance the main Permissions section uses.
  const namesByGroup = new Map<string, EffectivePermission[]>();
  const namesList = s.permissions.map((p) => p.name);
  const partition = groupPermissions(namesList);
  for (const [groupId, names] of partition) {
    const inGroup: EffectivePermission[] = [];
    for (const n of names) {
      for (const p of s.permissions) if (p.name === n) inGroup.push(p);
    }
    namesByGroup.set(groupId, inGroup);
  }

  const heading = el("p", { className: "authz-summary-row-label" }, "effective permissions");
  box.appendChild(heading);

  for (const [groupId, eps] of namesByGroup) {
    const sub = el("section", { className: "authz-subsection" });
    sub.appendChild(el("h4", { className: "authz-subsection-heading" }, groupLabelFor(groupId as PermissionGroupId)));
    const dl = el("dl", { className: "kv kv--wide authz-grants" });
    for (const ep of eps) {
      const desc = describePermission(ep.name);
      const dt = el("dt", { className: "authz-grant-name" });
      dt.appendChild(el("span", { className: "authz-grant-title" }, desc.title));
      if (desc.title !== ep.name) {
        dt.appendChild(el("span", { className: "authz-grant-wire-name" }, ep.name));
      }
      dl.appendChild(dt);
      const dd = el("dd", { className: "authz-grant-value" });
      dd.appendChild(renderEffectiveSource(ep));
      dl.appendChild(dd);
    }
    sub.appendChild(dl);
    box.appendChild(sub);
  }
  return box;
}

function renderEffectiveSource(ep: EffectivePermission): HTMLElement {
  const box = el("div", { className: "authz-grant-typed" });
  const row = el("div", { className: "authz-grant-row" });
  row.appendChild(el("span", { className: "authz-grant-row-label" }, "via"));
  if (ep.source === "super_user") {
    row.appendChild(el("span", { className: "authz-source-tag" }, "super-user"));
  } else if (ep.source === "direct") {
    row.appendChild(el("span", { className: "authz-source-tag" }, "direct grant"));
  } else {
    const tag = el("span", { className: "authz-source-tag" });
    tag.appendChild(document.createTextNode("group: "));
    tag.appendChild(el("code", { className: "authz-source-group" }, ep.source.viaGroup));
    row.appendChild(tag);
  }
  box.appendChild(row);
  if (ep.where && Object.keys(ep.where).length > 0) {
    const w = el("div", { className: "authz-grant-row" });
    w.appendChild(el("span", { className: "authz-grant-row-label" }, "where"));
    w.appendChild(renderWhereScope(ep.where));
    box.appendChild(w);
  }
  return box;
}

function renderPermissionSummary(s: PermissionSummary): HTMLElement {
  const box = el("div", { className: "authz-summary" });
  const desc = describePermission(s.permission);
  const head = el("div", { className: "authz-summary-head" });
  head.appendChild(el("strong", { className: "authz-summary-name" }, desc.title));
  if (desc.title !== s.permission) {
    head.appendChild(el("span", { className: "authz-grant-wire-name" }, s.permission));
  }
  box.appendChild(head);
  if (desc.body) {
    box.appendChild(el("p", { className: "authz-summary-body" }, desc.body));
  }

  if (s.superUsers.length > 0) {
    const row = el("div", { className: "authz-summary-row" });
    row.appendChild(el("span", { className: "authz-summary-row-label" }, "super-users"));
    row.appendChild(renderMemberList(s.superUsers));
    box.appendChild(row);
  }

  if (s.grants.length === 0) {
    box.appendChild(el("p", { className: "authz-empty" }, "(no explicit grants — only super-users hold it)"));
    return box;
  }

  for (let i = 0; i < s.grants.length; i++) {
    box.appendChild(renderExpandedGrant(s.grants[i]!, s.grants.length > 1 ? i + 1 : null));
  }
  return box;
}

function renderExpandedGrant(g: ExpandedGrant, index: number | null): HTMLElement {
  const box = el("div", { className: "authz-grant-typed authz-grant-expanded" });
  if (index !== null) {
    box.appendChild(el("p", { className: "authz-grant-row-label" }, `grant #${index}`));
  }
  if (g.directUsers.length > 0) {
    const row = el("div", { className: "authz-grant-row" });
    row.appendChild(el("span", { className: "authz-grant-row-label" }, "users"));
    row.appendChild(renderMemberList(g.directUsers));
    box.appendChild(row);
  }
  for (const grp of g.groups) {
    const row = el("div", { className: "authz-grant-row" });
    const label = el("span", { className: "authz-grant-row-label" });
    label.appendChild(document.createTextNode("group "));
    label.appendChild(el("code", { className: "authz-source-group" }, grp.name));
    row.appendChild(label);
    if (grp.members.length === 0) {
      row.appendChild(el("span", { className: "authz-empty" }, "(no members)"));
    } else {
      row.appendChild(renderMemberList(grp.members));
    }
    box.appendChild(row);
  }
  if (g.where && Object.keys(g.where).length > 0) {
    const row = el("div", { className: "authz-grant-row" });
    row.appendChild(el("span", { className: "authz-grant-row-label" }, "where"));
    row.appendChild(renderWhereScope(g.where));
    box.appendChild(row);
  }
  return box;
}

// isAuthorizationEmpty returns true when newtron's authorization
// payload has nothing populated — no super-users, no user groups, no
// permissions. The teaching empty state (slice #169.C) gates on this.
function isAuthorizationEmpty(data: AuthorizationDetail): boolean {
  const superUsers = data.super_users ?? [];
  const groups = data.user_groups ?? {};
  const permissions = data.permissions ?? {};
  return superUsers.length === 0
    && Object.keys(groups).length === 0
    && Object.keys(permissions).length === 0;
}

// renderPermissionsEmptyState renders the teaching block for an empty
// authorization payload. Same panel-empty styling as the Specs +
// Topology empty states so the operator recognises the pattern.
function renderPermissionsEmptyState(): HTMLElement {
  const block = el("div", { className: "panel-empty topology-empty-state" });
  block.appendChild(el("p", { className: "panel-empty-headline" }, PERMISSIONS_EMPTY.title));
  block.appendChild(el("p", { className: "panel-empty-body" }, PERMISSIONS_EMPTY.body));
  if (PERMISSIONS_EMPTY.hint) {
    block.appendChild(el("p", { className: "panel-empty-hint" }, PERMISSIONS_EMPTY.hint));
  }
  return block;
}

function renderSuperUsers(users: string[], total: number): HTMLElement {
  const section = el("section", { className: "authz-section" });
  const heading = el("h3", { className: "authz-section-heading" }, "Super users");
  section.appendChild(heading);
  appendFilterHint(section, users.length, total);
  if (total === 0) {
    section.appendChild(el("p", { className: "authz-empty" }, "(none)"));
    return section;
  }
  if (users.length === 0) {
    section.appendChild(el("p", { className: "authz-empty" }, "(no matches)"));
    return section;
  }
  const list = el("ul", { className: "authz-chip-list" });
  for (const u of users) {
    list.appendChild(el("li", { className: "chip chip--md chip--mono chip--sunken" }, u));
  }
  section.appendChild(list);
  return section;
}

function renderUserGroups(groups: Record<string, string[]>, total: number): HTMLElement {
  const section = el("section", { className: "authz-section" });
  section.appendChild(el("h3", { className: "authz-section-heading" }, "User groups"));
  const entries = Object.entries(groups);
  appendFilterHint(section, entries.length, total);
  if (total === 0) {
    section.appendChild(el("p", { className: "authz-empty" }, "(none)"));
    return section;
  }
  if (entries.length === 0) {
    section.appendChild(el("p", { className: "authz-empty" }, "(no matches)"));
    return section;
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  const dl = el("dl", { className: "kv kv--wide authz-grants" });
  for (const [name, members] of entries) {
    dl.appendChild(el("dt", { className: "authz-grant-name" }, name));
    const dd = el("dd", { className: "authz-grant-value" });
    dd.appendChild(renderMemberList(members));
    dl.appendChild(dd);
  }
  section.appendChild(dl);
  return section;
}

function renderPermissions(
  permissions: Record<string, unknown>,
  visibleNames: string[],
  total: number,
): HTMLElement {
  const section = el("section", { className: "authz-section" });
  section.appendChild(el("h3", { className: "authz-section-heading" }, "Permissions"));
  appendFilterHint(section, visibleNames.length, total);
  if (total === 0) {
    section.appendChild(el("p", { className: "authz-empty" }, "(none)"));
    return section;
  }
  if (visibleNames.length === 0) {
    section.appendChild(el("p", { className: "authz-empty" }, "(no matches)"));
    return section;
  }

  // Group by operator-domain category. Each group is its own subsection
  // with a heading so the operator scans by concern, not alphabet.
  const grouped = groupPermissions(visibleNames);
  for (const [groupId, groupNames] of grouped) {
    section.appendChild(renderPermissionGroup(groupId, groupNames, permissions));
  }
  return section;
}

function appendFilterHint(section: HTMLElement, shown: number, total: number): void {
  if (total > 0 && shown !== total) {
    section.appendChild(el("p", { className: "authz-filter-hint" },
      `showing ${shown} of ${total}`));
  }
}

function renderPermissionGroup(
  groupId: PermissionGroupId,
  names: string[],
  permissions: Record<string, unknown>,
): HTMLElement {
  const sub = el("section", { className: "authz-subsection" });
  sub.appendChild(el("h4", { className: "authz-subsection-heading" }, groupLabelFor(groupId)));
  const dl = el("dl", { className: "kv kv--wide authz-grants" });
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
    list.appendChild(el("li", { className: "chip chip--md chip--mono chip--sunken" }, m));
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

