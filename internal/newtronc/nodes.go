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
// The path argument must begin with "/" and be relative to the newtron engine
// base — e.g. "/networks/default/nodes/switch1/info". nodeGet prefixes
// /newtron/v1 internally via Client.newtronBase().
func (c *Client) nodeGet(ctx context.Context, path string) (json.RawMessage, error) {
	url := c.newtronBase() + path
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
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/topology", network))
}

// NodeInfo calls GET /networks/{netID}/nodes/{device}/info.
//
// Substrate: pkg/newtron/api/handler.go line 102.
func (c *Client) NodeInfo(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/info", network, device))
}

// NodeHealth calls GET /networks/{netID}/nodes/{device}/health.
//
// Substrate: pkg/newtron/api/handler.go line 114.
func (c *Client) NodeHealth(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/health", network, device))
}

// NodeInterfaces calls GET /networks/{netID}/nodes/{device}/interface.
//
// Substrate: pkg/newtron/api/handler.go line 103.
func (c *Client) NodeInterfaces(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/interfaces", network, device))
}

// NodeInterface calls GET /networks/{netID}/nodes/{device}/interfaces/{name}.
//
// Substrate: pkg/newtron/api/handler.go line 104.
func (c *Client) NodeInterface(ctx context.Context, network, device, name string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/interfaces/%s", network, device, name))
}

// NodeInterfaceBinding calls GET /networks/{netID}/nodes/{device}/interfaces/{name}/binding.
//
// Substrate: pkg/newtron/api/handler.go line 105.
func (c *Client) NodeInterfaceBinding(ctx context.Context, network, device, name string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/interfaces/%s/binding", network, device, name))
}

// NodeVLANs calls GET /networks/{netID}/nodes/{device}/vlan.
//
// Substrate: pkg/newtron/api/handler.go line 106.
func (c *Client) NodeVLANs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/vlans", network, device))
}

// NodeVRFs calls GET /networks/{netID}/nodes/{device}/vrf.
//
// Substrate: pkg/newtron/api/handler.go line 108.
func (c *Client) NodeVRFs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/vrfs", network, device))
}

// NodeACLs calls GET /networks/{netID}/nodes/{device}/acl.
//
// Substrate: pkg/newtron/api/handler.go line 110.
func (c *Client) NodeACLs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/acls", network, device))
}

// NodeLAGs calls GET /networks/{netID}/nodes/{device}/lag.
//
// Substrate: pkg/newtron/api/handler.go line 115.
func (c *Client) NodeLAGs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/lags", network, device))
}

// NodeDBTable calls GET /networks/{netID}/nodes/{device}/db/{db}/{table} —
// newtron's kind-aware operational-DB read (one bulk table per call). The
// console uses it for per-device bulk reads the per-interface status
// endpoint would need N calls for (e.g. APPL_DB/LLDP_ENTRY_TABLE backing
// link-truth classification, slice 4.2).
func (c *Client) NodeDBTable(ctx context.Context, network, device, db, table string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/db/%s/%s", network, device, db, table))
}

// NodeBGPCheck calls GET /networks/{netID}/nodes/{device}/bgp/check — the
// device BGP health-check summary (check/status/message rows). newtron #426
// deleted the /neighbors alias that returned this same payload under an
// adjacency name; /bgp/check is the sole path now.
func (c *Client) NodeBGPCheck(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/bgp/check", network, device))
}

// NodeBGPStatus calls GET /networks/{netID}/nodes/{device}/bgp/status.
//
// Substrate: pkg/newtron/api/handler.go line 112.
func (c *Client) NodeBGPStatus(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/bgp/status", network, device))
}

// NodeEVPNStatus calls GET /networks/{netID}/nodes/{device}/evpn/status.
//
// Substrate: pkg/newtron/api/handler.go line 113.
func (c *Client) NodeEVPNStatus(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/evpn/status", network, device))
}

// NodeInterfaceStatus calls GET /networks/{netID}/nodes/{device}/interfaces/{iface}/status
// — newtron #431's one-call operational diagnostic for a port: admin/oper state,
// cumulative counters, SONiC-computed rates (bps/pps + FEC BER), resolved ARP
// neighbors, LLDP far-end, and (on physical platforms) transceiver optics. This is
// the read that lets the console localize a link failure without SSH.
func (c *Client) NodeInterfaceStatus(ctx context.Context, network, device, iface string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/interfaces/%s/status", network, device, iface))
}

// NodeConfigDB calls GET /networks/{netID}/nodes/{device}/configdb.
//
// Substrate: pkg/newtron/api/handler.go line 150.
func (c *Client) NodeConfigDB(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/configdb", network, device))
}

// NodeConfigDBTable calls GET /networks/{netID}/nodes/{device}/configdb/{table}.
//
// Substrate: pkg/newtron/api/handler.go line 151.
func (c *Client) NodeConfigDBTable(ctx context.Context, network, device, table string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/configdb/%s", network, device, table))
}

// NodeConfigDBEntry calls GET /networks/{netID}/nodes/{device}/configdb/{table}/{key}.
//
// Substrate: pkg/newtron/api/handler.go line 152.
func (c *Client) NodeConfigDBEntry(ctx context.Context, network, device, table, key string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/configdb/%s/%s", network, device, table, key))
}

// NodeDrift calls GET /networks/{netID}/nodes/{device}/intent/drift.
// Returns the per-device drift report comparing intent vs CONFIG_DB reality.
func (c *Client) NodeDrift(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/intent/drift", network, device))
}

// NodeProjection calls GET /networks/{netID}/nodes/{device}/intent/projection.
func (c *Client) NodeProjection(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/intent/projection", network, device))
}

// NodeIntentTree calls GET /networks/{netID}/nodes/{device}/intent/tree.
func (c *Client) NodeIntentTree(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/networks/%s/nodes/%s/intent/tree", network, device))
}

// NodeProjectionDiff calls POST /networks/{netID}/nodes/{device}/intent/
// projection-diff with a list of {url, params} operations and returns the
// projected per-device diff. Operations apply in-memory only; newtron
// restores state before returning (per pkg/newtron/api/handler_node.go).
//
// Powers the per-device projection in newtcon's apply-preview modal
// (slice #171.B). One POST per affected device, fired in parallel by
// the caller.
func (c *Client) NodeProjectionDiff(ctx context.Context, network, device string, body any) (json.RawMessage, error) {
	return c.nodePostBody(ctx,
		fmt.Sprintf("/networks/%s/nodes/%s/intent/projection-diff", network, device),
		body)
}

// NodeReconcile calls POST /networks/{netID}/nodes/{device}/intent/reconcile.
// dryRun=true returns the drift as a preview; dryRun=false executes.
// mode is one of "topology" or "" (defaults to delta).
func (c *Client) NodeReconcile(ctx context.Context, network, device string, dryRun bool, mode string) (json.RawMessage, error) {
	path := fmt.Sprintf("/networks/%s/nodes/%s/intent/reconcile", network, device)
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
// Newtron topology write endpoints (PR #113 pluralization):
//
//	POST   /networks/{netID}/topology/create-node           (verb-noun, singular)
//	DELETE /networks/{netID}/topology/nodes/{name}          (collection, plural)
//	PUT    /networks/{netID}/topology/nodes/{name}
//	POST   /networks/{netID}/topology/create-link           (verb-noun, singular)
//	DELETE /networks/{netID}/topology/links/{device}/{interface}
func (c *Client) nodePostBody(ctx context.Context, path string, body any) (json.RawMessage, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("marshalling request: %v", err)}
	}
	url := c.newtronBase() + path
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

	if err := classifyResponse(resp.StatusCode, respBody, http.StatusOK, http.StatusCreated); err != nil {
		return nil, err
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
	url := c.newtronBase() + path
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

	if err := classifyResponse(resp.StatusCode, respBody, http.StatusOK); err != nil {
		return nil, err
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
	url := c.newtronBase() + path
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

	if err := classifyResponse(resp.StatusCode, respBody, http.StatusOK); err != nil {
		return nil, err
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
	return c.nodePostBody(ctx, fmt.Sprintf("/networks/%s/topology/create-node", network), body)
}

// DeleteTopologyDevice removes a device from the topology by name.
// force=true cascade-deletes referring links (handler_network.go:413-429).
// Substrate: handler.go line 51.
func (c *Client) DeleteTopologyDevice(ctx context.Context, network, name string, force bool) (json.RawMessage, error) {
	path := fmt.Sprintf("/networks/%s/topology/nodes/%s", network, name)
	if force {
		path += "?force=true"
	}
	return c.nodeDelete(ctx, path)
}

// UpdateTopologyDevice replaces the device entry at name with the given body.
// Body is a complete TopologyDevice (handler_network.go:435-455, spec.TopologyDevice).
// Substrate: handler.go line 52.
func (c *Client) UpdateTopologyDevice(ctx context.Context, network, name string, body any) (json.RawMessage, error) {
	return c.nodePutBody(ctx, fmt.Sprintf("/networks/%s/topology/nodes/%s", network, name), body)
}

// CreateTopologyLink adds a link between two interfaces.
//
// Newtron body shape (handler_network.go:460-478, spec.TopologyLink):
//
//	{ "a": "device:interface", "z": "device:interface" }
//
// Substrate: handler.go line 53.
func (c *Client) CreateTopologyLink(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.nodePostBody(ctx, fmt.Sprintf("/networks/%s/topology/create-link", network), body)
}

// DeleteTopologyLink removes the link containing the given endpoint. newtron
// #426 replaced the REST DELETE /topology/links/{device}/{interface} with an
// RPC verb paired with create-link:
//
//	POST /topology/delete-link   { "endpoint": "device:interface" }
//
// One endpoint uniquely identifies the link. Response: { "deleted": "device:interface" }.
func (c *Client) DeleteTopologyLink(ctx context.Context, network, device, iface string) (json.RawMessage, error) {
	body := map[string]string{"endpoint": device + ":" + iface}
	return c.nodePostBody(ctx, fmt.Sprintf("/networks/%s/topology/delete-link", network), body)
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
	path := fmt.Sprintf("/networks/%s/nodes/%s/interfaces/%s/apply-service", network, device, ifaceName)
	return c.nodePostBody(ctx, path, body)
}

// RemoveService unbinds any service from an interface (remove-service RPC).
// No request body required (handler_interface.go:50-69).
// Substrate: handler.go line 175.
func (c *Client) RemoveService(ctx context.Context, network, device, ifaceName string) (json.RawMessage, error) {
	path := fmt.Sprintf("/networks/%s/nodes/%s/interfaces/%s/remove-service", network, device, ifaceName)
	return c.nodePost(ctx, path)
}

// RefreshService re-applies the bound service on an interface (refresh-service RPC).
// No request body required (handler_interface.go:71-90).
// Substrate: handler.go line 176.
func (c *Client) RefreshService(ctx context.Context, network, device, ifaceName string) (json.RawMessage, error) {
	path := fmt.Sprintf("/networks/%s/nodes/%s/interfaces/%s/refresh-service", network, device, ifaceName)
	return c.nodePost(ctx, path)
}

// nodePost is a POST analog of nodeGet (no body).
func (c *Client) nodePost(ctx context.Context, path string) (json.RawMessage, error) {
	url := c.newtronBase() + path
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
	if err := classifyResponse(resp.StatusCode, body, http.StatusOK); err != nil {
		return nil, err
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

// NodeRPC POSTs an arbitrary node-level newtron action with an optional JSON
// body. subpath is the path segment after /nodes/{device}/ (for example
// "create-vlan", "save-config", "add-static-route"). The full URL is
//   /newtron/v1/networks/{network}/nodes/{device}/{subpath}?{rawQuery}
// rawQuery is forwarded verbatim so caller-supplied options like
// ?mode=topology and ?execute=false reach newtron unchanged.
func (c *Client) NodeRPC(ctx context.Context, network, device, subpath, rawQuery string, body []byte) (json.RawMessage, error) {
	path := fmt.Sprintf("/networks/%s/nodes/%s/%s", network, device, subpath)
	if rawQuery != "" {
		path = path + "?" + rawQuery
	}
	return c.nodePostRaw(ctx, path, body)
}

// InterfaceRPC POSTs an arbitrary per-interface newtron action. The full URL is
//   /newtron/v1/networks/{network}/nodes/{device}/interfaces/{iface}/{subpath}?{rawQuery}
// rawQuery is forwarded verbatim (see NodeRPC).
func (c *Client) InterfaceRPC(ctx context.Context, network, device, iface, subpath, rawQuery string, body []byte) (json.RawMessage, error) {
	path := fmt.Sprintf("/networks/%s/nodes/%s/interfaces/%s/%s", network, device, iface, subpath)
	if rawQuery != "" {
		path = path + "?" + rawQuery
	}
	return c.nodePostRaw(ctx, path, body)
}

// nodePostRaw is the underlying POST helper used by *RPC methods. The path
// argument must begin with "/" and be relative to the newtron engine base
// — e.g. "/networks/default/nodes/switch1/create-vlan".
func (c *Client) nodePostRaw(ctx context.Context, path string, body []byte) (json.RawMessage, error) {
	url := c.newtronBase() + path
	var bodyReader io.Reader
	if len(body) > 0 {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bodyReader)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response: %v", err)}
	}
	if err := classifyResponse(resp.StatusCode, respBody, http.StatusOK, http.StatusCreated); err != nil {
		return nil, err
	}
	var apiResp newtronAPIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &UnavailableError{Cause: apiResp.Error}
	}
	return apiResp.Data, nil
}
