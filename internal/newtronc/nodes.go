// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase. CLAUDE.md §newtron API Consumption Rule: all newtron HTTP traffic
// originates here; no other package may construct an http.Client or call
// http.Get/http.Post against newtron-server's address.
//
// This file implements node-level and topology proxy calls. Every method
// proxies one newtron endpoint verbatim and returns the decoded "data" field
// as json.RawMessage so handlers can forward it without field stripping.
//
// Newtron substrate verified against pkg/newtron/api/handler.go buildMux():
//   - Line 47: "GET /network/{netID}/topology"
//   - Lines 102-116: all node read endpoints
//   - Lines 150-152: CONFIG_DB endpoints
package newtronc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// nodeGet is the shared helper for every node-level GET endpoint that proxies
// newtron verbatim. It builds the URL from the path fragments, executes the
// request, and returns the decoded "data" field as RawMessage.
//
// The path argument must begin with "/" and be relative to baseURL — e.g.
// "/newtron/v1/network/default/node/switch1/info".
func (c *Client) nodeGet(ctx context.Context, path string) (json.RawMessage, error) {
	url := c.baseURL + path
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
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	default:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &UnavailableError{Cause: apiResp.Error}
	}
	return apiResp.Data, nil
}

// Topology calls GET /network/{netID}/topology and returns the full topology
// payload (devices + links + interfaces).
//
// Substrate: pkg/newtron/api/handler.go line 47.
func (c *Client) Topology(ctx context.Context, network string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/topology", network))
}

// NodeInfo calls GET /network/{netID}/node/{device}/info.
//
// Substrate: pkg/newtron/api/handler.go line 102.
func (c *Client) NodeInfo(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/info", network, device))
}

// NodeHealth calls GET /network/{netID}/node/{device}/health.
//
// Substrate: pkg/newtron/api/handler.go line 114.
func (c *Client) NodeHealth(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/health", network, device))
}

// NodeInterfaces calls GET /network/{netID}/node/{device}/interface.
//
// Substrate: pkg/newtron/api/handler.go line 103.
func (c *Client) NodeInterfaces(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/interface", network, device))
}

// NodeInterface calls GET /network/{netID}/node/{device}/interface/{name}.
//
// Substrate: pkg/newtron/api/handler.go line 104.
func (c *Client) NodeInterface(ctx context.Context, network, device, name string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/interface/%s", network, device, name))
}

// NodeInterfaceBinding calls GET /network/{netID}/node/{device}/interface/{name}/binding.
//
// Substrate: pkg/newtron/api/handler.go line 105.
func (c *Client) NodeInterfaceBinding(ctx context.Context, network, device, name string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/interface/%s/binding", network, device, name))
}

// NodeVLANs calls GET /network/{netID}/node/{device}/vlan.
//
// Substrate: pkg/newtron/api/handler.go line 106.
func (c *Client) NodeVLANs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/vlan", network, device))
}

// NodeVRFs calls GET /network/{netID}/node/{device}/vrf.
//
// Substrate: pkg/newtron/api/handler.go line 108.
func (c *Client) NodeVRFs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/vrf", network, device))
}

// NodeACLs calls GET /network/{netID}/node/{device}/acl.
//
// Substrate: pkg/newtron/api/handler.go line 110.
func (c *Client) NodeACLs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/acl", network, device))
}

// NodeLAGs calls GET /network/{netID}/node/{device}/lag.
//
// Substrate: pkg/newtron/api/handler.go line 115.
func (c *Client) NodeLAGs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/lag", network, device))
}

// NodeNeighbors calls GET /network/{netID}/node/{device}/neighbor.
//
// Substrate: pkg/newtron/api/handler.go line 116.
func (c *Client) NodeNeighbors(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/neighbor", network, device))
}

// NodeBGPStatus calls GET /network/{netID}/node/{device}/bgp/status.
//
// Substrate: pkg/newtron/api/handler.go line 112.
func (c *Client) NodeBGPStatus(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/bgp/status", network, device))
}

// NodeEVPNStatus calls GET /network/{netID}/node/{device}/evpn/status.
//
// Substrate: pkg/newtron/api/handler.go line 113.
func (c *Client) NodeEVPNStatus(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/evpn/status", network, device))
}

// NodeConfigDB calls GET /network/{netID}/node/{device}/configdb.
//
// Substrate: pkg/newtron/api/handler.go line 150.
func (c *Client) NodeConfigDB(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/configdb", network, device))
}

// NodeConfigDBTable calls GET /network/{netID}/node/{device}/configdb/{table}.
//
// Substrate: pkg/newtron/api/handler.go line 151.
func (c *Client) NodeConfigDBTable(ctx context.Context, network, device, table string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/configdb/%s", network, device, table))
}

// NodeConfigDBEntry calls GET /network/{netID}/node/{device}/configdb/{table}/{key}.
//
// Substrate: pkg/newtron/api/handler.go line 152.
func (c *Client) NodeConfigDBEntry(ctx context.Context, network, device, table, key string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/configdb/%s/%s", network, device, table, key))
}

// NodeDrift calls GET /network/{netID}/node/{device}/intent/drift.
// Returns the per-device drift report comparing intent vs CONFIG_DB reality.
func (c *Client) NodeDrift(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/intent/drift", network, device))
}

// NodeProjection calls GET /network/{netID}/node/{device}/intent/projection.
func (c *Client) NodeProjection(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/intent/projection", network, device))
}

// NodeIntentTree calls GET /network/{netID}/node/{device}/intent/tree.
func (c *Client) NodeIntentTree(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/newtron/v1/network/%s/node/%s/intent/tree", network, device))
}

// NodeReconcile calls POST /network/{netID}/node/{device}/intent/reconcile.
// dryRun=true returns the drift as a preview; dryRun=false executes.
// mode is one of "topology" or "" (defaults to delta).
func (c *Client) NodeReconcile(ctx context.Context, network, device string, dryRun bool, mode string) (json.RawMessage, error) {
	path := fmt.Sprintf("/newtron/v1/network/%s/node/%s/intent/reconcile", network, device)
	q := []string{}
	if dryRun {
		q = append(q, "dry_run=true")
	}
	if mode != "" {
		q = append(q, "mode="+mode)
	}
	if len(q) > 0 {
		path += "?" + strings.Join(q, "&")
	}
	return c.nodePost(ctx, path)
}

// ============================================================================
// Topology write operations
// ============================================================================

// nodePostBody is the shared helper for POST requests with a JSON body. It
// follows the same error mapping as networkPost in network.go.
//
// Newtron topology write endpoints:
//
//	handler.go line 50: POST /network/{netID}/topology/create-node
//	handler.go line 51: DELETE /network/{netID}/topology/node/{name}
//	handler.go line 52: PUT /network/{netID}/topology/node/{name}
//	handler.go line 53: POST /network/{netID}/topology/create-link
//	handler.go line 54: DELETE /network/{netID}/topology/link/{device}/{interface}
func (c *Client) nodePostBody(ctx context.Context, path string, body any) (json.RawMessage, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("marshalling request: %v", err)}
	}
	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}

	switch {
	case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated:
	case resp.StatusCode == http.StatusBadRequest:
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusConflict:
		return nil, &ConflictError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	default:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	}
	return apiResp.Data, nil
}

// nodePutBody sends a PUT request with a JSON body to the given path.
// Used for topology device updates (handler.go line 52).
func (c *Client) nodePutBody(ctx context.Context, path string, body any) (json.RawMessage, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("marshalling request: %v", err)}
	}
	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(b))
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}

	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusBadRequest:
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusConflict:
		return nil, &ConflictError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	default:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	}
	return apiResp.Data, nil
}

// nodeDelete sends a DELETE request to path and returns the data field.
// 200/201 accepted; 400 → ValidationError; 404 → NotFoundError; 409 → ConflictError.
func (c *Client) nodeDelete(ctx context.Context, path string) (json.RawMessage, error) {
	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}

	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusBadRequest:
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusConflict:
		return nil, &ConflictError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	default:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	}
	return apiResp.Data, nil
}

// CreateTopologyDevice adds a device to the topology.
//
// Newtron body shape (handler_network.go:389-405, types.go:109-112):
//
//	{ "name": string, "device": TopologyDevice }
//
// where TopologyDevice is { "steps": [...], "ports": {...} }.
// Substrate: handler.go line 50.
func (c *Client) CreateTopologyDevice(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.nodePostBody(ctx, fmt.Sprintf("/network/%s/topology/create-node", network), body)
}

// DeleteTopologyDevice removes a device from the topology by name.
// force=true cascade-deletes referring links (handler_network.go:413-429).
// Substrate: handler.go line 51.
func (c *Client) DeleteTopologyDevice(ctx context.Context, network, name string, force bool) (json.RawMessage, error) {
	path := fmt.Sprintf("/network/%s/topology/node/%s", network, name)
	if force {
		path += "?force=true"
	}
	return c.nodeDelete(ctx, path)
}

// UpdateTopologyDevice replaces the device entry at name with the given body.
// Body is a complete TopologyDevice (handler_network.go:435-455, spec.TopologyDevice).
// Substrate: handler.go line 52.
func (c *Client) UpdateTopologyDevice(ctx context.Context, network, name string, body any) (json.RawMessage, error) {
	return c.nodePutBody(ctx, fmt.Sprintf("/network/%s/topology/node/%s", network, name), body)
}

// CreateTopologyLink adds a link between two interfaces.
//
// Newtron body shape (handler_network.go:460-478, spec.TopologyLink):
//
//	{ "a": "device:interface", "z": "device:interface" }
//
// Substrate: handler.go line 53.
func (c *Client) CreateTopologyLink(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.nodePostBody(ctx, fmt.Sprintf("/network/%s/topology/create-link", network), body)
}

// DeleteTopologyLink removes the link containing the given endpoint.
// Endpoint is "device:interface" — one endpoint uniquely identifies the link
// (handler_network.go:484-504). URL path: /topology/link/{device}/{interface}.
// Substrate: handler.go line 54.
func (c *Client) DeleteTopologyLink(ctx context.Context, network, device, iface string) (json.RawMessage, error) {
	path := fmt.Sprintf("/network/%s/topology/link/%s/%s", network, device, iface)
	return c.nodeDelete(ctx, path)
}

// ============================================================================
// Interface service binding operations
// ============================================================================

// ApplyService binds a service to an interface (apply-service RPC).
//
// Newtron body shape (types.go:50-57, handler_interface.go:15-48):
//
//	{ "service": string, "ip_address"?: string, "vlan"?: int, "peer_as"?: int, "params"?: object }
//
// service is required; all others optional.
// Substrate: handler.go line 174.
func (c *Client) ApplyService(ctx context.Context, network, device, ifaceName string, body any) (json.RawMessage, error) {
	path := fmt.Sprintf("/network/%s/node/%s/interface/%s/apply-service", network, device, ifaceName)
	return c.nodePostBody(ctx, path, body)
}

// RemoveService unbinds any service from an interface (remove-service RPC).
// No request body required (handler_interface.go:50-69).
// Substrate: handler.go line 175.
func (c *Client) RemoveService(ctx context.Context, network, device, ifaceName string) (json.RawMessage, error) {
	path := fmt.Sprintf("/network/%s/node/%s/interface/%s/remove-service", network, device, ifaceName)
	return c.nodePost(ctx, path)
}

// RefreshService re-applies the bound service on an interface (refresh-service RPC).
// No request body required (handler_interface.go:71-90).
// Substrate: handler.go line 176.
func (c *Client) RefreshService(ctx context.Context, network, device, ifaceName string) (json.RawMessage, error) {
	path := fmt.Sprintf("/network/%s/node/%s/interface/%s/refresh-service", network, device, ifaceName)
	return c.nodePost(ctx, path)
}

// nodePost is a POST analog of nodeGet (no body).
func (c *Client) nodePost(ctx context.Context, path string) (json.RawMessage, error) {
	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
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
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	default:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	}
	var apiResp newtronAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &UnavailableError{Cause: apiResp.Error}
	}
	return apiResp.Data, nil
}
