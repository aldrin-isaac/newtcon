// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase. CLAUDE.md §newtron API Consumption Rule: all newtron HTTP traffic
// originates here; no other package may construct an http.Client or call
// http.Get/http.Post against newtron-server's address.
//
// This file implements service-related newtron calls:
//   - [Client.Network] — returns the network ID newtcon-server uses for v1.
//   - [Client.ListServices] — GET /newtron/v1/networks/{netID}/services.
//   - [Client.ShowService] — GET /newtron/v1/networks/{netID}/services/{name}.
//
// Newtron substrate verified against pkg/newtron/api/handler.go buildMux():
//   - mux.HandleFunc("GET /newtron/v1/networks/{netID}/services",         s.handleListServices)
//   - mux.HandleFunc("GET /newtron/v1/networks/{netID}/services/{name}",  s.handleShowService)
package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// NewtronService is the minimal type decoded from GET /networks/{netID}/services.
// Newtron returns {"data":["svc1","svc2"],"error":""} — an array of service
// name strings (confirmed: pkg/newtron/spec_ops.go:16 ListServices() []string).
//
// Only the name is available from the list endpoint; the full detail (including
// service type) requires a separate ShowService call.
type NewtronService struct {
	Name string
}

// NewtronServiceDetail is the type decoded from GET /networks/{netID}/services/{name}.
// Newtron returns {"data":{...ServiceDetail...},"error":""}.
//
// The JSON field for service type is "service_type" (not "type") — confirmed
// from pkg/newtron/types.go:476 ServiceDetail.ServiceType json:"service_type".
// The handler's callers (internal/handlers/services.go) translate this to the
// outward "type" field per API_CONTRACT.md §GET /api/services line 1365.
//
// Raw captures the full newtron response payload for forward-compat per
// DESIGN_PRINCIPLES_NEWTRON.md §46 additive evolution. Fields not consumed by
// this slice are preserved for future slices without a re-decode.
type NewtronServiceDetail struct {
	// Name is the service spec name.
	Name string `json:"name"`

	// ServiceType is the bounded service kind string from newtron's substrate.
	// JSON key is "service_type" per pkg/newtron/types.go:476.
	//
	// Post-ship gap: newtron defines "evpn-routed" (pkg/newtron/types.go
	// ServiceTypeEVPNRouted) which does not appear in the contract's enumerated
	// type values. Surfaced as Implementer note; no action in this slice.
	ServiceType string `json:"service_type"`

	// Raw holds the full decoded newtron payload for forward-compat.
	Raw json.RawMessage `json:"-"`
}

// networkCtxKey is the private context-key type used to plumb the active
// network ID through request handlers.
type networkCtxKey struct{}

// DefaultNetworkID is the fallback when no explicit selection is in context.
// Matches the value newt-server auto-registers via --net-id.
const DefaultNetworkID = "default"

// ContextWithNetwork returns ctx with id set as the active network. Callers
// (newtcon-server's middleware) inject the operator's selection here; every
// downstream c.Network(ctx) call reads it back. Empty id is treated as
// "no selection" — Network(ctx) then returns DefaultNetworkID.
func ContextWithNetwork(ctx context.Context, id string) context.Context {
	if id == "" {
		return ctx
	}
	return context.WithValue(ctx, networkCtxKey{}, id)
}

// Network returns the network ID newtcon-server uses for this request.
// Reads the value stashed by ContextWithNetwork; falls back to
// DefaultNetworkID.
func (c *Client) Network(ctx context.Context) string {
	if v, ok := ctx.Value(networkCtxKey{}).(string); ok && v != "" {
		return v
	}
	return DefaultNetworkID
}

// ListServices calls GET /newtron/v1/networks/{netID}/services and returns the
// list of service names registered in that network.
//
// Newtron returns {"data":["svc1","svc2"],"error":""} — see
// pkg/newtron/api/handler_network.go handleListServices.
//
// Error mapping:
//   - Transport failure or 5xx → *UnavailableError
//   - 404 (network not registered) → *NotFoundError
//   - Other 4xx → *UnavailableError (unexpected from this endpoint)
func (c *Client) ListServices(ctx context.Context, network string) ([]NewtronService, error) {
	url := fmt.Sprintf("%s/networks/%s/services", c.newtronBase(), network)
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

	switch {
	case resp.StatusCode == http.StatusOK:
		// OK — fall through to decode.
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: body}
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
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding newtron response envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &UnavailableError{Cause: apiResp.Error}
	}

	// Newtron returns ["svc1","svc2"] — a JSON array of strings.
	var names []string
	if err := json.Unmarshal(apiResp.Data, &names); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding service name list: %v", err)}
	}

	services := make([]NewtronService, len(names))
	for i, name := range names {
		services[i] = NewtronService{Name: name}
	}
	return services, nil
}

// ShowService calls GET /newtron/v1/networks/{netID}/services/{name} and returns
// the full service detail for the named service.
//
// Newtron returns {"data":{...ServiceDetail...},"error":""} — see
// pkg/newtron/api/handler_network.go handleShowService.
//
// Error mapping:
//   - Transport failure or 5xx → *UnavailableError
//   - 404 (service not found) → *NotFoundError
//   - Other 4xx → *UnavailableError (unexpected from this endpoint in v1)
func (c *Client) ShowService(ctx context.Context, network, name string) (*NewtronServiceDetail, error) {
	url := fmt.Sprintf("%s/networks/%s/services/%s", c.newtronBase(), network, name)
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

	switch {
	case resp.StatusCode == http.StatusOK:
		// OK — fall through to decode.
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: body}
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
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding newtron response envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &UnavailableError{Cause: apiResp.Error}
	}

	var detail NewtronServiceDetail
	if err := json.Unmarshal(apiResp.Data, &detail); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding service detail: %v", err)}
	}
	// Preserve the raw payload for forward-compat per DESIGN_PRINCIPLES_NEWTRON §46.
	detail.Raw = apiResp.Data

	return &detail, nil
}
