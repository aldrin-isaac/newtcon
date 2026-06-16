// types/authorization.go — operator-facing wire shape for newtron's
// GET /authorization endpoint (newtron PR #160 / closed gap newtron#150).
//
// Newtron returns the live authorization table from network.json as a
// typed payload. newtcon forwards it verbatim to the browser; the
// renderer there handles the polymorphic PermissionGrant shape.
package types

import "encoding/json"

// AuthorizationDetail mirrors newtron's AuthorizationDetail (per
// docs/newtron/authorization-howto.md §8 and the convergence note at
// /tmp/newtron-convergence-for-newtcon.md).
type AuthorizationDetail struct {
	// SuperUsers are user identities granted every permission. Operates
	// outside the per-permission table entirely.
	SuperUsers []string `json:"super_users"`

	// UserGroups names reusable membership sets — a permission grant can
	// reference a group by name and reach every member.
	UserGroups map[string][]string `json:"user_groups"`

	// Permissions is keyed by permission name (e.g. "create-vlan",
	// "spec.author"). Each value is a PermissionGrant in either shorthand
	// form (a JSON array of user/group names — implicit allow) or typed
	// form (an object with allow/where keys). The polymorphism stays as
	// json.RawMessage so the renderer can present either shape without
	// the newtcon backend forking newtron's wire schema.
	Permissions map[string]json.RawMessage `json:"permissions"`
}
