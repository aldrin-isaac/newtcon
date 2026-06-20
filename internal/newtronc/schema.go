// newtronc/schema.go — read the spec-authoring schema metadata from
// newtron-server (newtron PR #240).
//
// Two endpoints sit at the root of /newtron/v1/ (not under
// /networks/{netID}/...) because the schema is global to the newtron
// install, not per-network:
//
//	GET /newtron/v1/schema           → list of registered kinds
//	GET /newtron/v1/schema/{kind}    → full per-kind field metadata
//
// Newtcon uses these to drive create-form labels + tooltips + types
// from newtron's own struct tags, so labels can't drift from the
// schema they describe.
//
// Returns the decoded "data" field verbatim as RawMessage — newtcon's
// handler layer forwards it to the browser unchanged, and the
// frontend client typechecks the shape on its side.
package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// FetchSchemaKinds calls GET /newtron/v1/schema and returns the
// "data" payload — the list of registered spec authoring kinds.
func (c *Client) FetchSchemaKinds(ctx context.Context) (json.RawMessage, error) {
	return c.getAndDecode(ctx, c.newtronBase()+"/schema")
}

// FetchSchema calls GET /newtron/v1/schema/{kind} and returns the
// "data" payload — full field metadata for one kind. 404 (unknown
// kind) is surfaced as NotFoundError.
func (c *Client) FetchSchema(ctx context.Context, kind string) (json.RawMessage, error) {
	return c.getAndDecode(ctx, fmt.Sprintf("%s/schema/%s", c.newtronBase(), kind))
}

// FetchAllSchemas calls GET /newtron/v1/schema/all (newtron PR #242)
// and returns the "data" payload — every registered kind's full
// SchemaMeta in one round-trip. Preferred over FetchSchemaKinds +
// per-kind FetchSchema when the caller needs full metadata for every
// kind (e.g. cold-start kind resolution).
func (c *Client) FetchAllSchemas(ctx context.Context) (json.RawMessage, error) {
	return c.getAndDecode(ctx, c.newtronBase()+"/schema/all")
}

// getAndDecode — shared GET-and-unwrap-envelope path used by both
// schema endpoints. Keeps the wire shape mapping in one place.
func (c *Client) getAndDecode(ctx context.Context, url string) (json.RawMessage, error) {
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
