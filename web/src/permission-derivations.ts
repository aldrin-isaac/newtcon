// permission-derivations.ts — pure derivations on top of
// AuthorizationDetail. Powers the forward + inverse member-of views in
// the Permissions tab (slice #170.B).
//
//   Forward  — summarizeUser(u, data):  "what can alice do?"
//   Inverse  — summarizePermission(p, data):  "who has spec.author?"
//
// Both views work off the existing GET /api/networks/{netID}/authorization
// payload — no new server work. The polymorphism in PermissionGrant
// (shorthand list of names vs. typed {groups, users, allow, where}, and
// a list of those for disjunctive grants) is normalized once here so the
// derivation + renderer don't each have to re-implement the wire shape.

import type { AuthorizationDetail } from "./api/newtcon/authorization.js";

/**
 * NormalizedGrant — one disjunctive sub-grant of a permission, with names
 * already classified as either user_group references or direct users.
 *
 * A name in newtron's wire shape is ambiguous (could be a group, could be
 * a user). We resolve it the same way newtron does at evaluation time:
 * if the name is a key in user_groups, treat it as a group; otherwise
 * treat it as a direct user identity.
 */
export interface NormalizedGrant {
  groupNames: string[];
  userNames: string[];
  where?: Record<string, unknown>;
}

/**
 * normalizeGrant turns a polymorphic PermissionGrant value (shorthand
 * list of strings, typed single object, or typed list of objects) into
 * an array of NormalizedGrants — one per disjunctive sub-grant. Shorthand
 * collapses to a single sub-grant with no `where`.
 */
export function normalizeGrant(
  grant: unknown,
  userGroups: Record<string, string[]>,
): NormalizedGrant[] {
  if (Array.isArray(grant)) {
    if (grant.every((g) => typeof g === "string")) {
      return [classifyNameList(grant as string[], userGroups)];
    }
    const out: NormalizedGrant[] = [];
    for (const item of grant) {
      const n = normalizeTyped(item, userGroups);
      if (n) out.push(n);
    }
    return out;
  }
  if (grant && typeof grant === "object") {
    const n = normalizeTyped(grant, userGroups);
    return n ? [n] : [];
  }
  return [];
}

function normalizeTyped(
  item: unknown,
  userGroups: Record<string, string[]>,
): NormalizedGrant | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as {
    groups?: string[];
    users?: string[];
    allow?: string[];
    where?: Record<string, unknown>;
  };
  const groupNames: string[] = [];
  const userNames: string[] = [];
  if (Array.isArray(obj.groups)) groupNames.push(...obj.groups);
  if (Array.isArray(obj.users)) userNames.push(...obj.users);
  // Legacy "allow" field — classify each name by membership in user_groups.
  if (Array.isArray(obj.allow)) {
    const c = classifyNameList(obj.allow, userGroups);
    groupNames.push(...c.groupNames);
    userNames.push(...c.userNames);
  }
  const out: NormalizedGrant = { groupNames, userNames };
  if (obj.where && typeof obj.where === "object" && Object.keys(obj.where).length > 0) {
    out.where = obj.where;
  }
  return out;
}

function classifyNameList(
  names: string[],
  userGroups: Record<string, string[]>,
): NormalizedGrant {
  const groupNames: string[] = [];
  const userNames: string[] = [];
  for (const n of names) {
    if (Object.prototype.hasOwnProperty.call(userGroups, n)) {
      groupNames.push(n);
    } else {
      userNames.push(n);
    }
  }
  return { groupNames, userNames };
}

// ---------- Forward view: "what can alice do?" -----------------------------

/**
 * GrantSource describes *why* a user holds a permission.
 *
 *   "super_user"           — granted via the super-user list
 *   "direct"               — listed by name in the permission grant
 *   { viaGroup: "ops" }    — member of a group listed in the grant
 */
export type GrantSource = "super_user" | "direct" | { viaGroup: string };

export interface EffectivePermission {
  name: string;
  source: GrantSource;
  /** newtron where-clause scope, present when the grant constrains it. */
  where?: Record<string, unknown>;
}

export interface UserSummary {
  user: string;
  isSuperUser: boolean;
  /** Groups the user belongs to, alphabetised. */
  groups: string[];
  /** Effective permissions; duplicates preserved when a user holds the
   * same permission via multiple routes (e.g. both directly and via a
   * group) so the operator sees every grant path. */
  permissions: EffectivePermission[];
}

/**
 * summarizeUser computes the forward view: every permission `user` holds,
 * and the source of each grant. Super-users hold every permission in
 * `data.permissions` with source "super_user" — that's how the renderer
 * shows the "(holds all permissions)" effect honestly, instead of
 * inferring it implicitly.
 */
export function summarizeUser(user: string, data: AuthorizationDetail): UserSummary {
  const isSuperUser = (data.super_users ?? []).includes(user);
  const groups = Object.entries(data.user_groups ?? {})
    .filter(([, members]) => Array.isArray(members) && members.includes(user))
    .map(([name]) => name)
    .sort();

  const permissions: EffectivePermission[] = [];
  const permEntries = Object.entries(data.permissions ?? {})
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [permName, grant] of permEntries) {
    if (isSuperUser) {
      permissions.push({ name: permName, source: "super_user" });
      continue;
    }
    const subGrants = normalizeGrant(grant, data.user_groups ?? {});
    for (const sg of subGrants) {
      if (sg.userNames.includes(user)) {
        const ep: EffectivePermission = { name: permName, source: "direct" };
        if (sg.where) ep.where = sg.where;
        permissions.push(ep);
      }
      for (const g of sg.groupNames) {
        if (groups.includes(g)) {
          const ep: EffectivePermission = { name: permName, source: { viaGroup: g } };
          if (sg.where) ep.where = sg.where;
          permissions.push(ep);
        }
      }
    }
  }
  return { user, isSuperUser, groups, permissions };
}

// ---------- Inverse view: "who has spec.author?" ---------------------------

export interface ExpandedGrant {
  /** Users directly listed in this sub-grant. */
  directUsers: string[];
  /** Groups listed in this sub-grant, each expanded to its members. */
  groups: Array<{ name: string; members: string[] }>;
  /** Constraint scope, if any. */
  where?: Record<string, unknown>;
}

export interface PermissionSummary {
  permission: string;
  /** Super-users hold every permission — surfaced separately, not folded
   * into the per-grant rows. */
  superUsers: string[];
  /** One per disjunctive sub-grant; any one matching gives access. */
  grants: ExpandedGrant[];
}

/**
 * summarizePermission computes the inverse view: every identity that
 * holds `permission`, grouped by the route through which they hold it.
 * Returns an empty grants list if the permission name isn't in the
 * table — the renderer should treat that case as "no one holds this".
 */
export function summarizePermission(
  permission: string,
  data: AuthorizationDetail,
): PermissionSummary {
  const grant = data.permissions?.[permission];
  const subGrants = grant !== undefined
    ? normalizeGrant(grant, data.user_groups ?? {})
    : [];
  return {
    permission,
    superUsers: [...(data.super_users ?? [])].sort(),
    grants: subGrants.map((sg) => {
      const eg: ExpandedGrant = {
        directUsers: [...sg.userNames].sort(),
        groups: [...sg.groupNames].sort().map((g) => ({
          name: g,
          members: [...((data.user_groups ?? {})[g] ?? [])].sort(),
        })),
      };
      if (sg.where) eg.where = sg.where;
      return eg;
    }),
  };
}

// ---------- Identity index for the lookup selectors ------------------------

/**
 * allUsers extracts every identity that appears anywhere in the
 * authorization payload (super_users + group members + direct user
 * grants in any permission). De-duped, sorted. Powers the "user" selector
 * in the forward-view lookup.
 */
export function allUsers(data: AuthorizationDetail): string[] {
  const seen = new Set<string>();
  for (const u of data.super_users ?? []) seen.add(u);
  for (const members of Object.values(data.user_groups ?? {})) {
    if (Array.isArray(members)) for (const u of members) seen.add(u);
  }
  for (const grant of Object.values(data.permissions ?? {})) {
    for (const sg of normalizeGrant(grant, data.user_groups ?? {})) {
      for (const u of sg.userNames) seen.add(u);
    }
  }
  return [...seen].sort();
}
