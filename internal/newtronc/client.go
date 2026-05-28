// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase. CLAUDE.md §newtron API Consumption Rule: "All newtron interaction
// is mediated by one package, internal/newtronc/, which is the only HTTP client
// of newtron-server in the codebase. CI enforces this isolation: no other
// package may construct an http.Client or call http.Get/http.Post against
// newtron-server's address."
package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	// DefaultTimeout is the default per-request timeout for calls to newtron-server.
	// Overridden via WithTimeout.
	DefaultTimeout = 10 * time.Second
)

// Client is the HTTP client for newtron-server. It is the ONLY mechanism through
// which newtcon-server communicates with newtron-server.
//
// Construct with New; do not zero-initialise.
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// Option configures a [Client] at construction time.
type Option func(*Client)

// WithHTTPClient replaces the underlying *http.Client. Useful in tests to inject
// an httptest.Server transport without touching real network.
func WithHTTPClient(c *http.Client) Option {
	return func(cl *Client) {
		cl.httpClient = c
	}
}

// WithTimeout sets the per-request timeout. Default is [DefaultTimeout].
func WithTimeout(d time.Duration) Option {
	return func(cl *Client) {
		cl.httpClient.Timeout = d
	}
}

// New constructs a [Client] targeting the newtron-server at baseURL.
//
// baseURL should include scheme and host (e.g., "http://127.0.0.1:9090") with
// no trailing slash. Options are applied in order; later options override earlier
// ones for the same field.
func New(baseURL string, opts ...Option) *Client {
	c := &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: DefaultTimeout,
		},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// newtronAPIResponse is the envelope newtron-server wraps all successful list
// responses in. Per pkg/newtron/api/types.go APIResponse.
//
// The data field is decoded as json.RawMessage so callers can unmarshal into
// the concrete type they need without a second reflection pass.
type newtronAPIResponse struct {
	Data  json.RawMessage `json:"data"`
	Error string          `json:"error"`
}

// networkEntry is the minimal shape we decode from GET /network responses.
// Newtron returns an array of network objects; we only need the ID field for
// the health probe.
type networkEntry struct {
	ID string `json:"id"`
}

// ListNetworks calls GET {baseURL}/network and returns the IDs of all registered
// networks.
//
// On any non-200 response, ListNetworks returns a *UnavailableError (5xx) or the
// appropriate typed error. On transport failure, it returns a *UnavailableError
// wrapping the original error.
//
// This is also the substrate call used by Health for the reachability probe:
// GET /network is the lightest read newtron-server exposes and is confirmed
// present at pkg/newtron/api/handler.go:23 ("GET /network").
func (c *Client) ListNetworks(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/network", nil)
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

	switch {
	case resp.StatusCode == http.StatusOK:
		// OK — fall through to decode below.
	case resp.StatusCode == http.StatusBadRequest:
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode == http.StatusConflict:
		return nil, &ConflictError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	default:
		return nil, &UnavailableError{
			StatusCode: resp.StatusCode,
			Cause:      fmt.Sprintf("unexpected status %d: %s", resp.StatusCode, string(body)),
		}
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding newtron response: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &UnavailableError{Cause: apiResp.Error}
	}

	var entries []networkEntry
	if err := json.Unmarshal(apiResp.Data, &entries); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding network list: %v", err)}
	}

	ids := make([]string, len(entries))
	for i, e := range entries {
		ids[i] = e.ID
	}
	return ids, nil
}

// Health probes newtron-server's reachability by calling ListNetworks.
//
// Returns (true, "") if newtron-server is reachable (any non-error response).
// Returns (false, "") if newtron-server is unreachable.
//
// The version string is always "" in v1. Newtron-server exposes no /version
// endpoint (confirmed: pkg/newtron/api/handler.go buildMux() registers only
// POST/GET /network at the top level — no /health or /version route). This is
// a v1 limitation; newtron-version is not load-bearing for Composer v1.
func (c *Client) Health(ctx context.Context) (reachable bool, version string) {
	_, err := c.ListNetworks(ctx)
	if err != nil {
		return false, ""
	}
	return true, ""
}
