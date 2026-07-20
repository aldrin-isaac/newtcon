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
	"crypto/tls"
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

	// DefaultProvisionTimeout is the timeout for long synchronous lab operations
	// (provision). Provisioning a device pushes config over SSH and can restart
	// SONiC containers, legitimately taking minutes — the short DefaultTimeout
	// would mask the real outcome behind a client timeout. Overridden via
	// WithProvisionTimeout.
	DefaultProvisionTimeout = 10 * time.Minute
)

// Client is the HTTP client for newtron-server. It is the ONLY mechanism through
// which newtcon-server communicates with newtron-server.
//
// Construct with New; do not zero-initialise.
type Client struct {
	baseURL    string
	httpClient *http.Client
	// longClient shares httpClient's Transport (bearer + TLS) but carries a
	// much longer timeout, for synchronous operations that legitimately run for
	// minutes (lab provision). Built in New after options are applied.
	longClient       *http.Client
	provisionTimeout time.Duration
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

// WithProvisionTimeout sets the timeout for long synchronous lab operations
// (provision). Default is [DefaultProvisionTimeout].
func WithProvisionTimeout(d time.Duration) Option {
	return func(cl *Client) {
		cl.provisionTimeout = d
	}
}

// WithTLSConfig sets the TLS config used by the client's outbound transport.
// Pass nil for Go's defaults (system root CAs). Use [BuildTLSConfig] to
// construct from --newtron-ca-cert / --newtron-skip-tls-verify flag values.
//
// No-op if the underlying transport has been replaced (e.g., via
// [WithHTTPClient] for tests) — in that case the caller owns the transport's
// TLS config end-to-end.
func WithTLSConfig(cfg *tls.Config) Option {
	return func(cl *Client) {
		if cfg == nil {
			return
		}
		// The constructor wraps the base *http.Transport in a [bearerInjector];
		// drill through it to find the real transport.
		tr := cl.httpClient.Transport
		if bi, ok := tr.(*bearerInjector); ok {
			tr = bi.inner
		}
		if httpTr, ok := tr.(*http.Transport); ok {
			httpTr.TLSClientConfig = cfg
		}
	}
}

// New constructs a [Client] targeting the newtron-server at baseURL.
//
// baseURL should include scheme and host (e.g., "http://127.0.0.1:9090") with
// no trailing slash. Options are applied in order; later options override earlier
// ones for the same field.
func New(baseURL string, opts ...Option) *Client {
	// Clone http.DefaultTransport so TLSClientConfig is settable per-instance
	// via [WithTLSConfig] without mutating package-global state. Wrap with
	// [bearerInjector] so any request whose ctx carries [WithBearer] picks up
	// the Authorization header automatically.
	base := http.DefaultTransport.(*http.Transport).Clone()
	c := &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout:   DefaultTimeout,
			Transport: &bearerInjector{inner: base},
		},
		provisionTimeout: DefaultProvisionTimeout,
	}
	for _, o := range opts {
		o(c)
	}
	// longClient shares the (possibly option-customized) Transport so bearer +
	// TLS posture match httpClient exactly; only the timeout differs. Built here,
	// after options, so WithHTTPClient / WithTLSConfig are already reflected.
	c.longClient = &http.Client{
		Timeout:   c.provisionTimeout,
		Transport: c.httpClient.Transport,
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
// There is no newtrunBase(): newtrun's /newtrun/v1/topologies has been
// removed (scaffolding folded into POST /newtron/v1/networks per newtron
// PRs #245 + #251; see [Client.CreateNetwork]). Add a newtrunBase()
// helper if and when a real newtrun endpoint surfaces.

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
//
// Wire field renamed spec_dir → dir per newtron PR #208 (2026-06-17): the
// directory IS the network root after the layout collapse, so the old name
// lied about the data model.
type NetworkInfo struct {
	ID          string   `json:"id"`
	Dir         string   `json:"dir"`
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

	if err := classifyResponse(resp.StatusCode, body, http.StatusOK); err != nil {
		return nil, err
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

// CreateNetwork creates a network in newtron, or no-ops idempotently if
// a network with the given id is already registered. Wire shape per
// newtron's docs/newtron/api.md §POST /newtron/v1/networks (newtron
// PRs #245 + #251):
//
//	{"id":..., "description":...}
//
// `id` is the only required field. newtron resolves the on-disk path
// itself (--networks-base/id) — newtcon never carries paths on the
// wire. `description` seeds topology.json when the slot is new; it's
// ignored on existing slots (no rewrite of authored specs).
//
// The `existed` return distinguishes the two success cases:
//
//	201 Created → existed=false (slot was new to the server: either
//	              disk slot was empty and got materialized, or disk
//	              slot had specs that got loaded just now)
//	200 OK      → existed=true  (id was already registered in memory)
//
// A "name already taken" UX branches on existed. There's no 409
// response on this endpoint anymore — same id always resolves to the
// same dir, so the cross-dir disambiguation 409 used to carry is
// structurally impossible.
//
// Error mapping (newtron docs api.md §Status codes):
//
//	400 → *ValidationError (id missing / wrong shape, invalid JSON)
//	5xx → *UnavailableError (filesystem failure materializing the slot)
func (c *Client) CreateNetwork(ctx context.Context, id, description string) (info NetworkInfo, existed bool, err error) {
	body := map[string]any{"id": id}
	if description != "" {
		body["description"] = description
	}
	b, mErr := json.Marshal(body)
	if mErr != nil {
		return NetworkInfo{}, false, &UnavailableError{Cause: fmt.Sprintf("marshalling request: %v", mErr)}
	}
	req, rErr := http.NewRequestWithContext(ctx, http.MethodPost, c.newtronBase()+"/networks", bytes.NewReader(b))
	if rErr != nil {
		return NetworkInfo{}, false, &UnavailableError{Cause: fmt.Sprintf("building request: %v", rErr)}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, dErr := c.httpClient.Do(req)
	if dErr != nil {
		return NetworkInfo{}, false, &UnavailableError{Cause: dErr.Error()}
	}
	defer resp.Body.Close()
	respBody, bErr := io.ReadAll(resp.Body)
	if bErr != nil {
		return NetworkInfo{}, false, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", bErr)}
	}
	if cErr := classifyResponse(resp.StatusCode, respBody, http.StatusOK, http.StatusCreated); cErr != nil {
		return NetworkInfo{}, false, cErr
	}
	var env newtronAPIResponse
	if jErr := json.Unmarshal(respBody, &env); jErr != nil {
		return NetworkInfo{}, false, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", jErr)}
	}
	if env.Error != "" {
		return NetworkInfo{}, false, &UnavailableError{Cause: env.Error}
	}
	if jErr := json.Unmarshal(env.Data, &info); jErr != nil {
		return NetworkInfo{}, false, &UnavailableError{Cause: fmt.Sprintf("decoding CreateNetwork response: %v", jErr)}
	}
	return info, resp.StatusCode == http.StatusOK, nil
}

// Posture probes which optional engine layers are present (uplift 6.4):
// the L2c auth surface (credential-less login POST: 401/400 ⇒ enabled,
// 404 ⇒ absent) and the L6 audit log (first network's audit read: 200 ⇒
// enabled, an error naming "disabled" ⇒ disabled). Probe failures are
// "unknown" — the console never guesses posture.
func (c *Client) Posture(ctx context.Context) (authSurface, auditLog string) {
	authSurface, auditLog = "unknown", "unknown"

	if req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.newtServerBase()+"/auth/login", nil); err == nil {
		if resp, err := c.httpClient.Do(req); err == nil {
			switch resp.StatusCode {
			case http.StatusUnauthorized, http.StatusBadRequest:
				authSurface = "enabled"
			case http.StatusNotFound:
				authSurface = "absent"
			}
			resp.Body.Close()
		}
	}

	if req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.newtronBase()+"/networks", nil); err == nil {
		if resp, err := c.httpClient.Do(req); err == nil {
			// Engine envelope: {"data":[{id,...},...]} — same wrapper every
			// engine read uses.
			var envelope struct {
				Data []networkEntry `json:"data"`
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			nets := envelope.Data
			if resp.StatusCode == http.StatusOK && json.Unmarshal(body, &envelope) == nil {
				nets = envelope.Data
			}
			if resp.StatusCode == http.StatusOK && len(nets) > 0 {
				url := fmt.Sprintf("%s/networks/%s/audit/events?limit=1", c.newtronBase(), nets[0].ID)
				if req2, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil); err == nil {
					if resp2, err := c.httpClient.Do(req2); err == nil {
						body2, _ := io.ReadAll(resp2.Body)
						resp2.Body.Close()
						if resp2.StatusCode == http.StatusOK {
							auditLog = "enabled"
						} else if bytes.Contains(body2, []byte("disabled")) {
							auditLog = "disabled"
						}
					}
				}
			}
		}
	}
	return authSurface, auditLog
}
