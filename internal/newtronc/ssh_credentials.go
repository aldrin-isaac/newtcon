// ssh_credentials.go — network SSH-login client. The login is a SCOPED SCALAR
// (one value per network/zone/node scope, upserted — not a named collection), so
// it has its own set/clear/show surface rather than the generic create/delete-X
// verbs. ssh_pass is write-through the secret store (${secret:KEY}); values are
// never logged. Reuses the generic node{Get,PostBody} helpers, so upstream
// 400/403/409 map to typed errors via classifyResponse.
package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
)

// ShowSSHCredentials reads the login AUTHORED at a scope (rawQuery carries
// scope + scope_instance). ssh_pass is masked upstream: a ${secret:KEY} ref is
// returned intact, plaintext as ***redacted***. GET /networks/{net}/ssh-credentials.
func (c *Client) ShowSSHCredentials(ctx context.Context, network, rawQuery string) (json.RawMessage, error) {
	path := fmt.Sprintf("/networks/%s/ssh-credentials", network)
	if rawQuery != "" {
		path += "?" + rawQuery
	}
	return c.nodeGet(ctx, path)
}

// SetSSHCredentials upserts the login at a scope. Body:
// {scope, scope_instance, ssh_user, ssh_pass} — ssh_pass should be a ${secret:KEY}
// reference (set via the secret store), never plaintext. Enforces the
// network-floor invariant upstream (400 when overriding with no network base).
// POST /networks/{net}/set-ssh-credentials.
func (c *Client) SetSSHCredentials(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.nodePostBody(ctx, fmt.Sprintf("/networks/%s/set-ssh-credentials", network), body)
}

// ClearSSHCredentials removes the whole override at a scope. Body:
// {scope, scope_instance}. Upstream returns 409 when clearing the network base
// while a zone/node override still exists (clear bottom-up).
// POST /networks/{net}/clear-ssh-credentials.
func (c *Client) ClearSSHCredentials(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.nodePostBody(ctx, fmt.Sprintf("/networks/%s/clear-ssh-credentials", network), body)
}
