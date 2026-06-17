// permission-search.ts — pure filter for the Permissions tab search box
// (slice #170.C). One substring query narrows every visible section
// (super-users, user-groups, permissions) with rules that match either
// a name or a concept:
//
//   super-users   identity contains query
//   user-groups   group name OR any member contains query
//   permissions   wire name OR curated title OR curated body OR any
//                 member of any grant (group or direct user) contains
//                 query
//
// Curated-title / curated-body matching lets the operator search by
// what a permission *does* ("apply", "interface") in addition to its
// wire name (`service.apply`), which is the affordance the catalog +
// derivation slices already invested in.
//
// Lookup selectors are intentionally NOT filtered — they're their own
// affordance for direct identity / permission lookup, and shrinking them
// based on the search query would defeat their purpose.

import type { AuthorizationDetail } from "./api/newtcon/authorization.js";
import { describePermission } from "./permission-catalog.js";
import { normalizeGrant } from "./permission-derivations.js";

/**
 * FilteredAuthorization — the result of running a query against an
 * AuthorizationDetail. `totals` is always the unfiltered counts so the
 * renderer can show "showing N of M" hints honestly.
 */
export interface FilteredAuthorization {
  superUsers: string[];
  userGroups: Record<string, string[]>;
  permissions: string[];
  totals: {
    superUsers: number;
    userGroups: number;
    permissions: number;
  };
}

/**
 * filterAuthorization narrows every visible section of the Permissions
 * tab by the query. Empty / whitespace-only query passes everything
 * through (the "no filter" identity).
 */
export function filterAuthorization(
  query: string,
  data: AuthorizationDetail,
): FilteredAuthorization {
  const allSuper = data.super_users ?? [];
  const allGroups = data.user_groups ?? {};
  const permissions = data.permissions ?? {};
  const allPermNames = Object.keys(permissions);
  const totals = {
    superUsers: allSuper.length,
    userGroups: Object.keys(allGroups).length,
    permissions: allPermNames.length,
  };

  const q = query.trim().toLowerCase();
  if (q === "") {
    return {
      superUsers: [...allSuper],
      userGroups: { ...allGroups },
      permissions: allPermNames,
      totals,
    };
  }

  const superUsers = allSuper.filter((u) => u.toLowerCase().includes(q));

  const userGroups: Record<string, string[]> = {};
  for (const [name, members] of Object.entries(allGroups)) {
    if (name.toLowerCase().includes(q)) {
      userGroups[name] = members;
      continue;
    }
    if (Array.isArray(members) && members.some((m) => m.toLowerCase().includes(q))) {
      userGroups[name] = members;
    }
  }

  const matchedPerms: string[] = [];
  for (const name of allPermNames) {
    if (name.toLowerCase().includes(q)) {
      matchedPerms.push(name);
      continue;
    }
    const desc = describePermission(name);
    if (desc.title.toLowerCase().includes(q) || desc.body.toLowerCase().includes(q)) {
      matchedPerms.push(name);
      continue;
    }
    const grants = normalizeGrant(permissions[name], allGroups);
    let matched = false;
    for (const g of grants) {
      if (g.userNames.some((u) => u.toLowerCase().includes(q))) { matched = true; break; }
      if (g.groupNames.some((gn) => gn.toLowerCase().includes(q))) { matched = true; break; }
    }
    if (matched) matchedPerms.push(name);
  }

  return { superUsers, userGroups, permissions: matchedPerms, totals };
}
