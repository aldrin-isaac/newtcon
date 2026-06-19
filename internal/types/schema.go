// Package types — schema-metadata DTOs (newtron #240).
//
// These mirror newtron's published schema-metadata wire shape from
// docs/newtron/api.md §GET /newtron/v1/schema and §/schema/{kind}.
// Defined here so the handlers + clients share one source of truth
// for the JSON tags.

package types

// SchemaKindSummary is one entry in the GET /api/schema response —
// just enough to render a "pick the kind to author" picker without
// fetching each kind's full schema individually.
type SchemaKindSummary struct {
	Kind        string `json:"kind"`        // Go type name, e.g. "IPVPNSpec"
	Label       string `json:"label"`       // Operator-facing label
	Description string `json:"description"` // One-line description
}

// SchemaKindsResponse mirrors newtron's GET /newtron/v1/schema "data" field.
type SchemaKindsResponse struct {
	Kinds []SchemaKindSummary `json:"kinds"`
}

// SchemaMeta is the full per-kind schema returned by
// GET /api/schema/{kind}. Includes every spec field's wire name,
// operator-facing label, tooltip, type, and (where applicable) the
// enum values or referenced kind. Newtron PR #240's universal-engine
// extension also exposes paths + identifier + parent_ref so clients
// drive CRUD URLs from the schema rather than hardcoded mappings.
type SchemaMeta struct {
	Kind        string             `json:"kind"`
	Label       string             `json:"label"`
	Description string             `json:"description"`
	Fields      []SchemaFieldMeta  `json:"fields"`
	Identifier  string             `json:"identifier,omitempty"`
	ParentRef   string             `json:"parent_ref,omitempty"`
	Paths       SchemaPaths        `json:"paths,omitempty"`
}

// SchemaPaths declares the HTTP path templates per CRUD verb. All
// paths use {netID} as the network placeholder; show additionally uses
// {name} for the spec instance. Empty fields mean the verb isn't
// supported for the kind (e.g. PlatformSpec has only list+show).
type SchemaPaths struct {
	List   string `json:"list,omitempty"`
	Show   string `json:"show,omitempty"`
	Create string `json:"create,omitempty"`
	Update string `json:"update,omitempty"`
	Delete string `json:"delete,omitempty"`
}

// SchemaFieldMeta is one field's metadata. Optional members stay
// pointer-or-omit so absence and zero-value stay distinguishable on
// the wire (matches newtron's tagging).
type SchemaFieldMeta struct {
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Description string   `json:"description,omitempty"`
	Type        string   `json:"type"` // string|int|float|bool|enum|array|map|object|ref
	Required    bool     `json:"required"`
	Enum        []string `json:"enum,omitempty"`
	RefKind     string   `json:"ref_kind,omitempty"`
	ItemType    string   `json:"item_type,omitempty"`
	ItemKind    string   `json:"item_kind,omitempty"`
}
