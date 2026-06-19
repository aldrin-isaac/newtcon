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
// enum values or referenced kind.
type SchemaMeta struct {
	Kind        string             `json:"kind"`
	Label       string             `json:"label"`
	Description string             `json:"description"`
	Fields      []SchemaFieldMeta  `json:"fields"`
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
