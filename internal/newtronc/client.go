// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase. CLAUDE.md §1 binds this: no other package may import newtron Go
// packages, construct an http.Client, or call http.Get/http.Post against
// newtron-server's address. The rule is enforced by convention + review +
// grep (there is no CI gate today).
//
// Wire shape (newtron docs/newt-server.md). The base URL points at the
// aggregated bin/newt-server, which fans out by prefix to three engines and
// its own health probe. All path construction in this package routes through
// the engine-base helpers below; per-callsite Sprintf must not concatenate
// the prefix again.
//
//	/newtron/v1/...        newtron engine        →  c.newtronBase()
//	/newtlab/v1/...        newtlab engine        →  c.newtlabBase()    (newtlab.go)
//	/newt-server/v1/health server-level liveness →  c.newtServerBase()
//
// No c.newtrunBase() today — newtrun has no newtronc-mediated routes (see
// note above newtronBase below).
//
// Concurrency: as of newtron PR #101 (see docs/newtron/hld.md §8) the API
// layer holds no spec lock and per-engine atomicity is owned by the engine.
// Multiple concurrent calls through this client into the same network are
// safe; callers do not need to serialize.
package newtronc

import (
	"bytes"
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

// Engine-base helpers — the only places the service prefix string lives.
//
// docs/newt-server.md (newtron repo) pins these prefixes. newt-server's outer
// mux routes by prefix only and forwards the URL to the engine handler
// unchanged. Callers Sprintf relative paths onto the helper output; they MUST
// NOT concatenate "/newtron/v1" themselves.
//
// There is no newtrunBase(): newtrun's /newtrun/v1/topologies has been removed
// (spec-scaffolding moved to POST /newtron/v1/networks {scaffold:true}; see
// [Client.RegisterNetwork]). Add a newtrunBase() helper if and when a real
// newtrun endpoint surfaces.

func (c *Client) newtronBase() string    { return c.baseURL + "/newtron/v1" }
func (c *Client) newtServerBase() string { return c.baseURL + "/newt-server/v1" }

// networkEntry is the minimal shape we decode from GET /networks responses.
// Newtron returns an array of network objects; we only need the ID field for
// the health probe.
type networkEntry struct {
	ID string `json:"id"`
}

// NetworkInfo mirrors newtron's per-network record returned by GET
// /newtron/v1/networks. Exposed by Client.ListNetworksDetail and surfaced
// by newtcon-server's GET /api/networks for the topology-switcher UI.
type NetworkInfo struct {
	ID          string   `json:"id"`
	SpecDir     string   `json:"spec_dir"`
	HasTopology bool     `json:"has_topology"`
	Topology    string   `json:"topology"`
	Nodes       []string `json:"nodes"`
}

// ListNetworksDetail returns the full per-network record for every registered
// network. Use [Client.ListNetworks] when only the IDs are needed.
func (c *Client) ListNetworksDetail(ctx context.Context) ([]NetworkInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.newtronBase()+"/networks", nil)
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
	if resp.StatusCode == http.StatusForbidden {
		return nil, decodeAuthorizationError(resp.StatusCode, body)
	}
	if resp.StatusCode >= 500 {
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	}
	var env newtronAPIResponse
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if env.Error != "" {
		return nil, &UnavailableError{Cause: env.Error}
	}
	var infos []NetworkInfo
	if err := json.Unmarshal(env.Data, &infos); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding network list: %v", err)}
	}
	return infos, nil
}

// ListNetworks calls GET /newtron/v1/networks and returns the IDs of all
// registered networks (pkg/newtron/api/handler.go — handleListNetworks).
//
// On any non-200 response, ListNetworks returns a *UnavailableError (5xx) or
// the appropriate typed error. On transport failure, it returns a
// *UnavailableError wrapping the original error.
func (c *Client) ListNetworks(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.newtronBase()+"/networks", nil)
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
	case resp.StatusCode == http.StatusForbidden:
		return nil, decodeAuthorizationError(resp.StatusCode, body)
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

// newtServerHealthData is the data field shape inside the envelope returned by
// GET /newt-server/v1/health. Documented in newtron's docs/newt-server.md
// (Routes table); the response payload was observed live as
// {"data":{"status":"ok","version":"dev"}}. The version field is best-effort
// (it carries the newtron build's version stamp); the probe does not require
// it for reachability.
type newtServerHealthData struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

// Health probes newt-server's reachability via the server-level liveness
// endpoint, GET /newt-server/v1/health (docs/newt-server.md Routes table).
//
// This is the cheap path: it does not spin up any engine's network-list code,
// it is documented as the server-level health probe, and it returns a short
// JSON envelope newt-server constructs synchronously.
//
// Returns (true, version) when the endpoint responds 200 with status:"ok".
// Returns (false, "") for any non-200 response, transport failure, or
// undecodable envelope.
func (c *Client) Health(ctx context.Context) (reachable bool, version string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.newtServerBase()+"/health", nil)
	if err != nil {
		return false, ""
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, ""
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, ""
	}
	var env newtronAPIResponse
	if err := json.Unmarshal(body, &env); err != nil {
		return false, ""
	}
	var data newtServerHealthData
	if err := json.Unmarshal(env.Data, &data); err != nil {
		// Server responded 200 but with an unexpected envelope. Treat as
		// "reachable but version unknown" — the status code is the load-bearing
		// signal for the status pill.
		return true, ""
	}
	return data.Status == "ok", data.Version
}

// RegisterNetwork registers a network with newtron. Mirrors the wire shape
// documented in newtron's docs/newtron/api.md §POST /newtron/v1/networks:
//
//	{"id":..., "spec_dir":..., "scaffold":..., "description":...}
//
// When scaffold=false (the default), the spec_dir must already contain a
// valid spec layout and newtron loads it as-is. When scaffold=true, newtron
// creates an empty spec layout at spec_dir (three zero-valued spec files and
// an empty profiles/ subdirectory) before registering. description is only
// consulted on scaffold=true and seeds topology.json's description field.
//
// Error mapping (newtron docs api.md §Status codes):
//
//	400 → *ValidationError (missing id/spec_dir or invalid JSON)
//	409 → *ConflictError   (id already registered OR scaffold-into-initialized-dir)
//	5xx → *UnavailableError (spec directory load error)
//
// Callers cannot disambiguate the two 409 causes from the typed error alone;
// the underlying response body (preserved in *ConflictError.Body) carries the
// distinguishing message from newtron.
//
// Returns the network ID newtron acknowledged.
func (c *Client) RegisterNetwork(ctx context.Context, id, specDir string, scaffold bool, description string) (string, error) {
	body := map[string]any{
		"id":       id,
		"spec_dir": specDir,
	}
	if scaffold {
		body["scaffold"] = true
		if description != "" {
			body["description"] = description
		}
	}
	b, err := json.Marshal(body)
	if err != nil {
		return "", &UnavailableError{Cause: fmt.Sprintf("marshalling request: %v", err)}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.newtronBase()+"/networks", bytes.NewReader(b))
	if err != nil {
		return "", &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}
	switch {
	case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated:
		// fall through
	case resp.StatusCode == http.StatusBadRequest:
		return "", &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusNotFound:
		return "", &NotFoundError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusConflict:
		return "", &ConflictError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusForbidden:
		return "", decodeAuthorizationError(resp.StatusCode, respBody)
	case resp.StatusCode >= 500:
		return "", &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	default:
		return "", &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	}
	var env newtronAPIResponse
	if err := json.Unmarshal(respBody, &env); err != nil {
		return "", &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if env.Error != "" {
		return "", &UnavailableError{Cause: env.Error}
	}
	var data struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		return "", &UnavailableError{Cause: fmt.Sprintf("decoding RegisterNetwork response: %v", err)}
	}
	return data.ID, nil
}
