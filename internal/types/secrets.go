// types/secrets.go — network-scoped secret-store DTOs.
//
// The secret store holds operator-provided device credentials (e.g. an
// ssh_pass) so a spec field can reference a value as ${secret:<key>} instead
// of carrying plaintext. Values are WRITE-ONLY end to end: newtron never
// returns a stored value, so nothing here models a value being read back.
package types

// SetSecretRequest is the body for POST /api/networks/{netID}/secrets. Value is
// forwarded to newtron's store and never echoed back, logged, or written into a
// spec file — the referencing spec field carries "${secret:Key}" instead.
type SetSecretRequest struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// SecretsListResponse is the body of GET /api/networks/{netID}/secrets: the
// stored key NAMES only (sorted, [] when none) — never values.
type SecretsListResponse struct {
	Keys []string `json:"keys"`
}
