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

// getAndDecode — shared GET-and-unwrap-envelope path used by the
// schema endpoints. Keeps the wire shape mapping in one place.
func (c *Client) getAndDecode(ctx context.Context, url string) (json.RawMessage, error) {
	data, _, err := c.getAndDecodeConditional(ctx, url, "")
	return data, err
}

// SchemaCacheValidator carries the cache headers the schema handlers
// need to relay between newtron upstream and the browser. Empty
// Status means "no response received" (network error / pre-fetch
// failure); use NotModified to distinguish 304 from 200.
type SchemaCacheValidator struct {
	LastModified string // upstream's Last-Modified header verbatim, empty when absent
	NotModified  bool   // true when upstream returned 304 (Data will be nil)
}

// getAndDecodeConditional is the cache-aware variant: forwards
// `If-Modified-Since` to newtron and returns
// (nil data, NotModified=true) on a 304, or
// (decoded data, NotModified=false) on a 200. Either way the
// upstream's `Last-Modified` is propagated through the validator
// so the calling handler can echo it to the browser.
//
// When ifModifiedSince is "", the request is unconditional — semantics
// match getAndDecode (always returns 200 + data, never 304).
func (c *Client) getAndDecodeConditional(
	ctx context.Context, url, ifModifiedSince string,
) (json.RawMessage, SchemaCacheValidator, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, SchemaCacheValidator{}, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Accept", "application/json")
	if ifModifiedSince != "" {
		req.Header.Set("If-Modified-Since", ifModifiedSince)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, SchemaCacheValidator{}, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	validator := SchemaCacheValidator{
		LastModified: resp.Header.Get("Last-Modified"),
		NotModified:  resp.StatusCode == http.StatusNotModified,
	}
	if validator.NotModified {
		// Drain body so the connection is reusable; 304 bodies are
		// conventionally empty but the standard doesn't forbid them.
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, validator, nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, validator, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}
	if err := classifyResponse(resp.StatusCode, body, http.StatusOK); err != nil {
		return nil, validator, err
	}

	var env newtronAPIResponse
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, validator, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if env.Error != "" {
		return nil, validator, &UnavailableError{Cause: env.Error}
	}
	return env.Data, validator, nil
}

// FetchSchemaKindsConditional, FetchSchemaConditional,
// FetchAllSchemasConditional — cache-aware variants of the three
// public schema fetchers. Used by the schema HTTP handlers to relay
// `If-Modified-Since` + `Last-Modified` between newtron and the
// browser, so long-lived browser tabs detect schema rolls via
// 304s rather than re-downloading the full payload each time.

// FetchSchemaKindsConditional mirrors FetchSchemaKinds but accepts
// the browser's If-Modified-Since header and surfaces the upstream
// 304 + Last-Modified via SchemaCacheValidator.
func (c *Client) FetchSchemaKindsConditional(
	ctx context.Context, ifModifiedSince string,
) (json.RawMessage, SchemaCacheValidator, error) {
	return c.getAndDecodeConditional(ctx, c.newtronBase()+"/schema", ifModifiedSince)
}

// FetchSchemaConditional mirrors FetchSchema with cache awareness.
// 404 (unknown kind) is still surfaced as NotFoundError; cache hits
// (304) return NotModified=true with a nil body.
func (c *Client) FetchSchemaConditional(
	ctx context.Context, kind, ifModifiedSince string,
) (json.RawMessage, SchemaCacheValidator, error) {
	return c.getAndDecodeConditional(ctx, fmt.Sprintf("%s/schema/%s", c.newtronBase(), kind), ifModifiedSince)
}

// FetchAllSchemasConditional mirrors FetchAllSchemas with cache
// awareness. Most-frequently consulted endpoint, so the largest
// bandwidth saving comes from this one.
func (c *Client) FetchAllSchemasConditional(
	ctx context.Context, ifModifiedSince string,
) (json.RawMessage, SchemaCacheValidator, error) {
	return c.getAndDecodeConditional(ctx, c.newtronBase()+"/schema/all", ifModifiedSince)
}
