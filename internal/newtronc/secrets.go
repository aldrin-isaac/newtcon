// secrets.go — network-scoped secret-store client.
//
// Backs the operator-provided-credential authoring flow: a credential is POSTed
// to newtron's per-network store and the spec field is set to "${secret:<key>}"
// rather than carrying plaintext. Values are WRITE-ONLY end to end — newtron
// never returns a stored value, so there is no "get value" method; ListSecrets
// returns key NAMES only. Callers MUST NOT log the value passed to SetSecret.
//
// These reuse the generic node{Get,PostBody,Delete} helpers, so upstream 403 →
// AuthorizationError (→ 403 authorization_failure at the handler) et al. come
// for free via classifyResponse.
package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
)

// ListSecrets returns the secret key names stored for a network (sorted
// upstream; empty when none). GET /networks/{net}/secrets.
func (c *Client) ListSecrets(ctx context.Context, network string) ([]string, error) {
	data, err := c.nodeGet(ctx, fmt.Sprintf("/networks/%s/secrets", network))
	if err != nil {
		return nil, err
	}
	var resp struct {
		Keys []string `json:"keys"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding secrets list: %v", err)}
	}
	return resp.Keys, nil
}

// SetSecret stores value under key for a network so a spec field can reference
// it as ${secret:key}. The value is write-only upstream (never echoed) and MUST
// NOT be logged by callers. POST /networks/{net}/secrets {key, value}.
func (c *Client) SetSecret(ctx context.Context, network, key, value string) error {
	_, err := c.nodePostBody(ctx, fmt.Sprintf("/networks/%s/secrets", network),
		map[string]string{"key": key, "value": value})
	return err
}

// DeleteSecret removes key from a network's store. Idempotent upstream (a no-op
// delete still succeeds). DELETE /networks/{net}/secrets/{key}.
func (c *Client) DeleteSecret(ctx context.Context, network, key string) error {
	_, err := c.nodeDelete(ctx, fmt.Sprintf("/networks/%s/secrets/%s", network, key))
	return err
}
