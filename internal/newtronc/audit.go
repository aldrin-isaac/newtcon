// newtronc/audit.go — read newtron's audit log + L6 hash-chain
// integrity status (slice #175.B). Powers the Audit tab.
//
// Newtron PR #197 shipped two HTTP endpoints under the engage-when-
// configured `audit.read` permission:
//
//	GET /newtron/v1/networks/{netID}/audit/events?...     paged events
//	GET /newtron/v1/networks/{netID}/audit/integrity      L6 verify
//
// Both endpoints return 404 when newtron-server was started without
// --audit-log; classifyResponse maps that to NotFoundError so the
// handler can render a teaching empty state ("audit logging is
// disabled on this deployment") instead of a transient error.

package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// AuditEvents calls GET /networks/{netID}/audit/events?<rawQuery>.
// rawQuery is forwarded verbatim — the handler is responsible for any
// filter normalisation. Returns the raw "data" payload so the frontend
// can render the response shape directly (AuditEventPage).
func (c *Client) AuditEvents(ctx context.Context, network, rawQuery string) (json.RawMessage, error) {
	return c.auditGet(ctx, fmt.Sprintf("/networks/%s/audit/events", network), rawQuery)
}

// AuditIntegrity calls GET /networks/{netID}/audit/integrity. Returns
// the raw AuditIntegrityResult payload.
func (c *Client) AuditIntegrity(ctx context.Context, network string) (json.RawMessage, error) {
	return c.auditGet(ctx, fmt.Sprintf("/networks/%s/audit/integrity", network), "")
}

// auditGet is the shared GET helper for the two audit endpoints. Same
// shape as the per-endpoint helpers in network.go / authorization.go
// — kept local here so the audit-specific URL format and error mapping
// stay co-located with the methods that use them.
func (c *Client) auditGet(ctx context.Context, path, rawQuery string) (json.RawMessage, error) {
	url := c.newtronBase() + path
	if rawQuery != "" {
		url += "?" + rawQuery
	}
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
