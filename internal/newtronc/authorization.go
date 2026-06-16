// newtronc/authorization.go — read the live authorization table from
// newtron-server (newtron PR #160).
//
// Per the convergence note at /tmp/newtron-convergence-for-newtcon.md,
// newtron added GET /newtron/v1/networks/{netID}/authorization to expose
// the AuthorizationDetail (super_users + user_groups + permissions) the
// runtime checker consults — useful for newtcon's read-only Permissions
// inspector. Write is out of scope (operators edit network.json + POST
// /reload; see authorization-howto.md §8).
//
// No new error mapping needed: classifyResponse already handles 404 (no
// such network), 401/403 (when auth-gate is on), and 5xx (newtron down).
package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// GetAuthorization fetches GET /newtron/v1/networks/{netID}/authorization
// and returns newtron's "data" payload verbatim — the renderer reads the
// raw JSON because PermissionGrant is polymorphic (shorthand list OR typed
// object) and newtcon shouldn't fork newtron's schema.
func (c *Client) GetAuthorization(ctx context.Context, network string) (json.RawMessage, error) {
	url := fmt.Sprintf("%s/networks/%s/authorization", c.newtronBase(), network)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}
	if err := classifyResponse(resp.StatusCode, body, http.StatusOK); err != nil {
		return nil, err
	}

	var env newtronAPIResponse
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if env.Error != "" {
		return nil, &UnavailableError{Cause: env.Error}
	}
	return env.Data, nil
}
